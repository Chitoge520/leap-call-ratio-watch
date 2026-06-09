import json
import hashlib
import math
import os
import statistics
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
REPORTS_DIR = ROOT / "reports"
CACHE_DIR = DATA_DIR / "tushare-cache"
BASIC_CACHE_PATH = DATA_DIR / "tushare-stock-basic.json"
PUBLIC_BASIC_CACHE_PATH = DATA_DIR / "public-cn-stock-basic.json"
TUSHARE_URL = "https://api.tushare.pro"
EASTMONEY_STOCK_LIST_URL = (
    "https://push2.eastmoney.com/api/qt/clist/get?"
    "pn={page}&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&"
    "fs={fs}&fields=f12,f14,f13,f100"
)
EASTMONEY_STOCK_LIST_FS = [
    "m:0%2Bt:6,m:0%2Bt:80",
    "m:1%2Bt:2,m:1%2Bt:23",
]

INDEX_CODES = [
    ("000001.SH", "上证指数"),
    ("000300.SH", "沪深300"),
    ("000905.SH", "中证500"),
    ("000852.SH", "中证1000"),
    ("399001.SZ", "深证成指"),
    ("399006.SZ", "创业板指"),
]

THEME_KEYWORDS = {
    "AI/算力": ["软件", "互联网", "人工智能", "数据", "通信", "计算机", "信息", "科技"],
    "半导体": ["半导体", "芯片", "集成电路", "电子", "光电", "元件"],
    "新能源": ["电池", "锂", "光伏", "储能", "风电", "太阳能", "新能源"],
    "机器人/高端制造": ["机器人", "自动化", "精密", "工业机械", "专用机械", "设备", "机床"],
    "消费": ["食品", "饮料", "白酒", "旅游", "酒店", "家居", "零售", "服饰"],
    "医药": ["医药", "生物", "医疗", "药业", "制药", "健康"],
    "金融地产": ["银行", "证券", "保险", "地产", "金融", "信托"],
    "资源周期": ["煤炭", "钢铁", "有色", "矿", "石油", "化工", "黄金", "稀土"],
    "军工": ["军工", "航天", "航空", "兵器", "船舶", "卫星"],
}


def main():
    load_dotenv(ROOT / ".env")
    DATA_DIR.mkdir(exist_ok=True)
    REPORTS_DIR.mkdir(exist_ok=True)
    CACHE_DIR.mkdir(exist_ok=True)

    token = os.getenv("TUSHARE_TOKEN") or os.getenv("TS_TOKEN")
    if not token:
        raise SystemExit("Missing TUSHARE_TOKEN. Add it to .env, then run: npm run review:cn")

    client = TushareClient(token)
    max_stocks = int(os.getenv("CN_REVIEW_MAX_STOCKS", "5000"))
    trade_date = os.getenv("CN_REVIEW_TRADE_DATE") or latest_trade_date(client)

    daily_rows = fetch_daily_rows(client, trade_date)
    basics = fetch_stock_basic(client, max_stocks)
    if not basics:
        basics = build_basic_rows_from_daily(daily_rows, max_stocks)
    daily_basic = fetch_daily_basic(client, trade_date)
    rows = merge_stock_rows(basics, daily_rows, daily_basic)
    rows = [row for row in rows if row["lastPrice"] > 0 or row["turnover"] > 0 or row["volume"] > 0]

    indices = fetch_indices(client, trade_date)
    generated_at = datetime.now(timezone.utc).isoformat()
    report = build_review(generated_at, trade_date, rows, indices, max_stocks)
    report["strategyCandidates"] = build_strategy_candidates(report, rows)

    date_stamp = trade_date_to_iso(trade_date)
    markdown = build_markdown(report)
    html = build_html(markdown)
    (DATA_DIR / "latest-cn-review.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (REPORTS_DIR / f"{date_stamp}-cn-market-review.md").write_text(markdown, encoding="utf-8")
    (REPORTS_DIR / f"{date_stamp}-cn-market-review.html").write_text(html, encoding="utf-8")
    print(f"A-share review generated with Tushare: {len(rows)} stocks, trade_date={trade_date}.")


class TushareClient:
    def __init__(self, token):
        self.token = token
        self.url = os.getenv("TUSHARE_URL", TUSHARE_URL)
        self.sleep_ms = int(os.getenv("TUSHARE_SLEEP_MS", "250"))
        self.retries = max(1, int(os.getenv("TUSHARE_RETRIES", "3")))
        self.retry_delay_ms = int(os.getenv("TUSHARE_RETRY_DELAY_MS", "1500"))

    def query(self, api_name, params=None, fields=""):
        payload = {
            "api_name": api_name,
            "token": self.token,
            "params": params or {},
            "fields": fields,
        }
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        last_error = None
        for attempt in range(1, self.retries + 1):
            try:
                with urllib.request.urlopen(request, timeout=45) as response:
                    body = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.URLError as exc:
                last_error = exc
                if attempt >= self.retries:
                    cached = read_tushare_cache(api_name, payload)
                    if cached is not None:
                        print(f"{api_name} using cached response after network error: {exc}")
                        return cached
                    raise RuntimeError(f"Tushare request failed for {api_name}: {exc}") from exc
                time.sleep(self.retry_delay_ms / 1000 * attempt)
        else:
            raise RuntimeError(f"Tushare request failed for {api_name}: {last_error}")

        if body.get("code") != 0:
            cached = read_tushare_cache(api_name, payload)
            if cached is not None:
                print(f"{api_name} using cached response after Tushare error: {body.get('msg') or body}")
                return cached
            raise RuntimeError(f"Tushare {api_name} error: {body.get('msg') or body}")

        columns = body.get("data", {}).get("fields", [])
        items = body.get("data", {}).get("items", [])
        rows = [dict(zip(columns, item)) for item in items]
        write_tushare_cache(api_name, payload, rows)
        if self.sleep_ms > 0:
            time.sleep(self.sleep_ms / 1000)
        return rows


def latest_trade_date(client):
    end = datetime.now().strftime("%Y%m%d")
    start = (datetime.now() - timedelta(days=14)).strftime("%Y%m%d")
    rows = client.query(
        "trade_cal",
        {"exchange": "SSE", "start_date": start, "end_date": end, "is_open": "1"},
        "cal_date,is_open",
    )
    dates = sorted([str(row.get("cal_date")) for row in rows if str(row.get("is_open")) in ("1", "1.0")])
    if not dates:
        raise RuntimeError("Tushare trade_cal returned no open trading day in the last 14 days.")
    return dates[-1]


def fetch_stock_basic(client, max_stocks):
    try:
        rows = client.query(
            "stock_basic",
            {"exchange": "", "list_status": "L"},
            "ts_code,symbol,name,area,industry,market,list_date",
        )
        write_stock_basic_cache(rows)
    except RuntimeError as exc:
        print(f"stock_basic skipped: {exc}")
        rows = read_stock_basic_cache()
        if not rows:
            rows = fetch_public_stock_basic_fallback()
    filtered = [
        row
        for row in rows
        if is_mainland_common_stock(str(row.get("ts_code") or ""), str(row.get("name") or ""))
    ]
    filtered.sort(key=lambda row: str(row.get("ts_code") or ""))
    return filtered[:max_stocks]


def fetch_public_stock_basic_fallback():
    cached = read_public_stock_basic_cache()
    if len(cached) >= 4000:
        return cached

    rows = []
    for fs in EASTMONEY_STOCK_LIST_FS:
        total = None
        page_rows = []
        page = 1
        while total is None or len(page_rows) < total:
            try:
                request = urllib.request.Request(
                    EASTMONEY_STOCK_LIST_URL.format(page=page, fs=fs),
                    headers={
                        "User-Agent": "Mozilla/5.0",
                        "Referer": "https://quote.eastmoney.com/",
                    },
                    method="GET",
                )
                with urllib.request.urlopen(request, timeout=45) as response:
                    body = json.loads(response.read().decode("utf-8"))
            except (urllib.error.URLError, json.JSONDecodeError, OSError) as exc:
                print(f"public stock_basic fallback skipped: {exc}")
                if rows:
                    write_public_stock_basic_cache(rows)
                return cached or rows

            data = body.get("data") or {}
            items = data.get("diff") or []
            total = int(data.get("total") or len(page_rows) + len(items))
            if not items:
                break
            page_rows.extend(items)
            page += 1
            time.sleep(0.05)

        for item in page_rows:
            raw_code = str(item.get("f12") or "").strip()
            suffix = cn_suffix_for_symbol(raw_code)
            if not raw_code or not suffix:
                continue
            rows.append(
                {
                    "ts_code": f"{raw_code}.{suffix}",
                    "symbol": raw_code,
                    "name": str(item.get("f14") or raw_code),
                    "area": "",
                    "industry": str(item.get("f100") or ""),
                    "market": "",
                    "list_date": "",
                }
            )
    rows = normalize_public_basic_rows(rows)
    write_public_stock_basic_cache(rows)
    return rows


def build_basic_rows_from_daily(daily_rows, max_stocks):
    basic_cache = read_stock_basic_cache() or read_public_stock_basic_cache()
    cached = {
        str(row.get("ts_code") or ""): row
        for row in basic_cache
        if row.get("ts_code")
    }
    rows = []
    for code in sorted(daily_rows.keys()):
        cached_row = cached.get(code, {})
        name = str(cached_row.get("name") or code)
        if is_mainland_common_stock(code, name):
            rows.append(
                {
                    "ts_code": code,
                    "symbol": cached_row.get("symbol") or code.split(".", 1)[0],
                    "name": name,
                    "area": cached_row.get("area") or "",
                    "industry": cached_row.get("industry") or "",
                    "market": cached_row.get("market") or "",
                    "list_date": cached_row.get("list_date") or "",
                }
            )
    return rows[:max_stocks]


def fetch_daily_rows(client, trade_date):
    return index_by_code(
        client.query(
            "daily",
            {"trade_date": trade_date},
            "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
        )
    )


def fetch_daily_basic(client, trade_date):
    try:
        return index_by_code(
            client.query(
                "daily_basic",
                {"trade_date": trade_date},
                "ts_code,turnover_rate,turnover_rate_f,volume_ratio,pe,pe_ttm,pb,ps,ps_ttm,dv_ttm,total_mv,circ_mv",
            )
        )
    except RuntimeError as exc:
        print(f"daily_basic skipped: {exc}")
        return {}


def fetch_indices(client, trade_date):
    result = []
    fetch_all = os.getenv("CN_REVIEW_FETCH_ALL_INDICES", "0") == "1"
    active_codes = INDEX_CODES if fetch_all else INDEX_CODES[:1]
    empty_codes = [] if fetch_all else INDEX_CODES[1:]
    for code, name in active_codes:
        try:
            rows = client.query(
                "index_daily",
                {"ts_code": code, "trade_date": trade_date},
                "ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount",
            )
        except RuntimeError as exc:
            print(f"index_daily skipped for {code}: {exc}")
            rows = []
        if not rows:
            result.append({"code": code, "name": name, "lastPrice": 0, "changeRate": 0, "turnover": 0, "volume": 0})
            continue
        raw = rows[0]
        result.append(
            {
                "code": code,
                "name": name,
                "lastPrice": pick_number(raw, "close"),
                "change": pick_number(raw, "change"),
                "changeRate": pick_number(raw, "pct_chg"),
                "turnover": pick_number(raw, "amount") * 1000,
                "volume": pick_number(raw, "vol") * 100,
                "open": pick_number(raw, "open"),
                "high": pick_number(raw, "high"),
                "low": pick_number(raw, "low"),
                "prevClose": pick_number(raw, "pre_close"),
            }
        )
    for code, name in empty_codes:
        result.append({"code": code, "name": name, "lastPrice": 0, "changeRate": 0, "turnover": 0, "volume": 0})
    return result


def merge_stock_rows(basics, daily_rows, daily_basic):
    rows = []
    for basic in basics:
        code = str(basic.get("ts_code") or "")
        daily = daily_rows.get(code)
        if not daily:
            continue
        valuation = daily_basic.get(code, {})
        name = str(basic.get("name") or code)
        industry = str(basic.get("industry") or "")
        rows.append(
            {
                "code": code,
                "ticker": code,
                "name": name,
                "industry": industry,
                "area": str(basic.get("area") or ""),
                "market": str(basic.get("market") or ""),
                "lastPrice": pick_number(daily, "close"),
                "change": pick_number(daily, "change"),
                "changeRate": pick_number(daily, "pct_chg"),
                "volume": pick_number(daily, "vol") * 100,
                "turnover": pick_number(daily, "amount") * 1000,
                "turnoverRate": pick_number(valuation, "turnover_rate"),
                "volumeRatio": pick_number(valuation, "volume_ratio"),
                "amplitude": estimate_amplitude(daily),
                "open": pick_number(daily, "open"),
                "high": pick_number(daily, "high"),
                "low": pick_number(daily, "low"),
                "prevClose": pick_number(daily, "pre_close"),
                "marketVal": pick_number(valuation, "total_mv") * 10000,
                "circMarketVal": pick_number(valuation, "circ_mv") * 10000,
                "peTtm": pick_number(valuation, "pe_ttm"),
                "pb": pick_number(valuation, "pb"),
                "psTtm": pick_number(valuation, "ps_ttm"),
                "dividendRatioTtm": pick_number(valuation, "dv_ttm"),
                "theme": infer_theme(name, industry),
            }
        )
    return rows


def build_review(generated_at, trade_date, rows, indices, max_stocks):
    advancers = [row for row in rows if row["changeRate"] > 0]
    decliners = [row for row in rows if row["changeRate"] < 0]
    flat = len(rows) - len(advancers) - len(decliners)
    limit_up = [row for row in rows if row["changeRate"] >= limit_threshold(row["code"]) - 0.05]
    limit_down = [row for row in rows if row["changeRate"] <= -limit_threshold(row["code"]) + 0.05]
    total_turnover = sum(row["turnover"] for row in rows)
    median_change = median([row["changeRate"] for row in rows])
    up_ratio = len(advancers) / max(len(rows), 1)
    emotion_score = clamp(
        up_ratio * 45
        + min(len(limit_up) / 80, 1) * 20
        + min(total_turnover / 1_000_000_000_000, 1) * 20
        + (10 if median_change > 0 else 0)
        - min(len(limit_down) / 40, 1) * 15,
        0,
        100,
    )
    themes = build_themes(rows)
    leaders = sorted(rows, key=lambda row: (row["changeRate"], row["turnover"]), reverse=True)[:20]
    laggards = sorted(rows, key=lambda row: (row["changeRate"], -row["turnover"]))[:20]
    active = sorted(rows, key=lambda row: row["turnover"], reverse=True)[:30]
    summary = {
        "reviewDate": trade_date_to_iso(trade_date),
        "tradeDate": trade_date,
        "stockCoverage": len(rows),
        "maxStocks": max_stocks,
        "advancers": len(advancers),
        "decliners": len(decliners),
        "flat": flat,
        "upRatio": round(up_ratio, 4),
        "limitUp": len(limit_up),
        "limitDown": len(limit_down),
        "totalTurnover": round(total_turnover),
        "medianChangeRate": round(median_change, 4),
        "emotionScore": round(emotion_score),
        "marketState": classify_market(emotion_score, up_ratio, len(limit_up), len(limit_down)),
    }
    return {
        "generatedAt": generated_at,
        "source": "tushare_cn_review",
        "framework": [
            "指数结构：观察上证、沪深300、中证500、中证1000和创业板是否同向。",
            "市场宽度：用上涨家数、下跌家数、涨跌停和中位数涨跌幅确认赚钱效应。",
            "量能承接：用全市场成交额和高成交额股票确认资金活跃度。",
            "板块主线：按行业/主题聚合涨幅、成交额和涨停数量，区分主线、轮动和一日游。",
            "次日计划：把仓位、确认信号、风险线和观察名单写成可执行清单。",
        ],
        "summary": summary,
        "indices": indices,
        "themes": themes,
        "leaders": leaders,
        "laggards": laggards,
        "activeTurnover": active,
        "playbook": build_playbook(summary, themes, indices),
        "dataGaps": build_data_gaps(rows),
    }


def build_themes(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row.get("theme") or "其他"].append(row)

    themes = []
    for theme, items in grouped.items():
        if len(items) < 5 and theme == "其他":
            continue
        turnover = sum(row["turnover"] for row in items)
        avg_change = weighted_average(items, "changeRate", "turnover")
        breadth = len([row for row in items if row["changeRate"] > 0]) / max(len(items), 1)
        limit_up = len([row for row in items if row["changeRate"] >= limit_threshold(row["code"]) - 0.05])
        leaders = sorted(items, key=lambda row: (row["changeRate"], row["turnover"]), reverse=True)[:5]
        heat = clamp((avg_change + 3) * 8 + breadth * 30 + min(turnover / 80_000_000_000, 1) * 25 + limit_up * 2, 0, 100)
        themes.append(
            {
                "theme": theme,
                "stockCount": len(items),
                "averageChangeRate": round(avg_change, 4),
                "breadth": round(breadth, 4),
                "limitUp": limit_up,
                "turnover": round(turnover),
                "heatScore": round(heat),
                "leaders": leaders,
            }
        )
    return sorted(themes, key=lambda item: item["heatScore"], reverse=True)


def build_playbook(summary, themes, indices):
    top_theme = themes[0] if themes else {}
    market_state = summary.get("marketState", "中性震荡")
    if summary["emotionScore"] >= 70:
        position = "市场热度偏强，可以围绕主线做进攻，但只追确认后的强势股。"
    elif summary["emotionScore"] >= 45:
        position = "市场处在可交易区间，适合小仓位跟踪主线，等待指数和量能进一步确认。"
    else:
        position = "市场宽度偏弱，仓位以防守为主，只保留最强主题的观察单。"

    confirmations = [
        f"全市场上涨占比达到 {summary['upRatio'] * 100:.1f}%。",
        f"涨停 {summary['limitUp']} 家，跌停 {summary['limitDown']} 家。",
        f"成交额约 {format_cn_money(summary['totalTurnover'])}。",
    ]
    if top_theme:
        confirmations.append(
            f"最强主题是 {top_theme['theme']}，热度 {top_theme['heatScore']}，成交额 {format_cn_money(top_theme['turnover'])}。"
        )

    risks = []
    if summary["medianChangeRate"] < 0:
        risks.append("中位数涨跌幅为负，指数上涨也可能只是权重托盘。")
    if summary["limitDown"] > max(summary["limitUp"] * 0.6, 20):
        risks.append("跌停数量偏多，短线风险偏好仍需观察。")
    weak_indices = [row["name"] for row in indices if row.get("changeRate", 0) < -0.5]
    if weak_indices:
        risks.append(f"{'、'.join(weak_indices[:3])} 仍在走弱，注意指数背离。")
    if not risks:
        risks.append("最大风险是缩量冲高回落，强主题次日需要继续放量。")

    watchlist = []
    for theme in themes[:3]:
        watchlist.extend(theme.get("leaders", [])[:3])
    deduped = dedupe_rows(watchlist)[:10]
    headline = f"{trade_state_prefix(summary)}：{market_state}，主线看 {top_theme.get('theme', '暂无明确主题')}"
    return {
        "headline": headline,
        "position": position,
        "confirmations": confirmations,
        "risks": risks,
        "watchlist": deduped,
    }


def build_strategy_candidates(report, rows):
    summary = report.get("summary", {})
    theme_rank = {item["theme"]: index for index, item in enumerate(report.get("themes", []))}
    candidates = []
    liquid_rows = [row for row in rows if row["turnover"] >= 100_000_000 and row["lastPrice"] > 0]
    for row in liquid_rows:
        change = row["changeRate"]
        turnover_score = clamp(math.log10(max(row["turnover"], 1) / 100_000_000 + 1) * 22, 0, 30)
        theme_score = clamp(30 - theme_rank.get(row.get("theme"), 8) * 4, 0, 30)
        strength_score = clamp((change + 5) * 5, 0, 30)
        valuation_score = valuation_score_for(row)
        risk_penalty = risk_penalty_for(row)
        total = clamp(turnover_score + theme_score + strength_score + valuation_score - risk_penalty, 0, 100)
        candidates.append(strategy_row(row, total, turnover_score, theme_score, strength_score, valuation_score, risk_penalty, summary))

    candidates.sort(key=lambda item: (item["totalScore"], item["turnover"], item["changeRate"]), reverse=True)
    limit = int(os.getenv("CN_REVIEW_STRATEGY_LIMIT", "10"))
    for index, item in enumerate(candidates):
        item["selected"] = index < min(limit, 10)
    return candidates[:limit]


def strategy_row(row, total, turnover_score, theme_score, strength_score, valuation_score, risk_penalty, summary):
    price = row["lastPrice"]
    change = row["changeRate"]
    high = row.get("high") or price
    low = row.get("low") or price
    distance_to_high = (price - high) / high * 100 if high else 0
    entry_low = round(max(low, price * 0.985), 2)
    entry_high = round(price * 1.015, 2)
    stop_loss = round(min(low * 0.985, price * 0.94), 2)
    take_profit = round(price * (1.08 if total >= 75 else 1.05), 2)
    signal = "红灯" if total >= 78 and change > 1 else "黄灯" if total >= 60 else "灰灯"
    stock_state = "强势放量" if change >= 3 and row["turnover"] >= 500_000_000 else "趋势观察" if change >= 0 else "弱势修复"
    buy_type = "放量突破" if change >= 3 else "强势回踩" if change >= 0 else "只观察不追"
    grade = "B1" if total >= 80 else "B2" if total >= 70 else "B3" if total >= 60 else "C"
    action = "可小仓试错" if total >= 75 else "等确认" if total >= 60 else "观察"
    quality = "高" if total >= 80 else "中" if total >= 60 else "低"
    rating = "A-" if total >= 82 else "B+" if total >= 72 else "B" if total >= 62 else "C"
    risk_flags = []
    if row.get("peTtm", 0) > 80:
        risk_flags.append("PE TTM 偏高，需要确认盈利预期能否兑现。")
    if change >= limit_threshold(row["code"]) - 0.05:
        risk_flags.append("接近涨停，次日若不能继续放量容易分歧。")
    if row.get("turnoverRate", 0) > 20:
        risk_flags.append("换手率过高，短线筹码波动会放大。")
    if not risk_flags:
        risk_flags.append("未看到明显财务估值字段异常，但仍需结合公告和行业新闻确认。")

    return {
        **row,
        "signalLight": signal,
        "stockState": stock_state,
        "pivotStage": "日内强势" if change >= 3 else "趋势观察",
        "buyPointType": buy_type,
        "buyPointGrade": grade,
        "actionState": action,
        "buyPointQuality": quality,
        "commentScore": round((theme_score + strength_score + valuation_score) / 3, 1),
        "rating": rating,
        "selected": False,
        "totalScore": round(total, 1),
        "rs": round(strength_score * 3.3, 1),
        "pivotScore": round(clamp(100 + distance_to_high, 0, 100), 1),
        "distanceToPivotPct": round(distance_to_high, 2),
        "financialQuality": financial_quality(row),
        "earlyVcp": "缺少历史K线，待二次确认",
        "turnoverScore": round(turnover_score, 1),
        "themeScore": round(theme_score, 1),
        "strengthScore": round(strength_score, 1),
        "valuationScore": round(valuation_score, 1),
        "riskPenalty": round(risk_penalty, 1),
        "technical": {
            "ma20": 0,
            "ma60": 0,
            "rsi14": 50,
            "macdHist": 0,
            "volumeRatio": row.get("volumeRatio") or 0,
            "atr14": round(max(high - low, price * 0.03), 2),
            "pivot": high,
            "distanceToPivotPct": round(distance_to_high, 2),
        },
        "strategyDecision": {
            "decision": action,
            "marketRegime": summary.get("marketState", "-"),
            "entryZone": {"low": entry_low, "high": entry_high},
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
            "positionWeightPct": 3 if total >= 80 else 2 if total >= 70 else 1,
            "scores": {
                "newsTheme": round(theme_score, 1),
                "technical": round(strength_score, 1),
                "buyPoint": round(turnover_score, 1),
                "market": summary.get("emotionScore", 0),
                "riskPenalty": round(risk_penalty, 1),
            },
            "buyConditions": [
                f"股价站稳 {entry_low} - {entry_high} 区间，且成交额继续保持在 {format_cn_money(row['turnover'] * 0.8)} 以上。",
                f"所属主题 {row.get('theme')} 继续位于强势主题榜前列。",
                "指数不出现放量长阴，市场宽度维持在可交易区间。",
            ],
            "sellConditions": [
                f"跌破 {stop_loss} 或跌破当日低点后无法收回。",
                "主题热度跌出前列，且个股放量滞涨。",
                f"达到 {take_profit} 附近但成交额不能继续放大时分批兑现。",
            ],
            "riskFlags": risk_flags,
            "invalidation": f"如果次日跌破 {stop_loss} 且主题退潮，本次观察逻辑失效。",
        },
    }


def build_data_gaps(rows):
    gaps = [
        "Tushare 日线接口不包含实时盘口，A股复盘默认用于盘后研究。",
        "当前策略候选使用日线快照、行业、成交额和估值字段；如需 VCP/均线/RSI 的严格判定，需要额外拉取历史K线扩展。",
    ]
    missing_basic = len([row for row in rows if not row.get("peTtm") and not row.get("marketVal")])
    if missing_basic:
        gaps.append(f"{missing_basic} 只股票缺少 daily_basic 估值字段，可能由 Tushare 权限或当日数据缺口造成。")
    return gaps


def build_markdown(report):
    summary = report["summary"]
    lines = [
        "# A股全面复盘",
        "",
        f"- 数据源：Tushare",
        f"- 交易日：{summary.get('reviewDate')}",
        f"- 生成时间：{report.get('generatedAt')}",
        f"- 市场状态：{summary.get('marketState')}，情绪温度 {summary.get('emotionScore')}/100",
        f"- 上涨/下跌：{summary.get('advancers')} / {summary.get('decliners')}，涨停/跌停：{summary.get('limitUp')} / {summary.get('limitDown')}",
        f"- 全市场成交额：{format_cn_money(summary.get('totalTurnover'))}",
        "",
        "## 指数结构",
        "",
    ]
    for row in report.get("indices", []):
        lines.append(f"- {row.get('name')}：{format_signed_pct(row.get('changeRate'))}，成交额 {format_cn_money(row.get('turnover'))}")
    lines.extend(["", "## 主线主题", ""])
    for theme in report.get("themes", [])[:8]:
        leaders = " / ".join(f"{row.get('name')} {format_signed_pct(row.get('changeRate'))}" for row in theme.get("leaders", [])[:3])
        lines.append(
            f"- {theme.get('theme')}：热度 {theme.get('heatScore')}，均涨幅 {format_signed_pct(theme.get('averageChangeRate'))}，上涨占比 {theme.get('breadth', 0) * 100:.1f}%，成交额 {format_cn_money(theme.get('turnover'))}。{leaders}"
        )
    lines.extend(["", "## 次日计划", "", report.get("playbook", {}).get("position", "")])
    for key, title in (("confirmations", "确认信号"), ("risks", "风险线")):
        lines.extend(["", f"### {title}", ""])
        for item in report.get("playbook", {}).get(key, []):
            lines.append(f"- {item}")
    lines.extend(["", "## 策略候选", ""])
    for row in report.get("strategyCandidates", [])[:10]:
        decision = row.get("strategyDecision", {})
        lines.append(
            f"- {row.get('code')} {row.get('name')}：{row.get('theme')}，评分 {row.get('totalScore')}，动作 {decision.get('decision')}，入场 {decision.get('entryZone', {}).get('low')} - {decision.get('entryZone', {}).get('high')}，止损 {decision.get('stopLoss')}，目标 {decision.get('takeProfit')}。"
        )
    lines.extend(["", "## 数据缺口", ""])
    for item in report.get("dataGaps", []):
        lines.append(f"- {item}")
    return "\n".join(lines) + "\n"


def build_html(markdown):
    body = []
    for line in markdown.splitlines():
        if line.startswith("# "):
            body.append(f"<h1>{escape_html(line[2:])}</h1>")
        elif line.startswith("## "):
            body.append(f"<h2>{escape_html(line[3:])}</h2>")
        elif line.startswith("### "):
            body.append(f"<h3>{escape_html(line[4:])}</h3>")
        elif line.startswith("- "):
            body.append(f"<p>{escape_html(line)}</p>")
        elif line.strip():
            body.append(f"<p>{escape_html(line)}</p>")
    return (
        "<!doctype html><html><head><meta charset='utf-8'><title>A股全面复盘</title>"
        "<style>body{font-family:Arial,'Microsoft YaHei',sans-serif;max-width:980px;margin:40px auto;line-height:1.75;color:#17211d}"
        "h1{font-size:30px}h2{margin-top:28px}p{margin:6px 0}</style></head><body>"
        + "\n".join(body)
        + "</body></html>"
    )


def is_mainland_common_stock(code, name):
    if is_special_treatment_stock(name):
        return False
    if code.endswith(".SH"):
        return code.startswith(("600", "601", "603", "605", "688"))
    if code.endswith(".SZ"):
        return code.startswith(("000", "001", "002", "003", "300"))
    return False


def cn_suffix_for_symbol(symbol):
    text = str(symbol or "")
    if text.startswith(("600", "601", "603", "605", "688")):
        return "SH"
    if text.startswith(("000", "001", "002", "003", "300", "301")):
        return "SZ"
    return ""


def is_special_treatment_stock(name):
    text = str(name or "").upper().replace(" ", "")
    return "ST" in text or text.startswith("*") or "退" in text or "摘牌" in text


def infer_theme(name, industry):
    text = f"{name or ''}{industry or ''}"
    for theme, keywords in THEME_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return theme
    return industry or "其他"


def limit_threshold(code):
    if str(code).startswith(("300", "688")):
        return 19.8
    return 9.8


def valuation_score_for(row):
    pe = row.get("peTtm") or 0
    if pe <= 0:
        return 8
    if pe < 25:
        return 14
    if pe < 55:
        return 10
    if pe < 90:
        return 5
    return 0


def risk_penalty_for(row):
    penalty = 0
    if row.get("turnoverRate", 0) > 25:
        penalty += 8
    if row.get("peTtm", 0) > 100:
        penalty += 8
    if row.get("changeRate", 0) < -2:
        penalty += 10
    if row.get("marketVal", 0) and row["marketVal"] < 3_000_000_000:
        penalty += 5
    return penalty


def financial_quality(row):
    pe = row.get("peTtm") or 0
    market_val = row.get("marketVal") or 0
    if pe > 0 and pe < 35 and market_val >= 20_000_000_000:
        return "估值较稳"
    if pe > 80:
        return "预期偏高"
    if market_val and market_val < 5_000_000_000:
        return "小市值波动"
    return "待跟踪"


def classify_market(score, up_ratio, limit_up, limit_down):
    if score >= 72 and up_ratio >= 0.58:
        return "强势进攻"
    if score >= 55:
        return "结构性机会"
    if score >= 40 and limit_down <= max(limit_up, 20):
        return "中性震荡"
    return "防守观察"


def trade_state_prefix(summary):
    if summary.get("emotionScore", 0) >= 70:
        return "情绪升温"
    if summary.get("emotionScore", 0) >= 45:
        return "结构轮动"
    return "风险偏弱"


def index_by_code(rows):
    return {str(row.get("ts_code") or ""): row for row in rows if row.get("ts_code")}


def tushare_cache_path(api_name, payload):
    cache_input = json.dumps(
        {
            "api_name": api_name,
            "params": payload.get("params") or {},
            "fields": payload.get("fields") or "",
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    digest = hashlib.sha1(cache_input.encode("utf-8")).hexdigest()[:16]
    return CACHE_DIR / f"{api_name}-{digest}.json"


def read_tushare_cache(api_name, payload):
    path = tushare_cache_path(api_name, payload)
    if not path.exists():
        return None
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        return cached.get("rows", [])
    except (OSError, json.JSONDecodeError):
        return None


def write_tushare_cache(api_name, payload, rows):
    path = tushare_cache_path(api_name, payload)
    data = {
        "apiName": api_name,
        "cachedAt": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_stock_basic_cache():
    if not BASIC_CACHE_PATH.exists():
        return []
    try:
        cached = json.loads(BASIC_CACHE_PATH.read_text(encoding="utf-8-sig"))
        rows = cached.get("rows", [])
        return rows if isinstance(rows, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_stock_basic_cache(rows):
    data = {
        "cachedAt": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
    }
    BASIC_CACHE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_public_stock_basic_cache():
    if not PUBLIC_BASIC_CACHE_PATH.exists():
        return []
    try:
        cached = json.loads(PUBLIC_BASIC_CACHE_PATH.read_text(encoding="utf-8-sig"))
        rows = cached.get("rows", [])
        return normalize_public_basic_rows(rows) if isinstance(rows, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def write_public_stock_basic_cache(rows):
    rows = normalize_public_basic_rows(rows)
    data = {
        "cachedAt": datetime.now(timezone.utc).isoformat(),
        "source": "eastmoney_public_stock_list",
        "rows": rows,
    }
    PUBLIC_BASIC_CACHE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_public_basic_rows(rows):
    result = {}
    for row in rows or []:
        symbol = str(row.get("symbol") or row.get("ts_code") or "").split(".", 1)[0]
        suffix = cn_suffix_for_symbol(symbol)
        if not symbol or not suffix:
            continue
        code = f"{symbol}.{suffix}"
        result[code] = {
            "ts_code": code,
            "symbol": symbol,
            "name": str(row.get("name") or symbol),
            "area": str(row.get("area") or ""),
            "industry": str(row.get("industry") or ""),
            "market": str(row.get("market") or ""),
            "list_date": str(row.get("list_date") or ""),
        }
    return [result[key] for key in sorted(result)]


def pick_number(row, *keys):
    for key in keys:
        value = row.get(key) if isinstance(row, dict) else None
        if value in (None, "", "None"):
            continue
        try:
            number = float(value)
            if math.isnan(number) or math.isinf(number):
                return 0
            return number
        except (TypeError, ValueError):
            continue
    return 0


def estimate_amplitude(row):
    high = pick_number(row, "high")
    low = pick_number(row, "low")
    prev = pick_number(row, "pre_close")
    if not prev:
        return 0
    return (high - low) / prev * 100


def median(values):
    cleaned = [value for value in values if isinstance(value, (int, float))]
    return round(statistics.median(cleaned), 4) if cleaned else 0


def weighted_average(rows, value_key, weight_key):
    total_weight = sum(max(row.get(weight_key, 0), 0) for row in rows)
    if total_weight <= 0:
        return median([row.get(value_key, 0) for row in rows])
    return sum(row.get(value_key, 0) * max(row.get(weight_key, 0), 0) for row in rows) / total_weight


def clamp(value, low, high):
    return max(low, min(high, value))


def dedupe_rows(rows):
    seen = set()
    result = []
    for row in rows:
        code = row.get("code")
        if code in seen:
            continue
        seen.add(code)
        result.append(row)
    return result


def format_cn_money(value):
    number = float(value or 0)
    if number >= 1_0000_0000_0000:
        return f"{number / 1_0000_0000_0000:.2f}万亿"
    if number >= 1_0000_0000:
        return f"{number / 1_0000_0000:.2f}亿"
    if number >= 1_0000:
        return f"{number / 1_0000:.2f}万"
    return f"{number:.0f}"


def format_signed_pct(value):
    number = float(value or 0)
    return f"{number:+.2f}%"


def trade_date_to_iso(trade_date):
    text = str(trade_date)
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"


def escape_html(text):
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


if __name__ == "__main__":
    main()
