import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";

const root = path.dirname(fileURLToPath(import.meta.url));
loadDotenv(path.join(root, ".env"));
const port = Number(process.env.PORT || 4173);
const dbPath = path.join(root, "data", "leap_watch.db");
const jobStatusPath = path.join(root, "data", "job-status.json");
const autoScanEnabled = process.env.AUTO_SCAN_ENABLED !== "0";
const autoScanTimeEt = process.env.AUTO_SCAN_TIME_ET || "16:30";
const autoPremarketEnabled = process.env.AUTO_PREMARKET_ENABLED !== "0";
const autoPremarketTimeEt = process.env.AUTO_PREMARKET_TIME_ET || "08:30";
const autoHkScanEnabled = process.env.AUTO_HK_SCAN_ENABLED !== "0";
const autoHkScanTimeHkt = process.env.AUTO_HK_SCAN_TIME_HKT || "16:30";
const autoJobRetryMinutes = Math.max(5, Number(process.env.AUTO_JOB_RETRY_MINUTES || 60));
const autoPremarketProtectMinutes = Math.max(0, Number(process.env.AUTO_PREMARKET_PROTECT_MINUTES || 90));
const deepSeekBalanceEnabled = process.env.DEEPSEEK_BALANCE_ENABLED !== "0";
const deepSeekBalanceCacheMs = Math.max(30_000, Number(process.env.DEEPSEEK_BALANCE_CACHE_MS || 5 * 60_000));
const jobState = loadJobState();
let openDHealthPromise = null;
let deepSeekBalanceState = {
  enabled: deepSeekBalanceEnabled,
  provider: "deepseek",
  configured: isDeepSeekConfigured(),
  lastCheckedAt: "",
  available: false,
  balanceInfos: [],
  error: ""
};
let deepSeekBalancePromise = null;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(url, response);
      return;
    }
    serveStatic(url, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}).listen(port, () => {
  console.log(`LEAP Watch is running at http://localhost:${port}`);
  startScheduler();
});

async function handleApi(url, response) {
  if (url.pathname === "/api/job/status") {
    sendJson(response, 200, buildPublicJobState());
    return;
  }

  if (url.pathname === "/api/cn-review") {
    const reviewPath = path.join(root, "data", "latest-cn-review.json");
    if (!existsSync(reviewPath)) {
      sendJson(response, 404, { error: "A-share review not found. Run npm run review:cn first." });
      return;
    }
    sendJson(response, 200, JSON.parse(readFileSync(reviewPath, "utf8")));
    return;
  }

  if (url.pathname === "/api/cn-review/run") {
    const requestedDate = normalizeCnReviewDate(url.searchParams.get("date"));
    if (!requestedDate) {
      sendJson(response, 400, { error: "date is required. Use YYYY-MM-DD or YYYYMMDD." });
      return;
    }
    await runProcess("python", ["scripts/cn_review.py"], {
      envOverrides: { CN_REVIEW_TRADE_DATE: requestedDate }
    });
    const reviewPath = path.join(root, "data", "latest-cn-review.json");
    if (!existsSync(reviewPath)) {
      sendJson(response, 500, { error: "A-share review did not generate data/latest-cn-review.json." });
      return;
    }
    sendJson(response, 200, JSON.parse(readFileSync(reviewPath, "utf8")));
    return;
  }

  if (url.pathname === "/api/deepseek/balance") {
    const force = url.searchParams.get("force") === "1";
    const balance = await refreshDeepSeekBalance({ force });
    sendJson(response, 200, balance);
    return;
  }

  if (url.pathname.startsWith("/api/backtest/")) {
    sendJson(response, 410, { error: "Backtest is temporarily disabled." });
    return;
  }

  if (!existsSync(dbPath)) {
    sendJson(response, 404, { error: "Database not found. Run npm run scan:futu first." });
    return;
  }

  if (url.pathname === "/api/reports") {
    const rows = await all(
      `SELECT report_date, generated_at, source, scanned_symbols, qualified_symbols, errors_count
       FROM scan_reports
       ORDER BY generated_at DESC
       LIMIT 120`
    );
    sendJson(response, 200, { reports: rows });
    return;
  }

  if (url.pathname === "/api/report") {
    const date = url.searchParams.get("date");
    const generatedAt = url.searchParams.get("generatedAt");
    const market = String(url.searchParams.get("market") || "US").toUpperCase();
    const source = market === "HK" ? "futu_hk" : "futu";
    const row = generatedAt
      ? await get(`SELECT raw_json FROM scan_reports WHERE generated_at = ?`, [generatedAt])
      : date
        ? await get(`SELECT raw_json FROM scan_reports WHERE report_date = ? AND source = ? ORDER BY generated_at DESC LIMIT 1`, [date, source])
        : await get(`SELECT raw_json FROM scan_reports WHERE source = ? ORDER BY generated_at DESC LIMIT 1`, [source]);
    if (!row) {
      sendJson(response, 404, { error: "Report not found" });
      return;
    }
    sendJson(response, 200, JSON.parse(row.raw_json));
    return;
  }

  if (url.pathname === "/api/history") {
    const ticker = String(url.searchParams.get("ticker") || "").toUpperCase();
    if (!ticker) {
      sendJson(response, 400, { error: "ticker is required" });
      return;
    }
    const rows = await all(
      `SELECT report_date, generated_at, ticker, name, score, cp_ratio, leap_ratio,
              total_volume, call_volume, premium_flow, stock_dollar_volume, hot_contract, flow_type
       FROM stock_records
       WHERE ticker = ?
       ORDER BY generated_at DESC
       LIMIT 180`,
      [ticker]
    );
    sendJson(response, 200, { ticker, history: rows });
    return;
  }

  /* Backtest API is temporarily disabled.
  if (url.pathname === "/api/backtest/summary") {
    const rows = await all(
      `SELECT r.horizon_days, r.status, s.qualified_by_leap,
              CASE WHEN s.cp_ratio >= 1 THEN 'call_dominant' ELSE 'put_dominant' END AS cp_group,
              CASE WHEN s.score >= 75 THEN 'score_high'
                   WHEN s.score >= 50 THEN 'score_mid'
                   ELSE 'score_low' END AS score_group,
              r.return_pct, r.max_drawdown_pct
       FROM backtest_results r
       JOIN backtest_signals s ON s.signal_id = r.signal_id`
    );
    sendJson(response, 200, summarizeBacktest(rows));
    return;
  }

  if (url.pathname === "/api/backtest/signals") {
    const ticker = String(url.searchParams.get("ticker") || "").toUpperCase();
    const horizon = Number(url.searchParams.get("horizon") || 0);
    const params = [];
    const clauses = [];
    if (ticker) {
      clauses.push("s.ticker = ?");
      params.push(ticker);
    }
    if (horizon) {
      clauses.push("r.horizon_days = ?");
      params.push(horizon);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await all(
      `SELECT s.signal_id, s.report_date, s.generated_at, s.ticker, s.score, s.option_volume,
              s.leap_ratio, s.cp_ratio, s.premium_flow, s.qualified_by_leap, s.raw_json,
              r.horizon_days, r.entry_date, r.entry_close, r.exit_date, r.exit_close,
              r.return_pct, r.max_drawdown_pct, r.status
       FROM backtest_signals s
       LEFT JOIN backtest_results r ON r.signal_id = s.signal_id
       ${where}
       ORDER BY s.report_date DESC, s.score DESC, r.horizon_days ASC
       LIMIT 500`,
      params
    );
    sendJson(response, 200, { signals: rows.map(normalizeBacktestRow) });
    return;
  }

  if (url.pathname === "/api/backtest/ticker") {
    const ticker = String(url.searchParams.get("ticker") || "").toUpperCase();
    if (!ticker) {
      sendJson(response, 400, { error: "ticker is required" });
      return;
    }
    const rows = await all(
      `SELECT s.signal_id, s.report_date, s.generated_at, s.ticker, s.score, s.option_volume,
              s.leap_ratio, s.cp_ratio, s.premium_flow, s.qualified_by_leap, s.raw_json,
              r.horizon_days, r.entry_date, r.entry_close, r.exit_date, r.exit_close,
              r.return_pct, r.max_drawdown_pct, r.status
       FROM backtest_signals s
       LEFT JOIN backtest_results r ON r.signal_id = s.signal_id
       WHERE s.ticker = ?
       ORDER BY s.report_date DESC, r.horizon_days ASC
       LIMIT 240`,
      [ticker]
    );
    sendJson(response, 200, { ticker, signals: rows.map(normalizeBacktestRow) });
    return;
  }
  */

  sendJson(response, 404, { error: "Unknown API endpoint" });
}

function serveStatic(url, response) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function openDb() {
  return new sqlite3.Database(dbPath);
}

function all(sql, params = []) {
  const db = openDb();
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  const db = openDb();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      db.close();
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function summarizeBacktest(rows) {
  const groups = new Map();
  for (const row of rows) {
    addSummaryGroup(groups, row.horizon_days, "all", row);
    addSummaryGroup(groups, row.horizon_days, row.qualified_by_leap ? "leap_qualified" : "leap_unqualified", row);
    addSummaryGroup(groups, row.horizon_days, row.cp_group, row);
    addSummaryGroup(groups, row.horizon_days, row.score_group, row);
  }
  return { summary: Array.from(groups.values()).map(finalizeSummaryGroup) };
}

function addSummaryGroup(groups, horizon, group, row) {
  const key = `${horizon}:${group}`;
  if (!groups.has(key)) {
    groups.set(key, {
      horizonDays: horizon,
      group,
      totalSamples: 0,
      completedSamples: 0,
      pendingSamples: 0,
      wins: 0,
      returns: [],
      drawdowns: []
    });
  }
  const item = groups.get(key);
  item.totalSamples += 1;
  if (row.status === "complete" && Number.isFinite(Number(row.return_pct))) {
    const returnPct = Number(row.return_pct);
    item.completedSamples += 1;
    item.wins += returnPct > 0 ? 1 : 0;
    item.returns.push(returnPct);
    if (Number.isFinite(Number(row.max_drawdown_pct))) item.drawdowns.push(Number(row.max_drawdown_pct));
  } else {
    item.pendingSamples += 1;
  }
}

function finalizeSummaryGroup(item) {
  const returns = item.returns.slice().sort((a, b) => a - b);
  const completed = item.completedSamples || 0;
  return {
    horizonDays: item.horizonDays,
    group: item.group,
    totalSamples: item.totalSamples,
    completedSamples: completed,
    pendingSamples: item.pendingSamples,
    winRate: completed ? item.wins / completed : null,
    averageReturnPct: completed ? average(returns) : null,
    medianReturnPct: completed ? median(returns) : null,
    maxDrawdownPct: item.drawdowns.length ? Math.min(...item.drawdowns) : null
  };
}

function normalizeBacktestRow(row) {
  let raw = {};
  try {
    raw = JSON.parse(row.raw_json || "{}");
  } catch {
    raw = {};
  }
  return {
    signal_id: row.signal_id,
    report_date: row.report_date,
    generated_at: row.generated_at,
    ticker: row.ticker,
    score: row.score,
    option_volume: row.option_volume,
    leap_ratio: row.leap_ratio,
    cp_ratio: row.cp_ratio,
    premium_flow: row.premium_flow,
    qualified_by_leap: Boolean(row.qualified_by_leap),
    horizon_days: row.horizon_days,
    entry_date: row.entry_date,
    entry_close: row.entry_close,
    exit_date: row.exit_date,
    exit_close: row.exit_close,
    return_pct: row.return_pct,
    max_drawdown_pct: row.max_drawdown_pct,
    status: row.status,
    sourceTopOptionContracts: raw.sourceTopOptionContracts || []
  };
}

function average(items) {
  return items.reduce((sum, item) => sum + item, 0) / Math.max(items.length, 1);
}

function median(items) {
  const mid = Math.floor(items.length / 2);
  return items.length % 2 ? items[mid] : (items[mid - 1] + items[mid]) / 2;
}

function startScheduler() {
  mkdirSync(path.join(root, "data"), { recursive: true });
  updateNextRun();
  persistJobState();
  refreshDeepSeekBalance().catch(() => {});
  setInterval(() => refreshDeepSeekBalance().catch(() => {}), deepSeekBalanceCacheMs);
  if (!autoScanEnabled && !autoPremarketEnabled && !autoHkScanEnabled) return;
  setTimeout(refreshOpenDStatus, 1000);
  setInterval(refreshOpenDStatus, 5 * 60_000);
  setTimeout(checkScheduler, 2500);
  setInterval(checkScheduler, 60_000);
}

async function refreshOpenDStatus() {
  if (jobState.running) return;
  try {
    const et = getEtParts();
    const health = await checkOpenDHealth("US", et.date);
    jobState.openD = health;
    jobState.healthCheckedAt = new Date().toISOString();
    if (jobState.lastStatus === "idle" || jobState.lastStatus === "error" || jobState.lastStatus === "disconnected") {
      jobState.lastStatus = health.connected ? "ready" : "disconnected";
      jobState.error = health.connected ? "" : health.error || "Futu OpenD disconnected";
    }
    persistJobState();
  } catch (error) {
    jobState.openD = { connected: false, isTradingDay: false, error: error.message };
    jobState.healthCheckedAt = new Date().toISOString();
    if (jobState.lastStatus === "idle" || jobState.lastStatus === "ready") {
      jobState.lastStatus = "disconnected";
      jobState.error = error.message;
    }
    persistJobState();
  }
}

async function checkScheduler() {
  if (jobState.running) return;
  if (jobState.lastStatus === "error" && isWithinRetryCooldown(jobState.lastAttemptAt)) return;
  const et = getEtParts();
  const nowMinutes = Number(et.hour) * 60 + Number(et.minute);
  const premarketMinutes = parseTimeToMinutes(autoPremarketTimeEt);
  const closeMinutes = parseTimeToMinutes(autoScanTimeEt);
  const hkt = getMarketParts("Asia/Hong_Kong");
  const hktMinutes = Number(hkt.hour) * 60 + Number(hkt.minute);
  const hkCloseMinutes = parseTimeToMinutes(autoHkScanTimeHkt);
  const premarketPending = autoPremarketEnabled && jobState.lastPremarketRunDateEt !== et.date;
  const premarketProtected = premarketPending && nowMinutes >= premarketMinutes - autoPremarketProtectMinutes;
  if (autoPremarketEnabled && nowMinutes >= premarketMinutes && jobState.lastPremarketRunDateEt !== et.date) {
    await runScheduledPipeline({
      dateEt: et.date,
      kind: "premarket",
      market: "US",
      script: ["node", ["scripts/premarket-futu-pipeline.mjs"]]
    });
    return;
  }
  if (!premarketProtected && autoHkScanEnabled && hktMinutes >= hkCloseMinutes && jobState.lastHkRunDateHkt !== hkt.date) {
    await runScheduledPipeline({
      dateEt: hkt.date,
      kind: "hk_after_close",
      market: "HK",
      script: ["node", ["scripts/daily-hk-futu-pipeline.mjs"]]
    });
    return;
  }
  if (!autoScanEnabled || nowMinutes < closeMinutes || jobState.lastRunDateEt === et.date) return;

  await runScheduledPipeline({
    dateEt: et.date,
    kind: "after_close",
    market: "US",
    script: ["node", ["scripts/daily-futu-pipeline.mjs"]]
  });
}

function isWithinRetryCooldown(timestamp) {
  const attemptedAt = Date.parse(timestamp || "");
  if (!Number.isFinite(attemptedAt)) return false;
  return Date.now() - attemptedAt < autoJobRetryMinutes * 60_000;
}

async function runScheduledPipeline({ dateEt, kind, market, script }) {
  jobState.running = true;
  jobState.runningKind = kind;
  jobState.lastAttemptAt = new Date().toISOString();
  jobState.lastAttemptDateEt = dateEt;
  jobState.lastStatus = "checking";
  jobState.error = "";
  persistJobState();

  try {
    const health = await checkOpenDHealth(market || "US", dateEt);
    jobState.openD = health;
    if (!health.connected) {
      jobState.lastStatus = "disconnected";
      jobState.error = health.error || "Futu OpenD disconnected";
      return;
    }
    if (!health.isTradingDay) {
      jobState.lastStatus = "skipped_non_trading_day";
      if (kind === "premarket") jobState.lastPremarketRunDateEt = dateEt;
      else if (kind === "hk_after_close") jobState.lastHkRunDateHkt = dateEt;
      else jobState.lastRunDateEt = dateEt;
      return;
    }
    jobState.lastStatus = "running";
    persistJobState();
    await runProcess(script[0], script[1]);
    jobState.lastStatus = "success";
    if (kind === "premarket") {
      jobState.lastPremarketRunAt = new Date().toISOString();
      jobState.lastPremarketRunDateEt = dateEt;
    } else if (kind === "hk_after_close") {
      jobState.lastHkRunAt = new Date().toISOString();
      jobState.lastHkRunDateHkt = dateEt;
    } else {
      jobState.lastRunAt = new Date().toISOString();
      jobState.lastRunDateEt = dateEt;
    }
  } catch (error) {
    jobState.lastStatus = "error";
    jobState.error = error.message;
  } finally {
    jobState.running = false;
    jobState.runningKind = "";
    updateNextRun();
    persistJobState();
  }
}

async function checkOpenDHealth(market, tradingDay) {
  while (openDHealthPromise) {
    await openDHealthPromise.catch(() => {});
  }
  openDHealthPromise = runJson("python", ["scripts/futu_healthcheck.py", "--market", market, "--trading-day", tradingDay]);
  try {
    return await openDHealthPromise;
  } finally {
    openDHealthPromise = null;
  }
}

function buildPublicJobState() {
  updateNextRun();
  return {
    enabled: autoScanEnabled,
    scheduleTimeEt: autoScanTimeEt,
    premarketEnabled: autoPremarketEnabled,
    premarketScheduleTimeEt: autoPremarketTimeEt,
    hkEnabled: autoHkScanEnabled,
    hkScheduleTimeHkt: autoHkScanTimeHkt,
    retryMinutes: autoJobRetryMinutes,
    premarketProtectMinutes: autoPremarketProtectMinutes,
    deepSeekBalance: publicDeepSeekBalanceState(),
    ...jobState
  };
}

async function refreshDeepSeekBalance({ force = false } = {}) {
  deepSeekBalanceState.enabled = deepSeekBalanceEnabled;
  deepSeekBalanceState.configured = isDeepSeekConfigured();
  if (!deepSeekBalanceEnabled) {
    deepSeekBalanceState = {
      ...deepSeekBalanceState,
      available: false,
      balanceInfos: [],
      error: "DeepSeek balance monitor is disabled."
    };
    return publicDeepSeekBalanceState();
  }
  if (!deepSeekBalanceState.configured) {
    deepSeekBalanceState = {
      ...deepSeekBalanceState,
      available: false,
      balanceInfos: [],
      error: "DeepSeek API key/base URL is not configured."
    };
    return publicDeepSeekBalanceState();
  }
  const checkedAt = Date.parse(deepSeekBalanceState.lastCheckedAt || "");
  if (!force && Number.isFinite(checkedAt) && Date.now() - checkedAt < deepSeekBalanceCacheMs) {
    return publicDeepSeekBalanceState();
  }
  if (deepSeekBalancePromise) return deepSeekBalancePromise;
  deepSeekBalancePromise = fetchDeepSeekBalance()
    .then((payload) => {
      deepSeekBalanceState = {
        enabled: deepSeekBalanceEnabled,
        provider: "deepseek",
        configured: true,
        lastCheckedAt: new Date().toISOString(),
        available: Boolean(payload.is_available),
        balanceInfos: normalizeDeepSeekBalanceInfos(payload.balance_infos),
        error: ""
      };
      return publicDeepSeekBalanceState();
    })
    .catch((error) => {
      deepSeekBalanceState = {
        ...deepSeekBalanceState,
        enabled: deepSeekBalanceEnabled,
        configured: true,
        lastCheckedAt: new Date().toISOString(),
        available: false,
        balanceInfos: [],
        error: error.message
      };
      return publicDeepSeekBalanceState();
    })
    .finally(() => {
      deepSeekBalancePromise = null;
    });
  return deepSeekBalancePromise;
}

async function fetchDeepSeekBalance() {
  const response = await fetch(`${deepSeekApiRoot()}/user/balance`, {
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      accept: "application/json"
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload.error?.message || payload.message || text || `DeepSeek balance API ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function normalizeDeepSeekBalanceInfos(rows) {
  return Array.isArray(rows)
    ? rows.map((row) => ({
        currency: String(row.currency || ""),
        totalBalance: String(row.total_balance ?? ""),
        grantedBalance: String(row.granted_balance ?? ""),
        toppedUpBalance: String(row.topped_up_balance ?? "")
      }))
    : [];
}

function publicDeepSeekBalanceState() {
  return {
    ...deepSeekBalanceState,
    balanceInfos: deepSeekBalanceState.balanceInfos.map((row) => ({ ...row }))
  };
}

function isDeepSeekConfigured() {
  return Boolean(process.env.OPENAI_API_KEY) && deepSeekApiRoot().includes("api.deepseek.com");
}

function deepSeekApiRoot() {
  const base = (process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  return base.replace(/\/v1$/, "");
}

function updateNextRun() {
  const et = getEtParts();
  const targetMinutes = parseTimeToMinutes(autoScanTimeEt);
  const premarketMinutes = parseTimeToMinutes(autoPremarketTimeEt);
  const nowMinutes = Number(et.hour) * 60 + Number(et.minute);
  let nextDate = et.date;
  if (nowMinutes >= targetMinutes || jobState.lastRunDateEt === et.date) {
    nextDate = addDaysIso(et.date, 1);
  }
  jobState.nextRunEt = `${nextDate} ${autoScanTimeEt}`;
  let nextPremarketDate = et.date;
  if (nowMinutes >= premarketMinutes || jobState.lastPremarketRunDateEt === et.date) {
    nextPremarketDate = addDaysIso(et.date, 1);
  }
  jobState.nextPremarketRunEt = `${nextPremarketDate} ${autoPremarketTimeEt}`;
  const hkt = getMarketParts("Asia/Hong_Kong");
  const hkTargetMinutes = parseTimeToMinutes(autoHkScanTimeHkt);
  const hktMinutes = Number(hkt.hour) * 60 + Number(hkt.minute);
  let nextHkDate = hkt.date;
  if (hktMinutes >= hkTargetMinutes || jobState.lastHkRunDateHkt === hkt.date) {
    nextHkDate = addDaysIso(hkt.date, 1);
  }
  jobState.nextHkRunHkt = `${nextHkDate} ${autoHkScanTimeHkt}`;
}

function runJson(command, args) {
  return runProcess(command, args).then((text) => {
    return JSON.parse(extractJsonLine(text));
  });
}

function extractJsonLine(text) {
  const lines = String(text || "").trim().split(/\r?\n/).reverse();
  const line = lines.find((item) => {
    const trimmed = item.trim();
    return trimmed.startsWith("{") && trimmed.endsWith("}");
  });
  if (!line) throw new Error(`No JSON object found in command output: ${String(text).slice(-500)}`);
  return line.trim();
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...buildChildEnv(), ...(options.envOverrides || {}) };
    const child = spawn(command, args, { cwd: root, env, shell: process.platform === "win32" });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${output.slice(-1000)}`));
    });
  });
}

function normalizeCnReviewDate(value) {
  const text = String(value || "").trim();
  if (/^\d{8}$/.test(text)) return text;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return `${match[1]}${match[2]}${match[3]}`;
}

function buildChildEnv() {
  const userPath = process.env.Path || process.env.PATH || "";
  const dotEnv = readDotenv(path.join(root, ".env"));
  const env = {
    ...process.env,
    ...dotEnv,
    AUTO_SCAN_ENABLED: process.env.AUTO_SCAN_ENABLED || "1",
    FUTU_USE_OPTION_VOLUME_UNIVERSE: process.env.FUTU_USE_OPTION_VOLUME_UNIVERSE || "1",
    FUTU_OPTION_SCREEN_CONTRACTS: process.env.FUTU_OPTION_SCREEN_CONTRACTS || "500",
    FUTU_MAX_SYMBOLS: process.env.FUTU_MAX_SYMBOLS || "5",
    APPDATA: process.env.APPDATA || path.join(root, ".futu-appdata"),
    Path: userPath
  };
  if (env.PATH && env.Path) delete env.PATH;
  return env;
}

function loadJobState() {
  try {
    if (existsSync(jobStatusPath)) return JSON.parse(readFileSync(jobStatusPath, "utf8"));
  } catch {
    // Ignore corrupt status; it will be rewritten on next scheduler tick.
  }
  return {
    running: false,
    lastStatus: "idle",
    lastRunAt: "",
    lastRunDateEt: "",
    lastPremarketRunAt: "",
    lastPremarketRunDateEt: "",
    lastHkRunAt: "",
    lastHkRunDateHkt: "",
    lastAttemptAt: "",
    lastAttemptDateEt: "",
    nextRunEt: "",
    nextPremarketRunEt: "",
    nextHkRunHkt: "",
    error: "",
    runningKind: "",
    openD: { connected: false, isTradingDay: false }
  };
}

function persistJobState() {
  mkdirSync(path.dirname(jobStatusPath), { recursive: true });
  writeFileSync(jobStatusPath, JSON.stringify(jobState, null, 2), "utf8");
}

function getEtParts() {
  return getMarketParts("America/New_York");
}

function getMarketParts(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: values.hour,
    minute: values.minute
  };
}

function parseTimeToMinutes(value) {
  const [hour, minute] = String(value).split(":").map((item) => Number(item));
  return hour * 60 + minute;
}

function addDaysIso(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function loadDotenv(filePath) {
  Object.assign(process.env, readDotenv(filePath));
}

function readDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    env[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}
