import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUTU_APPDATA = os.getenv("FUTU_APPDATA") or str(ROOT / ".futu-appdata")
os.environ["APPDATA"] = FUTU_APPDATA
os.environ["appdata"] = FUTU_APPDATA

try:
    from futu import Market, OpenQuoteContext, RET_OK, SecurityType
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
    finally:
        quote_ctx.close()

    rows = [merge_symbol_snapshot(item, snapshots.get(item["code"], {})) for item in symbols]
    rows = [row for row in rows if row["lastPrice"] > 0 or row["turnover"] > 0 or row["volume"] > 0]
    generated_at = datetime.now(timezone.utc).isoformat()
    report = build_review(generated_at, rows, indices, max_stocks)

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
    if code.startswith("SH."):
        body = code.split(".", 1)[1]
        return body.startswith(("600", "601", "603", "605", "688"))
    if code.startswith("SZ."):
        body = code.split(".", 1)[1]
        return body.startswith(("000", "001", "002", "003", "300"))
    return False


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
