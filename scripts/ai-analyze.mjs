import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "data", "latest-report.json");
const dbPath = path.join(root, "data", "leap_watch.db");

loadDotEnv(path.join(root, ".env"));

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

if (!existsSync(reportPath)) {
  throw new Error("data/latest-report.json not found. Run npm run scan:futu first.");
}
if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY. Add it to .env to enable AI analysis.");
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const analyzed = await analyzeReport(report);

writeFileSync(reportPath, JSON.stringify(analyzed, null, 2), "utf8");
if (existsSync(dbPath)) await updateDatabase(analyzed);

console.log(`AI analysis completed for ${analyzed.records.length} records.`);

async function analyzeReport(sourceReport) {
  const records = [];
  for (const record of sourceReport.records || []) {
    const aiAnalysis = await analyzeRecord(record, sourceReport.topOptionAlerts || []);
    records.push({ ...record, aiAnalysis });
    await sleep(500);
  }
  const reportAiSummary = await analyzeDailySummary({ ...sourceReport, records });
  return {
    ...sourceReport,
    aiGeneratedAt: new Date().toISOString(),
    aiModel: model,
    aiSummary: reportAiSummary,
    records
  };
}

async function analyzeRecord(record, alerts) {
  const alert = alerts.find((item) => item.ticker === record.ticker);
  const chain = Array.isArray(record.optionChain) ? record.optionChain.slice(0, 40) : [];
  const payload = {
    ticker: record.ticker,
    name: record.name,
    theme: record.theme,
    score: record.score,
    cpRatio: record.cpRatio,
    leapRatio: record.leapRatio,
    leapCpRatio: record.leapCpRatio,
    totalVolume: record.totalVolume,
    callVolume: record.callVolume,
    putVolume: record.putVolume,
    leapCallVolume: record.leapCallVolume,
    leapCallOi: record.leapCallOi,
    premiumFlow: record.premiumFlow,
    stockDollarVolume: record.stockDollarVolume,
    hotContract: record.hotContract,
    topOptionAlert: alert || null,
    optionChainSample: chain.map((row) => ({
      code: row.code,
      type: row.type,
      expiration: row.expiration,
      dte: row.daysToExpiration,
      strike: row.strike,
      volume: row.volume,
      oi: row.openInterest,
      premium: row.premium,
      bid: row.bid,
      ask: row.ask,
      iv: row.iv,
      delta: row.delta,
      isLeap: row.isLeap
    }))
  };

  const messages = [
    {
      role: "system",
      content:
        "你是一个严谨的美股盘后研究员。你只根据用户提供的富途 OpenD 真实行情、期权链、OI、成交量和权利金数据分析。不要编造新闻、财报或估值数字。不要给期权买卖建议。期权只作为资金流证据，你的交易计划必须针对股票价格和产业逻辑。输出必须是 JSON。"
    },
    {
      role: "user",
      content:
        "请分析这只股票。回答：1 是否是市场主线；2 股票/期权成交量是否充足；3 估值是否有预期以及缺哪些验证；4 产业链研究深度、上下游和关键问题；5 股票买入、加仓、卖出/降级计划。数据如下：\n" +
        JSON.stringify(payload, null, 2)
    }
  ];

  const schemaHint = {
    marketMainline: { verdict: "是/疑似/否", confidence: 0, reason: "" },
    liquidity: { verdict: "充足/一般/不足", reason: "" },
    valuationExpectation: { verdict: "有预期差/预期充分/低估修复/需要补充", reason: "", missingData: [] },
    industryResearch: { level: "高/中/低", upstream: [], downstream: [], competitors: [], keyQuestions: [] },
    optionFlowRead: { summary: "", abnormalEvidence: [] },
    stockTradePlan: { stance: "", buyConditions: [], addConditions: [], sellOrDowngradeConditions: [], invalidation: "" },
    risks: [],
    nextResearchTasks: []
  };

  return callChatJson(messages, schemaHint);
}

async function analyzeDailySummary(report) {
  const compact = {
    generatedAt: report.generatedAt,
    source: report.source,
    topOptionAlerts: report.topOptionAlerts,
    records: (report.records || []).map((record) => ({
      ticker: record.ticker,
      name: record.name,
      score: record.score,
      cpRatio: record.cpRatio,
      leapRatio: record.leapRatio,
      totalVolume: record.totalVolume,
      premiumFlow: record.premiumFlow,
      stockDollarVolume: record.stockDollarVolume,
      aiVerdict: record.aiAnalysis?.marketMainline?.verdict,
      aiStance: record.aiAnalysis?.stockTradePlan?.stance
    }))
  };
  return callChatJson(
    [
      {
        role: "system",
        content:
          "你是美股盘后研究总监。只基于提供的富途真实扫描结果做日终总结，不编造外部事实，不给期权买卖建议。输出 JSON。"
      },
      {
        role: "user",
        content:
          "请总结今天最值得跟踪的个股、共同产业线索、需要明天验证的 OI/股价条件。数据：\n" +
          JSON.stringify(compact, null, 2)
      }
    ],
    {
      headline: "",
      strongestStocks: [],
      commonThemes: [],
      tomorrowChecks: [],
      avoidList: [],
      summary: ""
    }
  );
}

async function callChatJson(messages, schemaHint) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        ...messages,
        {
          role: "user",
          content: `请严格返回 JSON，字段结构参考：${JSON.stringify(schemaHint)}`
        }
      ]
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AI API ${response.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI response missing content");
  return JSON.parse(content);
}

async function updateDatabase(report) {
  const db = new sqlite3.Database(dbPath);
  await run(
    db,
    `UPDATE scan_reports SET raw_json = ? WHERE generated_at = ?`,
    [JSON.stringify(report), report.generatedAt]
  );
  for (const record of report.records || []) {
    await run(
      db,
      `UPDATE stock_records SET raw_json = ? WHERE generated_at = ? AND ticker = ?`,
      [JSON.stringify(record), report.generatedAt, record.ticker]
    );
  }
  db.close();
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
