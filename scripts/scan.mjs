import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config", "watchlist.json");
const dataDir = path.join(root, "data");
const reportsDir = path.join(root, "reports");

loadDotEnv(path.join(root, ".env"));

const config = JSON.parse(await readFile(configPath, "utf8"));
const apiKey = process.env.POLYGON_API_KEY;

if (!apiKey) {
  throw new Error("Missing POLYGON_API_KEY. Copy .env.example to .env and set your Polygon API key.");
}

const today = new Date();
const scanStartedAt = new Date().toISOString();
const symbols = config.symbols.slice(0, config.maxSymbolsPerRun || config.symbols.length);

await mkdir(dataDir, { recursive: true });
await mkdir(reportsDir, { recursive: true });

const records = [];
const errors = [];

for (const symbol of symbols) {
  try {
    const snapshot = await fetchOptionChain(symbol);
    const record = analyzeSymbol(symbol, snapshot);
    if (record && record.totalVolume >= (config.minTotalOptionVolume || 0)) {
      records.push(record);
    }
    await sleep(250);
  } catch (error) {
    errors.push({ symbol, error: error.message });
  }
}

const ranked = records
  .filter((record) => record.leapCallVolume >= (config.minLeapCallVolume || 0))
  .sort((a, b) => b.score - a.score);

const report = {
  generatedAt: new Date().toISOString(),
  source: "polygon",
  config: {
    leapDays: config.leapDays,
    minTotalOptionVolume: config.minTotalOptionVolume,
    minLeapCallVolume: config.minLeapCallVolume
  },
  summary: {
    scannedSymbols: symbols.length,
    qualifiedSymbols: ranked.length,
    errors: errors.length
  },
  records: ranked,
  errors
};

const dateStamp = scanStartedAt.slice(0, 10);
const markdown = buildMarkdownReport(report);
const html = buildHtmlReport(report, markdown);

await writeFile(path.join(dataDir, "latest-report.json"), JSON.stringify(report, null, 2), "utf8");
await writeFile(path.join(reportsDir, `${dateStamp}-leap-report.md`), markdown, "utf8");
await writeFile(path.join(reportsDir, `${dateStamp}-leap-report.html`), html, "utf8");

await deliverReport(report, markdown);

console.log(`Generated ${ranked.length} qualified records from ${symbols.length} symbols.`);
if (errors.length) console.log(`Completed with ${errors.length} symbol errors.`);

async function fetchOptionChain(symbol) {
  const results = [];
  let url = new URL(`https://api.polygon.io/v3/snapshot/options/${symbol}`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("limit", "250");

  while (url) {
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Polygon ${response.status}: ${text.slice(0, 180)}`);
    }
    const payload = await response.json();
    results.push(...(payload.results || []));
    if (!payload.next_url) break;
    url = new URL(payload.next_url);
    url.searchParams.set("apiKey", apiKey);
  }
  return results;
}

function analyzeSymbol(symbol, options) {
  if (!options.length) return null;

  const leapCutoff = addDays(today, config.leapDays || 180);
  const calls = [];
  const puts = [];
  const leapCalls = [];
  const leapPuts = [];

  for (const item of options) {
    const details = item.details || {};
    const type = details.contract_type;
    const expiration = parseDate(details.expiration_date);
    const volume = number(item.day?.volume);
    const openInterest = number(item.open_interest);
    const price = optionPrice(item);
    const premium = volume * price * 100;
    const normalized = {
      ticker: details.ticker,
      type,
      strike: number(details.strike_price),
      expirationDate: details.expiration_date,
      daysToExpiration: expiration ? daysBetween(today, expiration) : 0,
      volume,
      openInterest,
      impliedVolatility: number(item.implied_volatility),
      delta: number(item.greeks?.delta),
      price,
      premium
    };

    if (type === "call") calls.push(normalized);
    if (type === "put") puts.push(normalized);
    if (expiration && expiration >= leapCutoff && type === "call") leapCalls.push(normalized);
    if (expiration && expiration >= leapCutoff && type === "put") leapPuts.push(normalized);
  }

  const totalCallVolume = sum(calls, "volume");
  const totalPutVolume = sum(puts, "volume");
  const totalVolume = totalCallVolume + totalPutVolume;
  const leapCallVolume = sum(leapCalls, "volume");
  const leapPutVolume = sum(leapPuts, "volume");
  const nearTermCallVolume = Math.max(totalCallVolume - leapCallVolume, 1);
  const leapRatio = leapCallVolume / nearTermCallVolume;
  const cpRatio = totalCallVolume / Math.max(totalPutVolume, 1);
  const leapCpRatio = leapCallVolume / Math.max(leapPutVolume, 1);
  const premiumFlow = sum(leapCalls, "premium");
  const leapCallOi = sum(leapCalls, "openInterest");
  const totalCallOi = sum(calls, "openInterest");
  const hot = [...leapCalls].sort((a, b) => b.volume - a.volume)[0];
  const score = scoreRecord({ leapRatio, cpRatio, callShare: totalCallVolume / Math.max(totalVolume, 1), premiumFlow, leapCallVolume, leapCallOi });

  return {
    ticker: symbol,
    name: symbol,
    theme: inferTheme(symbol),
    date: today.toISOString().slice(0, 10),
    cpRatio,
    leapRatio,
    leapCpRatio,
    totalVolume,
    callVolume: totalCallVolume,
    putVolume: totalPutVolume,
    leapCallVolume,
    leapPutVolume,
    leapCallOi,
    totalCallOi,
    hotContract: hot?.ticker || "",
    hotContractVolume: hot?.volume || 0,
    hotContractOi: hot?.openInterest || 0,
    hotContractPremium: hot?.premium || 0,
    premiumFlow,
    streak: 1,
    oiTrend: "未知",
    catalyst: "",
    risk: "",
    score,
    flowType: classify({ leapRatio, cpRatio, premiumFlow, score, leapCallOi }),
    note: buildResearchNote({
      ticker: symbol,
      leapRatio,
      cpRatio,
      totalVolume,
      callVolume: totalCallVolume,
      leapCallVolume,
      premiumFlow,
      hotContract: hot?.ticker || "",
      hotContractOi: hot?.openInterest || 0,
      score
    })
  };
}

function optionPrice(item) {
  const mid = midpoint(item.last_quote?.bid, item.last_quote?.ask);
  return mid || number(item.day?.close) || number(item.day?.vwap) || number(item.last_trade?.price);
}

function midpoint(bid, ask) {
  const b = number(bid);
  const a = number(ask);
  if (b > 0 && a > 0) return (b + a) / 2;
  return 0;
}

function scoreRecord(record) {
  const leap = normalize(record.leapRatio, 3) * 28;
  const cp = normalize(record.cpRatio, 5) * 18;
  const callShare = normalize(record.callShare, 0.85) * 14;
  const premium = normalize(record.premiumFlow, 25_000_000) * 16;
  const leapVolume = normalize(record.leapCallVolume, 25_000) * 12;
  const oi = normalize(record.leapCallOi, 100_000) * 12;
  return Math.round(Math.min(100, leap + cp + callShare + premium + leapVolume + oi));
}

function classify(record) {
  if (record.score >= 78 && record.leapRatio >= 1.5 && record.cpRatio >= 2.5) return "Conviction candidate";
  if (record.leapRatio >= 1 && record.cpRatio >= 2) return "Directional LEAP call flow";
  if (record.premiumFlow >= 20_000_000) return "Large premium flow";
  return "Watchlist";
}

function buildResearchNote(record) {
  const callShare = record.callVolume / Math.max(record.totalVolume, 1);
  const hot = record.hotContract || "最热 LEAP call";
  const premium = compact(record.premiumFlow);

  return [
    `${record.ticker} 进入 LEAP call 异常观察区。C/P ${record.cpRatio.toFixed(2)}，LEAP 比 ${record.leapRatio.toFixed(2)}，总期权成交 ${compact(record.totalVolume)}，其中 call 占 ${(callShare * 100).toFixed(1)}%。`,
    `重点不是单日成交，而是远月 call 是否能在 OI 里留下来。当前最热合约是 ${hot}，远月 call 权利金流约 ${premium}，对应评分 ${record.score}/100。`,
    `如果后续 ${hot} 的 OI 继续增长，同时股价相对行业转强，这笔钱更像在押 6-12 个月维度的公司重估或事件兑现。若成交热但 OI 不增长，就要把它降级为换手、滚仓或情绪交易。`
  ].join("\n\n");
}

function buildMarkdownReport(report) {
  const lines = [
    `# LEAP Call Ratio 异常监控报告`,
    ``,
    `生成时间：${report.generatedAt}`,
    `扫描标的：${report.summary.scannedSymbols}`,
    `入选标的：${report.summary.qualifiedSymbols}`,
    ``,
    `## 今日重点`,
    ``
  ];

  if (!report.records.length) {
    lines.push(`今天没有标的通过过滤条件。`);
  }

  for (const record of report.records.slice(0, 12)) {
    lines.push(`### ${record.ticker} - ${record.flowType}`);
    lines.push(``);
    lines.push(`评分：${record.score}/100`);
    lines.push(`C/P：${record.cpRatio.toFixed(2)}，LEAP 比：${record.leapRatio.toFixed(2)}，LEAP C/P：${record.leapCpRatio.toFixed(2)}`);
    lines.push(`最热合约：${record.hotContract || "-"}，成交 ${compact(record.hotContractVolume)}，OI ${compact(record.hotContractOi)}`);
    lines.push(`远月 call 权利金流：${compact(record.premiumFlow)}`);
    lines.push(``);
    lines.push(record.note);
    lines.push(``);
  }

  if (report.errors.length) {
    lines.push(`## 抓取错误`);
    for (const item of report.errors) lines.push(`- ${item.symbol}: ${item.error}`);
  }

  return lines.join("\n");
}

function buildHtmlReport(report, markdown) {
  const escaped = escapeHtml(markdown)
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LEAP Call Ratio 异常监控报告</title>
  <style>
    body{margin:0;background:#f5f1ea;color:#19201d;font-family:Arial,"Microsoft YaHei",sans-serif;line-height:1.75}
    main{max-width:920px;margin:0 auto;padding:32px 20px}
    h1,h2,h3{line-height:1.25}
    h3{margin-top:28px;padding-top:18px;border-top:1px solid #ded7cc}
    p{background:#fffdf8;border:1px solid #ded7cc;border-radius:8px;padding:18px;box-shadow:0 12px 30px rgba(24,31,29,.06)}
  </style>
</head>
<body><main><p>${escaped}</p></main></body>
</html>`;
}

async function deliverReport(report, markdown) {
  const subject = `LEAP Call 异常报告：${report.summary.qualifiedSymbols} 个入选标的`;
  if (process.env.REPORT_WEBHOOK_URL) {
    await fetch(process.env.REPORT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: subject, report: markdown.slice(0, 12000), records: report.records.slice(0, 10) })
    });
  }

  if (process.env.RESEND_API_KEY && process.env.REPORT_TO && process.env.REPORT_FROM) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.REPORT_FROM,
        to: process.env.REPORT_TO.split(",").map((item) => item.trim()),
        subject,
        html: `<pre style="white-space:pre-wrap;font:14px/1.7 system-ui">${escapeHtml(markdown)}</pre>`
      })
    });
  }
}

function inferTheme(symbol) {
  const themes = {
    NOK: "AI 网络基础设施、光网络、5G/国防通信供应链重估",
    INTC: "晶圆制造周期反转、政策补贴和代工订单兑现",
    PLTR: "AI 软件平台商业化和政府订单扩张",
    NVDA: "AI 加速计算需求和数据中心资本开支",
    AMD: "AI GPU 份额提升和服务器 CPU 周期",
    TSLA: "自动驾驶、储能和机器人叙事重估",
    SOFI: "金融科技盈利能力和信贷周期改善"
  };
  return themes[symbol] || "";
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86_400_000);
}

function sum(items, key) {
  return items.reduce((total, item) => total + number(item[key]), 0);
}

function normalize(value, max) {
  return Math.min(number(value) / max, 1);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compact(value) {
  const n = number(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
