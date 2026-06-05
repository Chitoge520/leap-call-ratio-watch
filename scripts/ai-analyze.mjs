import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, process.env.AI_REPORT_PATH || path.join("data", "latest-report.json"));
const dbPath = path.join(root, "data", "leap_watch.db");
const aiUsageLogPath = path.join(root, process.env.AI_USAGE_LOG_PATH || path.join("logs", "ai-usage.jsonl"));

loadDotEnv(path.join(root, ".env"));

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const useResponsesApi = process.env.OPENAI_USE_RESPONSES !== "0" && baseUrl.includes("api.openai.com");
const agentPreset = process.env.STOCK_AGENT_PRESET || "tradingagents";
const agentReference = process.env.STOCK_AGENT_REFERENCE || "TauricResearch/TradingAgents";
const dailySummaryMode = (process.env.AI_DAILY_SUMMARY_MODE || "local").toLowerCase();
const optionChainSampleLimit = Math.max(0, Number(process.env.AI_OPTION_CHAIN_SAMPLE_LIMIT || 0));
const maxOutputTokens = Math.max(600, Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1600));

if (!existsSync(reportPath)) {
  throw new Error(`${path.relative(root, reportPath)} not found. Run the matching Futu scan first.`);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));

if (!apiKey) {
  const skipped = markAiSkipped(report, "missing_openai_api_key", "OPENAI_API_KEY is not configured.");
  writeFileSync(reportPath, JSON.stringify(skipped, null, 2), "utf8");
  if (existsSync(dbPath)) await updateDatabase(skipped);
  console.log("AI analysis skipped: OPENAI_API_KEY is not configured.");
} else {
  try {
    const analyzed = await analyzeReport(report);
    writeFileSync(reportPath, JSON.stringify(analyzed, null, 2), "utf8");
    if (existsSync(dbPath)) await updateDatabase(analyzed);
    console.log(`AI analysis completed for ${analyzed.records.length} records with ${model} (${agentPreset}).`);
  } catch (error) {
    const failed = markAiFailed(report, "ai_api_error", error.message);
    writeFileSync(reportPath, JSON.stringify(failed, null, 2), "utf8");
    if (existsSync(dbPath)) await updateDatabase(failed);
    throw error;
  }
}

async function analyzeReport(sourceReport) {
  const records = [];
  for (const record of sourceReport.records || []) {
    const aiAnalysis = await analyzeRecord(record, sourceReport);
    records.push({ ...record, aiAnalysis });
    await sleep(Number(process.env.OPENAI_RECORD_DELAY_MS || 500));
  }
  const aiSummary =
    dailySummaryMode === "ai"
      ? await analyzeDailySummary({ ...sourceReport, records })
      : buildLocalDailySummary({ ...sourceReport, records });
  return {
    ...sourceReport,
    aiGeneratedAt: new Date().toISOString(),
    aiModel: model,
    aiAgentPreset: agentPreset,
    aiAgentReference: agentReference,
    aiStatus: {
      state: "complete",
      model,
      agentPreset,
      agentReference,
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
      content: buildSystemPrompt()
    },
    {
      role: "user",
      content: [
        "Analyze one stock. Output strict JSON matching the schema.",
        "Style: Futu unusual-options feed. Start with context, sector/peers, then option tape and volatility/positioning.",
        "",
        "Rules: use supplied Futu facts first; unsupported news/valuation/industry facts must be unknown; options are evidence only, no option trade recommendation; write Simplified Chinese narrative; keep JSON keys/enums English.",
        "Must cover: market mainline, liquidity, valuation expectation, industry chain, stock-only plan, missing data.",
        "Keep it compact: each string <= 80 Chinese characters, arrays max 3 items, no markdown, no long paragraphs.",
        "",
        `Expected JSON shape: ${JSON.stringify(schema)}`,
        "",
        `Input data: ${JSON.stringify(payload)}`
      ].join("\n")
    }
  ];
  return callModelJson(messages, schema, { stage: "record", ticker: record.ticker, reportDate: record.date || String(report.generatedAt || "").slice(0, 10) });
}

function buildLocalDailySummary(report) {
  const rows = (report.records || []).map((record) => ({
    ticker: record.ticker,
    name: record.name,
    score: Number(record.score || 0),
    cpRatio: Number(record.cpRatio || 0),
    leapRatio: Number(record.leapRatio || 0),
    premiumFlow: Number(record.premiumFlow || 0),
    stance: record.aiAnalysis?.stockTradePlan?.stance || "unknown",
    headline: record.aiAnalysis?.futuStyleBrief?.headline || record.aiAnalysis?.executiveSummary || ""
  }));
  const strongest = rows.slice().sort((a, b) => b.score - a.score).slice(0, 3);
  const avoid = rows.filter((row) => /avoid|downgrade|unknown/i.test(row.stance)).slice(0, 3);
  return {
    headline: `${report.config?.market || "US"} option-volume Top${rows.length} research summary`,
    strongestStocks: strongest.map((row) => `${row.ticker} ${row.name || ""}`.trim()),
    commonThemes: ["See per-stock futuStyleBrief for sector and option-tape context."],
    tomorrowChecks: ["Check next-session OI change for top contracts.", "Confirm whether stock price follows the option-volume signal."],
    avoidList: avoid.map((row) => `${row.ticker} ${row.name || ""}`.trim()),
    portfolioRead: strongest.map((row) => `${row.ticker}: score ${row.score}, C/P ${row.cpRatio.toFixed(2)}, LEAP ratio ${row.leapRatio.toFixed(2)}`).join("; "),
    committeeRead: "Generated locally to reduce DeepSeek token usage. Per-stock AI reports remain model-generated.",
    missingData: [],
    nextResearchTasks: ["Run AI_DAILY_SUMMARY_MODE=ai only when a model-written portfolio summary is required."]
  };
}

async function analyzeDailySummary(report) {
  const compact = {
    generatedAt: report.generatedAt,
    source: report.source,
    config: report.config,
    agentPreset,
    agentReference,
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
      committeeDecision: record.aiAnalysis?.tradingAgentsReview?.portfolioManagerDecision,
      marketMainline: record.aiAnalysis?.marketMainline?.verdict,
      stockStance: record.aiAnalysis?.stockTradePlan?.stance,
      missingData: record.aiAnalysis?.missingData
    }))
  };
  return callModelJson(
    [
      {
        role: "system",
        content: [
          "You are the daily Research Manager for an after-close equity research desk covering the report's market.",
          "Use only the supplied Futu scan results and completed per-stock committee reports.",
          "Summarize stock research priorities in the style of an unusual-options daily feed: market thread, sector clusters, option tape, risk checks.",
          "Do not recommend option trades.",
          "Return strict JSON only."
        ].join("\n")
      },
      {
        role: "user",
        content:
          "Create the daily portfolio-level research summary in Simplified Chinese: strongest stocks, avoid/watch names, common themes, tomorrow checks, and unresolved data gaps. Keep JSON keys and enum values in English.\n" +
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
      committeeRead: "",
      missingData: [],
      nextResearchTasks: []
    },
    { stage: "daily_summary", ticker: "ALL", reportDate: String(report.generatedAt || "").slice(0, 10) }
  );
}

function buildSystemPrompt() {
  if (agentPreset !== "tradingagents") {
    return [
      "You are a rigorous equity research analyst.",
      "Use supplied Futu option-flow facts first. Unsupported facts are unknown.",
      "Options are evidence only; final plan is for the underlying stock. Strict JSON. Chinese narrative."
    ].join("\n");
  }

  return [
    "You are a TradingAgents-style stock research committee.",
    "Roles: fundamentals, sentiment/news, technical/flow, bull, bear, risk, portfolio manager.",
    "Use supplied Futu option-volume/OI/premium/LEAP facts first. Do not invent news, valuation, or sources.",
    "Style: Futu unusual-options feed, then committee conclusion.",
    "Options are positioning evidence only; never recommend option trades. Final plan is stock-only.",
    "Unsupported conclusions go to unknown/missingData. Strict JSON. Chinese narrative, English keys/enums."
  ].join("\n");
}

function buildRecordPayload(record, report) {
  return {
    reportDate: record.date || String(report.generatedAt || "").slice(0, 10),
    market: report.config?.market || "US",
    source: report.source || "",
    ticker: record.ticker,
    name: record.name,
    agentPreset,
    agentReference,
    futuOptionVolumeRankEvidence: {
      stockOptionVolume: record.stockOptionVolume,
      stockOptionTurnover: record.stockOptionTurnover,
      sourceTopOptionContracts: (record.sourceTopOptionContracts || []).slice(0, 5).map(compactContract)
    },
    futuFeedStyleMetrics: buildFutuFeedMetrics(record),
    leapEvidence: {
      leapDays: report.config?.leapDays,
      hotLeapContract: record.hotContract,
      topLeapContracts: (record.topLeapContracts || []).slice(0, 5).map(compactContract),
      leapCallVolume: record.leapCallVolume,
      leapPutVolume: record.leapPutVolume,
      leapCallOi: record.leapCallOi,
      premiumFlow: record.premiumFlow,
      optionChainExpirations: record.optionChainExpirations || [],
      optionChainExpirationCount: record.optionChainExpirationCount
    },
    premarketEvidence: record.premarketSnapshot || null,
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
    optionChainSample: optionChainSampleLimit
      ? (record.optionChain || [])
      .filter((row) => row.isLeap || Number(row.volume || 0) > 0)
      .slice(0, optionChainSampleLimit)
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
      : []
  };
}

function compactContract(row = {}) {
  return {
    code: row.code || row.ticker || "",
    type: row.type || "",
    expiration: row.expiration || row.expirationDate || "",
    strike: row.strike,
    volume: Number(row.volume || 0),
    openInterest: Number(row.openInterest || 0),
    premium: Number(row.premium || row.turnover || 0),
    iv: Number(row.iv || 0),
    isLeap: Boolean(row.isLeap)
  };
}

function buildFutuFeedMetrics(record) {
  const chain = Array.isArray(record.optionChain) ? record.optionChain : [];
  const sourceContracts = Array.isArray(record.sourceTopOptionContracts) ? record.sourceTopOptionContracts : [];
  const rows = chain.length ? chain : sourceContracts.map((item) => ({
    ...item,
    code: item.code,
    type: item.type,
    expiration: item.expiration,
    volume: item.volume,
    openInterest: item.openInterest,
    premium: item.premium || Number(item.turnover || 0),
    iv: item.iv
  }));
  const calls = rows.filter((row) => row.type === "call");
  const puts = rows.filter((row) => row.type === "put");
  const totalVolume = sumBy(rows, "volume") || Number(record.totalVolume || 0);
  const callVolume = sumBy(calls, "volume") || Number(record.callVolume || 0);
  const putVolume = sumBy(puts, "volume") || Number(record.putVolume || 0);
  const totalOpenInterest = sumBy(rows, "openInterest");
  const totalPremium = sumBy(rows, "premium") || Number(record.premiumFlow || 0);
  const ivValues = rows.map((row) => Number(row.iv)).filter((value) => Number.isFinite(value) && value > 0);
  const expirations = groupVolume(rows, "expiration").slice(0, 5);
  const strikes = groupVolume(rows, "strike").slice(0, 5);
  const topContracts = rows
    .slice()
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 8)
    .map((row) => ({
      code: row.code || row.ticker || "",
      type: row.type || "",
      expiration: row.expiration || row.expirationDate || "",
      strike: row.strike,
      volume: Number(row.volume || 0),
      openInterest: Number(row.openInterest || 0),
      volumeToOi: Number(row.volume || 0) / Math.max(Number(row.openInterest || 0), 1),
      premium: Number(row.premium || 0),
      iv: Number(row.iv || 0),
      isLeap: Boolean(row.isLeap)
    }));

  return {
    totalOptionVolume: totalVolume,
    callVolume,
    putVolume,
    putCallVolumeRatio: putVolume / Math.max(callVolume, 1),
    callPutVolumeRatio: callVolume / Math.max(putVolume, 1),
    totalOpenInterest,
    volumeToOpenInterest: totalVolume / Math.max(totalOpenInterest, 1),
    premiumFlow: totalPremium,
    averageIv: ivValues.length ? average(ivValues) : null,
    maxIv: ivValues.length ? Math.max(...ivValues) : null,
    ivDataAvailable: ivValues.length > 0,
    topExpirationConcentration: expirations,
    topStrikeConcentration: strikes,
    topContracts
  };
}

function sumBy(rows, key) {
  return rows.reduce((sum, row) => sum + Number(row?.[key] || 0), 0);
}

function groupVolume(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const label = String(row?.[key] ?? "").trim();
    if (!label) continue;
    const current = grouped.get(label) || { value: label, volume: 0, openInterest: 0, premium: 0 };
    current.volume += Number(row.volume || 0);
    current.openInterest += Number(row.openInterest || 0);
    current.premium += Number(row.premium || 0);
    grouped.set(label, current);
  }
  return Array.from(grouped.values()).sort((a, b) => b.volume - a.volume);
}

function average(items) {
  return items.reduce((sum, item) => sum + item, 0) / Math.max(items.length, 1);
}

function recordSchema() {
  return {
    executiveSummary: "",
    futuStyleBrief: {
      headline: "",
      openingContext: "",
      sectorAndPeers: "",
      optionTape: "",
      volatilityAndPositioning: "",
      interpretation: "",
      watchItems: [],
      confidence: 0
    },
    dataQuality: { verdict: "sufficient / partial / insufficient", issues: [] },
    marketMainline: { verdict: "yes / possible / no / unknown", confidence: 0, reason: "", evidence: [] },
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

async function callModelJson(messages, schemaHint, meta = {}) {
  const attempts = Math.max(1, Number(process.env.OPENAI_RETRY_ATTEMPTS || 3));
  const retryDelayMs = Math.max(1000, Number(process.env.OPENAI_RETRY_DELAY_MS || 15000));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (useResponsesApi) {
        try {
          return await callResponsesJson(messages, schemaHint, meta);
        } catch (error) {
          console.warn(`Responses API failed, falling back to chat completions: ${error.message}`);
        }
      }
      return await callChatJson(messages, schemaHint, meta);
    } catch (error) {
      lastError = error;
      if (isNonRetriableAiError(error)) break;
      if (attempt >= attempts) break;
      console.warn(`AI request attempt ${attempt}/${attempts} failed: ${error.message}. Retrying...`);
      await sleep(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

function isNonRetriableAiError(error) {
  const message = String(error?.message || "");
  return /AI API 40[0123]\b/.test(message) || /insufficient balance|invalid api key|unauthorized|forbidden/i.test(message);
}

async function callChatJson(messages, schemaHint, meta = {}) {
  const startedAt = Date.now();
  const requestPayload = {
    model,
    temperature: 0.2,
    max_tokens: maxOutputTokens,
    response_format: { type: "json_object" },
    messages: [
      ...messages,
      {
        role: "user",
        content: "Return strict JSON only. Chinese narrative. Keep JSON keys/enums English."
      }
    ]
  };
  const inputChars = JSON.stringify(requestPayload.messages).length;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });
  const text = await response.text();
  const durationMs = Date.now() - startedAt;
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  logAiUsage({
    ...meta,
    provider: "chat_completions",
    status: response.ok ? "success" : "error",
    httpStatus: response.status,
    durationMs,
    inputChars,
    outputChars: response.ok ? String(payload.choices?.[0]?.message?.content || "").length : text.length,
    usage: payload.usage,
    error: response.ok ? "" : text.slice(0, 500)
  });
  if (!response.ok) throw new Error(`AI API ${response.status}: ${text.slice(0, 500)}`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI response missing content");
  return JSON.parse(stripJsonFence(content));
}

async function callResponsesJson(messages, schemaHint, meta = {}) {
  const input = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
  const startedAt = Date.now();
  const requestPayload = {
    model,
    temperature: 0.2,
    max_output_tokens: maxOutputTokens,
    tools: [{ type: "web_search_preview" }],
    input:
      `${input}\n\nReturn strict JSON only. Unsupported facts must be unknown. ` +
      `Write all narrative text in Simplified Chinese. Keep JSON keys and enum values in English. ` +
      `Do not recommend option trades. JSON shape: ${JSON.stringify(schemaHint)}`
  };
  const inputChars = String(requestPayload.input).length;
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });
  const text = await response.text();
  const durationMs = Date.now() - startedAt;
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  const outputText =
    payload.output_text ||
    (payload.output || [])
      .flatMap((item) => item.content || [])
      .map((item) => item.text || "")
      .join("");
  logAiUsage({
    ...meta,
    provider: "responses",
    status: response.ok ? "success" : "error",
    httpStatus: response.status,
    durationMs,
    inputChars,
    outputChars: response.ok ? outputText.length : text.length,
    usage: payload.usage,
    error: response.ok ? "" : text.slice(0, 500)
  });
  if (!response.ok) throw new Error(`Responses API ${response.status}: ${text.slice(0, 500)}`);
  if (!outputText) throw new Error("Responses API missing output text");
  return JSON.parse(stripJsonFence(outputText));
}

function logAiUsage(entry) {
  const usage = normalizeUsage(entry.usage);
  const row = {
    timestamp: new Date().toISOString(),
    model,
    baseUrl,
    stage: entry.stage || "",
    ticker: entry.ticker || "",
    reportDate: entry.reportDate || "",
    provider: entry.provider || "",
    status: entry.status || "",
    httpStatus: entry.httpStatus || 0,
    durationMs: entry.durationMs || 0,
    inputChars: entry.inputChars || 0,
    outputChars: entry.outputChars || 0,
    estimatedInputTokens: estimateTokens(entry.inputChars || 0),
    estimatedOutputTokens: estimateTokens(entry.outputChars || 0),
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    usageSource: usage.source,
    error: entry.error || ""
  };
  mkdirSync(path.dirname(aiUsageLogPath), { recursive: true });
  appendFileSync(aiUsageLogPath, `${JSON.stringify(row)}\n`, "utf8");
  const tokenText = row.totalTokens
    ? `${row.totalTokens} tokens (${row.promptTokens || "?"}/${row.completionTokens || "?"})`
    : `~${row.estimatedInputTokens + row.estimatedOutputTokens} estimated tokens`;
  console.log(`[AI usage] ${row.stage}:${row.ticker || "-"} ${row.status} ${tokenText}, ${row.durationMs}ms`);
}

function normalizeUsage(usage = {}) {
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens) ?? 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    source: totalTokens ? "api" : "estimated"
  };
}

function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / 3.2);
}

function markAiSkipped(sourceReport, reason, detail) {
  return {
    ...sourceReport,
    aiGeneratedAt: "",
    aiModel: model,
    aiAgentPreset: agentPreset,
    aiAgentReference: agentReference,
    aiStatus: {
      state: "skipped",
      reason,
      detail,
      model,
      agentPreset,
      agentReference,
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

function markAiFailed(sourceReport, reason, detail) {
  return {
    ...sourceReport,
    aiGeneratedAt: "",
    aiModel: model,
    aiAgentPreset: agentPreset,
    aiAgentReference: agentReference,
    aiStatus: {
      state: "error",
      reason,
      detail,
      model,
      agentPreset,
      agentReference,
      generatedAt: new Date().toISOString(),
      webSearch: useResponsesApi,
      error: detail
    }
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
