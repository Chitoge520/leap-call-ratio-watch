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
const agentPreset = process.env.STOCK_AGENT_PRESET || "tradingagents";
const agentReference = process.env.STOCK_AGENT_REFERENCE || "TauricResearch/TradingAgents";

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
  console.log(`AI analysis completed for ${analyzed.records.length} records with ${model} (${agentPreset}).`);
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
        "Analyze this one stock using the TradingAgents-style committee.",
        "",
        "Required fixed questions:",
        "1. Market mainline: is this stock part of the current market theme, sector confirmation, or an isolated single-stock flow?",
        "2. Volume/liquidity: are stock liquidity and option liquidity sufficient for research? Is the LEAP flow meaningful?",
        "3. Valuation expectation: what may the market be pricing, what is already priced, and what remains unknown?",
        "4. Industry chain: company position, upstream/downstream, competitors, and questions that need verification.",
        "5. Stock plan only: buy/add/sell/downgrade/watch conditions for the underlying stock. Do not recommend option trades.",
        "",
        "Important constraints:",
        "- Separate Futu facts, model inference, and unknowns.",
        "- Explain topLeapContracts separately from 0DTE or near-term source contracts.",
        "- If web search is unavailable, researchSources can be empty, but missingData and nextResearchTasks must be concrete.",
        "- If the data cannot support a conclusion, say unknown and specify the missing data.",
        "- Write all narrative text in Simplified Chinese. Keep JSON keys and enum values in English.",
        "- Return strict JSON only. No markdown, no code block.",
        "",
        `Expected JSON shape: ${JSON.stringify(schema)}`,
        "",
        `Input data: ${JSON.stringify(payload, null, 2)}`
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
          "You are the daily Research Manager for an after-close US equity research desk.",
          "Use only the supplied Futu scan results and completed per-stock committee reports.",
          "Summarize stock research priorities. Do not recommend option trades.",
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
    }
  );
}

function buildSystemPrompt() {
  if (agentPreset !== "tradingagents") {
    return [
      "You are a rigorous US equity after-close research analyst.",
      "Use the supplied Futu OpenD option flow, option chain, OI, premium, and LEAP data first.",
      "Options are evidence only. The plan must be for the underlying stock, not option trades.",
      "Write all narrative text in Simplified Chinese. Keep JSON keys and enum values in English.",
      "Return strict JSON only."
    ].join("\n");
  }

  return [
    "You are a TradingAgents-style multi-agent stock research committee adapted for this project.",
    "Reference architecture: TauricResearch/TradingAgents. Emulate the role structure, not external execution.",
    "",
    "Roles to simulate inside one JSON answer:",
    "- Fundamentals Analyst: company quality, financial/valuation unknowns, business risks.",
    "- Sentiment/News Analyst: catalysts, news gaps, market narrative, unknown if not verifiable.",
    "- Technical/Flow Analyst: Futu option-volume rank, LEAP contracts, OI, premium, CP ratio, liquidity.",
    "- Bull Researcher: strongest bullish thesis supported by the supplied facts.",
    "- Bear Researcher: strongest skeptical thesis and failure modes.",
    "- Risk Manager: liquidity, concentration, event, valuation, and data-quality risks.",
    "- Portfolio Manager: final stock-only decision: buy_setup, add_setup, watch, avoid, downgrade, or unknown.",
    "",
    "Hard rules:",
    "- Use supplied Futu facts first. Do not invent news, financials, valuation numbers, or sources.",
    "- Mark unsupported facts as unknown and place them in missingData.",
    "- Explain long-dated topLeapContracts separately from near-term source contracts.",
    "- Options are only evidence of capital flow. Never recommend buying/selling option contracts.",
    "- The final plan is for the underlying stock only.",
    "- Write all narrative text in Simplified Chinese. Keep JSON keys and enum values in English.",
    "- Return strict JSON only. No markdown, no code block."
  ].join("\n");
}

function buildRecordPayload(record, report) {
  return {
    reportDate: record.date || String(report.generatedAt || "").slice(0, 10),
    ticker: record.ticker,
    name: record.name,
    agentPreset,
    agentReference,
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
    tradingAgentsReview: {
      fundamentalsAnalyst: {
        thesis: "",
        evidence: [],
        unknowns: []
      },
      sentimentNewsAnalyst: {
        thesis: "",
        evidence: [],
        unknowns: []
      },
      technicalFlowAnalyst: {
        thesis: "",
        nearTermContractRead: "",
        leapContractRead: "",
        evidence: [],
        counterEvidence: []
      },
      bullResearcher: {
        thesis: "",
        strongestEvidence: []
      },
      bearResearcher: {
        thesis: "",
        strongestRisks: []
      },
      riskManager: {
        riskLevel: "low / medium / high / unknown",
        reasons: [],
        requiredChecks: []
      },
      portfolioManagerDecision: {
        stance: "watch / buy_setup / add_setup / avoid / downgrade / unknown",
        confidence: 0,
        rationale: ""
      }
    },
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
          content: `Return strict JSON only. Write all narrative text in Simplified Chinese. Keep JSON keys and enum values in English. Shape reference: ${JSON.stringify(schemaHint)}`
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
        `${input}\n\nReturn strict JSON only. Unsupported facts must be unknown. ` +
        `Write all narrative text in Simplified Chinese. Keep JSON keys and enum values in English. ` +
        `Do not recommend option trades. JSON shape: ${JSON.stringify(schemaHint)}`
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
