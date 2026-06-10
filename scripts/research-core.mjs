import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { PDFParse } from "pdf-parse";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const DATA_DIR = path.join(root, "data");
const DEFAULT_IMPORT_DIR = path.join(DATA_DIR, "research-inbox");
const DEFAULT_STORAGE_DIR = path.join(DATA_DIR, "research-files");
const DEFAULT_TEXT_DIR = path.join(DATA_DIR, "research-text");

const PRICE_KEYWORDS = ["涨价", "提价", "价格上涨", "价格上行", "报价上调", "供需缺口", "库存低位", "补库", "景气上行", "订单增长", "资本开支", "政策支持"];
const BARRIER_KEYWORDS = ["壁垒", "龙头", "稀缺", "认证", "份额", "专利", "产能", "成本优势", "客户粘性", "技术领先", "高端", "国产替代"];
const SUPPLY_KEYWORDS = ["供给", "需求", "库存", "产能", "开工率", "订单", "交付", "扩产", "紧缺", "缺口"];
const THEME_KEYWORDS = {
  "AI/算力": ["AI", "算力", "光模块", "服务器", "数据中心", "GPU", "HBM", "液冷", "CPO"],
  "半导体": ["半导体", "晶圆", "芯片", "封测", "设备", "材料", "EDA", "先进封装"],
  "新能源": ["锂", "电池", "储能", "光伏", "风电", "逆变器", "充电桩", "固态电池"],
  "机器人/高端制造": ["机器人", "人形机器人", "减速器", "丝杠", "伺服", "机床", "自动化", "工业母机"],
  "资源周期": ["铜", "铝", "煤炭", "钢铁", "黄金", "稀土", "化工", "涨价", "资源"],
  "医药": ["创新药", "医药", "器械", "CXO", "医疗", "生物", "药品"],
  "消费": ["消费", "食品", "饮料", "白酒", "旅游", "零售", "家电"],
  "军工": ["军工", "航空", "航天", "卫星", "船舶", "低空"]
};

export function loadDotenv(filePath = path.join(root, ".env")) {
  if (!existsSync(filePath)) return;
  const content = String(awaitSafeRead(filePath) || "");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function awaitSafeRead(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function getResearchPool() {
  loadDotenv();
  if (!process.env.MYSQL_URL) {
    throw new Error("MYSQL_URL is not configured. Add it to .env before using the research report database.");
  }
  return mysql.createPool(process.env.MYSQL_URL);
}

export async function ensureResearchSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_reports (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      file_hash CHAR(64) NOT NULL UNIQUE,
      file_name VARCHAR(255) NOT NULL,
      title VARCHAR(512) DEFAULT '',
      broker VARCHAR(255) DEFAULT '',
      author VARCHAR(255) DEFAULT '',
      report_date DATE NULL,
      uploaded_at DATETIME NOT NULL,
      status VARCHAR(48) NOT NULL,
      error_message TEXT NULL,
      file_path TEXT NOT NULL,
      text_path TEXT NULL,
      text_chars INT NOT NULL DEFAULT 0,
      metadata_json LONGTEXT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_report_mentions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_id BIGINT NOT NULL,
      entity_name VARCHAR(255) NOT NULL,
      ts_code VARCHAR(32) DEFAULT '',
      industry VARCHAR(255) DEFAULT '',
      product VARCHAR(255) DEFAULT '',
      chain_segment VARCHAR(255) DEFAULT '',
      mention_count INT NOT NULL DEFAULT 0,
      evidence_excerpt TEXT NULL,
      INDEX idx_report_mentions_report (report_id),
      INDEX idx_report_mentions_code (ts_code),
      CONSTRAINT fk_mentions_report FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_logic_items (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      report_id BIGINT NOT NULL,
      theme VARCHAR(255) NOT NULL,
      industry VARCHAR(255) DEFAULT '',
      price_logic TEXT NULL,
      supply_demand TEXT NULL,
      barrier_reason TEXT NULL,
      evidence_excerpt TEXT NULL,
      confidence DECIMAL(5,2) NOT NULL DEFAULT 0,
      INDEX idx_logic_theme (theme),
      CONSTRAINT fk_logic_report FOREIGN KEY (report_id) REFERENCES research_reports(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_daily_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      run_date DATE NOT NULL,
      generated_at DATETIME NOT NULL,
      status VARCHAR(48) NOT NULL,
      model VARCHAR(128) DEFAULT '',
      report_count INT NOT NULL DEFAULT 0,
      candidate_count INT NOT NULL DEFAULT 0,
      error_message TEXT NULL,
      output_json LONGTEXT NULL,
      INDEX idx_runs_date (run_date, generated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_candidates (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      run_id BIGINT NOT NULL,
      entity_name VARCHAR(255) NOT NULL,
      ts_code VARCHAR(32) DEFAULT '',
      tradable TINYINT NOT NULL DEFAULT 0,
      theme VARCHAR(255) NOT NULL,
      industry VARCHAR(255) DEFAULT '',
      chain_segment VARCHAR(255) DEFAULT '',
      price_logic TEXT NULL,
      barrier_reason TEXT NULL,
      evidence_count INT NOT NULL DEFAULT 0,
      source_report_ids TEXT NULL,
      mainline_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      price_logic_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      barrier_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      company_evidence_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      technical_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      total_score DECIMAL(6,2) NOT NULL DEFAULT 0,
      explanation LONGTEXT NULL,
      evidence_json LONGTEXT NULL,
      INDEX idx_candidates_run_score (run_id, total_score),
      INDEX idx_candidates_code (ts_code),
      CONSTRAINT fk_candidates_run FOREIGN KEY (run_id) REFERENCES research_daily_runs(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS research_candidate_technicals (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      candidate_id BIGINT NOT NULL,
      ts_code VARCHAR(32) NOT NULL,
      technical_json LONGTEXT NULL,
      trend_state VARCHAR(128) DEFAULT '',
      risk_state VARCHAR(128) DEFAULT '',
      CONSTRAINT fk_technicals_candidate FOREIGN KEY (candidate_id) REFERENCES research_candidates(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  `);
}

export async function importResearchReportsFromDirectory({ directory = process.env.RESEARCH_REPORT_IMPORT_DIR || DEFAULT_IMPORT_DIR } = {}) {
  const pool = await getResearchPool();
  try {
    await ensureResearchSchema(pool);
    await mkdir(directory, { recursive: true });
    const names = await readdir(directory);
    const files = names.filter((name) => name.toLowerCase().endsWith(".pdf")).map((name) => path.join(directory, name));
    return await importResearchReportFiles(files, { pool });
  } finally {
    await pool.end();
  }
}

export async function importResearchReportFiles(files, { pool = null } = {}) {
  const ownPool = !pool;
  const activePool = pool || await getResearchPool();
  try {
    await ensureResearchSchema(activePool);
    await mkdir(storageDir(), { recursive: true });
    await mkdir(textDir(), { recursive: true });
    const results = [];
    for (const file of files) {
      results.push(await importOnePdf(activePool, file));
    }
    return { imported: results.length, reports: results };
  } finally {
    if (ownPool) await activePool.end();
  }
}

export async function importResearchReportBuffers(files) {
  const pool = await getResearchPool();
  try {
    await ensureResearchSchema(pool);
    await mkdir(storageDir(), { recursive: true });
    await mkdir(textDir(), { recursive: true });
    const tempFiles = [];
    for (const file of files) {
      const hash = sha256(file.buffer);
      const safeName = sanitizeFileName(file.fileName || `${hash}.pdf`);
      const tempPath = path.join(storageDir(), `${hash}-${safeName}`);
      await writeFile(tempPath, file.buffer);
      tempFiles.push(tempPath);
    }
    return await importResearchReportFiles(tempFiles, { pool });
  } finally {
    await pool.end();
  }
}

async function importOnePdf(pool, sourcePath) {
  const buffer = await readFile(sourcePath);
  const hash = sha256(buffer);
  const safeName = sanitizeFileName(path.basename(sourcePath));
  const storedPath = path.join(storageDir(), `${hash}-${safeName}`);
  const textPath = path.join(textDir(), `${hash}.txt`);
  const [existing] = await pool.query("SELECT id, status, file_name FROM research_reports WHERE file_hash = ?", [hash]);
  if (existing.length) {
    return { id: existing[0].id, fileName: existing[0].file_name, status: existing[0].status, duplicate: true };
  }

  await copyFile(sourcePath, storedPath).catch(async () => {
    if (sourcePath !== storedPath) await writeFile(storedPath, buffer);
  });

  let status = "parsed";
  let errorMessage = "";
  let text = "";
  let metadata = {};
  try {
    const parsed = await extractPdfText(buffer);
    text = parsed.text.trim();
    metadata = parsed.metadata;
    if (text.length < 200) {
      status = "text_extract_failed";
      errorMessage = "PDF text extraction returned too little text. Scanned PDFs are not supported in v1.";
    } else {
      await writeFile(textPath, text, "utf8");
    }
  } catch (error) {
    status = "text_extract_failed";
    errorMessage = error.message;
  }

  const reportMeta = inferReportMeta(safeName, text, metadata);
  const [result] = await pool.query(
    `INSERT INTO research_reports
      (file_hash, file_name, title, broker, author, report_date, uploaded_at, status, error_message, file_path, text_path, text_chars, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
    [
      hash,
      safeName,
      reportMeta.title,
      reportMeta.broker,
      reportMeta.author,
      reportMeta.reportDate,
      status,
      errorMessage,
      storedPath,
      status === "parsed" ? textPath : "",
      text.length,
      JSON.stringify(metadata)
    ]
  );
  const reportId = result.insertId;
  if (status === "parsed") {
    await persistReportSignals(pool, reportId, text);
  }
  return { id: reportId, fileName: safeName, status, textChars: text.length, errorMessage };
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo().catch(() => ({}));
    return {
      text: textResult.text || "",
      metadata: {
        totalPages: textResult.total || infoResult.total || 0,
        info: infoResult.info || {}
      }
    };
  } finally {
    await parser.destroy();
  }
}

async function persistReportSignals(pool, reportId, text) {
  const stockMap = loadStockMap();
  const mentions = extractMentions(text, stockMap);
  const logicItems = extractLogicItems(text);
  for (const mention of mentions) {
    await pool.query(
      `INSERT INTO research_report_mentions
        (report_id, entity_name, ts_code, industry, product, chain_segment, mention_count, evidence_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [reportId, mention.name, mention.tsCode, mention.industry, mention.product, mention.chainSegment, mention.count, mention.evidence]
    );
  }
  for (const item of logicItems) {
    await pool.query(
      `INSERT INTO research_logic_items
        (report_id, theme, industry, price_logic, supply_demand, barrier_reason, evidence_excerpt, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [reportId, item.theme, item.industry, item.priceLogic, item.supplyDemand, item.barrierReason, item.evidence, item.confidence]
    );
  }
}

export async function runResearchSelection({ runDate = todayIso() } = {}) {
  const started = Date.now();
  const pool = await getResearchPool();
  try {
    await ensureResearchSchema(pool);
    const [reports] = await pool.query(
      "SELECT id, file_name, title, text_path, text_chars FROM research_reports WHERE status = 'parsed' ORDER BY uploaded_at DESC LIMIT 200"
    );
    const contexts = [];
    for (const report of reports) {
      const text = report.text_path ? await readFile(report.text_path, "utf8").catch(() => "") : "";
      contexts.push({ ...report, text, snippets: buildEvidenceSnippets(text) });
    }
    const local = buildLocalSelection(contexts);
    const ai = await enrichWithAi(local, contexts).catch((error) => ({
      aiStatus: { status: "failed", error: error.message },
      candidates: local.candidates
    }));
    const candidates = mergeAiCandidates(local.candidates, ai.candidates || []);
    const technicalMap = loadLatestCnTechnicals();
    const finalCandidates = candidates.map((candidate) => scoreCandidate(candidate, local, technicalMap));
    finalCandidates.sort((a, b) => b.totalScore - a.totalScore);

    const output = {
      generatedAt: new Date().toISOString(),
      runDate,
      status: "success",
      model: process.env.RESEARCH_ANALYSIS_MODEL || process.env.OPENAI_MODEL || "local",
      aiStatus: ai.aiStatus || { status: process.env.OPENAI_API_KEY ? "completed" : "skipped", reason: "OPENAI_API_KEY is not configured." },
      summary: {
        reportCount: reports.length,
        candidateCount: finalCandidates.length,
        elapsedMs: Date.now() - started,
        topThemes: local.themes.slice(0, 8)
      },
      candidates: finalCandidates.slice(0, 50)
    };

    const [runResult] = await pool.query(
      `INSERT INTO research_daily_runs
        (run_date, generated_at, status, model, report_count, candidate_count, error_message, output_json)
       VALUES (?, NOW(), 'success', ?, ?, ?, '', ?)`,
      [runDate, output.model, reports.length, output.candidates.length, JSON.stringify(output)]
    );
    await persistCandidates(pool, runResult.insertId, output.candidates);
    return output;
  } catch (error) {
    await pool.query(
      `INSERT INTO research_daily_runs
        (run_date, generated_at, status, model, report_count, candidate_count, error_message, output_json)
       VALUES (?, NOW(), 'failed', ?, 0, 0, ?, NULL)`,
      [runDate, process.env.RESEARCH_ANALYSIS_MODEL || process.env.OPENAI_MODEL || "local", error.message]
    ).catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
}

async function persistCandidates(pool, runId, candidates) {
  for (const candidate of candidates) {
    const [result] = await pool.query(
      `INSERT INTO research_candidates
        (run_id, entity_name, ts_code, tradable, theme, industry, chain_segment, price_logic, barrier_reason,
         evidence_count, source_report_ids, mainline_score, price_logic_score, barrier_score, company_evidence_score,
         technical_score, total_score, explanation, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        candidate.name,
        candidate.tsCode || "",
        candidate.tradable ? 1 : 0,
        candidate.theme,
        candidate.industry,
        candidate.chainSegment,
        candidate.priceLogic,
        candidate.barrierReason,
        candidate.evidenceCount,
        JSON.stringify(candidate.sourceReportIds || []),
        candidate.scores.mainline,
        candidate.scores.priceLogic,
        candidate.scores.barrier,
        candidate.scores.companyEvidence,
        candidate.scores.technical,
        candidate.totalScore,
        candidate.explanation,
        JSON.stringify(candidate.evidence || [])
      ]
    );
    if (candidate.technical) {
      await pool.query(
        `INSERT INTO research_candidate_technicals (candidate_id, ts_code, technical_json, trend_state, risk_state)
         VALUES (?, ?, ?, ?, ?)`,
        [result.insertId, candidate.tsCode || "", JSON.stringify(candidate.technical), candidate.technical.trendState || "", candidate.technical.riskState || ""]
      );
    }
  }
}

export async function getLatestResearchSelection() {
  const pool = await getResearchPool();
  try {
    await ensureResearchSchema(pool);
    const [rows] = await pool.query("SELECT output_json FROM research_daily_runs WHERE status = 'success' ORDER BY generated_at DESC LIMIT 1");
    if (!rows.length) return null;
    return JSON.parse(rows[0].output_json);
  } finally {
    await pool.end();
  }
}

export async function listResearchReports({ limit = 100 } = {}) {
  const pool = await getResearchPool();
  try {
    await ensureResearchSchema(pool);
    const [rows] = await pool.query(
      `SELECT id, file_name AS fileName, title, broker, author, report_date AS reportDate,
              uploaded_at AS uploadedAt, status, error_message AS errorMessage, text_chars AS textChars
       FROM research_reports
       ORDER BY uploaded_at DESC
       LIMIT ?`,
      [limit]
    );
    return { reports: rows };
  } finally {
    await pool.end();
  }
}

function buildLocalSelection(contexts) {
  const stockMap = loadStockMap();
  const byName = new Map();
  const themeCounts = new Map();
  for (const context of contexts) {
    const mentions = extractMentions(context.text, stockMap);
    const logicItems = extractLogicItems(context.text);
    for (const logic of logicItems) {
      themeCounts.set(logic.theme, (themeCounts.get(logic.theme) || 0) + 1);
    }
    for (const mention of mentions) {
      const key = mention.tsCode || mention.name;
      const current = byName.get(key) || {
        name: mention.name,
        tsCode: mention.tsCode,
        tradable: Boolean(mention.tsCode),
        industry: mention.industry,
        chainSegment: mention.chainSegment,
        theme: inferTheme(`${mention.industry} ${mention.evidence} ${context.text.slice(0, 2000)}`),
        evidence: [],
        sourceReportIds: new Set(),
        priceHits: 0,
        barrierHits: 0,
        supplyHits: 0
      };
      const reportText = context.text;
      current.sourceReportIds.add(context.id);
      current.priceHits += countAny(reportText, PRICE_KEYWORDS);
      current.barrierHits += countAny(reportText, BARRIER_KEYWORDS);
      current.supplyHits += countAny(reportText, SUPPLY_KEYWORDS);
      current.evidence.push({
        reportId: context.id,
        reportTitle: context.title || context.file_name,
        excerpt: mention.evidence
      });
      byName.set(key, current);
    }
  }
  const themes = Array.from(themeCounts.entries()).map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count);
  const candidates = Array.from(byName.values()).map((item) => ({
    ...item,
    sourceReportIds: Array.from(item.sourceReportIds),
    evidenceCount: item.evidence.length,
    priceLogic: summarizeLogic(item, "price"),
    barrierReason: summarizeLogic(item, "barrier")
  }));
  return { themes, candidates };
}

async function enrichWithAi(local, contexts) {
  loadDotenv();
  if (!process.env.OPENAI_API_KEY) {
    return { aiStatus: { status: "skipped", reason: "OPENAI_API_KEY is not configured." }, candidates: local.candidates };
  }
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.RESEARCH_ANALYSIS_MODEL || process.env.OPENAI_MODEL || "deepseek-chat";
  const payload = {
    themes: local.themes.slice(0, 12),
    candidates: local.candidates.slice(0, 30).map((item) => ({
      name: item.name,
      tsCode: item.tsCode,
      industry: item.industry,
      theme: item.theme,
      evidence: item.evidence.slice(0, 3)
    })),
    snippets: contexts.flatMap((context) => context.snippets.map((snippet) => ({ reportId: context.id, title: context.title || context.file_name, snippet }))).slice(0, 60)
  };
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是A股产业链投研助手。只基于输入研报片段，提炼涨价逻辑、主线叠加、高壁垒环节和公司候选，返回JSON。" },
        { role: "user", content: JSON.stringify(payload).slice(0, 80000) }
      ]
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AI API ${response.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  const content = json.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return {
    aiStatus: { status: "completed", model },
    candidates: Array.isArray(parsed.candidates) ? parsed.candidates : local.candidates
  };
}

function mergeAiCandidates(localCandidates, aiCandidates) {
  const byKey = new Map(localCandidates.map((item) => [item.tsCode || item.name, item]));
  for (const ai of aiCandidates) {
    const key = ai.tsCode || ai.name || ai.entityName;
    if (!key) continue;
    const current = byKey.get(key);
    if (!current) continue;
    current.theme = ai.theme || current.theme;
    current.chainSegment = ai.chainSegment || ai.segment || current.chainSegment;
    current.priceLogic = ai.priceLogic || current.priceLogic;
    current.barrierReason = ai.barrierReason || ai.barrier || current.barrierReason;
    current.aiExplanation = ai.explanation || ai.reason || "";
  }
  return Array.from(byKey.values());
}

function scoreCandidate(candidate, local, technicalMap) {
  const tech = candidate.tsCode ? technicalMap.get(candidate.tsCode) : null;
  const topThemeCount = Math.max(...local.themes.map((item) => item.count), 1);
  const themeCount = local.themes.find((item) => item.theme === candidate.theme)?.count || 1;
  const mainline = clamp((themeCount / topThemeCount) * 70 + Math.min(candidate.sourceReportIds.length, 3) * 10, 0, 100);
  const priceLogic = clamp(candidate.priceHits * 4 + candidate.supplyHits * 2 + evidenceKeywordScore(candidate.evidence, PRICE_KEYWORDS), 0, 100);
  const barrier = clamp(candidate.barrierHits * 4 + evidenceKeywordScore(candidate.evidence, BARRIER_KEYWORDS), 0, 100);
  const companyEvidence = clamp(candidate.evidenceCount * 18 + candidate.sourceReportIds.length * 20, 0, 100);
  const technical = tech ? technicalScore(tech) : 0;
  const total = clamp(mainline * 0.2 + priceLogic * 0.25 + barrier * 0.25 + companyEvidence * 0.15 + technical * 0.15, 0, 100);
  return {
    name: candidate.name,
    tsCode: candidate.tsCode || "",
    tradable: Boolean(candidate.tsCode),
    theme: candidate.theme,
    industry: candidate.industry || "",
    chainSegment: candidate.chainSegment || "",
    priceLogic: candidate.priceLogic || "研报中出现涨价、供需或景气相关描述，需人工复核具体触发因素。",
    barrierReason: candidate.barrierReason || "研报中出现壁垒、份额、认证、产能或技术领先相关描述，需人工复核。",
    evidenceCount: candidate.evidenceCount,
    sourceReportIds: candidate.sourceReportIds,
    evidence: candidate.evidence.slice(0, 6),
    scores: {
      mainline: round(mainline),
      priceLogic: round(priceLogic),
      barrier: round(barrier),
      companyEvidence: round(companyEvidence),
      technical: round(technical)
    },
    totalScore: round(total),
    technical: tech,
    explanation: candidate.aiExplanation || `${candidate.theme} 主线下，${candidate.name} 被研报提及 ${candidate.evidenceCount} 次；涨价逻辑和壁垒评分来自关键词与证据密度，技术面来自最新A股复盘数据。`
  };
}

function technicalScore(tech) {
  const factors = tech.factorScores || {};
  if (typeof factors.technical === "number") return factors.technical;
  const technical = tech.technical || {};
  const trend = tech.stockState?.includes("多头") ? 80 : tech.stockState?.includes("MA20") ? 65 : 45;
  const pivot = typeof tech.distanceToPivotPct === "number" ? clamp(100 - Math.abs(tech.distanceToPivotPct) * 4, 0, 100) : 50;
  const rsi = technical.rsi14 || 50;
  const rsiScore = clamp(100 - Math.abs(rsi - 55) * 2, 0, 100);
  return trend * 0.45 + pivot * 0.35 + rsiScore * 0.2;
}

function loadLatestCnTechnicals() {
  const result = new Map();
  const file = path.join(DATA_DIR, "latest-cn-review.json");
  if (!existsSync(file)) return result;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const row of data.strategyCandidates || []) result.set(row.code, row);
    for (const row of data.leaders || []) if (!result.has(row.code)) result.set(row.code, row);
    for (const row of data.activeTurnover || []) if (!result.has(row.code)) result.set(row.code, row);
  } catch {
    return result;
  }
  return result;
}

function loadStockMap() {
  const rows = [];
  for (const file of [path.join(DATA_DIR, "tushare-stock-basic.json"), path.join(DATA_DIR, "public-cn-stock-basic.json")]) {
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      rows.push(...(data.rows || []));
    } catch {}
  }
  const byName = new Map();
  const byCode = new Map();
  for (const row of rows) {
    if (row.name) byName.set(row.name, row);
    if (row.ts_code) byCode.set(row.ts_code, row);
  }
  return { byName, byCode, rows };
}

function extractMentions(text, stockMap) {
  const mentions = [];
  const seen = new Set();
  for (const row of stockMap.rows) {
    const name = row.name || "";
    if (!name || name.length < 2 || seen.has(name)) continue;
    const count = countOccurrences(text, name);
    if (count <= 0) continue;
    seen.add(name);
    mentions.push({
      name,
      tsCode: row.ts_code || "",
      industry: row.industry || "",
      product: "",
      chainSegment: inferChainSegment(`${row.industry || ""} ${excerptAround(text, name)}`),
      count,
      evidence: excerptAround(text, name)
    });
  }
  return mentions.sort((a, b) => b.count - a.count).slice(0, 60);
}

function extractLogicItems(text) {
  const snippets = buildEvidenceSnippets(text);
  return snippets.map((snippet) => ({
    theme: inferTheme(snippet),
    industry: "",
    priceLogic: snippetWithKeywords(snippet, PRICE_KEYWORDS),
    supplyDemand: snippetWithKeywords(snippet, SUPPLY_KEYWORDS),
    barrierReason: snippetWithKeywords(snippet, BARRIER_KEYWORDS),
    evidence: snippet,
    confidence: confidenceForSnippet(snippet)
  })).filter((item) => item.confidence > 20).slice(0, 50);
}

function buildEvidenceSnippets(text) {
  const sentences = text.replace(/\s+/g, " ").split(/[。！？；\n]/).map((item) => item.trim()).filter(Boolean);
  return sentences
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 360)
    .filter((sentence) => countAny(sentence, [...PRICE_KEYWORDS, ...BARRIER_KEYWORDS, ...SUPPLY_KEYWORDS]) > 0)
    .slice(0, 120);
}

function inferReportMeta(fileName, text, metadata) {
  const title = metadata?.info?.Title || text.split(/\r?\n/).find((line) => line.trim().length > 8)?.trim()?.slice(0, 180) || fileName.replace(/\.pdf$/i, "");
  const reportDateMatch = text.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/);
  return {
    title,
    broker: "",
    author: "",
    reportDate: reportDateMatch ? normalizeDate(reportDateMatch[0]) : null
  };
}

function normalizeDate(value) {
  const match = String(value).match(/(20\d{2})\D?(\d{1,2})\D?(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function inferTheme(text) {
  let best = "未分类主线";
  let score = 0;
  for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
    const hits = countAny(text, keywords);
    if (hits > score) {
      best = theme;
      score = hits;
    }
  }
  return best;
}

function inferChainSegment(text) {
  if (/材料|原料|上游|矿|锂|铜|硅|稀土/.test(text)) return "上游材料/资源";
  if (/设备|制造|封装|模组|零部件|丝杠|减速器/.test(text)) return "中游制造/核心部件";
  if (/应用|客户|下游|终端|运营|数据中心/.test(text)) return "下游应用/客户";
  return "产业链核心环节";
}

function summarizeLogic(item, type) {
  const evidenceText = item.evidence.map((row) => row.excerpt).join(" ");
  const keywords = type === "price" ? PRICE_KEYWORDS : BARRIER_KEYWORDS;
  const hit = keywords.find((keyword) => evidenceText.includes(keyword));
  if (type === "price") return hit ? `研报证据集中出现“${hit}”相关涨价/景气逻辑。` : "研报提及供需、景气或价格相关线索。";
  return hit ? `研报证据集中出现“${hit}”相关壁垒线索。` : "研报提及份额、技术、产能或客户壁垒线索。";
}

function confidenceForSnippet(snippet) {
  return clamp(countAny(snippet, PRICE_KEYWORDS) * 20 + countAny(snippet, BARRIER_KEYWORDS) * 18 + countAny(snippet, SUPPLY_KEYWORDS) * 12, 0, 100);
}

function evidenceKeywordScore(evidence, keywords) {
  return evidence.reduce((sum, item) => sum + countAny(item.excerpt || "", keywords) * 12, 0);
}

function snippetWithKeywords(snippet, keywords) {
  return keywords.some((keyword) => snippet.includes(keyword)) ? snippet : "";
}

function countAny(text, keywords) {
  return keywords.reduce((sum, keyword) => sum + countOccurrences(text, keyword), 0);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return String(text).split(needle).length - 1;
}

function excerptAround(text, needle, size = 90) {
  const index = text.indexOf(needle);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - size), Math.min(text.length, index + needle.length + size)).replace(/\s+/g, " ").trim();
}

function storageDir() {
  return process.env.RESEARCH_REPORT_STORAGE_DIR || DEFAULT_STORAGE_DIR;
}

function textDir() {
  return process.env.RESEARCH_REPORT_TEXT_DIR || DEFAULT_TEXT_DIR;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizeFileName(name) {
  return String(name || "report.pdf").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, Number(value) || 0));
}
