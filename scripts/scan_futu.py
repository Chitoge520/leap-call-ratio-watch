import json
import math
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUTU_APPDATA = os.getenv("FUTU_APPDATA") or str(ROOT / ".futu-appdata")
os.environ["APPDATA"] = FUTU_APPDATA
os.environ["appdata"] = FUTU_APPDATA

try:
    from futu import (
        Market,
        OpenQuoteContext,
        OptIndicator,
        OptMarketCategory,
        OptionScreenRequest,
        OptionType,
        RET_OK,
        SecurityType,
        SubType,
    )
except ImportError as exc:
    raise SystemExit(
        "Missing futu-api. Install it with: pip install -r requirements-futu.txt"
    ) from exc


CONFIG_PATH = ROOT / "config" / "watchlist.json"
DATA_DIR = ROOT / "data"
REPORTS_DIR = ROOT / "reports"
DB_PATH = DATA_DIR / "leap_watch.db"
LAST_CHAIN_CALL_TS = 0
STOCK_META = {}
HK_NAME_SYMBOLS = None
DEFAULT_NON_SINGLE_STOCK_SYMBOLS = {
    "SPY",
    "QQQ",
    "IWM",
    "DIA",
    "VTI",
    "VOO",
    "IVV",
    "RSP",
    "TQQQ",
    "SQQQ",
    "SOXL",
    "SOXS",
    "SPX",
    "SPXW",
    "XSP",
    "NDX",
    "RUT",
    "VIX",
    "XLF",
    "XLE",
    "XLK",
    "XLV",
    "XLY",
    "XLI",
    "XLP",
    "XLU",
    "XLC",
    "XLB",
    "XLRE",
    "SMH",
    "SOXX",
    "ARKK",
    "HYG",
    "TLT",
    "GLD",
    "SLV",
    "USO",
    "UNG",
}
DEFAULT_NON_SINGLE_HK_SYMBOLS = {
    "02800",
    "02828",
    "03033",
    "03067",
    "03088",
    "03188",
    "07200",
    "07500",
    "07552",
}
HK_OPTION_CODE_FALLBACKS = {
    "TCH": "00700",
    "MET": "03690",
    "XIC": "01398",
    "ALB": "09988",
    "PAI": "02318",
}


def market_code():
    return os.getenv("FUTU_MARKET", "US").upper()


def market_prefix():
    return "HK" if market_code() == "HK" else "US"


def quote_market():
    return Market.HK if market_code() == "HK" else Market.US


def option_market_category():
    return OptMarketCategory.HK_STOCK if market_code() == "HK" else OptMarketCategory.US_STOCK


def latest_report_path():
    default_name = "latest-hk-report.json" if market_code() == "HK" else "latest-report.json"
    return DATA_DIR / os.getenv("FUTU_REPORT_FILE", default_name)


def main():
    load_dotenv(ROOT / ".env")
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    use_market_universe = (
        os.getenv("FUTU_USE_DOLLAR_VOLUME_UNIVERSE", "0") == "1"
        or os.getenv("FUTU_USE_VOLUME_UNIVERSE", "0") == "1"
    )
    use_option_volume_universe = os.getenv("FUTU_USE_OPTION_VOLUME_UNIVERSE", "0") == "1"
    universe_sort_field = os.getenv("FUTU_UNIVERSE_SORT_FIELD", "turnover").lower()
    default_max_symbols = 9999 if use_market_universe or use_option_volume_universe else config.get("maxSymbolsPerRun", len(config["symbols"]))
    max_symbols = int(os.getenv("FUTU_MAX_SYMBOLS", default_max_symbols))
    leap_days = int(config.get("leapDays", 180))

    DATA_DIR.mkdir(exist_ok=True)
    REPORTS_DIR.mkdir(exist_ok=True)

    quote_ctx = OpenQuoteContext(host=host, port=port)
    records = []
    errors = []

    try:
        if use_option_volume_universe:
            symbols = build_option_volume_universe(quote_ctx, max_symbols)
        elif use_market_universe:
            symbols = build_dollar_volume_universe(quote_ctx, max_symbols)
        else:
            symbols = config["symbols"][:max_symbols]

        for symbol in symbols:
            futu_code = to_futu_code(symbol)
            try:
                rows = fetch_symbol_options(quote_ctx, futu_code, leap_days)
                record = analyze_symbol(symbol, rows, leap_days)
                if record:
                    apply_thresholds(record, config)
                    if use_option_volume_universe or record["qualifiedByLeapThreshold"]:
                        records.append(record)
                time.sleep(0.8)
            except Exception as exc:
                if use_option_volume_universe and symbol in STOCK_META:
                    record = build_source_only_record(symbol, leap_days, str(exc))
                    apply_thresholds(record, config)
                    records.append(record)
                errors.append({"symbol": symbol, "error": str(exc)})
    finally:
        quote_ctx.close()

    records.sort(key=lambda item: item["score"], reverse=True)
    generated_at = datetime.now(timezone.utc).isoformat()
    report = {
        "generatedAt": generated_at,
        "source": "futu_hk" if market_code() == "HK" else "futu",
        "config": {
            "leapDays": leap_days,
            "minTotalOptionVolume": config.get("minTotalOptionVolume", 0),
            "minLeapCallVolume": config.get("minLeapCallVolume", 0),
            "market": market_code(),
            "universe": f"{market_code().lower()}_option_volume" if use_option_volume_universe else f"{market_code().lower()}_market" if use_market_universe else "watchlist",
            "universeSortField": universe_sort_field if use_market_universe else "",
            "optionScreenContractCount": int(os.getenv("FUTU_OPTION_SCREEN_CONTRACTS", "500")) if use_option_volume_universe else 0,
            "maxExpirations": option_chain_expiration_limit(use_option_volume_universe),
            "minExpirationsForOptionVolumeScan": min_option_volume_expirations() if use_option_volume_universe else 0,
            "leapExpirationsForOptionVolumeScan": leap_option_volume_expirations() if use_option_volume_universe else 0,
        },
        "summary": {
            "scannedSymbols": len(symbols),
            "qualifiedSymbols": len(records),
            "leapQualifiedSymbols": sum(1 for item in records if item.get("qualifiedByLeapThreshold")),
            "errors": len(errors),
        },
        "records": records,
        "topOptionAlerts": build_top_option_alerts(records),
        "errors": errors,
    }

    date_stamp = generated_at[:10]
    markdown = build_markdown_report(report)
    html = build_html_report(markdown)
    latest_report_path().write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    save_report_to_db(report)
    report_prefix = "hk-futu-leap-report" if market_code() == "HK" else "futu-leap-report"
    (REPORTS_DIR / f"{date_stamp}-{report_prefix}.md").write_text(markdown, encoding="utf-8")
    (REPORTS_DIR / f"{date_stamp}-{report_prefix}.html").write_text(html, encoding="utf-8")

    print(f"Futu scan generated {len(records)} qualified records from {len(symbols)} symbols.")
    if errors:
        print(f"Completed with {len(errors)} symbol errors.")


def save_report_to_db(report):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        init_db(conn)
        generated_at = report["generatedAt"]
        report_date = generated_at[:10]
        conn.execute(
            """
            INSERT OR REPLACE INTO scan_reports
            (generated_at, report_date, source, scanned_symbols, qualified_symbols, errors_count, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                generated_at,
                report_date,
                report.get("source", ""),
                report["summary"].get("scannedSymbols", 0),
                report["summary"].get("qualifiedSymbols", 0),
                report["summary"].get("errors", 0),
                json.dumps(report, ensure_ascii=False),
            ),
        )
        conn.execute("DELETE FROM stock_records WHERE generated_at = ?", (generated_at,))
        conn.execute("DELETE FROM option_alerts WHERE generated_at = ?", (generated_at,))
        conn.execute("DELETE FROM option_chain_rows WHERE generated_at = ?", (generated_at,))

        for record in report.get("records", []):
            conn.execute(
                """
                INSERT INTO stock_records
                (generated_at, report_date, ticker, name, score, cp_ratio, leap_ratio, total_volume,
                 call_volume, premium_flow, stock_dollar_volume, hot_contract, flow_type, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    generated_at,
                    report_date,
                    record.get("ticker", ""),
                    record.get("name", ""),
                    record.get("score", 0),
                    record.get("cpRatio", 0),
                    record.get("leapRatio", 0),
                    record.get("totalVolume", 0),
                    record.get("callVolume", 0),
                    record.get("premiumFlow", 0),
                    record.get("stockDollarVolume", 0),
                    record.get("hotContract", ""),
                    record.get("flowType", ""),
                    json.dumps(record, ensure_ascii=False),
                ),
            )
            # Backtest is temporarily disabled; keep historical tables intact but stop
            # inserting new signals during scans.
            for row in record.get("optionChain", []):
                conn.execute(
                    """
                    INSERT INTO option_chain_rows
                    (generated_at, report_date, ticker, contract, option_type, expiration, days_to_expiration,
                     strike, volume, open_interest, premium, bid, ask, iv, delta, is_leap, raw_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        generated_at,
                        report_date,
                        record.get("ticker", ""),
                        row.get("code", ""),
                        row.get("type", ""),
                        row.get("expiration", ""),
                        row.get("daysToExpiration"),
                        row.get("strike"),
                        row.get("volume"),
                        row.get("openInterest"),
                        row.get("premium"),
                        row.get("bid"),
                        row.get("ask"),
                        row.get("iv"),
                        row.get("delta"),
                        1 if row.get("isLeap") else 0,
                        json.dumps(row, ensure_ascii=False),
                    ),
                )

        for alert in report.get("topOptionAlerts", []):
            conn.execute(
                """
                INSERT INTO option_alerts
                (generated_at, report_date, ticker, name, contract, score, reason, volume,
                 open_interest, volume_to_oi, premium, is_leap, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    generated_at,
                    report_date,
                    alert.get("ticker", ""),
                    alert.get("name", ""),
                    alert.get("contract", ""),
                    alert.get("score", 0),
                    alert.get("reason", ""),
                    alert.get("volume", 0),
                    alert.get("openInterest", 0),
                    alert.get("volumeToOi", 0),
                    alert.get("premium", 0),
                    1 if alert.get("isLeap") else 0,
                    json.dumps(alert, ensure_ascii=False),
                ),
            )
        conn.commit()
    finally:
        conn.close()


def init_db(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS scan_reports (
            generated_at TEXT PRIMARY KEY,
            report_date TEXT NOT NULL,
            source TEXT,
            scanned_symbols INTEGER,
            qualified_symbols INTEGER,
            errors_count INTEGER,
            raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scan_reports_date ON scan_reports(report_date DESC);

        CREATE TABLE IF NOT EXISTS stock_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generated_at TEXT NOT NULL,
            report_date TEXT NOT NULL,
            ticker TEXT NOT NULL,
            name TEXT,
            score REAL,
            cp_ratio REAL,
            leap_ratio REAL,
            total_volume REAL,
            call_volume REAL,
            premium_flow REAL,
            stock_dollar_volume REAL,
            hot_contract TEXT,
            flow_type TEXT,
            raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stock_records_ticker_date ON stock_records(ticker, report_date DESC);
        CREATE INDEX IF NOT EXISTS idx_stock_records_date_score ON stock_records(report_date DESC, score DESC);

        CREATE TABLE IF NOT EXISTS option_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generated_at TEXT NOT NULL,
            report_date TEXT NOT NULL,
            ticker TEXT,
            name TEXT,
            contract TEXT,
            score REAL,
            reason TEXT,
            volume REAL,
            open_interest REAL,
            volume_to_oi REAL,
            premium REAL,
            is_leap INTEGER,
            raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_option_alerts_date_score ON option_alerts(report_date DESC, score DESC);

        CREATE TABLE IF NOT EXISTS option_chain_rows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            generated_at TEXT NOT NULL,
            report_date TEXT NOT NULL,
            ticker TEXT,
            contract TEXT,
            option_type TEXT,
            expiration TEXT,
            days_to_expiration INTEGER,
            strike REAL,
            volume REAL,
            open_interest REAL,
            premium REAL,
            bid REAL,
            ask REAL,
            iv REAL,
            delta REAL,
            is_leap INTEGER,
            raw_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_option_chain_ticker_date ON option_chain_rows(ticker, report_date DESC);
        CREATE INDEX IF NOT EXISTS idx_option_chain_date_volume ON option_chain_rows(report_date DESC, volume DESC);

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


def apply_thresholds(record, config):
    min_total = config.get("minTotalOptionVolume", 0)
    min_leap = config.get("minLeapCallVolume", 0)
    total_ok = record.get("totalVolume", 0) >= min_total
    leap_ok = record.get("leapCallVolume", 0) >= min_leap
    record["qualifiedByLeapThreshold"] = bool(total_ok and leap_ok)
    record["leapThresholdReason"] = (
        "pass"
        if total_ok and leap_ok
        else f"below threshold: totalVolume>={min_total} is {total_ok}, leapCallVolume>={min_leap} is {leap_ok}"
    )
    return record


def build_source_only_record(symbol, leap_days, error):
    today = datetime.now().date()
    meta = STOCK_META.get(symbol, {})
    source_top_contracts = meta.get("topOptionContracts", [])
    stock_option_volume = meta.get("stockOptionVolume", 0)
    option_chain_expirations = meta.get("optionChainExpirations", [])
    call_volume = sum(number(item.get("volume")) for item in source_top_contracts if item.get("type") == "call")
    put_volume = sum(number(item.get("volume")) for item in source_top_contracts if item.get("type") == "put")
    total_volume = call_volume + put_volume or stock_option_volume
    cp_ratio = call_volume / max(put_volume, 1)
    return {
        "ticker": symbol,
        "name": meta.get("name") or symbol,
        "theme": infer_theme(symbol),
        "date": today.isoformat(),
        "cpRatio": cp_ratio,
        "leapRatio": 0,
        "leapCpRatio": 0,
        "totalVolume": total_volume,
        "callVolume": call_volume,
        "putVolume": put_volume,
        "leapCallVolume": 0,
        "leapPutVolume": 0,
        "leapCallOi": 0,
        "totalCallOi": 0,
        "hotContract": source_top_contracts[0].get("code", "") if source_top_contracts else "",
        "hotContractVolume": source_top_contracts[0].get("volume", 0) if source_top_contracts else 0,
        "hotContractOi": source_top_contracts[0].get("openInterest", 0) if source_top_contracts else 0,
        "hotContractPremium": 0,
        "premiumFlow": 0,
        "stockDollarVolume": meta.get("stockDollarVolume", 0),
        "stockVolume": meta.get("stockVolume", 0),
        "stockOptionVolume": stock_option_volume,
        "stockOptionTurnover": meta.get("stockOptionTurnover", 0),
        "sourceTopOptionContracts": source_top_contracts,
        "topLeapContracts": [],
        "optionChainExpirations": option_chain_expirations,
        "optionChainExpirationCount": len(option_chain_expirations),
        "streak": 1,
        "oiTrend": "unknown",
        "catalyst": "",
        "risk": f"Full option chain fetch failed; source contracts are from get_option_screen. Error: {error}",
        "score": score_record(0, cp_ratio, call_volume / max(total_volume, 1), 0, 0, 0),
        "flowType": "Source option-volume Top5",
        "note": f"{symbol} is included because it ranked in the option-volume screen. Full chain fetch failed, so LEAP ratios are unknown.",
        "optionChain": [],
        "dataStatus": "source_only",
        "missingData": ["fullOptionChain", "leapRatio", "premiumFlow"],
    }


def fetch_symbol_options(quote_ctx, futu_code, leap_days):
    today = datetime.now().date()
    max_days = int(os.getenv("FUTU_MAX_DAYS", max(leap_days + 550, 730)))
    horizon = today + timedelta(days=max_days)
    frames = []
    expirations = fetch_expiration_dates(quote_ctx, futu_code, today, horizon)

    selected_expirations = select_option_chain_expirations(expirations, today, leap_days, is_option_volume_scan())
    symbol = code_to_symbol(futu_code)
    if symbol:
        STOCK_META.setdefault(symbol, {})["optionChainExpirations"] = [item.isoformat() for item in selected_expirations]
    for expiration in selected_expirations:
        throttle_chain_request()
        ret, chain = quote_ctx.get_option_chain(
            code=futu_code,
            start=expiration.isoformat(),
            end=expiration.isoformat(),
            option_type=OptionType.ALL,
        )
        if ret != RET_OK:
            raise RuntimeError(f"get_option_chain failed: {chain}")
        if not chain.empty:
            frames.append(chain)

    if not frames:
        return []

    chain = concat_frames(frames)

    option_codes = normalize_codes(chain)
    if not option_codes:
        return []

    quote_rows = fetch_option_quotes(quote_ctx, option_codes)
    static_rows = frame_to_records(chain)
    static_by_code = {row.get("code"): row for row in static_rows if row.get("code")}

    rows = []
    for code, quote in quote_rows.items():
        merged = {**static_by_code.get(code, {}), **quote}
        merged["code"] = code
        rows.append(merged)
    return rows


def is_option_volume_scan():
    return os.getenv("FUTU_USE_OPTION_VOLUME_UNIVERSE", "0") == "1"


def option_chain_expiration_limit(use_option_volume_universe=False):
    requested = int(os.getenv("FUTU_MAX_EXPIRATIONS", "9999"))
    if use_option_volume_universe:
        requested = max(requested, min_option_volume_expirations())
    return requested


def min_option_volume_expirations():
    return int(os.getenv("FUTU_MIN_EXPIRATIONS_OPTION_VOLUME", "12"))


def leap_option_volume_expirations():
    return int(os.getenv("FUTU_LEAP_EXPIRATIONS_OPTION_VOLUME", "8"))


def select_option_chain_expirations(expirations, today, leap_days, use_option_volume_universe=False):
    if not use_option_volume_universe:
        return expirations[: min(option_chain_expiration_limit(False), len(expirations))]
    near_count = min(option_chain_expiration_limit(True), len(expirations))
    selected = list(expirations[:near_count])
    leap_cutoff = today + timedelta(days=leap_days)
    leap_expirations = [item for item in expirations if item >= leap_cutoff][:leap_option_volume_expirations()]
    return sorted(set(selected + leap_expirations))


def build_dollar_volume_universe(quote_ctx, max_symbols):
    min_turnover = float(os.getenv("FUTU_MIN_STOCK_DOLLAR_VOLUME", "1000000000"))
    min_volume = float(os.getenv("FUTU_MIN_STOCK_VOLUME", "0"))
    sort_field = os.getenv("FUTU_UNIVERSE_SORT_FIELD", "turnover").lower()
    if sort_field not in {"turnover", "volume"}:
        sort_field = "turnover"
    sample_limit = int(os.getenv("FUTU_UNIVERSE_SAMPLE_LIMIT", "0"))
    batch_size = int(os.getenv("FUTU_SNAPSHOT_BATCH_SIZE", "300"))

    ret, stocks = quote_ctx.get_stock_basicinfo(quote_market(), SecurityType.STOCK)
    if ret != RET_OK:
        raise RuntimeError(f"get_stock_basicinfo failed: {stocks}")

    rows = frame_to_records(stocks)
    candidates = []
    for row in rows:
        code = row.get("code", "")
        ticker = code_to_symbol(code)
        exchange = row.get("exchange_type", "")
        if not ticker:
            continue
        if row.get("delisting") is True or row.get("suspension") is True:
            continue
        if market_code() == "US" and exchange not in {"US_NASDAQ", "US_NYSE", "US_AMEX"}:
            continue
        candidates.append(code)

    if sample_limit > 0:
        candidates = candidates[:sample_limit]

    liquid = []
    for start in range(0, len(candidates), batch_size):
        batch = candidates[start : start + batch_size]
        ret, snapshot = quote_ctx.get_market_snapshot(batch)
        if ret != RET_OK:
            continue
        for row in frame_to_records(snapshot):
            turnover = number(row.get("turnover"))
            volume = number(row.get("volume"))
            code = row.get("code", "")
            symbol = code_to_symbol(code)
            is_liquid_enough = volume >= min_volume if sort_field == "volume" else turnover >= min_turnover
            if symbol and is_liquid_enough:
                STOCK_META[symbol] = {
                    "name": row.get("name") or infer_name(symbol),
                    "stockDollarVolume": turnover,
                    "lastPrice": number(row.get("last_price")),
                    "stockVolume": volume,
                }
                liquid.append({"symbol": symbol, "turnover": turnover, "volume": volume})
        time.sleep(0.25)

    liquid.sort(key=lambda item: item[sort_field], reverse=True)
    return [item["symbol"] for item in liquid[:max_symbols]]


def build_option_volume_universe(quote_ctx, max_symbols):
    page_count = int(os.getenv("FUTU_OPTION_SCREEN_CONTRACTS", "500"))
    page_count = max(max_symbols, min(page_count, 2000))
    req = OptionScreenRequest(market_categories=[option_market_category()])
    req.add_sort(OptIndicator.VOLUME, desc=True)
    req.page_count = page_count
    for field in (
        OptIndicator.VOLUME,
        OptIndicator.TURNOVER,
        OptIndicator.OPEN_INTEREST,
        OptIndicator.PRICE,
        OptIndicator.BID_PRICE,
        OptIndicator.ASK_PRICE,
        OptIndicator.STRIKE_PRICE,
        OptIndicator.STRIKE_DATE_TIMESTAMP,
        OptIndicator.OPTION_TYPE,
        OptIndicator.IMPLIED_VOLATILITY,
        OptIndicator.DELTA,
    ):
        req.add_option_retrieve(field)

    ret, data = quote_ctx.get_option_screen(req)
    if ret != RET_OK:
        raise RuntimeError(f"get_option_screen failed: {data}")

    _, _, screen = data
    rows = frame_to_records(screen)
    by_symbol = {}
    for row in rows:
        symbol = option_screen_symbol(row, quote_ctx)
        if not symbol or is_non_single_stock_symbol(symbol):
            continue
        display_name = option_screen_name(row) or symbol
        volume = number(row.get("volume"))
        bucket = by_symbol.setdefault(
            symbol,
            {
                "symbol": symbol,
                "name": display_name,
                "optionVolume": 0,
                "optionTurnover": 0,
                "topContracts": [],
            },
        )
        bucket["optionVolume"] += volume
        bucket["optionTurnover"] += number(row.get("turnover"))
        if len(bucket["topContracts"]) < 5:
            bucket["topContracts"].append(normalize_option_screen_row(row))

    ranked = sorted(by_symbol.values(), key=lambda item: item["optionVolume"], reverse=True)
    for item in ranked[:max_symbols]:
        STOCK_META[item["symbol"]] = {
            "name": item.get("name") or item["symbol"],
            "stockOptionVolume": item["optionVolume"],
            "stockOptionTurnover": item["optionTurnover"],
            "topOptionContracts": item["topContracts"],
        }
    return [item["symbol"] for item in ranked[:max_symbols]]


def is_non_single_stock_symbol(symbol):
    if os.getenv("FUTU_INCLUDE_ETF_OPTIONS", "0") == "1":
        return False
    normalized = str(symbol or "").upper().strip()
    extra = parse_symbol_set(os.getenv("FUTU_EXCLUDE_OPTION_UNDERLYINGS", ""))
    defaults = DEFAULT_NON_SINGLE_HK_SYMBOLS if market_code() == "HK" else DEFAULT_NON_SINGLE_STOCK_SYMBOLS
    return normalized in defaults or normalized in extra


def parse_symbol_set(value):
    return {
        item.strip().upper()
        for item in str(value or "").replace(";", ",").split(",")
        if item.strip()
    }


def option_screen_name(row):
    name = str(row.get("option_name") or "").strip()
    if not name:
        return ""
    return name.split(" ", 1)[0].strip()


def option_screen_symbol(row, quote_ctx=None):
    code = str(row.get("code") or "")
    prefix = f"{market_prefix()}."
    if market_code() == "HK":
        name_symbol = resolve_hk_option_name(option_screen_name(row), quote_ctx)
        if name_symbol:
            return name_symbol
        if code.startswith(prefix):
            raw = code.split(".", 1)[1]
            letters = "".join(ch for ch in raw if ch.isalpha())
            for length in range(min(len(letters), 4), 1, -1):
                mapped = HK_OPTION_CODE_FALLBACKS.get(letters[:length])
                if mapped:
                    return mapped
        return ""

    name = str(row.get("option_name") or "")
    if name:
        symbol = name.split(" ", 1)[0].strip().upper()
        if symbol:
            return symbol
    if code.startswith(prefix):
        raw = code.split(".", 1)[1]
        for marker in ("2", "1"):
            idx = raw.find(marker)
            if idx > 0:
                return raw[:idx]
    return ""


def resolve_hk_option_name(name, quote_ctx=None):
    if not name or quote_ctx is None:
        return ""
    rows = hk_name_symbols(quote_ctx)
    exact = [item for item in rows if item["name"] == name]
    if len(exact) == 1:
        return exact[0]["symbol"]
    prefix_matches = [item for item in rows if item["name"].startswith(name) or name.startswith(item["name"])]
    if len(prefix_matches) == 1:
        return prefix_matches[0]["symbol"]
    contains_matches = [item for item in rows if name in item["name"] or item["name"] in name]
    if len(contains_matches) == 1:
        return contains_matches[0]["symbol"]
    return ""


def hk_name_symbols(quote_ctx):
    global HK_NAME_SYMBOLS
    if HK_NAME_SYMBOLS is not None:
        return HK_NAME_SYMBOLS
    ret, stocks = quote_ctx.get_stock_basicinfo(Market.HK, SecurityType.STOCK)
    if ret != RET_OK:
        HK_NAME_SYMBOLS = []
        return HK_NAME_SYMBOLS
    items = []
    for row in frame_to_records(stocks):
        symbol = code_to_symbol(row.get("code", ""))
        name = str(row.get("name") or "").strip()
        if symbol and name and row.get("delisting") is not True and row.get("suspension") is not True:
            items.append({"symbol": symbol, "name": name})
    HK_NAME_SYMBOLS = items
    return HK_NAME_SYMBOLS


def normalize_option_screen_row(row):
    return {
        "code": row.get("code", ""),
        "name": row.get("option_name", ""),
        "type": "call" if int(number(row.get("option_type"))) == 1 else "put" if int(number(row.get("option_type"))) == 2 else "",
        "expiration": parse_option_screen_date(row.get("strike_date")),
        "strike": number(row.get("strike_price")),
        "volume": number(row.get("volume")),
        "openInterest": number(row.get("open_interest")),
        "turnover": number(row.get("turnover")),
        "last": number(row.get("price")),
        "bid": number(row.get("bid_price")),
        "ask": number(row.get("ask_price")),
        "iv": number(row.get("implied_volatility")),
        "delta": number(row.get("delta")),
    }


def parse_option_screen_date(value):
    text = str(value or "")
    if len(text) == 8 and text.isdigit():
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    return text


def code_to_symbol(code):
    prefix = f"{market_prefix()}."
    if not isinstance(code, str) or not code.startswith(prefix):
        return ""
    symbol = code.split(".", 1)[1]
    if market_code() == "HK":
        return symbol if len(symbol) == 5 and symbol.isdigit() else ""
    if not symbol.replace(".", "").replace("-", "").isalpha():
        return ""
    if len(symbol) > 8:
        return ""
    return symbol


def fetch_expiration_dates(quote_ctx, futu_code, today, horizon):
    ret, data = quote_ctx.get_option_expiration_date(code=futu_code)
    if ret != RET_OK:
        raise RuntimeError(f"get_option_expiration_date failed: {data}")
    expirations = []
    for row in frame_to_records(data):
        expiry = parse_date(row.get("strike_time"))
        if expiry and today <= expiry <= horizon:
            expirations.append(expiry)
    return sorted(set(expirations))


def throttle_chain_request():
    global LAST_CHAIN_CALL_TS
    now = time.monotonic()
    wait = 3.2 - (now - LAST_CHAIN_CALL_TS)
    if wait > 0:
        time.sleep(wait)
    LAST_CHAIN_CALL_TS = time.monotonic()


def fetch_option_quotes(quote_ctx, option_codes):
    quotes = {}
    batch_size = 200
    for start in range(0, len(option_codes), batch_size):
        batch = option_codes[start : start + batch_size]
        quote_ctx.subscribe(batch, [SubType.QUOTE], subscribe_push=False)
        try:
            snapshot = get_market_snapshot_with_retry(quote_ctx, batch)
            for row in frame_to_records(snapshot):
                code = row.get("code")
                if code:
                    quotes[code] = row
        finally:
            quote_ctx.unsubscribe(batch, [SubType.QUOTE])
        time.sleep(0.55)
    return quotes


def get_market_snapshot_with_retry(quote_ctx, batch):
    attempts = int(os.getenv("FUTU_SNAPSHOT_RETRIES", "3"))
    for attempt in range(attempts):
        ret, snapshot = quote_ctx.get_market_snapshot(batch)
        if ret == RET_OK:
            return snapshot
        message = str(snapshot)
        if attempt < attempts - 1 and ("频率" in message or "frequency" in message.lower()):
            time.sleep(31)
            continue
        raise RuntimeError(f"get_market_snapshot failed: {snapshot}")


def normalize_codes(chain):
    codes = []
    for row in frame_to_records(chain):
        for key in ("code", "option_code", "stock_child_type"):
            value = row.get(key)
            if isinstance(value, str) and value.startswith(f"{market_prefix()}."):
                codes.append(value)
        call_code = row.get("call_code") or row.get("call")
        put_code = row.get("put_code") or row.get("put")
        for value in (call_code, put_code):
            if isinstance(value, str) and value.startswith(f"{market_prefix()}."):
                codes.append(value)
    return sorted(set(codes))


def frame_to_records(frame):
    return json.loads(frame.to_json(orient="records", force_ascii=False))


def concat_frames(frames):
    try:
        import pandas as pd

        return pd.concat(frames, ignore_index=True).drop_duplicates()
    except Exception:
        return frames[0]


def analyze_symbol(symbol, rows, leap_days):
    if not rows:
        return None

    today = datetime.now().date()
    leap_cutoff = today + timedelta(days=leap_days)
    calls = []
    puts = []
    leap_calls = []
    leap_puts = []

    for row in rows:
        option_type = infer_option_type(row)
        expiration = parse_date(
            row.get("strike_time")
            or row.get("expiration")
            or row.get("expiry_date")
            or row.get("last_trade_time")
        )
        volume = number(row.get("volume") or row.get("option_volume"))
        open_interest = number(
            row.get("open_interest")
            or row.get("option_open_interest")
            or row.get("net_open_interest")
            or row.get("option_net_open_interest")
        )
        bid = number(row.get("bid_price") or row.get("bid"))
        ask = number(row.get("ask_price") or row.get("ask"))
        last = number(row.get("last_price") or row.get("price"))
        price = midpoint(bid, ask) or last
        premium = volume * price * 100
        item = {
            "ticker": row.get("code", ""),
            "type": option_type,
            "expirationDate": expiration.isoformat() if expiration else "",
            "strike": number(row.get("strike_price") or row.get("option_strike_price")),
            "volume": volume,
            "openInterest": open_interest,
            "price": price,
            "premium": premium,
        }

        if option_type == "call":
            calls.append(item)
        elif option_type == "put":
            puts.append(item)

        if expiration and expiration >= leap_cutoff:
            if option_type == "call":
                leap_calls.append(item)
            elif option_type == "put":
                leap_puts.append(item)

    total_call_volume = sum_item(calls, "volume")
    total_put_volume = sum_item(puts, "volume")
    total_volume = total_call_volume + total_put_volume
    leap_call_volume = sum_item(leap_calls, "volume")
    leap_put_volume = sum_item(leap_puts, "volume")
    near_term_call_volume = max(total_call_volume - leap_call_volume, 1)
    leap_ratio = leap_call_volume / near_term_call_volume
    cp_ratio = total_call_volume / max(total_put_volume, 1)
    leap_cp_ratio = leap_call_volume / max(leap_put_volume, 1)
    premium_flow = sum_item(leap_calls, "premium")
    leap_call_oi = sum_item(leap_calls, "openInterest")
    total_call_oi = sum_item(calls, "openInterest")
    hot = max(leap_calls, key=lambda item: item["volume"], default={})
    top_leap_contracts = sorted(leap_calls, key=lambda item: item["volume"], reverse=True)[:10]
    company_name = STOCK_META.get(symbol, {}).get("name") or infer_name(symbol, rows)
    stock_dollar_volume = STOCK_META.get(symbol, {}).get("stockDollarVolume", 0)
    stock_volume = STOCK_META.get(symbol, {}).get("stockVolume", 0)
    stock_option_volume = STOCK_META.get(symbol, {}).get("stockOptionVolume", 0)
    stock_option_turnover = STOCK_META.get(symbol, {}).get("stockOptionTurnover", 0)
    source_top_contracts = STOCK_META.get(symbol, {}).get("topOptionContracts", [])
    option_chain_expirations = STOCK_META.get(symbol, {}).get("optionChainExpirations", [])
    option_chain_rows = build_option_chain_rows(rows, today, leap_days)
    score = score_record(
        leap_ratio=leap_ratio,
        cp_ratio=cp_ratio,
        call_share=total_call_volume / max(total_volume, 1),
        premium_flow=premium_flow,
        leap_call_volume=leap_call_volume,
        leap_call_oi=leap_call_oi,
    )

    return {
        "ticker": symbol,
        "name": company_name,
        "theme": infer_theme(symbol),
        "date": today.isoformat(),
        "cpRatio": cp_ratio,
        "leapRatio": leap_ratio,
        "leapCpRatio": leap_cp_ratio,
        "totalVolume": total_volume,
        "callVolume": total_call_volume,
        "putVolume": total_put_volume,
        "leapCallVolume": leap_call_volume,
        "leapPutVolume": leap_put_volume,
        "leapCallOi": leap_call_oi,
        "totalCallOi": total_call_oi,
        "hotContract": hot.get("ticker", ""),
        "hotContractVolume": hot.get("volume", 0),
        "hotContractOi": hot.get("openInterest", 0),
        "hotContractPremium": hot.get("premium", 0),
        "premiumFlow": premium_flow,
        "stockDollarVolume": stock_dollar_volume,
        "stockVolume": stock_volume,
        "stockOptionVolume": stock_option_volume,
        "stockOptionTurnover": stock_option_turnover,
        "sourceTopOptionContracts": source_top_contracts,
        "topLeapContracts": top_leap_contracts,
        "optionChainExpirations": option_chain_expirations,
        "optionChainExpirationCount": len(option_chain_expirations),
        "streak": 1,
        "oiTrend": "未知",
        "catalyst": "",
        "risk": "富途 OpenD 数据适合盘后研究，但仍需确认行情权限、延迟口径、OI 更新时间和期权合约订阅限制。",
        "score": score,
        "flowType": classify(score, leap_ratio, cp_ratio, premium_flow),
        "note": build_research_note(symbol, cp_ratio, leap_ratio, total_volume, total_call_volume, premium_flow, hot.get("ticker", ""), score),
        "optionChain": option_chain_rows,
    }


def build_option_chain_rows(rows, today, leap_days):
    items = []
    cutoff = today + timedelta(days=leap_days)
    for row in rows:
        option_type = infer_option_type(row)
        expiration = parse_date(row.get("strike_time") or row.get("expiration") or row.get("expiry_date"))
        volume = number(row.get("volume") or row.get("option_volume"))
        open_interest = number(
            row.get("open_interest")
            or row.get("option_open_interest")
            or row.get("net_open_interest")
            or row.get("option_net_open_interest")
        )
        bid = number(row.get("bid_price") or row.get("bid"))
        ask = number(row.get("ask_price") or row.get("ask"))
        last = number(row.get("last_price") or row.get("price"))
        price = midpoint(bid, ask) or last
        items.append(
            {
                "code": row.get("code", ""),
                "name": row.get("name", ""),
                "type": option_type,
                "expiration": expiration.isoformat() if expiration else "",
                "daysToExpiration": (expiration - today).days if expiration else None,
                "strike": number(row.get("strike_price") or row.get("option_strike_price")),
                "volume": volume,
                "openInterest": open_interest,
                "bid": bid,
                "ask": ask,
                "last": last,
                "mid": price,
                "premium": volume * price * 100,
                "iv": number(row.get("option_implied_volatility")),
                "delta": number(row.get("option_delta")),
                "isLeap": bool(expiration and expiration >= cutoff),
            }
        )
    return sorted(items, key=lambda item: (not item["isLeap"], -item["volume"]))[:250]


def build_top_option_alerts(records):
    best_by_ticker = {}
    for record in records:
        for row in record.get("optionChain", []):
            volume = number(row.get("volume"))
            oi = number(row.get("openInterest"))
            premium = number(row.get("premium"))
            is_leap = bool(row.get("isLeap"))
            is_call = row.get("type") == "call"
            volume_to_oi = volume / max(oi, 1)
            surprise_score = (
                normalize(volume, 25_000) * 35
                + normalize(premium, 5_000_000) * 25
                + normalize(volume_to_oi, 1.5) * 20
                + (15 if is_leap and is_call else 0)
                + (5 if is_call else 0)
            )
            reason = []
            if is_leap and is_call:
                reason.append("LEAP call")
            if volume_to_oi >= 1:
                reason.append("成交量接近/超过 OI")
            if premium >= 2_000_000:
                reason.append("权利金流大")
            if not reason:
                reason.append("高成交合约")
            alert = {
                "ticker": record["ticker"],
                "name": record.get("name", record["ticker"]),
                "contract": row.get("code", ""),
                "type": row.get("type", ""),
                "expiration": row.get("expiration", ""),
                "daysToExpiration": row.get("daysToExpiration"),
                "strike": row.get("strike"),
                "volume": volume,
                "openInterest": oi,
                "volumeToOi": volume_to_oi,
                "premium": premium,
                "bid": row.get("bid"),
                "ask": row.get("ask"),
                "iv": row.get("iv"),
                "delta": row.get("delta"),
                "isLeap": is_leap,
                "score": round(min(100, surprise_score)),
                "reason": " / ".join(reason),
            }
            current = best_by_ticker.get(record["ticker"])
            if current is None or alert["score"] > current["score"]:
                best_by_ticker[record["ticker"]] = alert
    return sorted(best_by_ticker.values(), key=lambda item: item["score"], reverse=True)[:5]


def infer_option_type(row):
    raw = str(row.get("option_type") or row.get("type") or row.get("stock_child_type") or "").lower()
    code = str(row.get("code") or "").upper()
    if "call" in raw or raw in {"c", "option_type.call"}:
        return "call"
    if "put" in raw or raw in {"p", "option_type.put"}:
        return "put"
    if "C" in code[-12:]:
        return "call"
    if "P" in code[-12:]:
        return "put"
    return ""


def to_futu_code(symbol):
    text = str(symbol or "").upper().strip()
    prefix = f"{market_prefix()}."
    if text.startswith(prefix):
        return text
    if market_code() == "HK":
        digits = "".join(ch for ch in text if ch.isdigit())
        return f"HK.{digits.zfill(5)}"
    return f"US.{text}"


def score_record(leap_ratio, cp_ratio, call_share, premium_flow, leap_call_volume, leap_call_oi):
    score = (
        normalize(leap_ratio, 3) * 28
        + normalize(cp_ratio, 5) * 18
        + normalize(call_share, 0.85) * 14
        + normalize(premium_flow, 25_000_000) * 16
        + normalize(leap_call_volume, 25_000) * 12
        + normalize(leap_call_oi, 100_000) * 12
    )
    return round(min(100, score))


def classify(score, leap_ratio, cp_ratio, premium_flow):
    if score >= 78 and leap_ratio >= 1.5 and cp_ratio >= 2.5:
        return "Conviction candidate"
    if leap_ratio >= 1 and cp_ratio >= 2:
        return "Directional LEAP call flow"
    if premium_flow >= 20_000_000:
        return "Large premium flow"
    return "Watchlist"


def build_research_note(symbol, cp_ratio, leap_ratio, total_volume, call_volume, premium_flow, hot_contract, score):
    call_share = call_volume / max(total_volume, 1)
    return "\n\n".join(
        [
            f"{symbol} 进入富途 OpenD 版 LEAP call 异常观察。C/P {cp_ratio:.2f}，LEAP 比 {leap_ratio:.2f}，总期权成交 {compact(total_volume)}，call 占 {call_share * 100:.1f}%。",
            f"最热远月合约是 {hot_contract or '-'}，远月 call 权利金流约 {compact(premium_flow)}，综合评分 {score}/100。",
            "这份报告适合盘后研究。真正的确认点不是当日成交，而是次日 OI 是否继续增长，以及价差、股价结构和公司催化是否同时支持这笔远月 call 资金流。",
        ]
    )


def build_markdown_report(report):
    lines = [
        "# LEAP Call Ratio 异常监控报告 Futu OpenD 版",
        "",
        f"生成时间：{report['generatedAt']}",
        f"扫描标的：{report['summary']['scannedSymbols']}",
        f"入选标的：{report['summary']['qualifiedSymbols']}",
        "",
        "## 今日重点",
        "",
    ]
    if not report["records"]:
        lines.append("今天没有标的通过过滤条件。可以降低 config/watchlist.json 的 minTotalOptionVolume 和 minLeapCallVolume 做连通性验证。")
    for record in report["records"][:12]:
        lines.extend(
            [
                f"### {record['ticker']} - {record['flowType']}",
                "",
                f"评分：{record['score']}/100",
                f"C/P：{record['cpRatio']:.2f}，LEAP 比：{record['leapRatio']:.2f}，LEAP C/P：{record['leapCpRatio']:.2f}",
                f"最热合约：{record['hotContract'] or '-'}，成交 {compact(record['hotContractVolume'])}，OI {compact(record['hotContractOi'])}",
                f"远月 call 权利金流：{compact(record['premiumFlow'])}",
                "",
                record["note"],
                "",
            ]
        )
    if report["errors"]:
        lines.append("## 抓取错误")
        for item in report["errors"]:
            lines.append(f"- {item['symbol']}: {item['error']}")
    return "\n".join(lines)


def build_html_report(markdown):
    body = html_escape(markdown).replace("\n\n", "</p><p>").replace("\n", "<br>")
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        "<title>LEAP Report</title>"
        "<style>body{margin:0;background:#f5f1ea;color:#19201d;font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.75}"
        "main{max-width:920px;margin:0 auto;padding:32px 20px}p{background:#fffdf8;border:1px solid #ded7cc;border-radius:8px;padding:18px}</style>"
        f"</head><body><main><p>{body}</p></main></body></html>"
    )


def infer_theme(symbol):
    themes = {
        "NOK": "AI 网络基础设施、光网络、5G/国防通信供应链重估",
        "INTC": "晶圆制造周期反转、政策补贴和代工订单兑现",
        "PLTR": "AI 软件平台商业化和政府订单扩张",
        "NVDA": "AI 加速计算需求和数据中心资本开支",
        "AMD": "AI GPU 份额提升和服务器 CPU 周期",
        "TSLA": "自动驾驶、储能和机器人叙事重估",
        "SOFI": "金融科技盈利能力和信贷周期改善",
    }
    return themes.get(symbol, "")


def infer_name(symbol, rows=None):
    names = {
        "NOK": "Nokia",
        "INTC": "Intel",
        "T": "AT&T",
        "PLTR": "Palantir",
        "AAPL": "Apple",
        "MSFT": "Microsoft",
        "NVDA": "NVIDIA",
        "AMD": "AMD",
        "TSLA": "Tesla",
        "AMZN": "Amazon",
        "GOOGL": "Alphabet",
        "META": "Meta Platforms",
        "SMCI": "Super Micro Computer",
        "SOFI": "SoFi Technologies",
        "RIVN": "Rivian"
    }
    if symbol in names:
        return names[symbol]
    if rows:
        for row in rows:
            owner = row.get("stock_owner") or ""
            name = row.get("stock_owner_name") or row.get("owner_name")
            if owner.endswith(f".{symbol}") and name:
                return str(name)
    return symbol


def load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def parse_date(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return None


def midpoint(bid, ask):
    if bid > 0 and ask > 0:
        return (bid + ask) / 2
    return 0


def sum_item(items, key):
    return sum(number(item.get(key)) for item in items)


def normalize(value, max_value):
    if max_value <= 0:
        return 0
    return min(number(value) / max_value, 1)


def number(value):
    if value is None:
        return 0
    if isinstance(value, float) and math.isnan(value):
        return 0
    try:
        parsed = float(value)
        if math.isnan(parsed):
            return 0
        return parsed
    except (TypeError, ValueError):
        return 0


def compact(value):
    n = number(value)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(round(n))


def html_escape(value):
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#039;")
    )


if __name__ == "__main__":
    main()
