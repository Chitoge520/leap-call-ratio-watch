import json
import os
import sqlite3
import time
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    from futu import AuType, KLType, OpenQuoteContext, RET_OK
except ImportError as exc:
    raise SystemExit("Missing futu-api. Install it with: pip install -r requirements-futu.txt") from exc


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "leap_watch.db"
HORIZONS = (20, 60, 120)


def main():
    load_dotenv(ROOT / ".env")
    if not DB_PATH.exists():
        print("No database found. Run npm run scan:futu:volume first.")
        return

    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    quote_ctx = OpenQuoteContext(host=host, port=port)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        init_db(conn)
        signals = load_signals(conn)
        if not signals:
            print("No backtest signals found.")
            return
        fetch_price_bars(conn, quote_ctx, signals)
        updated = calculate_results(conn, signals)
        conn.commit()
        print(f"Backtest updated {updated} result rows for {len(signals)} signals.")
    finally:
        quote_ctx.close()
        conn.close()


def init_db(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS stock_price_bars (
            ticker TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            open REAL,
            close REAL,
            high REAL,
            low REAL,
            volume REAL,
            turnover REAL,
            PRIMARY KEY (ticker, trade_date)
        );
        CREATE INDEX IF NOT EXISTS idx_stock_price_bars_ticker_date ON stock_price_bars(ticker, trade_date);

        CREATE TABLE IF NOT EXISTS backtest_signals (
            signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_date TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            ticker TEXT NOT NULL,
            score REAL,
            option_volume REAL,
            leap_ratio REAL,
            cp_ratio REAL,
            premium_flow REAL,
            qualified_by_leap INTEGER,
            raw_json TEXT NOT NULL,
            UNIQUE(generated_at, ticker)
        );
        CREATE INDEX IF NOT EXISTS idx_backtest_signals_date ON backtest_signals(report_date DESC);
        CREATE INDEX IF NOT EXISTS idx_backtest_signals_ticker ON backtest_signals(ticker, report_date DESC);

        CREATE TABLE IF NOT EXISTS backtest_results (
            signal_id INTEGER NOT NULL,
            horizon_days INTEGER NOT NULL,
            entry_date TEXT,
            entry_close REAL,
            exit_date TEXT,
            exit_close REAL,
            return_pct REAL,
            max_drawdown_pct REAL,
            status TEXT NOT NULL,
            PRIMARY KEY (signal_id, horizon_days),
            FOREIGN KEY (signal_id) REFERENCES backtest_signals(signal_id)
        );
        CREATE INDEX IF NOT EXISTS idx_backtest_results_horizon ON backtest_results(horizon_days, status);
        """
    )


def load_signals(conn):
    return conn.execute(
        """
        SELECT s.*
        FROM backtest_signals s
        ORDER BY s.report_date ASC, s.signal_id ASC
        """
    ).fetchall()


def fetch_price_bars(conn, quote_ctx, signals):
    by_ticker = {}
    for signal in signals:
        by_ticker.setdefault(signal["ticker"], []).append(signal)

    today = date.today()
    for ticker, ticker_signals in by_ticker.items():
        start = min(parse_date(row["report_date"]) for row in ticker_signals)
        start = start - timedelta(days=7)
        end = today
        rows = request_daily_bars(quote_ctx, to_futu_us_code(ticker), start, end)
        for row in rows:
            trade_date = parse_bar_date(row)
            if not trade_date:
                continue
            conn.execute(
                """
                INSERT OR REPLACE INTO stock_price_bars
                (ticker, trade_date, open, close, high, low, volume, turnover)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ticker,
                    trade_date.isoformat(),
                    number(row.get("open")),
                    number(row.get("close")),
                    number(row.get("high")),
                    number(row.get("low")),
                    number(row.get("volume")),
                    number(row.get("turnover")),
                ),
            )
        time.sleep(0.25)


def request_daily_bars(quote_ctx, code, start, end):
    ret, data, _ = quote_ctx.request_history_kline(
        code=code,
        start=start.isoformat(),
        end=end.isoformat(),
        ktype=KLType.K_DAY,
        autype=AuType.QFQ,
    )
    if ret != RET_OK:
        raise RuntimeError(f"request_history_kline failed for {code}: {data}")
    return json.loads(data.to_json(orient="records", force_ascii=False))


def calculate_results(conn, signals):
    updated = 0
    bars_cache = {}
    for signal in signals:
        ticker = signal["ticker"]
        bars = bars_cache.get(ticker)
        if bars is None:
            bars = conn.execute(
                """
                SELECT trade_date, close
                FROM stock_price_bars
                WHERE ticker = ?
                ORDER BY trade_date ASC
                """,
                (ticker,),
            ).fetchall()
            bars_cache[ticker] = bars

        entry_index = first_bar_index_on_or_after(bars, signal["report_date"])
        for horizon in HORIZONS:
            result = build_result(signal["signal_id"], horizon, bars, entry_index)
            conn.execute(
                """
                INSERT OR REPLACE INTO backtest_results
                (signal_id, horizon_days, entry_date, entry_close, exit_date, exit_close,
                 return_pct, max_drawdown_pct, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                result,
            )
            updated += 1
    return updated


def build_result(signal_id, horizon, bars, entry_index):
    if entry_index is None:
        return (signal_id, horizon, None, None, None, None, None, None, "pending")

    entry = bars[entry_index]
    exit_index = entry_index + horizon
    entry_close = number(entry["close"])
    if exit_index >= len(bars) or entry_close <= 0:
        return (
            signal_id,
            horizon,
            entry["trade_date"],
            entry_close,
            None,
            None,
            None,
            None,
            "pending",
        )

    exit_bar = bars[exit_index]
    exit_close = number(exit_bar["close"])
    closes = [number(row["close"]) for row in bars[entry_index : exit_index + 1] if number(row["close"]) > 0]
    min_close = min(closes) if closes else entry_close
    return_pct = (exit_close / entry_close - 1) * 100
    max_drawdown_pct = (min_close / entry_close - 1) * 100
    return (
        signal_id,
        horizon,
        entry["trade_date"],
        entry_close,
        exit_bar["trade_date"],
        exit_close,
        round(return_pct, 4),
        round(max_drawdown_pct, 4),
        "complete",
    )


def first_bar_index_on_or_after(bars, report_date):
    for index, row in enumerate(bars):
        if row["trade_date"] >= report_date:
            return index
    return None


def parse_bar_date(row):
    raw = row.get("time_key") or row.get("date") or row.get("trade_date")
    if not raw:
        return None
    return datetime.fromisoformat(str(raw)[:10]).date()


def parse_date(value):
    return datetime.fromisoformat(str(value)[:10]).date()


def to_futu_us_code(symbol):
    return symbol if symbol.startswith("US.") else f"US.{symbol}"


def number(value, fallback=0):
    try:
        parsed = float(value)
        if parsed == parsed:
            return parsed
    except Exception:
        pass
    return fallback


def load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


if __name__ == "__main__":
    main()
