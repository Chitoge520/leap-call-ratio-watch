import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUTU_APPDATA = os.getenv("FUTU_APPDATA") or str(ROOT / ".futu-appdata")
os.environ["APPDATA"] = FUTU_APPDATA
os.environ["appdata"] = FUTU_APPDATA

try:
    from futu import AuType, KLType, Market, OpenQuoteContext, RET_OK, SecurityType
except ImportError as exc:
    raise SystemExit("Missing futu-api. Install it with: pip install -r requirements-futu.txt") from exc


DATA_DIR = ROOT / "data"
REPORTS_DIR = ROOT / "reports"
INDEX_CODES = [
    ("SH.000001", "上证指数"),
    ("SH.000300", "沪深300"),
    ("SH.000905", "中证500"),
    ("SH.000852", "中证1000"),
    ("SZ.399001", "深证成指"),
    ("SZ.399006", "创业板指"),
]

THEME_KEYWORDS = {
    "AI/算力": ["算力", "人工智能", "智能", "数据", "云", "软件", "信息", "科技"],
    "半导体": ["半导体", "芯片", "微电", "集成", "电子", "光电"],
    "新能源": ["新能源", "锂", "电池", "光伏", "储能", "风电", "太阳"],
    "机器人/高端制造": ["机器人", "自动化", "精密", "数控", "工业", "机电", "装备"],
    "消费": ["消费", "食品", "饮料", "酒", "旅游", "酒店", "家居", "医美"],
    "医药": ["医药", "生物", "医疗", "药业", "制药", "健康"],
    "金融地产": ["银行", "证券", "保险", "地产", "金融", "信托"],
    "资源周期": ["煤", "钢", "有色", "矿", "石油", "化工", "稀土", "黄金"],
    "军工": ["军工", "航天", "航空", "兵器", "船舶", "卫星"],
}


def main():
    load_dotenv(ROOT / ".env")
    DATA_DIR.mkdir(exist_ok=True)
    REPORTS_DIR.mkdir(exist_ok=True)
    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    max_stocks = int(os.getenv("CN_REVIEW_MAX_STOCKS", "5000"))

    quote_ctx = OpenQuoteContext(host=host, port=port)
    try:
        symbols = build_cn_universe(quote_ctx, max_stocks)
        snapshots = fetch_snapshots(quote_ctx, [item["code"] for item in symbols])
        indices = fetch_snapshots(quote_ctx, [code for code, _ in INDEX_CODES], keep_failed=True)
        rows = [merge_symbol_snapshot(item, snapshots.get(item["code"], {})) for item in symbols]
        rows = [
            row
            for row in rows
            if not is_special_treatment_stock(row.get("name"))
            and (row["lastPrice"] > 0 or row["turnover"] > 0 or row["volume"] > 0)
        ]
        generated_at = datetime.now(timezone.utc).isoformat()
        report = build_review(generated_at, rows, indices, max_stocks)
        report["strategyCandidates"] = build_strategy_candidates(quote_ctx, report, rows)
    finally:
        quote_ctx.close()

    date_stamp = generated_at[:10]
    markdown = build_markdown(report)
    html = build_html(markdown)
    (DATA_DIR / "latest-cn-review.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (REPORTS_DIR / f"{date_stamp}-cn-market-review.md").write_text(markdown, encoding="utf-8")
    (REPORTS_DIR / f"{date_stamp}-cn-market-review.html").write_text(html, encoding="utf-8")
    print(f"A-share review generated: {len(rows)} stocks, {len(report['themes'])} themes.")


def build_cn_universe(quote_ctx, max_stocks):
    rows = []
    for market in (Market.SH, Market.SZ):
        ret, data = quote_ctx.get_stock_basicinfo(market, SecurityType.STOCK)
        if ret != RET_OK:
            raise RuntimeError(f"get_stock_basicinfo {market} failed: {data}")
        for item in to_records(data):
            code = str(item.get("code") or "").upper()
            name = str(item.get("name") or code)
            if is_mainland_common_stock(code, name):
                rows.append({"code": code, "name": name})
    rows.sort(key=lambda item: item["code"])
    return rows[:max_stocks]


def is_mainland_common_stock(code, name):
    if is_special_treatment_stock(name):
        return False
    if code.startswith("SH."):
        body = code.split(".", 1)[1]
        return body.startswith(("600", "601", "603", "605", "688"))
    if code.startswith("SZ."):
        body = code.split(".", 1)[1]
        return body.startswith(("000", "001", "002", "003", "300"))
    return False


def is_special_treatment_stock(name):
    text = str(name or "").upper().replace(" ", "")
    return (
        "ST" in text
        or text.startswith("*")
        or "退" in text
        or "退市" in text
        or "摘牌" in text
    )


def fetch_snapshots(quote_ctx, codes, keep_failed=False):
    result = {}
    batch_size = int(os.getenv("CN_REVIEW_SNAPSHOT_BATCH", "300"))
    for start in range(0, len(codes), batch_size):
        batch = codes[start : start + batch_size]
        if not batch:
            continue
        ret, data = quote_ctx.get_market_snapshot(batch)
        if ret != RET_OK:
            if keep_failed:
                continue
            raise RuntimeError(f"get_market_snapshot failed: {data}")
        for row in to_records(data):
            code = str(row.get("code") or "").upper()
            if code:
                result[code] = row
    return result


def merge_symbol_snapshot(item, raw):
    change_rate = pick_number(raw, "change_rate", "changeRatio", "change_rate_5min")
    last_price = pick_number(raw, "last_price", "cur_price", "price")
    prev_close = pick_number(raw, "prev_close_price", "prev_close")
    change = pick_number(raw, "change_price", "change")
    if not change and last_price and prev_close:
        change = last_price - prev_close
    if not change_rate and last_price and prev_close:
        change_rate = (last_price - prev_close) / prev_close * 100
    turnover = pick_number(raw, "turnover", "turnover_rate")
    if turnover and turnover < 100:
        turnover = pick_number(raw, "turnover")
    return {
        "code": item["code"],
        "ticker": item["code"],
        "name": item["name"],
        "lastPrice": last_price,
        "change": change,
        "changeRate": change_rate,
        "volume": pick_number(raw, "volume"),
        "turnover": turnover,
        "turnoverRate": pick_number(raw, "turnover_rate"),
        "amplitude": pick_number(raw, "amplitude"),
        "high": pick_number(raw, "high_price", "high"),
        "low": pick_number(raw, "low_price", "low"),
        "open": pick_number(raw, "open_price", "open"),
        "prevClose": prev_close,
        "marketVal": pick_number(raw, "total_market_val", "market_val", "market_value"),
        "peTtm": pick_number(raw, "pe_ttm_ratio", "pe_ttm", "peTTM"),
        "dividendRatioTtm": pick_number(raw, "dividend_ratio_ttm"),
        "theme": infer_theme(item["name"]),
    }


def build_review(generated_at, rows, index_raw, max_stocks):
    advancers = [row for row in rows if row["changeRate"] > 0]
    decliners = [row for row in rows if row["changeRate"] < 0]
    flat = len(rows) - len(advancers) - len(decliners)
    limit_up = [row for row in rows if row["changeRate"] >= limit_threshold(row["code"])]
    limit_down = [row for row in rows if row["changeRate"] <= -limit_threshold(row["code"])]
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
    indices = build_indices(index_raw)
    summary = {
        "reviewDate": generated_at[:10],
        "stockCoverage": len(rows),
        "maxStocks": max_stocks,
        "advancers": len(advancers),
        "decliners": len(decliners),
        "flat": flat,
        "upRatio": round(up_ratio, 4),
        "limitUp": len(limit_up),
        "limitDown": len(limit_down),
        "totalTurnover": total_turnover,
        "medianChangeRate": median_change,
        "emotionScore": round(emotion_score),
        "marketState": classify_market(emotion_score, up_ratio, len(limit_up), len(limit_down)),
    }
    playbook = build_playbook(summary, themes, indices)
    return {
        "generatedAt": generated_at,
        "source": "futu_cn_review",
        "framework": [
            "指数结构：看主要宽基指数是否同向，识别大小盘和成长/价值风格。",
            "市场宽度：看上涨家数、下跌家数、涨跌停和中位数涨跌幅。",
            "量能承接：用全市场成交额和高成交额股票确认资金活跃度。",
            "板块主线：按主题聚合涨幅、成交额和涨停数量，区分主线、轮动和一日游。",
            "次日计划：把仓位、确认信号、风险线和观察名单写成可执行清单。",
        ],
        "summary": summary,
        "indices": indices,
        "themes": themes,
        "leaders": leaders,
        "laggards": laggards,
        "activeTurnover": active,
        "limitUpLeaders": sorted(limit_up, key=lambda row: row["turnover"], reverse=True)[:30],
        "limitDownLeaders": sorted(limit_down, key=lambda row: row["turnover"], reverse=True)[:30],
        "playbook": playbook,
        "strategyFieldLegend": build_strategy_field_legend(),
        "dataGaps": build_data_gaps(rows, index_raw),
    }


def build_indices(index_raw):
    rows = []
    name_map = dict(INDEX_CODES)
    for code, name in INDEX_CODES:
        raw = index_raw.get(code, {})
        last_price = pick_number(raw, "last_price", "cur_price", "price")
        prev_close = pick_number(raw, "prev_close_price", "prev_close")
        change = pick_number(raw, "change_price", "change")
        change_rate = pick_number(raw, "change_rate", "changeRatio")
        if not change and last_price and prev_close:
            change = last_price - prev_close
        if not change_rate and last_price and prev_close:
            change_rate = (last_price - prev_close) / prev_close * 100
        rows.append({
            "code": code,
            "name": name_map.get(code, name),
            "lastPrice": last_price,
            "change": change,
            "changeRate": change_rate,
            "turnover": pick_number(raw, "turnover"),
            "volume": pick_number(raw, "volume"),
        })
    return rows


def build_themes(rows):
    buckets = {}
    for row in rows:
        theme = row["theme"]
        bucket = buckets.setdefault(theme, {"theme": theme, "count": 0, "advancers": 0, "limitUp": 0, "turnover": 0, "changes": [], "leaders": []})
        bucket["count"] += 1
        bucket["advancers"] += 1 if row["changeRate"] > 0 else 0
        bucket["limitUp"] += 1 if row["changeRate"] >= limit_threshold(row["code"]) else 0
        bucket["turnover"] += row["turnover"]
        bucket["changes"].append(row["changeRate"])
        bucket["leaders"].append(row)
    themes = []
    for bucket in buckets.values():
        avg_change = sum(bucket["changes"]) / max(len(bucket["changes"]), 1)
        breadth = bucket["advancers"] / max(bucket["count"], 1)
        heat = avg_change * 6 + breadth * 35 + min(bucket["turnover"] / 120_000_000_000, 1) * 25 + min(bucket["limitUp"] / 8, 1) * 25
        leaders = sorted(bucket["leaders"], key=lambda row: (row["changeRate"], row["turnover"]), reverse=True)[:6]
        themes.append({
            "theme": bucket["theme"],
            "count": bucket["count"],
            "advancers": bucket["advancers"],
            "breadth": round(breadth, 4),
            "averageChangeRate": avg_change,
            "limitUp": bucket["limitUp"],
            "turnover": bucket["turnover"],
            "heatScore": round(clamp(heat, 0, 100)),
            "leaders": leaders,
        })
    return sorted(themes, key=lambda item: (item["heatScore"], item["turnover"]), reverse=True)


def build_playbook(summary, themes, indices):
    top_theme = themes[0]["theme"] if themes else "未识别"
    state = summary["marketState"]
    if summary["emotionScore"] >= 70:
        position = "积极复盘强主线，但次日只追确认后的核心票，避免后排补涨。"
    elif summary["emotionScore"] >= 45:
        position = "中性仓位，优先低吸主线核心和高辨识度回踩，少做杂毛轮动。"
    else:
        position = "防守为主，降低交易频率，等待指数止跌和上涨家数修复。"
    return {
        "headline": f"{state}，主线线索集中在 {top_theme}",
        "position": position,
        "confirmations": [
            "上涨家数继续超过下跌家数，且中位数涨跌幅不转负。",
            "领涨主题成交额保持前列，核心股没有高开低走放量回落。",
            "宽基指数至少有两个同步走强，避免只有小票情绪孤立发酵。",
        ],
        "risks": [
            "涨停数量增加但全市场上涨家数下降，说明情绪抱团而非赚钱效应扩散。",
            "高成交额个股集中在跌幅榜，说明资金在兑现而不是进攻。",
            "指数走强但中位数涨跌幅为负，属于权重护盘，复盘应降级。",
        ],
        "watchlist": [row for theme in themes[:3] for row in theme.get("leaders", [])[:3]][:9],
    }


def build_strategy_candidates(quote_ctx, report, rows):
    output_limit = int(os.getenv("CN_REVIEW_STRATEGY_LIMIT", "10"))
    technical_limit = int(os.getenv("CN_REVIEW_STRATEGY_TECHNICAL_LIMIT", "1000"))
    dividend_excluded = [row for row in rows if is_dividend_style_stock(row)]
    eligible = [
        row
        for row in rows
        if not is_dividend_style_stock(row)
        and row.get("lastPrice", 0) > 0
        and (row.get("turnover", 0) > 0 or row.get("volume", 0) > 0)
    ]
    ranked_pool = sorted(eligible, key=preliminary_strategy_score, reverse=True)
    technical_pool = ranked_pool[:technical_limit] if technical_limit > 0 else ranked_pool
    candidates = []
    index_change = average([row.get("changeRate", 0) for row in report.get("indices", []) if row.get("changeRate") is not None])
    market_score = report.get("summary", {}).get("emotionScore", 0)
    for row in technical_pool:
        kline = fetch_daily_kline(quote_ctx, row["code"], 90)
        technical = compute_technical(row, kline, index_change)
        candidate = score_strategy_candidate(row, technical, market_score)
        candidates.append(candidate)
    report["strategyScan"] = {
        "mode": "full_market_snapshot_then_technical_rank",
        "universeCount": len(rows),
        "eligibleCount": len(eligible),
        "technicalScoredCount": len(candidates),
        "technicalLimit": technical_limit,
        "outputLimit": output_limit,
        "excludedDividendStyleCount": len(dividend_excluded),
        "excludedNoQuoteCount": len(rows) - len(dividend_excluded) - len(eligible),
    }
    return sorted(candidates, key=lambda item: item["totalScore"], reverse=True)[:output_limit]


def preliminary_strategy_score(row):
    theme_score = theme_heat_score(row.get("theme", ""))
    change_rate = row.get("changeRate", 0)
    turnover = row.get("turnover", 0)
    volume = row.get("volume", 0)
    market_val = row.get("marketVal", 0)
    score = 0
    score += clamp(change_rate * 5 + 35, 0, 55)
    score += min(turnover / 1_000_000_000, 1) * 18
    score += min(volume / 100_000_000, 1) * 8
    score += theme_score * 0.18
    score += 8 if market_val >= 8_000_000_000 else 0
    score -= 20 if change_rate < -5 else 0
    return score


def build_strategy_field_legend():
    return {
        "signalLight": "参考 CAN SLIM/Minervini 的强势触发思路：金钻触发、突破触发、回踩触发、趋势观察、弱势过滤。",
        "stockState": "参考 Weinstein 阶段分析：二阶段主升、右侧修复、二阶段强势、高位延伸、均线下方。",
        "pivotStage": "参考 VCP/枢轴交易：VCP末端、首次突破、回踩确认、突破延伸、二阶段整理。",
        "buyPointType": "区分枢轴突破、回踩MA20、VCP待破、延伸等回踩、观察买点。",
        "buyPointGrade": "B1/B2/B3/C 表示买点成熟度，不是公司质量评级。",
        "actionState": "可执行、等待回踩、观察、过滤。由市场门控、技术评分、买点窗口和风险标记共同决定。",
        "buyPointQuality": "A+低风险、A可试错、B回踩待确认、B待触发、C过热。",
        "rating": "A+首选、A重点、B跟踪、C过滤，是组合管理优先级。",
        "totalScore": "消息/主题、技术结构、买点窗口、RS、市场环境和风险扣分的综合分。",
        "rs": "相对强弱分，参考 IBD RS 思路，用个股相对指数和成交活跃度估算。",
        "riskFlags": "弱市门控、距枢轴过远、短线过热、跌破MA20、MACD未确认、成交额不足等。",
    }


def fetch_daily_kline(quote_ctx, code, count):
    end = datetime.now().date()
    start = end - timedelta(days=max(count * 2, 180))
    ret, data, _ = quote_ctx.request_history_kline(
        code,
        start=start.isoformat(),
        end=end.isoformat(),
        ktype=KLType.K_DAY,
        autype=AuType.NONE,
        max_count=count,
    )
    if ret != RET_OK:
        return []
    return to_records(data)


def compute_technical(row, kline, index_change):
    closes = [pick_number(item, "close", "close_price") for item in kline]
    highs = [pick_number(item, "high", "high_price") for item in kline]
    lows = [pick_number(item, "low", "low_price") for item in kline]
    volumes = [pick_number(item, "volume") for item in kline]
    close = row.get("lastPrice") or (closes[-1] if closes else 0)
    ma20 = average(closes[-20:]) if len(closes) >= 20 else 0
    ma60 = average(closes[-60:]) if len(closes) >= 60 else 0
    prior_high20 = max(closes[-21:-1]) if len(closes) >= 21 else max(closes[:-1] or [close])
    pivot = prior_high20 or close
    distance_to_pivot = (close - pivot) / pivot * 100 if pivot else 0
    volume_avg20 = average(volumes[-21:-1]) if len(volumes) >= 21 else average(volumes)
    volume_ratio = row.get("volume", 0) / volume_avg20 if volume_avg20 else 0
    rsi = rsi14(closes)
    macd_line, macd_signal, macd_hist = macd(closes)
    atr = atr14(highs, lows, closes)
    trend_score = 0
    trend_score += 25 if ma20 and close >= ma20 else 0
    trend_score += 20 if ma20 and ma60 and ma20 >= ma60 else 0
    trend_score += 15 if distance_to_pivot >= -3 else 0
    trend_score += 15 if macd_hist > 0 else 0
    trend_score += 15 if 50 <= rsi <= 72 else 5 if 45 <= rsi < 50 else 0
    trend_score += 10 if volume_ratio >= 1.3 else 0
    rs = clamp(50 + (row.get("changeRate", 0) - index_change) * 6 + min(row.get("turnover", 0) / 1_000_000_000, 1) * 12, 0, 100)
    vcp = detect_vcp(closes, volumes)
    return {
        "ma20": ma20,
        "ma60": ma60,
        "rsi14": rsi,
        "macdLine": macd_line,
        "macdSignal": macd_signal,
        "macdHist": macd_hist,
        "atr14": atr,
        "volumeRatio": volume_ratio,
        "pivot": pivot,
        "distanceToPivotPct": distance_to_pivot,
        "pivotScore": clamp(trend_score, 0, 100),
        "rs": rs,
        "earlyVcp": "触发" if vcp else "未触发",
    }


def score_strategy_candidate(row, technical, market_score):
    theme_score = theme_heat_score(row.get("theme", ""))
    market_regime = classify_strategy_market(market_score)
    news_score = score_news_theme_proxy(row, theme_score)
    technical_score = score_technical_setup(row, technical)
    buy_point_score = score_buy_point(row, technical)
    risk_penalty, risk_flags = score_risk_penalty(row, technical, market_score)
    signal_score = clamp(news_score * 0.25 + technical_score * 0.4 + buy_point_score * 0.25 + market_score * 0.1 - risk_penalty, 0, 100)
    pivot_score = technical["pivotScore"] / 20
    rs_score = technical["rs"]
    total = clamp(signal_score * 0.62 + rs_score * 0.18 + theme_score * 0.12 + market_score * 0.08, 0, 130)
    decision = decide_strategy_action(total, technical_score, buy_point_score, risk_flags, market_regime)
    field_ratings = classify_strategy_fields(row, technical, total, decision, market_regime, risk_flags, news_score, technical_score, buy_point_score)
    action_state = field_ratings["actionState"]
    rating = field_ratings["rating"]
    buy_type = field_ratings["buyPointType"]
    entry_zone = strategy_entry_zone(row, technical, decision)
    stop_loss = strategy_stop_loss(row, technical, entry_zone)
    take_profit = strategy_take_profit(row, entry_zone, stop_loss)
    return {
        "code": row["code"],
        "name": row["name"],
        "theme": row.get("theme", "-"),
        "signalLight": field_ratings["signalLight"],
        "stockState": field_ratings["stockState"],
        "pivotStage": field_ratings["pivotStage"],
        "buyPointType": buy_type,
        "buyPointGrade": field_ratings["buyPointGrade"],
        "actionState": action_state,
        "buyPointQuality": field_ratings["buyPointQuality"],
        "commentScore": clamp(signal_score / 10, 0, 10),
        "rating": rating,
        "selected": decision in {"buy_setup", "wait_pullback", "watch"},
        "totalScore": total,
        "rs": technical["rs"],
        "pivotScore": pivot_score,
        "distanceToPivotPct": technical["distanceToPivotPct"],
        "financialQuality": "通过" if row.get("peTtm", 0) > 0 or row.get("marketVal", 0) >= 10_000_000_000 else "-",
        "earlyVcp": technical["earlyVcp"],
        "technical": technical,
        "strategyDecision": {
            "decision": decision,
            "marketRegime": market_regime,
            "entryZone": entry_zone,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
            "positionWeightPct": position_weight(decision, market_regime, total),
            "scores": {
                "newsTheme": news_score,
                "technical": technical_score,
                "buyPoint": buy_point_score,
                "market": market_score,
                "riskPenalty": risk_penalty,
                "total": total,
            },
            "riskFlags": risk_flags,
            "fieldRationale": field_ratings["rationale"],
            "buyConditions": build_buy_conditions(row, technical, market_regime),
            "sellConditions": build_sell_conditions(row, technical, stop_loss),
            "invalidation": build_invalidation(row, technical),
        },
        "tradingAgentsRead": {
            "newsSentiment": "消息面未接入真实新闻；当前用主题热度、涨停、成交额做代理" if row.get("changeRate", 0) > 0 else "消息面待验证",
            "technicalAnalyst": f"MA20/MA60、RSI、MACD、量比、枢轴距离综合评分 {technical_score:.1f}",
            "riskManager": "弱市门控：只允许核心票确认后低吸/突破，不追后排" if market_score < 45 else "可按 ATR 定义止损和仓位",
        },
    }


def classify_strategy_fields(row, technical, total, decision, market_regime, risk_flags, news_score, technical_score, buy_point_score):
    distance = technical["distanceToPivotPct"]
    volume_ratio = technical["volumeRatio"]
    rsi = technical["rsi14"]
    rs = technical["rs"]
    above_ma20 = technical["ma20"] and row.get("lastPrice", 0) >= technical["ma20"]
    ma_bull = technical["ma20"] and technical["ma60"] and technical["ma20"] >= technical["ma60"]
    macd_ok = technical["macdHist"] > 0
    near_pivot = -3 <= distance <= 5
    extended = distance > 8
    limit_move = row.get("changeRate", 0) >= limit_threshold(row["code"])
    constructive_pullback = -8 <= distance < -3 and above_ma20 and rs >= 70

    if decision == "buy_setup" and total >= 95:
        signal_light = "金钻触发"
    elif near_pivot and volume_ratio >= 1.5 and macd_ok:
        signal_light = "突破触发"
    elif constructive_pullback:
        signal_light = "回踩触发"
    elif technical_score >= 65:
        signal_light = "趋势观察"
    else:
        signal_light = "弱势过滤"

    if above_ma20 and ma_bull and rs >= 80 and macd_ok:
        stock_state = "二阶段主升"
    elif above_ma20 and rs >= 70:
        stock_state = "右侧修复"
    elif extended and rsi >= 73:
        stock_state = "高位延伸"
    elif not above_ma20:
        stock_state = "均线下方"
    else:
        stock_state = "二阶段强势"

    if technical["earlyVcp"] == "触发" and near_pivot:
        pivot_stage = "VCP末端"
    elif limit_move and near_pivot:
        pivot_stage = "首次突破"
    elif extended:
        pivot_stage = "突破延伸"
    elif constructive_pullback:
        pivot_stage = "回踩确认"
    else:
        pivot_stage = "二阶段整理"

    if near_pivot and volume_ratio >= 1.5:
        buy_point_type = "枢轴突破"
    elif constructive_pullback:
        buy_point_type = "回踩MA20"
    elif technical["earlyVcp"] == "触发":
        buy_point_type = "VCP待破"
    elif extended:
        buy_point_type = "延伸等回踩"
    else:
        buy_point_type = "观察买点"

    if buy_point_score >= 85 and technical_score >= 75 and not risk_flags:
        buy_point_grade = "B1"
    elif buy_point_score >= 70 and technical_score >= 65:
        buy_point_grade = "B2"
    elif buy_point_score >= 50:
        buy_point_grade = "B3"
    else:
        buy_point_grade = "C"

    if decision == "buy_setup":
        action_state = "可执行"
    elif decision == "wait_pullback":
        action_state = "等待回踩"
    elif decision == "watch":
        action_state = "观察"
    else:
        action_state = "过滤"

    if near_pivot and technical_score >= 75 and rs >= 85:
        buy_point_quality = "A+ 低风险"
    elif near_pivot and technical_score >= 65:
        buy_point_quality = "A 可试错"
    elif extended:
        buy_point_quality = "C 过热"
    elif constructive_pullback:
        buy_point_quality = "B 回踩待确认"
    else:
        buy_point_quality = "B 待触发"

    if total >= 100 and decision == "buy_setup":
        rating = "A+ 首选"
    elif total >= 88 and decision in {"buy_setup", "wait_pullback"}:
        rating = "A 重点"
    elif total >= 70:
        rating = "B 跟踪"
    else:
        rating = "C 过滤"

    rationale = [
        f"RS={rs:.1f}，{'强于市场' if rs >= 80 else '相对强度一般'}",
        f"距枢轴={distance:.1f}%，{'在买点窗口' if near_pivot else '偏离买点'}",
        f"量比={volume_ratio:.1f}，{'放量确认' if volume_ratio >= 1.5 else '量能未充分'}",
        f"市场={market_regime}，{'弱市降级' if market_regime == 'defense' else '市场允许度较高'}",
        f"消息/主题代理分={news_score:.1f}",
    ]

    return {
        "signalLight": signal_light,
        "stockState": stock_state,
        "pivotStage": pivot_stage,
        "buyPointType": buy_point_type,
        "buyPointGrade": buy_point_grade,
        "actionState": action_state,
        "buyPointQuality": buy_point_quality,
        "rating": rating,
        "rationale": rationale,
    }


def classify_strategy_market(market_score):
    if market_score >= 70:
        return "attack"
    if market_score >= 45:
        return "neutral"
    return "defense"


def score_news_theme_proxy(row, theme_score):
    score = theme_score * 0.45
    score += 25 if row.get("changeRate", 0) >= limit_threshold(row["code"]) else 0
    score += min(row.get("turnover", 0) / 1_000_000_000, 1) * 20
    score += 10 if row.get("theme") != "其他" else 0
    return clamp(score, 0, 100)


def score_technical_setup(row, technical):
    close = row.get("lastPrice", 0)
    score = 0
    score += 18 if technical["ma20"] and close >= technical["ma20"] else 0
    score += 15 if technical["ma20"] and technical["ma60"] and technical["ma20"] >= technical["ma60"] else 0
    score += 18 if technical["macdHist"] > 0 else 0
    score += 16 if 50 <= technical["rsi14"] <= 72 else 8 if 45 <= technical["rsi14"] < 50 else 0
    score += 15 if technical["volumeRatio"] >= 1.3 else 0
    score += 10 if technical["rs"] >= 80 else 5 if technical["rs"] >= 65 else 0
    score += 8 if technical["earlyVcp"] == "触发" else 0
    return clamp(score, 0, 100)


def score_buy_point(row, technical):
    distance = technical["distanceToPivotPct"]
    score = 0
    if -3 <= distance <= 5:
        score += 45
    elif -8 <= distance < -3:
        score += 25
    elif 5 < distance <= 12:
        score += 15
    score += 25 if technical["volumeRatio"] >= 1.3 else 0
    score += 15 if technical["macdHist"] > 0 else 0
    score += 15 if row.get("turnover", 0) >= 100_000_000 else 0
    return clamp(score, 0, 100)


def score_risk_penalty(row, technical, market_score):
    flags = []
    penalty = 0
    if market_score < 45:
        flags.append("弱市门控")
        penalty += 12
    if technical["distanceToPivotPct"] > 8:
        flags.append("距枢轴过远")
        penalty += 18
    if technical["rsi14"] > 78:
        flags.append("短线过热")
        penalty += 12
    if technical["ma20"] and row.get("lastPrice", 0) < technical["ma20"]:
        flags.append("跌破MA20")
        penalty += 18
    if technical["macdHist"] < 0:
        flags.append("MACD未确认")
        penalty += 10
    if row.get("turnover", 0) < 80_000_000:
        flags.append("成交额不足")
        penalty += 8
    return penalty, flags


def decide_strategy_action(total, technical_score, buy_point_score, risk_flags, market_regime):
    hard_flags = {"跌破MA20", "成交额不足"}
    if hard_flags.intersection(risk_flags):
        return "avoid"
    if "距枢轴过远" in risk_flags:
        return "wait_pullback"
    if market_regime == "defense" and total < 105:
        return "wait_pullback" if technical_score >= 70 else "watch"
    if total >= 92 and technical_score >= 70 and buy_point_score >= 70:
        return "buy_setup"
    if total >= 78 and technical_score >= 60:
        return "wait_pullback"
    if total >= 62:
        return "watch"
    return "avoid"


def strategy_stop_loss(row, technical, entry_zone):
    close = row.get("lastPrice", 0)
    entry_low = entry_zone.get("low") or close
    atr = technical.get("atr14", 0)
    ma20 = technical.get("ma20", 0)
    if entry_low and atr:
        atr_stop = entry_low - 1.5 * atr
        ma_stop = ma20 * 0.985 if ma20 else atr_stop
        return round(max(min(atr_stop, entry_low * 0.94), ma_stop), 2)
    return round(entry_low * 0.93, 2) if entry_low else 0


def strategy_take_profit(row, entry_zone, stop_loss):
    entry_high = entry_zone.get("high") or row.get("lastPrice", 0)
    risk = max(entry_high - stop_loss, 0)
    return round(entry_high + risk * 2, 2) if entry_high and risk else 0


def strategy_entry_zone(row, technical, decision):
    close = row.get("lastPrice", 0)
    pivot = technical.get("pivot", 0)
    if decision == "buy_setup":
        low = max(pivot, close * 0.985)
        high = min(close * 1.02, pivot * 1.05)
    else:
        low = max(technical.get("ma20", 0), pivot * 0.97) if pivot else technical.get("ma20", 0)
        high = pivot * 1.02 if pivot else close
    return {"low": round(low, 2), "high": round(high, 2)}


def position_weight(decision, market_regime, total):
    if decision != "buy_setup":
        return 0
    base = 3 if market_regime == "defense" else 5 if market_regime == "neutral" else 7
    bonus = 1 if total >= 105 else 0
    return min(base + bonus, 8)


def build_buy_conditions(row, technical, market_regime):
    return [
        f"市场门控为 {market_regime}，弱市只允许核心票确认后出手",
        f"收盘价站上 MA20，RSI14 在 50-72 区间；当前 RSI {technical['rsi14']:.1f}",
        f"量比不低于 1.3；当前量比 {technical['volumeRatio']:.1f}",
        f"距枢轴在 -3% 到 +5% 的买点窗口；当前 {technical['distanceToPivotPct']:.1f}%",
    ]


def build_sell_conditions(row, technical, stop_loss):
    return [
        f"收盘跌破止损价 {stop_loss}",
        "跌破 MA20 且 MACD 柱体转负",
        "放量长上影后次日不能修复",
        "主题热度退潮：涨停数量下降且成交额转移到跌幅榜",
    ]


def build_invalidation(row, technical):
    return "若突破后 2 个交易日内不能维持枢轴上方，或跌破 MA20，策略失效。"


def theme_heat_score(theme):
    if theme in {"AI/算力", "半导体", "机器人/高端制造", "新能源", "军工"}:
        return 85
    if theme in {"金融地产", "资源周期", "医药", "消费"}:
        return 65
    return 50


def is_dividend_style_stock(row):
    name = str(row.get("name") or "")
    dividend_ratio = row.get("dividendRatioTtm", 0) or 0
    if dividend_ratio >= 3.5:
        return True
    dividend_keywords = [
        "银行",
        "农商",
        "城商",
        "煤",
        "电力",
        "水电",
        "能源",
        "石油",
        "油气",
        "燃气",
        "港口",
        "高速",
        "铁路",
        "公用",
        "运营商",
        "电信",
        "移动",
        "联通",
        "保险",
    ]
    if any(keyword in name for keyword in dividend_keywords):
        return True
    return False


def rsi14(closes):
    if len(closes) < 15:
        return 50
    gains = []
    losses = []
    for idx in range(-14, 0):
        diff = closes[idx] - closes[idx - 1]
        gains.append(max(diff, 0))
        losses.append(abs(min(diff, 0)))
    avg_gain = average(gains)
    avg_loss = average(losses)
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def ema(values, period):
    if not values:
        return []
    alpha = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append(value * alpha + output[-1] * (1 - alpha))
    return output


def macd(closes):
    if len(closes) < 35:
        return 0, 0, 0
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)
    line = [a - b for a, b in zip(ema12, ema26)]
    signal = ema(line, 9)
    return line[-1], signal[-1], line[-1] - signal[-1]


def atr14(highs, lows, closes):
    if len(closes) < 15:
        return 0
    trs = []
    for idx in range(-14, 0):
        high = highs[idx]
        low = lows[idx]
        prev_close = closes[idx - 1]
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return average(trs)


def detect_vcp(closes, volumes):
    if len(closes) < 45 or len(volumes) < 45:
        return False
    recent_range = (max(closes[-15:]) - min(closes[-15:])) / max(min(closes[-15:]), 0.01)
    prior_range = (max(closes[-45:-15]) - min(closes[-45:-15])) / max(min(closes[-45:-15]), 0.01)
    recent_volume = average(volumes[-15:])
    prior_volume = average(volumes[-45:-15])
    return recent_range < prior_range * 0.65 and recent_volume < prior_volume * 0.9


def classify_market(score, up_ratio, limit_up, limit_down):
    if score >= 75 and up_ratio >= 0.58:
        return "进攻日"
    if score >= 58:
        return "修复日"
    if score >= 42:
        return "震荡日"
    if limit_down > limit_up and up_ratio < 0.35:
        return "退潮日"
    return "防守日"


def build_data_gaps(rows, index_raw):
    gaps = []
    if not rows:
        gaps.append("没有抓到 A 股股票快照，请检查 OpenD 权限和 A 股行情连接。")
    if any(not index_raw.get(code) for code, _ in INDEX_CODES):
        gaps.append("部分宽基指数快照缺失，指数结构判断可能不完整。")
    gaps.append("当前版本使用股票名称关键词近似归因主题，尚未接入申万/中信行业和真实概念板块。")
    gaps.append("未接入龙虎榜、北向资金、融资融券和涨停原因，情绪周期结论以行情快照为主。")
    return gaps


def infer_theme(name):
    text = str(name or "")
    for theme, keywords in THEME_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return theme
    return "其他"


def limit_threshold(code):
    body = code.split(".", 1)[-1]
    if body.startswith(("688", "300")):
        return 19.5
    return 9.5


def median(values):
    clean = sorted(value for value in values if isinstance(value, (int, float)) and math.isfinite(value))
    if not clean:
        return 0
    mid = len(clean) // 2
    if len(clean) % 2:
        return clean[mid]
    return (clean[mid - 1] + clean[mid]) / 2


def average(values):
    clean = [value for value in values if isinstance(value, (int, float)) and math.isfinite(value)]
    return sum(clean) / max(len(clean), 1)


def pick_number(row, *keys):
    for key in keys:
        value = row.get(key) if isinstance(row, dict) else None
        try:
            parsed = float(value)
            if math.isfinite(parsed):
                return parsed
        except (TypeError, ValueError):
            continue
    return 0


def to_records(data):
    if hasattr(data, "to_json"):
        return json.loads(data.to_json(orient="records", force_ascii=False))
    if isinstance(data, list):
        return data
    return []


def clamp(value, low, high):
    return max(low, min(high, value))


def compact(value):
    n = float(value or 0)
    if abs(n) >= 100_000_000:
        return f"{n / 100_000_000:.2f}亿"
    if abs(n) >= 10_000:
        return f"{n / 10_000:.1f}万"
    return f"{n:.0f}"


def pct(value):
    return f"{float(value or 0):.2f}%"


def build_markdown(report):
    s = report["summary"]
    lines = [
        "# A股全面复盘",
        "",
        f"生成时间：{report['generatedAt']}",
        f"覆盖股票：{s['stockCoverage']} / 上限 {s['maxStocks']}",
        f"市场状态：{s['marketState']}，情绪温度 {s['emotionScore']} / 100",
        "",
        "## 今日结论",
        "",
        f"- {report['playbook']['headline']}",
        f"- 上涨/下跌/平盘：{s['advancers']} / {s['decliners']} / {s['flat']}，上涨占比 {s['upRatio'] * 100:.1f}%",
        f"- 涨停/跌停：{s['limitUp']} / {s['limitDown']}，全市场成交额 {compact(s['totalTurnover'])}",
        f"- 中位数涨跌幅：{pct(s['medianChangeRate'])}",
        "",
        "## 指数结构",
        "",
    ]
    for row in report["indices"]:
        lines.append(f"- {row['name']}：{pct(row['changeRate'])}，成交额 {compact(row['turnover'])}")
    lines += ["", "## 板块/主题强度", ""]
    for theme in report["themes"][:8]:
        leaders = "、".join(f"{row['name']}({pct(row['changeRate'])})" for row in theme["leaders"][:3])
        lines.append(
            f"- {theme['theme']}：热度 {theme['heatScore']}，均涨幅 {pct(theme['averageChangeRate'])}，"
            f"上涨占比 {theme['breadth'] * 100:.1f}%，涨停 {theme['limitUp']}，成交额 {compact(theme['turnover'])}。核心：{leaders}"
        )
    lines += ["", "## 次日计划", "", f"- 仓位/节奏：{report['playbook']['position']}"]
    for item in report["playbook"]["confirmations"]:
        lines.append(f"- 确认：{item}")
    for item in report["playbook"]["risks"]:
        lines.append(f"- 风险：{item}")
    lines += ["", "## 观察名单", ""]
    for row in report["playbook"]["watchlist"]:
        lines.append(f"- {row['code']} {row['name']}：{pct(row['changeRate'])}，成交额 {compact(row['turnover'])}，主题 {row['theme']}")
    if report["dataGaps"]:
        lines += ["", "## 数据缺口", ""]
        lines.extend(f"- {item}" for item in report["dataGaps"])
    return "\n".join(lines) + "\n"


def build_html(markdown):
    body = "\n".join(f"<p>{line}</p>" if line else "" for line in markdown.splitlines())
    return f"<!doctype html><html><head><meta charset='utf-8'><title>A股全面复盘</title><style>body{{font-family:Arial,'Microsoft YaHei',sans-serif;max-width:980px;margin:40px auto;line-height:1.75;color:#17211d}}p{{margin:6px 0}}p:first-child{{font-size:30px;font-weight:800}}</style></head><body>{body}</body></html>"


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
