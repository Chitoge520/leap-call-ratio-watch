import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUTU_APPDATA = os.getenv("FUTU_APPDATA") or str(ROOT / ".futu-appdata")
os.environ["APPDATA"] = FUTU_APPDATA
os.environ["appdata"] = FUTU_APPDATA

try:
    from futu import OpenQuoteContext, RET_OK
except ImportError as exc:
    raise SystemExit(
        "Missing futu-api. Install it with: pip install -r requirements-futu.txt"
    ) from exc


REPORT_PATH = ROOT / "data" / "latest-report.json"
DB_PATH = ROOT / "data" / "leap_watch.db"


def main():
    load_dotenv(ROOT / ".env")
    if not REPORT_PATH.exists():
        raise SystemExit("data/latest-report.json not found. Run npm run scan:futu:volume first.")

    report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    records = report.get("records") or []
    tickers = [str(item.get("ticker", "")).upper() for item in records if item.get("ticker")]
    tickers = sorted(set(tickers))
    if not tickers:
        raise SystemExit("No tickers found in latest report.")

    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    quote_ctx = OpenQuoteContext(host=host, port=port)
    try:
        snapshots = fetch_premarket_snapshots(quote_ctx, tickers)
    finally:
        quote_ctx.close()

    captured_at = datetime.now(timezone.utc).isoformat()
    for record in records:
        ticker = str(record.get("ticker", "")).upper()
        snapshot = snapshots.get(ticker)
        if snapshot:
            record["premarketSnapshot"] = {
                **snapshot,
                "capturedAt": captured_at,
                "source": "futu"
            }

    report["premarketGeneratedAt"] = captured_at
    report["premarketStatus"] = {
        "state": "complete",
        "generatedAt": captured_at,
        "tickers": tickers,
        "snapshots": len(snapshots),
        "source": "futu"
    }

    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if DB_PATH.exists():
        update_database(report)
    print(f"Premarket snapshot updated for {len(snapshots)} tickers: {', '.join(sorted(snapshots))}")


def fetch_premarket_snapshots(quote_ctx, tickers):
    codes = [to_futu_us_code(ticker) for ticker in tickers]
    ret, snapshot = quote_ctx.get_market_snapshot(codes)
    if ret != RET_OK:
        raise RuntimeError(f"get_market_snapshot failed: {snapshot}")

    market_states = {}
    try:
        ret, data = quote_ctx.get_market_state(codes)
        if ret == RET_OK:
            for row in frame_to_records(data):
                ticker = code_to_symbol(row.get("code", ""))
                market_states[ticker] = row.get("market_state") or row.get("market_state_str") or ""
    except Exception:
        market_states = {}

    result = {}
    for row in frame_to_records(snapshot):
        ticker = code_to_symbol(row.get("code", ""))
        if not ticker:
            continue
        last_price = pick_number(row, "pre_market_price", "pre_price", "last_price", "cur_price", "price")
        prev_close = pick_number(row, "prev_close_price", "prev_close", "close_price")
        change = pick_number(row, "pre_market_change", "pre_change", "change_price", "price_change")
        change_rate = pick_number(row, "pre_market_change_rate", "pre_change_rate", "change_rate")
        if not change and last_price and prev_close:
            change = last_price - prev_close
        if not change_rate and change and prev_close:
            change_rate = change / prev_close * 100

        result[ticker] = {
            "ticker": ticker,
            "code": row.get("code", ""),
            "name": row.get("name", ticker),
            "session": infer_session(market_states.get(ticker)),
            "marketState": market_states.get(ticker, ""),
            "lastPrice": last_price,
            "prevClose": prev_close,
            "change": change,
            "changeRate": change_rate,
            "volume": pick_number(row, "pre_market_volume", "pre_volume", "volume"),
            "turnover": pick_number(row, "pre_market_turnover", "pre_turnover", "turnover"),
            "quoteTime": row.get("update_time") or row.get("svr_recv_time_bid") or row.get("svr_recv_time_ask") or "",
            "rawAvailableFields": sorted(str(key) for key in row.keys() if any(token in str(key).lower() for token in ("pre", "last", "close", "volume", "turnover", "change", "market")))
        }
    return result


def infer_session(market_state):
    text = str(market_state or "").upper()
    if "PRE" in text:
        return "premarket"
    if "AFTER" in text or "POST" in text:
        return "afterhours"
    if "OPEN" in text or "TRADE" in text or "MORNING" in text:
        return "regular"
    if "CLOSE" in text:
        return "closed"
    return "unknown"


def pick_number(row, *keys):
    for key in keys:
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if parsed == parsed:
            return parsed
    return 0


def to_futu_us_code(ticker):
    text = str(ticker or "").upper().strip()
    return text if text.startswith("US.") else f"US.{text}"


def code_to_symbol(code):
    text = str(code or "")
    return text.split(".", 1)[1].upper() if text.startswith("US.") else text.upper()


def frame_to_records(frame):
    return json.loads(frame.to_json(orient="records", force_ascii=False))


def update_database(report):
    conn = sqlite3.connect(DB_PATH)
    try:
        generated_at = report.get("generatedAt", "")
        conn.execute(
            "UPDATE scan_reports SET raw_json = ? WHERE generated_at = ?",
            (json.dumps(report, ensure_ascii=False), generated_at),
        )
        for record in report.get("records", []):
            conn.execute(
                "UPDATE stock_records SET raw_json = ? WHERE generated_at = ? AND ticker = ?",
                (json.dumps(record, ensure_ascii=False), generated_at, record.get("ticker", "")),
            )
        conn.commit()
    finally:
        conn.close()


def load_dotenv(file_path):
    if not file_path.exists():
        return
    for line in file_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


if __name__ == "__main__":
    main()
