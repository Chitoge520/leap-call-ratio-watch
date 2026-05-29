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
const apiKey = process.env.ALPHAVANTAGE_API_KEY;

if (!apiKey) {
  throw new Error("Missing ALPHAVANTAGE_API_KEY. Get a free key from Alpha Vantage and add it to .env.");
}

const today = new Date();
const scanStartedAt = new Date().toISOString();
const symbols = config.symbols.slice(0, Math.min(config.maxSymbolsPerRun || 10, 10));

await mkdir(dataDir, { recursive: true });
await mkdir(reportsDir, { recursive: true });

const records = [];
const errors = [];

for (const symbol of symbols) {
  try {
    const chain = await fetchAlphaOptions(symbol);
    const record = analyzeSymbol(symbol, chain);
    if (record && record.totalVolume >= (config.minTotalOptionVolume || 0)) {
      records.push(record);
    }
    await sleep(12_500);
  } catch (error) {
    errors.push({ symbol, error: error.message });
  }
}

const ranked = records
  .filter((record) => record.leapCallVolume >= (config.minLeapCallVolume || 0))
  .sort((a, b) => b.score - a.score);

const report = {
  generatedAt: new Date().toISOString(),
  source: "alpha_vantage",
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
const html = buildHtmlReport(markdown);

await writeFile(path.join(dataDir, "latest-report.json"), JSON.stringify(report, null, 2), "utf8");
await writeFile(path.join(reportsDir, `${dateStamp}-alpha-leap-report.md`), markdown, "utf8");
await writeFile(path.join(reportsDir, `${dateStamp}-alpha-leap-report.html`), html, "utf8");

console.log(`Alpha Vantage scan generated ${ranked.length} qualified records from ${symbols.length} symbols.`);
if (errors.length) console.log(`Completed with ${errors.length} symbol errors.`);

async function fetchAlphaOptions(symbol) {
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", "REALTIME_OPTIONS");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("require_greeks", "true");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  const payload = await response.json();
  if (payload.Note) throw new Error(payload.Note);
  if (payload.Information) throw new Error(payload.Information);
  if (payload["Error Message"]) throw new Error(payload["Error Message"]);

  const rows = payload.data || payload.options || payload["Realtime Options"] || [];
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected Alpha Vantage response shape: ${Object.keys(payload).join(", ")}`);
  }
  return rows;
}

function analyzeSymbol(symbol, rows) {
  if (!rows.length) return null;

  const leapCutoff = addDays(today, config.leapDays || 180);
  const calls = [];
  const puts = [];
  const leapCalls = [];
  const leapPuts = [];

  for (const row of rows) {
    const type = String(row.type || row.contract_type || row.option_type || "").toLowerCase();
    const expirationDate = row.expiration || row.expiration_date;
    const expiration = parseDate(expirationDate);
    const volume = number(row.volume);
    const openInterest = number(row.open_interest || row.openInterest);
    const bid = number(row.bid);
    const ask = number(row.ask);
    const last = number(row.last || row.mark || row.close);
    const price = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
    const premium = volume * price * 100;
    const contract = row.contractID || row.contract_id || row.symbol || row.ticker || "";
    const normalized = {
      ticker: contract,
      type,
      strike: number(row.strike),
      expirationDate,
      daysToExpiration: expiration ? daysBetween(today, expiration) : 0,
      volume,
      openInterest,
      impliedVolatility: number(row.implied_volatility || row.iv),
      delta: number(row.delta),
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
  const score = scoreRecord({
    leapRatio,
    cpRatio,
    callShare: totalCallVolume / Math.max(totalVolume, 1),
    premiumFlow,
    leapCallVolume,
    leapCallOi
  });

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
    risk: "Alpha Vantage 免费/低门槛数据适合验证流程，正式研究仍要确认数据延迟、覆盖、限频和 OI 更新口径。",
    score,
    flowType: classify({ leapRatio, cpRatio, premiumFlow, score }),
    note: buildResearchNote({
      ticker: symbol,
      leapRatio,
      cpRatio,
      totalVolume,
      callVolume: totalCallVolume,
      premiumFlow,
      hotContract: hot?.ticker || "",
      score
    })
  };
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
  return [
    `${record.ticker} 进入免费数据源验证版 LEAP call 异常观察。C/P ${record.cpRatio.toFixed(2)}，LEAP 比 ${record.leapRatio.toFixed(2)}，总期权成交 ${compact(record.totalVolume)}，call 占 ${(callShare * 100).toFixed(1)}%。`,
    `最热远月合约是 ${record.hotContract || "-"}，远月 call 权利金流约 ${compact(record.premiumFlow)}，综合评分 ${record.score}/100。`,
    `这份报告主要用于验证程序链路是否成立：能否自动拉取期权链、识别远月 call、计算异常评分并生成研究文本。正式使用时，要继续用 OI 连续变化和价差过滤确认资金是否真的留下来。`
  ].join("\n\n");
}

function buildMarkdownReport(report) {
  const lines = [
    `# LEAP Call Ratio 异常监控报告 Alpha Vantage 验证版`,
    ``,
    `生成时间：${report.generatedAt}`,
    `扫描标的：${report.summary.scannedSymbols}`,
    `入选标的：${report.summary.qualifiedSymbols}`,
    ``,
    `## 今日重点`,
    ``
  ];

  if (!report.records.length) lines.push(`今天没有标的通过过滤条件。可以临时降低 config/watchlist.json 里的 minTotalOptionVolume 和 minLeapCallVolume。`);

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

function buildHtmlReport(markdown) {
  const body = escapeHtml(markdown)
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LEAP Report</title><style>body{margin:0;background:#f5f1ea;color:#19201d;font-family:Arial,"Microsoft YaHei",sans-serif;line-height:1.75}main{max-width:920px;margin:0 auto;padding:32px 20px}p{background:#fffdf8;border:1px solid #ded7cc;border-radius:8px;padding:18px}</style></head><body><main><p>${body}</p></main></body></html>`;
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
