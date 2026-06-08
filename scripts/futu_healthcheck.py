import argparse
import json
import os
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUTU_APPDATA = os.getenv("FUTU_APPDATA") or str(ROOT / ".futu-appdata")
os.environ["APPDATA"] = FUTU_APPDATA
os.environ["appdata"] = FUTU_APPDATA

try:
    from futu import Market, OpenQuoteContext, RET_OK
except ImportError as exc:
    raise SystemExit("Missing futu-api. Install it with: pip install -r requirements-futu.txt") from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trading-day", default=date.today().isoformat())
    parser.add_argument("--market", default=os.getenv("FUTU_MARKET", "US"))
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    payload = {
        "connected": False,
        "isTradingDay": False,
        "date": args.trading_day,
        "market": args.market.upper(),
        "host": host,
        "port": port,
        "error": "",
    }

    quote_ctx = None
    try:
        quote_ctx = OpenQuoteContext(host=host, port=port)
        market = Market.HK if args.market.upper() == "HK" else Market.US
        ret, data = quote_ctx.request_trading_days(market, args.trading_day, args.trading_day)
        if ret != RET_OK:
            payload["error"] = str(data)
        else:
            payload["connected"] = True
            rows = normalize_trading_days(data)
            payload["isTradingDay"] = bool(rows)
    except Exception as exc:
        payload["error"] = str(exc)
    finally:
        if quote_ctx is not None:
            quote_ctx.close()

    print(json.dumps(payload, ensure_ascii=False))


def normalize_trading_days(data):
    if hasattr(data, "to_json"):
        return json.loads(data.to_json(orient="records", force_ascii=False))
    if isinstance(data, (list, tuple, set)):
        return list(data)
    if data:
        return [data]
    return []


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
