import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const dbPath = path.join(root, "data", "leap_watch.db");

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
});

async function handleApi(url, response) {
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
    const row = generatedAt
      ? await get(`SELECT raw_json FROM scan_reports WHERE generated_at = ?`, [generatedAt])
      : date
        ? await get(`SELECT raw_json FROM scan_reports WHERE report_date = ? ORDER BY generated_at DESC LIMIT 1`, [date])
        : await get(`SELECT raw_json FROM scan_reports ORDER BY generated_at DESC LIMIT 1`);
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
