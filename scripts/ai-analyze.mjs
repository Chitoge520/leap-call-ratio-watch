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
const useResponsesApi = process.env.OPENAI_USE_RESPONSES !== "0" && baseUrl.includes("api.openai.com");

if (!existsSync(reportPath)) {
  throw new Error("data/latest-report.json not found. Run npm run scan:futu first.");
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));

if (!apiKey) {
  const skipped = markAiSkipped(report, "missing_openai_api_key", "OPENAI_API_KEY is not configured.");
  writeFileSync(reportPath, JSON.stringify(skipped, null, 2), "utf8");
  if (existsSync(dbPath)) await updateDatabase(skipped);
  console.log("AI analysis skipped: OPENAI_API_KEY is not configured.");
} else {
  const analyzed = await analyzeReport(report);
  writeFileSync(reportPath, JSON.stringify(analyzed, null, 2), "utf8");
  if (existsSync(dbPath)) await updateDatabase(analyzed);
  console.log(`AI analysis completed for ${analyzed.records.length} records with ${model}.`);
}

async function analyzeReport(sourceReport) {
  const records = [];
  for (const record of sourceReport.records || []) {
    const aiAnalysis = await analyzeRecord(record, sourceReport);
    records.push({ ...record, aiAnalysis });
    await sleep(Number(process.env.OPENAI_RECORD_DELAY_MS || 500));
  }
  const aiSummary = await analyzeDailySummary({ ...sourceReport, records });
  return {
    ...sourceReport,
    aiGeneratedAt: new Date().toISOString(),
    aiModel: model,
    aiStatus: {
      state: "complete",
      model,
      generatedAt: new Date().toISOString(),
      webSearch: useResponsesApi,
      error: ""
    },
    aiSummary,
    records
  };
}

async function analyzeRecord(record, report) {
  const payload = buildRecordPayload(record, report);
  const schema = recordSchema();
  const messages = [
    {
      role: "system",
      content: [
        "你是严谨的美股盘后研究分析师，专门把期权异动转化为正股研究假设。",
        "你必须优先使用用户提供的 Futu OpenD 真实行情、期权链、远月 LEAP 合约、成交量、OI 和权利金数据。",
        "当问题需要新闻、财报、估值、产业链、行业 ETF 或同行对比时，如果工具支持 web search，你必须搜索并给出来源；如果无法确认，必须写 unknown，不得编造。",
        "期权只作为资金流证据，禁止输出期权买卖建议。交易计划只能针对正股买入、加仓、卖出或降级。",
        "输出必须是严格 JSON，不要 Markdown，不要代码块。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "请围绕以下 5 个固定问题生成研究报告：",
        "1. 市场主线：这只股票是否属于当前市场主线？是板块共振还是个股孤立异动？",
        "2. 成交量：正股与期权成交是否足够支撑研究？远月 LEAP 资金流是否有意义？",
        "3. 估值预期：市场可能在押什么预期？哪些事实还缺失？",
        "4. 产业链研究：公司在产业链的位置、上游、下游、关键竞争对手和需要继续验证的问题。",
        "5. 正股计划：只针对正股，给出买入、加仓、卖出/降级条件和失效条件。",
        "",
        "要求：",
        "- 明确区分 Futu 数据事实、搜索确认的信息、推断、unknown。",
        "- 单独解释 topLeapContracts 里的远月合约，而不是只看 0DTE 来源合约。",
        "- researchSources 需要包含 title、url、publisher、usedFor；没有来源则空数组。",
        "- missingData 和 nextResearchTasks 必须具体可执行。",
        "- 如果无法回答，写 unknown，并说明需要什么数据。",
        "",
        `请按这个 JSON 结构输出：${JSON.stringify(schema)}`,
        "",
        `输入数据：${JSON.stringify(payload, null, 2)}`
      ].join("\n")
    }
  ];
  return callModelJson(messages, schema);
}

async function analyzeDailySummary(report) {
  const compact = {
    generatedAt: report.generatedAt,
    source: report.source,
    config: report.config,
    records: (report.records || []).map((record) => ({
      ticker: record.ticker,
      name: record.name,
      score: record.score,
      cpRatio: record.cpRatio,
      leapRatio: record.leapRatio,
      leapCallVolume: record.leapCallVolume,
      premiumFlow: record.premiumFlow,
      hotContract: record.hotContract,
      topLeapContracts: (record.topLeapContracts || []).slice(0, 3),
      aiVerdict: record.aiAnalysis?.marketMainline?.verdict,
      aiStance: record.aiAnalysis?.stockTradePlan?.stance,
      missingData: record.aiAnalysis?.missingData
    }))
  };
  return callModelJson(
    [
      {
        role: "system",
        content:
          "你是美股盘后研究总监。你只基于提供的 Futu 扫描结果和已完成的单票 AI 研究做日终总结。禁止给期权交易建议。输出严格 JSON。"
      },
      {
        role: "user",
        content:
          "请总结今天最值得跟踪的正股、共同产业线索、明天需要验证的 OI/正股价格条件，以及不应行动的样本。数据如下：\n" +
          JSON.stringify(compact, null, 2)
      }
    ],
    {
      headline: "",
      strongestStocks: [],
      commonThemes: [],
      tomorrowChecks: [],
      avoidList: [],
      portfolioRead: "",
      missingData: [],
      nextResearchTasks: []
    }
  );
}

function buildRecordPayload(record, report) {
  return {
    reportDate: record.date || String(report.generatedAt || "").slice(0, 10),
    ticker: record.ticker,
    name: record.name,
    futuOptionVolumeRankEvidence: {
      stockOptionVolume: record.stockOptionVolume,
      stockOptionTurnover: record.stockOptionTurnover,
      sourceTopOptionContracts: record.sourceTopOptionContracts || []
    },
    leapEvidence: {
      leapDays: report.config?.leapDays,
      hotLeapContract: record.hotContract,
      topLeapContracts: record.topLeapContracts || [],
      leapCallVolume: record.leapCallVolume,
      leapPutVolume: record.leapPutVolume,
      leapCallOi: record.leapCallOi,
      premiumFlow: record.premiumFlow,
      optionChainExpirations: record.optionChainExpirations || [],
      optionChainExpirationCount: record.optionChainExpirationCount
    },
    optionFlowMetrics: {
      score: record.score,
      cpRatio: record.cpRatio,
      leapRatio: record.leapRatio,
      leapCpRatio: record.leapCpRatio,
      totalVolume: record.totalVolume,
      callVolume: record.callVolume,
      putVolume: record.putVolume,
      qualifiedByLeapThreshold: record.qualifiedByLeapThreshold,
      leapThresholdReason: record.leapThresholdReason
    },
    optionChainSample: (record.optionChain || [])
      .filter((row) => row.isLeap || Number(row.volume || 0) > 0)
      .slice(0, 80)
      .map((row) => ({
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
}

function recordSchema() {
  return {
    executiveSummary: "",
    dataQuality: {
      verdict: "sufficient / partial / insufficient",
      issues: []
    },
    marketMainline: {
      verdict: "yes / possible / no / unknown",
      confidence: 0,
      reason: "",
      evidence: []
    },
    liquidity: {
      verdict: "sufficient / average / insufficient / unknown",
      reason: "",
      optionFlowEvidence: [],
      stockLiquidityEvidence: []
    },
    valuationExpectation: {
      verdict: "expectation_gap / fully_priced / re-rating / unknown",
      reason: "",
      whatMarketMayBePricing: [],
      missingData: []
    },
    industryResearch: {
      level: "high / medium / low / unknown",
      industryPosition: "",
      upstream: [],
      downstream: [],
      competitors: [],
      keyQuestions: []
    },
    optionFlowRead: {
      summary: "",
      leapInterpretation: "",
      abnormalEvidence: [],
      counterEvidence: []
    },
    stockTradePlan: {
      stance: "watch / buy_setup / add_setup / avoid / downgrade / unknown",
      buyConditions: [],
      addConditions: [],
      sellOrDowngradeConditions: [],
      invalidation: ""
    },
    risks: [],
    researchSources: [],
    missingData: [],
    nextResearchTasks: []
  };
}

async function callModelJson(messages, schemaHint) {
  if (useResponsesApi) {
    try {
      return await callResponsesJson(messages, schemaHint);
    } catch (error) {
      console.warn(`Responses API failed, falling back to chat completions: ${error.message}`);
    }
  }
  return callChatJson(messages, schemaHint);
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
          content: `请严格返回 JSON。结构参考：${JSON.stringify(schemaHint)}`
        }
      ]
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AI API ${response.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI response missing content");
  return JSON.parse(stripJsonFence(content));
}

async function callResponsesJson(messages, schemaHint) {
  const input = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      tools: [{ type: "web_search_preview" }],
      input:
        `${input}\n\n必须返回严格 JSON。` +
        `无法确认的事实写 unknown。researchSources 必须列出搜索或引用来源。` +
        `禁止输出期权买卖建议。JSON 结构：${JSON.stringify(schemaHint)}`
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Responses API ${response.status}: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text);
  const outputText =
    payload.output_text ||
    (payload.output || [])
      .flatMap((item) => item.content || [])
      .map((item) => item.text || "")
      .join("");
  if (!outputText) throw new Error("Responses API missing output text");
  return JSON.parse(stripJsonFence(outputText));
}

function markAiSkipped(sourceReport, reason, detail) {
  return {
    ...sourceReport,
    aiGeneratedAt: "",
    aiModel: model,
    aiStatus: {
      state: "skipped",
      reason,
      detail,
      generatedAt: new Date().toISOString(),
      webSearch: false,
      error: detail
    },
    aiSummary: null,
    records: (sourceReport.records || []).map((record) => {
      const copy = { ...record };
      delete copy.aiAnalysis;
      return copy;
    })
  };
}

function stripJsonFence(text) {
  return String(text).trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}

async function updateDatabase(report) {
  const db = new sqlite3.Database(dbPath);
  await run(db, `UPDATE scan_reports SET raw_json = ? WHERE generated_at = ?`, [
    JSON.stringify(report),
    report.generatedAt
  ]);
  for (const record of report.records || []) {
    await run(db, `UPDATE stock_records SET raw_json = ? WHERE generated_at = ? AND ticker = ?`, [
      JSON.stringify(record),
      report.generatedAt,
      record.ticker
    ]);
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
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
