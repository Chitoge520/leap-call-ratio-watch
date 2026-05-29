import json
import math
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from futu import Market, OpenQuoteContext, OptionType, RET_OK, SecurityType, SubType
except ImportError as exc:
    raise SystemExit(
        "Missing futu-api. Install it with: pip install -r requirements-futu.txt"
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "watchlist.json"
DATA_DIR = ROOT / "data"
REPORTS_DIR = ROOT / "reports"
LAST_CHAIN_CALL_TS = 0
STOCK_META = {}


def main():
    load_dotenv(ROOT / ".env")
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    use_dollar_volume_universe = os.getenv("FUTU_USE_DOLLAR_VOLUME_UNIVERSE", "0") == "1"
    default_max_symbols = 9999 if use_dollar_volume_universe else config.get("maxSymbolsPerRun", len(config["symbols"]))
    max_symbols = int(os.getenv("FUTU_MAX_SYMBOLS", default_max_symbols))
    leap_days = int(config.get("leapDays", 180))

    DATA_DIR.mkdir(exist_ok=True)
    REPORTS_DIR.mkdir(exist_ok=True)

    quote_ctx = OpenQuoteContext(host=host, port=port)
    records = []
    errors = []

    try:
        if use_dollar_volume_universe:
            symbols = build_dollar_volume_universe(quote_ctx, max_symbols)
        else:
            symbols = config["symbols"][:max_symbols]

        for symbol in symbols:
            futu_code = to_futu_us_code(symbol)
            try:
                rows = fetch_symbol_options(quote_ctx, futu_code, leap_days)
                record = analyze_symbol(symbol, rows, leap_days)
                if record and record["totalVolume"] >= config.get("minTotalOptionVolume", 0):
                    if record["leapCallVolume"] >= config.get("minLeapCallVolume", 0):
                        records.append(record)
                time.sleep(0.8)
            except Exception as exc:
                errors.append({"symbol": symbol, "error": str(exc)})
    finally:
        quote_ctx.close()

    records.sort(key=lambda item: item["score"], reverse=True)
    generated_at = datetime.now(timezone.utc).isoformat()
    report = {
        "generatedAt": generated_at,
        "source": "futu",
        "config": {
            "leapDays": leap_days,
            "minTotalOptionVolume": config.get("minTotalOptionVolume", 0),
            "minLeapCallVolume": config.get("minLeapCallVolume", 0),
        },
        "summary": {
            "scannedSymbols": len(symbols),
            "qualifiedSymbols": len(records),
            "errors": len(errors),
        },
        "records": records,
        "topOptionAlerts": build_top_option_alerts(records),
        "errors": errors,
    }

    date_stamp = generated_at[:10]
    markdown = build_markdown_report(report)
    html = build_html_report(markdown)
    (DATA_DIR / "latest-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (REPORTS_DIR / f"{date_stamp}-futu-leap-report.md").write_text(markdown, encoding="utf-8")
    (REPORTS_DIR / f"{date_stamp}-futu-leap-report.html").write_text(html, encoding="utf-8")

    print(f"Futu scan generated {len(records)} qualified records from {len(symbols)} symbols.")
    if errors:
        print(f"Completed with {len(errors)} symbol errors.")


def fetch_symbol_options(quote_ctx, futu_code, leap_days):
    today = datetime.now().date()
    max_days = int(os.getenv("FUTU_MAX_DAYS", max(leap_days + 550, 730)))
    horizon = today + timedelta(days=max_days)
    frames = []
    expirations = fetch_expiration_dates(quote_ctx, futu_code, today, horizon)

    max_expirations = int(os.getenv("FUTU_MAX_EXPIRATIONS", len(expirations)))
    for expiration in expirations[:max_expirations]:
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


def build_dollar_volume_universe(quote_ctx, max_symbols):
    min_turnover = float(os.getenv("FUTU_MIN_STOCK_DOLLAR_VOLUME", "1000000000"))
    sample_limit = int(os.getenv("FUTU_UNIVERSE_SAMPLE_LIMIT", "0"))
    batch_size = int(os.getenv("FUTU_SNAPSHOT_BATCH_SIZE", "300"))

    ret, stocks = quote_ctx.get_stock_basicinfo(Market.US, SecurityType.STOCK)
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
        if exchange not in {"US_NASDAQ", "US_NYSE", "US_AMEX"}:
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
            code = row.get("code", "")
            symbol = code_to_symbol(code)
            if symbol and turnover >= min_turnover:
                STOCK_META[symbol] = {
                    "name": row.get("name") or infer_name(symbol),
                    "stockDollarVolume": turnover,
                    "lastPrice": number(row.get("last_price")),
                    "stockVolume": number(row.get("volume")),
                }
                liquid.append({"symbol": symbol, "turnover": turnover})
        time.sleep(0.25)

    liquid.sort(key=lambda item: item["turnover"], reverse=True)
    return [item["symbol"] for item in liquid[:max_symbols]]


def code_to_symbol(code):
    if not isinstance(code, str) or not code.startswith("US."):
        return ""
    symbol = code.split(".", 1)[1]
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
        ret, snapshot = quote_ctx.get_market_snapshot(batch)
        quote_ctx.unsubscribe(batch, [SubType.QUOTE])
        if ret != RET_OK:
            raise RuntimeError(f"get_market_snapshot failed: {snapshot}")
        for row in frame_to_records(snapshot):
            code = row.get("code")
            if code:
                quotes[code] = row
        time.sleep(0.25)
    return quotes


def normalize_codes(chain):
    codes = []
    for row in frame_to_records(chain):
        for key in ("code", "option_code", "stock_child_type"):
            value = row.get(key)
            if isinstance(value, str) and value.startswith("US."):
                codes.append(value)
        call_code = row.get("call_code") or row.get("call")
        put_code = row.get("put_code") or row.get("put")
        for value in (call_code, put_code):
            if isinstance(value, str) and value.startswith("US."):
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
    company_name = STOCK_META.get(symbol, {}).get("name") or infer_name(symbol, rows)
    stock_dollar_volume = STOCK_META.get(symbol, {}).get("stockDollarVolume", 0)
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
    alerts = []
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
            alerts.append(
                {
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
            )
    return sorted(alerts, key=lambda item: item["score"], reverse=True)[:5]


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


def to_futu_us_code(symbol):
    return symbol if symbol.startswith("US.") else f"US.{symbol}"


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
