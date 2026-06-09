const STORAGE_KEY = "leap-watch-records-v2";

const demoRecords = [
  {
    ticker: "NOK",
    name: "Nokia",
    theme: "AI 网络基础设施、光网络、5G/国防通信供应链重估",
    date: "2026-05-27",
    cpRatio: 5.32,
    leapRatio: 16.64,
    totalVolume: 345900,
    callVolume: 291200,
    hotContract: "260618.C.15",
    premiumFlow: 18800000,
    stockDollarVolume: 420000000,
    relativeStrength: 72,
    streak: 3,
    oiTrend: "增长",
    marketTheme: "疑似主线",
    valuationView: "有重估预期",
    researchLevel: "中",
    industry: "通信设备 / 光网络 / AI 网络基础设施",
    upstream: "光模块、射频器件、芯片、制造外包",
    downstream: "电信运营商、云厂商、政府/国防、企业专网",
    competitors: "ERIC、CSCO、CIEN、ANET",
    catalyst:
      "远月 call 连续多日高浓度，资金可能在押 Network Infrastructure 恢复、AI/Cloud 订单、光网络需求和可信通信供应链的估值身份切换。",
    risk:
      "NOK 历史上有散户抱团痕迹。若最热合约 OI 停止增长，或宽价差吞掉入场优势，异动可能从 conviction bet 退化为 meme flow。"
  },
  {
    ticker: "INTC",
    name: "Intel",
    theme: "晶圆制造周期反转、政策补贴和代工订单兑现",
    date: "2026-05-27",
    cpRatio: 3.18,
    leapRatio: 9.42,
    totalVolume: 228600,
    callVolume: 171300,
    hotContract: "270115.C.45",
    premiumFlow: 24600000,
    stockDollarVolume: 1600000000,
    relativeStrength: 64,
    streak: 2,
    oiTrend: "增长",
    marketTheme: "疑似主线",
    valuationView: "低估修复",
    researchLevel: "高",
    industry: "半导体制造 / 晶圆代工 / CPU",
    upstream: "半导体设备、EDA、硅片、材料",
    downstream: "PC、服务器、云厂商、政府项目",
    competitors: "AMD、TSM、NVDA、AVGO",
    catalyst:
      "远月资金更像押制造业务拐点和美国本土半导体政策红利，而不是短线财报波动。若毛利率和代工订单连续改善，估值弹性会放大。",
    risk:
      "资本开支重、执行周期长。若订单兑现慢或现金流继续承压，远月 call 会变成时间价值消耗。"
  },
  {
    ticker: "SOFI",
    name: "SoFi",
    theme: "金融科技盈利能力和信贷周期改善",
    date: "2026-05-27",
    cpRatio: 4.44,
    leapRatio: 6.85,
    totalVolume: 164000,
    callVolume: 133900,
    hotContract: "SOFI260116C00020000",
    premiumFlow: 8200000,
    stockDollarVolume: 690000000,
    relativeStrength: 58,
    streak: 1,
    oiTrend: "未知",
    marketTheme: "否",
    valuationView: "有改善预期",
    researchLevel: "中",
    industry: "金融科技 / 消费金融",
    upstream: "存款、资本市场、银行牌照、风控模型",
    downstream: "个人贷款、学生贷、投资账户、支付服务",
    competitors: "AFRM、LC、HOOD、ALLY",
    catalyst: "资金可能押信贷成本稳定、盈利能力改善和金融科技估值修复。",
    risk: "单日信号还没有跨天确认，且低价成长股容易混入散户情绪。"
  },
  {
    ticker: "PLTR",
    name: "Palantir",
    theme: "AI 软件平台商业化和政府订单扩张",
    date: "2026-05-27",
    cpRatio: 1.78,
    leapRatio: 4.9,
    totalVolume: 412000,
    callVolume: 249200,
    hotContract: "260618.C.90",
    premiumFlow: 31400000,
    stockDollarVolume: 2200000000,
    relativeStrength: 81,
    streak: 4,
    oiTrend: "增长",
    marketTheme: "是",
    valuationView: "预期充分",
    researchLevel: "高",
    industry: "AI 软件 / 数据平台 / 政府科技",
    upstream: "云基础设施、数据源、模型能力、系统集成",
    downstream: "政府、国防、企业运营、金融机构",
    competitors: "MSFT、SNOW、DDOG、CRM",
    catalyst:
      "连续上榜和权利金强，但 LEAP 浓度不算极端。资金更像继续押 AI 软件收入扩张，而不是刚刚发现的新重估。",
    risk:
      "估值已经拥挤。若 C/P 不高而权利金大，可能混有对冲、滚仓或波动率交易。"
  }
];

let records = loadRecords();
let activeView = "dashboard";
let sortKey = "score";
let selectedTicker = records[0]?.ticker || "";
let topOptionAlerts = [];
let cnReview = null;
let expandedStrategyCode = "";
let cnReviewRequestId = 0;

const els = {
  pageTitle: document.querySelector("#pageTitle"),
  sampleCount: document.querySelector("#sampleCount"),
  sideSummary: document.querySelector("#sideSummary"),
  searchInput: document.querySelector("#searchInput"),
  resetData: document.querySelector("#resetData"),
  loadAutoReport: document.querySelector("#loadAutoReport"),
  loadHkReport: document.querySelector("#loadHkReport"),
  avgLeap: document.querySelector("#avgLeap"),
  avgCp: document.querySelector("#avgCp"),
  streakCount: document.querySelector("#streakCount"),
  strongCount: document.querySelector("#strongCount"),
  onlyActionable: document.querySelector("#onlyActionable"),
  alertRows: document.querySelector("#alertRows"),
  optionAlertRows: document.querySelector("#optionAlertRows"),
  refreshHistory: document.querySelector("#refreshHistory"),
  historyReportRows: document.querySelector("#historyReportRows"),
  historyTicker: document.querySelector("#historyTicker"),
  loadTickerHistory: document.querySelector("#loadTickerHistory"),
  tickerHistoryRows: document.querySelector("#tickerHistoryRows"),
  tickerList: document.querySelector("#tickerList"),
  noteTitle: document.querySelector("#noteTitle"),
  noteScore: document.querySelector("#noteScore"),
  noteContent: document.querySelector("#noteContent"),
  entryForm: document.querySelector("#entryForm"),
  jsonBox: document.querySelector("#jsonBox"),
  jsonOutput: document.querySelector("#jsonOutput"),
  importJson: document.querySelector("#importJson"),
  exportJson: document.querySelector("#exportJson"),
  jobStatusText: document.querySelector("#jobStatusText"),
  jobStatusGrid: document.querySelector("#jobStatusGrid"),
  refreshBacktest: document.querySelector("#refreshBacktest"),
  backtestSummaryRows: document.querySelector("#backtestSummaryRows"),
  backtestSignalRows: document.querySelector("#backtestSignalRows"),
  backtestTicker: document.querySelector("#backtestTicker"),
  backtestHorizon: document.querySelector("#backtestHorizon"),
  cnReviewDate: document.querySelector("#cnReviewDate"),
  loadCnReviewDate: document.querySelector("#loadCnReviewDate"),
  refreshCnReview: document.querySelector("#refreshCnReview"),
  cnReviewHeadline: document.querySelector("#cnReviewHeadline"),
  cnReviewMeta: document.querySelector("#cnReviewMeta"),
  cnStrategyRows: document.querySelector("#cnStrategyRows"),
  cnIndexGrid: document.querySelector("#cnIndexGrid"),
  cnThemeGrid: document.querySelector("#cnThemeGrid"),
  cnPlaybook: document.querySelector("#cnPlaybook"),
  cnLeaderRows: document.querySelector("#cnLeaderRows"),
  cnActiveRows: document.querySelector("#cnActiveRows"),
  cnDataGaps: document.querySelector("#cnDataGaps")
};

function loadRecords() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return demoRecords;
  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) && parsed.length ? parsed : demoRecords;
  } catch {
    return demoRecords;
  }
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

async function loadGeneratedReport({ silent = false, market = "US" } = {}) {
  try {
    const response = await fetch(market === "HK" ? "data/latest-hk-report.json" : "data/latest-report.json", { cache: "no-store" });
    if (!response.ok) throw new Error("没有找到自动扫描报告");
    const report = await response.json();
    if (!Array.isArray(report.records)) throw new Error("报告格式不正确");
    records = report.records.map(normalizeRecord);
    topOptionAlerts = Array.isArray(report.topOptionAlerts) ? dedupeOptionAlerts(report.topOptionAlerts) : buildTopStockOptionAlerts(records);
    selectedTicker = records[0]?.ticker || "";
    saveRecords();
    renderAll();
    if (!silent) alert(`已载入${market === "HK" ? "港股" : "美股"}期权异动报告：${records.length} 条记录`);
  } catch (error) {
    if (!silent) alert(`读取失败：${error.message}。请先运行 npm run scan:futu，并通过 npm start 打开网页。`);
  }
}

async function loadReportFromApi({ date, generatedAt } = {}) {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if (generatedAt) params.set("generatedAt", generatedAt);
  const response = await fetch(`/api/report?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error((await response.json()).error || "读取历史报告失败");
  const report = await response.json();
  records = report.records.map(normalizeRecord);
  topOptionAlerts = Array.isArray(report.topOptionAlerts) ? dedupeOptionAlerts(report.topOptionAlerts) : buildTopStockOptionAlerts(records);
  selectedTicker = records[0]?.ticker || "";
  saveRecords();
  renderAll();
}

async function renderHistoryReports() {
  if (!els.historyReportRows) return;
  try {
    const response = await fetch("/api/reports", { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "没有历史数据");
    const payload = await response.json();
    els.historyReportRows.innerHTML = payload.reports.length
      ? payload.reports.map((report) => `
        <tr>
          <td>${report.report_date}</td>
          <td>${String(report.generated_at || "").slice(11, 19)}</td>
          <td>${report.source || "-"}</td>
          <td>${report.scanned_symbols}</td>
          <td>${report.qualified_symbols}</td>
          <td><button class="mini-btn" data-generated-at="${report.generated_at}">载入</button></td>
        </tr>
      `).join("")
      : `<tr><td colspan="6">暂无历史报告。请先运行 npm run scan:futu。</td></tr>`;
    document.querySelectorAll(".mini-btn[data-generated-at]").forEach((button) => {
      button.addEventListener("click", async () => {
        await loadReportFromApi({ generatedAt: button.dataset.generatedAt });
        switchView("dashboard");
      });
    });
  } catch (error) {
    els.historyReportRows.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
  }
}

async function renderTickerHistory() {
  const ticker = els.historyTicker.value.trim().toUpperCase();
  if (!ticker) return;
  try {
    const response = await fetch(`/api/history?ticker=${encodeURIComponent(ticker)}`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "查询失败");
    const payload = await response.json();
    els.tickerHistoryRows.innerHTML = payload.history.length
      ? payload.history.map((row) => `
        <tr>
          <td>${row.report_date}</td>
          <td>${number(row.score).toFixed(0)}</td>
          <td>${number(row.cp_ratio).toFixed(2)}</td>
          <td>${number(row.leap_ratio).toFixed(2)}</td>
          <td>${compactNumber(row.total_volume)}</td>
          <td>${compactNumber(row.premium_flow)}</td>
          <td>${row.hot_contract || "-"}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="7">没有找到 ${ticker} 的历史记录。</td></tr>`;
  } catch (error) {
    els.tickerHistoryRows.innerHTML = `<tr><td colspan="7">${error.message}</td></tr>`;
  }
}

async function renderJobStatus() {
  if (!els.jobStatusGrid) return;
  try {
    const response = await fetch("/api/job/status", { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "job status failed");
    const status = await response.json();
    els.jobStatusText.textContent = status.running ? "running" : status.lastStatus || "idle";
    const openD = status.openD || {};
    const deepSeek = status.deepSeekBalance || {};
    els.jobStatusGrid.innerHTML = [
      ["Enabled", status.enabled ? "yes" : "no"],
      ["OpenD", openD.connected ? "connected" : "disconnected"],
      ["Trading day", openD.isTradingDay ? "yes" : "no"],
      ["DeepSeek", formatDeepSeekBalance(deepSeek)],
      ["DeepSeek check", deepSeek.lastCheckedAt ? deepSeek.lastCheckedAt.slice(0, 19).replace("T", " ") : "-"],
      ["Last run", status.lastRunAt ? status.lastRunAt.slice(0, 19).replace("T", " ") : "-"],
      ["Next ET", status.nextRunEt || "-"],
      ["Error", status.error || "-"]
    ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");
  } catch (error) {
    els.jobStatusText.textContent = "unavailable";
    els.jobStatusGrid.innerHTML = `<article><span>Error</span><strong>${error.message}</strong></article>`;
  }
}

function formatDeepSeekBalance(balance) {
  if (!balance.enabled) return "disabled";
  if (!balance.configured) return "not configured";
  if (balance.error) return "error";
  const infos = Array.isArray(balance.balanceInfos) ? balance.balanceInfos : [];
  if (!infos.length) return balance.available ? "available" : "unavailable";
  return infos.map((row) => `${row.currency || ""} ${row.totalBalance || "-"}`.trim()).join(" / ");
}

async function loadCnReview({ silent = false } = {}) {
  try {
    let response = await fetch("/api/cn-review", { cache: "no-store" });
    if (!response.ok) {
      response = await fetch("data/latest-cn-review.json", { cache: "no-store" });
    }
    if (!response.ok) throw new Error("A股复盘读取失败");
    cnReview = await response.json();
    renderCnReview();
    if (!silent) alert("已载入 A股全面复盘");
  } catch (error) {
    cnReview = null;
    renderCnReviewError(error.message);
    if (!silent) alert(`${error.message}。请先运行 npm run review:cn。`);
  }
}

async function loadCnReviewForDate({ silent = false } = {}) {
  const date = els.cnReviewDate?.value || "";
  if (!date) {
    alert("请先选择一个交易日期。");
    return;
  }
  const requestId = ++cnReviewRequestId;
  const button = els.loadCnReviewDate;
  const refreshButton = els.refreshCnReview;
  const previousText = button?.textContent || "";
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "获取中...";
    }
    if (refreshButton) refreshButton.disabled = true;
    if (els.cnReviewHeadline) els.cnReviewHeadline.textContent = `正在获取 ${date} 的A股复盘数据...`;
    const response = await fetch(`/api/cn-review/run?date=${encodeURIComponent(date)}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "该日期复盘生成失败");
    if (requestId !== cnReviewRequestId) return;
    cnReview = payload;
    renderCnReview();
    if (!silent) alert(`已生成 ${date} 的A股复盘。`);
  } catch (error) {
    if (requestId !== cnReviewRequestId) return;
    renderCnReviewError(error.message);
    if (!silent) alert(`${error.message}。如果是 Tushare 频控，请稍后重试或换一个已缓存日期。`);
  } finally {
    if (requestId === cnReviewRequestId && button) {
      button.disabled = false;
      button.textContent = previousText || "获取该日期";
    }
    if (requestId === cnReviewRequestId && refreshButton) refreshButton.disabled = false;
  }
}

function renderCnReview() {
  if (!els.cnReviewHeadline) return;
  if (!cnReview) {
    renderCnReviewError("暂无 A股复盘。请先运行 npm run review:cn。");
    return;
  }
  const summary = cnReview.summary || {};
  const playbook = cnReview.playbook || {};
  if (els.cnReviewDate && summary.reviewDate) {
    els.cnReviewDate.value = summary.reviewDate;
  }
  els.cnReviewHeadline.textContent = playbook.headline || "A股全面复盘已生成。";
  els.cnReviewMeta.innerHTML = [
    ["市场状态", summary.marketState || "-"],
    ["情绪温度", `${summary.emotionScore ?? "-"} / 100`],
    ["上涨/下跌", `${summary.advancers ?? 0} / ${summary.decliners ?? 0}`],
    ["涨停/跌停", `${summary.limitUp ?? 0} / ${summary.limitDown ?? 0}`],
    ["成交额", compactCn(summary.totalTurnover)],
    ["覆盖股票", `${summary.stockCoverage ?? 0}`]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");

  els.cnIndexGrid.innerHTML = (cnReview.indices || []).map((row) => `
    <article>
      <span>${row.name || row.code}</span>
      <strong class="${number(row.changeRate) >= 0 ? "positive" : "negative"}">${formatSignedPct(row.changeRate)}</strong>
      <small>${formatPrice(row.lastPrice)} · ${compactCn(row.turnover)}</small>
    </article>
  `).join("");

  els.cnThemeGrid.innerHTML = (cnReview.themes || []).slice(0, 8).map((theme) => `
    <article>
      <div class="cn-theme-head">
        <strong>${theme.theme}</strong>
        <span>${theme.heatScore}</span>
      </div>
      <p>均涨幅 ${formatSignedPct(theme.averageChangeRate)} · 上涨占比 ${(number(theme.breadth) * 100).toFixed(1)}% · 涨停 ${theme.limitUp}</p>
      <small>${(theme.leaders || []).slice(0, 3).map((row) => `${row.name} ${formatSignedPct(row.changeRate)}`).join(" / ") || "-"}</small>
    </article>
  `).join("");

  els.cnPlaybook.innerHTML = `
    <article>
      <h4>仓位与节奏</h4>
      <p>${playbook.position || "-"}</p>
    </article>
    <article>
      <h4>确认信号</h4>
      ${renderCnList(playbook.confirmations)}
    </article>
    <article>
      <h4>风险线</h4>
      ${renderCnList(playbook.risks)}
    </article>
    <article>
      <h4>观察名单</h4>
      ${renderCnStockChips(playbook.watchlist)}
    </article>
  `;

  renderStrategyBoard(cnReview.strategyCandidates || []);
  renderCnRows(els.cnLeaderRows, (cnReview.leaders || []).slice(0, 12));
  renderCnRows(els.cnActiveRows, (cnReview.activeTurnover || []).slice(0, 12));
  els.cnDataGaps.innerHTML = renderCnList(cnReview.dataGaps);
}

function renderCnReviewError(message) {
  if (!els.cnReviewHeadline) return;
  els.cnReviewHeadline.textContent = message;
  if (els.cnReviewMeta) els.cnReviewMeta.innerHTML = "";
  if (els.cnIndexGrid) els.cnIndexGrid.innerHTML = "";
  if (els.cnThemeGrid) els.cnThemeGrid.innerHTML = "";
  if (els.cnPlaybook) els.cnPlaybook.innerHTML = "";
  if (els.cnStrategyRows) els.cnStrategyRows.innerHTML = `<tr><td colspan="20">${message}</td></tr>`;
  if (els.cnLeaderRows) els.cnLeaderRows.innerHTML = `<tr><td colspan="5">${message}</td></tr>`;
  if (els.cnActiveRows) els.cnActiveRows.innerHTML = `<tr><td colspan="5">${message}</td></tr>`;
  if (els.cnDataGaps) els.cnDataGaps.innerHTML = "";
}

function renderStrategyBoard(rows) {
  if (!els.cnStrategyRows) return;
  const visible = Array.isArray(rows) ? rows.slice(0, 10) : [];
  els.cnStrategyRows.innerHTML = visible.length
    ? visible.map((row, index) => `
      <tr class="strategy-main-row ${expandedStrategyCode === row.code ? "expanded" : ""}" data-code="${row.code}">
        <td>${index + 1}</td>
        <td><strong>${row.code || "-"}</strong></td>
        <td>${row.name || "-"}</td>
        <td>${strategyPill(row.theme || "-", "neutral")}</td>
        <td>${strategyPill(row.signalLight || "-", signalTone(row.signalLight))}</td>
        <td>${strategyPill(row.stockState || "-", stockStateTone(row.stockState))}</td>
        <td>${strategyPill(row.pivotStage || "-", pivotStageTone(row.pivotStage))}</td>
        <td>${strategyPill(row.buyPointType || "-", buyPointTone(row.buyPointType))}</td>
        <td>${strategyPill(row.buyPointGrade || "-", "cream")}</td>
        <td>${strategyPill(row.actionState || "-", actionTone(row.actionState))}</td>
        <td>${strategyPill(row.buyPointQuality || "-", qualityTone(row.buyPointQuality))}</td>
        <td>${number(row.commentScore).toFixed(1)}</td>
        <td>${strategyPill(row.rating || "-", row.rating?.startsWith("A") ? "red" : "orange")}</td>
        <td>${row.selected ? "入选" : "-"}</td>
        <td>${number(row.totalScore).toFixed(1)}</td>
        <td>${number(row.rs).toFixed(1)}</td>
        <td>${number(row.pivotScore).toFixed(1)}</td>
        <td>${formatPct(row.distanceToPivotPct, 1)}</td>
        <td>${row.financialQuality || "-"}</td>
        <td>${row.earlyVcp || "-"}</td>
      </tr>
      ${expandedStrategyCode === row.code ? renderStrategyDetailRow(row) : ""}
    `).join("")
    : `<tr><td colspan="20">暂无策略候选。请重新运行 <code>npm run review:cn</code> 生成包含技术面指标的复盘。</td></tr>`;

  document.querySelectorAll(".strategy-main-row[data-code]").forEach((row) => {
    row.addEventListener("click", () => {
      expandedStrategyCode = expandedStrategyCode === row.dataset.code ? "" : row.dataset.code;
      renderStrategyBoard(rows);
    });
  });
}

function renderStrategyDetailRow(row) {
  const decision = row.strategyDecision || {};
  const scores = decision.scores || {};
  const technical = row.technical || {};
  const entry = decision.entryZone || {};
  return `
    <tr class="strategy-detail-row">
      <td colspan="20">
        <div class="strategy-detail-card">
          <section>
            <h4>TradingAgents 决策</h4>
            <div class="strategy-detail-grid">
              <article><span>决策</span><strong>${decision.decision || "-"}</strong></article>
              <article><span>市场门控</span><strong>${decision.marketRegime || "-"}</strong></article>
              <article><span>入场区</span><strong>${formatPrice(entry.low)} - ${formatPrice(entry.high)}</strong></article>
              <article><span>止损</span><strong>${formatPrice(decision.stopLoss)}</strong></article>
              <article><span>目标</span><strong>${formatPrice(decision.takeProfit)}</strong></article>
              <article><span>仓位</span><strong>${number(decision.positionWeightPct).toFixed(1)}%</strong></article>
            </div>
          </section>
          <section>
            <h4>分项得分</h4>
            <div class="strategy-score-bars">
              ${renderScoreBar("消息/主题", scores.newsTheme)}
              ${renderScoreBar("技术面", scores.technical)}
              ${renderScoreBar("买点", scores.buyPoint)}
              ${renderScoreBar("市场", scores.market)}
              ${renderScoreBar("风险扣分", scores.riskPenalty, true)}
            </div>
          </section>
          <section>
            <h4>技术读数</h4>
            <div class="strategy-tech-list">
              <span>MA20 ${formatPrice(technical.ma20)}</span>
              <span>MA60 ${formatPrice(technical.ma60)}</span>
              <span>RSI ${number(technical.rsi14).toFixed(1)}</span>
              <span>MACD柱 ${number(technical.macdHist).toFixed(3)}</span>
              <span>量比 ${number(technical.volumeRatio).toFixed(1)}</span>
              <span>ATR ${formatPrice(technical.atr14)}</span>
            </div>
          </section>
          <section>
            <h4>买入条件</h4>
            ${renderCnList(decision.buyConditions)}
          </section>
          <section>
            <h4>卖出/降级条件</h4>
            ${renderCnList(decision.sellConditions)}
          </section>
          <section>
            <h4>风险标记</h4>
            ${renderCnList(decision.riskFlags)}
            <p class="strategy-invalidation">${decision.invalidation || ""}</p>
          </section>
        </div>
      </td>
    </tr>
  `;
}

function renderScoreBar(label, value, inverse = false) {
  const score = Math.max(0, Math.min(number(value), 100));
  return `
    <div class="strategy-score-bar">
      <span>${label}</span>
      <div><i style="width:${score}%"></i></div>
      <strong class="${inverse && score > 20 ? "negative" : ""}">${score.toFixed(1)}</strong>
    </div>
  `;
}

function strategyPill(label, tone) {
  return `<span class="strategy-pill ${tone || "neutral"}">${label}</span>`;
}

function signalTone(label) {
  if (/金钻|突破|触发|达标/.test(label || "")) return "orange";
  if (/观察|回踩|待破/.test(label || "")) return "gold";
  if (/过滤|弱势/.test(label || "")) return "red";
  return "neutral";
}

function stockStateTone(label) {
  if (/主升|右侧|强势/.test(label || "")) return "gold";
  if (/高位|下方/.test(label || "")) return "red";
  return "neutral";
}

function pivotStageTone(label) {
  if (/VCP|首次|回踩/.test(label || "")) return "orange";
  if (/延伸/.test(label || "")) return "red";
  return "neutral";
}

function buyPointTone(label) {
  if (/突破|VCP/.test(label || "")) return "orange";
  if (/回踩/.test(label || "")) return "green";
  if (/延伸/.test(label || "")) return "red";
  return "neutral";
}

function actionTone(label) {
  if (/可执行/.test(label || "")) return "green";
  if (/等待|观察/.test(label || "")) return "orange";
  return "red";
}

function qualityTone(label) {
  if (/A\+|A/.test(label || "")) return "green";
  if (/过热|C/.test(label || "")) return "red";
  return "orange";
}

function renderCnRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows.length
    ? rows.map((row) => `
      <tr>
        <td><strong>${row.code || row.ticker || "-"}</strong></td>
        <td>${row.name || "-"}</td>
        <td class="${number(row.changeRate) >= 0 ? "positive" : "negative"}">${formatSignedPct(row.changeRate)}</td>
        <td>${compactCn(row.turnover)}</td>
        <td>${row.theme || "-"}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="5">暂无数据</td></tr>`;
}

function renderCnList(items) {
  if (!Array.isArray(items) || !items.length) return "<p>暂无</p>";
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function renderCnStockChips(items) {
  if (!Array.isArray(items) || !items.length) return "<p>暂无</p>";
  return `<div class="cn-stock-chips">${items.map((row) => `
    <span><strong>${row.name || row.code}</strong>${formatSignedPct(row.changeRate)} · ${row.theme || "-"}</span>
  `).join("")}</div>`;
}

function compactCn(value) {
  const n = number(value);
  if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

function formatSignedPct(value) {
  const n = number(value, NaN);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

async function renderBacktest() {
  await Promise.all([renderBacktestSummary(), renderBacktestSignals()]);
}

async function renderBacktestSummary() {
  if (!els.backtestSummaryRows) return;
  try {
    const response = await fetch("/api/backtest/summary", { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "backtest summary failed");
    const payload = await response.json();
    const rows = (payload.summary || []).sort((a, b) => a.horizonDays - b.horizonDays || String(a.group).localeCompare(String(b.group)));
    els.backtestSummaryRows.innerHTML = rows.length
      ? rows.map((row) => `
        <tr>
          <td>${row.horizonDays}D</td>
          <td>${formatGroup(row.group)}</td>
          <td>${row.completedSamples} / ${row.totalSamples}</td>
          <td>${formatPct(row.winRate, 1, true)}</td>
          <td>${formatPct(row.averageReturnPct)}</td>
          <td>${formatPct(row.medianReturnPct)}</td>
          <td>${formatPct(row.maxDrawdownPct)}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="7">No completed backtest data yet. New Top5 signals start as pending until enough trading days pass.</td></tr>`;
  } catch (error) {
    els.backtestSummaryRows.innerHTML = `<tr><td colspan="7">${error.message}</td></tr>`;
  }
}

async function renderBacktestSignals() {
  if (!els.backtestSignalRows) return;
  const params = new URLSearchParams();
  const ticker = els.backtestTicker?.value.trim().toUpperCase();
  const horizon = els.backtestHorizon?.value;
  if (ticker) params.set("ticker", ticker);
  if (horizon) params.set("horizon", horizon);
  try {
    const response = await fetch(`/api/backtest/signals?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json()).error || "backtest signals failed");
    const payload = await response.json();
    els.backtestSignalRows.innerHTML = (payload.signals || []).length
      ? payload.signals.map((row) => `
        <tr>
          <td>${row.report_date || "-"}</td>
          <td><strong>${row.ticker}</strong><div class="small">${row.qualified_by_leap ? "LEAP qualified" : "LEAP unqualified"}</div></td>
          <td>${row.horizon_days ? `${row.horizon_days}D` : "-"}</td>
          <td>${row.entry_date || "-"}<div class="small">${formatPrice(row.entry_close)}</div></td>
          <td>${row.exit_date || row.status || "-"}<div class="small">${formatPrice(row.exit_close)}</div></td>
          <td>${row.status === "complete" ? formatPct(row.return_pct) : "pending"}</td>
          <td>${number(row.score).toFixed(0)}<div class="small">Opt vol ${compactNumber(row.option_volume)}</div></td>
          <td>${formatContracts(row.sourceTopOptionContracts)}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="8">No signal rows found.</td></tr>`;
  } catch (error) {
    els.backtestSignalRows.innerHTML = `<tr><td colspan="8">${error.message}</td></tr>`;
  }
}

function normalizeRecord(record) {
  const ticker = String(record.ticker || "").toUpperCase();
  const normalized = {
    ...record,
    ticker,
    name: record.name && record.name !== ticker ? record.name : inferCompanyName(ticker),
    cpRatio: number(record.cpRatio),
    leapRatio: number(record.leapRatio),
    totalVolume: number(record.totalVolume),
    callVolume: number(record.callVolume),
    premiumFlow: number(record.premiumFlow),
    stockDollarVolume: number(record.stockDollarVolume),
    relativeStrength: number(record.relativeStrength),
    streak: number(record.streak, 1),
    catalyst: record.catalyst || record.note || "",
    risk: record.risk || "自动扫描记录需要继续确认 OI、价差、公司催化和股价相对强度。"
  };
  return {
    ...normalized,
    marketTheme: record.marketTheme || inferMarketTheme(normalized).label,
    valuationView: record.valuationView || inferValuation(normalized).label,
    researchLevel: record.researchLevel || inferResearchProfile(normalized).level,
    industry: record.industry || inferResearchProfile(normalized).industry,
    upstream: record.upstream || inferResearchProfile(normalized).upstream,
    downstream: record.downstream || inferResearchProfile(normalized).downstream,
    competitors: record.competitors || inferResearchProfile(normalized).competitors
  };
}

function displayName(record) {
  return `${record.ticker}${record.name && record.name !== record.ticker ? ` · ${record.name}` : ""}`;
}

function inferCompanyName(ticker) {
  const names = {
    NOK: "Nokia",
    INTC: "Intel",
    T: "AT&T",
    PLTR: "Palantir",
    AAPL: "Apple",
    MSFT: "Microsoft",
    NVDA: "NVIDIA",
    AMD: "AMD",
    TSLA: "Tesla",
    AMZN: "Amazon",
    GOOGL: "Alphabet",
    META: "Meta Platforms",
    SMCI: "Super Micro Computer",
    SOFI: "SoFi Technologies",
    RIVN: "Rivian"
  };
  return names[ticker] || ticker;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactNumber(value) {
  const n = number(value);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatPct(value, digits = 2, ratio = false) {
  if (value === null || value === undefined || value === "") return "-";
  const n = number(value, NaN);
  if (!Number.isFinite(n)) return "-";
  return `${(ratio ? n * 100 : n).toFixed(digits)}%`;
}

function formatPrice(value) {
  const n = number(value, NaN);
  return Number.isFinite(n) ? n.toFixed(2) : "-";
}

function formatGroup(group) {
  const labels = {
    all: "All Top5",
    leap_qualified: "LEAP qualified",
    leap_unqualified: "LEAP unqualified",
    call_dominant: "Call dominant",
    put_dominant: "Put dominant",
    score_high: "Score high",
    score_mid: "Score mid",
    score_low: "Score low"
  };
  return labels[group] || group || "-";
}

function formatContracts(contracts) {
  if (!Array.isArray(contracts) || !contracts.length) return "-";
  return contracts.slice(0, 3).map((item) => {
    const name = item.code || item.name || "-";
    const volume = compactNumber(item.volume);
    return `<div><strong>${name}</strong><span class="small"> ${item.type || ""} vol ${volume}</span></div>`;
  }).join("");
}

function callShare(record) {
  const total = number(record.totalVolume);
  return total ? number(record.callVolume) / total : 0;
}

function normalize(value, max) {
  return Math.min(number(value) / max, 1);
}

function scoreRecord(record) {
  const leap = normalize(record.leapRatio, 18) * 30;
  const cp = normalize(record.cpRatio, 6) * 16;
  const call = callShare(record) * 12;
  const premium = normalize(record.premiumFlow, 35_000_000) * 12;
  const streak = normalize(record.streak, 5) * 10;
  const oi = record.oiTrend === "增长" ? 8 : record.oiTrend === "持平" ? 3 : record.oiTrend === "下降" ? -8 : 1;
  const theme = inferMarketTheme(record).score * 0.08;
  const liquidity = inferLiquidity(record).score * 0.04;
  return Math.max(0, Math.min(100, Math.round(leap + cp + call + premium + streak + oi + theme + liquidity)));
}

function classify(record) {
  const score = scoreRecord(record);
  if (record.oiTrend === "下降") return "退场警报";
  if (score >= 78 && number(record.streak) >= 2 && number(record.leapRatio) >= 8) return "Conviction bet";
  if (number(record.leapRatio) >= 6 && number(record.cpRatio) >= 2.5) return "定向押注";
  if (number(record.premiumFlow) >= 20_000_000 && number(record.cpRatio) < 2) return "混合资金流";
  return "待确认异动";
}

function badgeClass(record) {
  const label = classify(record);
  if (label === "Conviction bet" || label === "定向押注") return "good";
  if (label === "退场警报") return "bad";
  return "warn";
}

function inferMarketTheme(record) {
  const text = `${record.theme || ""} ${record.industry || ""} ${record.catalyst || ""}`.toLowerCase();
  const hotWords = ["ai", "人工智能", "半导体", "gpu", "光网络", "数据中心", "电力", "核能", "机器人", "国防", "crypto", "加密"];
  const themeHits = hotWords.filter((word) => text.includes(word.toLowerCase())).length;
  const rs = number(record.relativeStrength);
  const flowScore = scoreRecordLight(record);
  const score = Math.min(100, themeHits * 22 + normalize(rs, 100) * 24 + normalize(flowScore, 100) * 28 + normalize(record.streak, 3) * 26);
  let label = "否";
  if (record.marketTheme) label = record.marketTheme;
  else if (score >= 75) label = "是";
  else if (score >= 52) label = "疑似";
  return { label, score: Math.round(score), hits: themeHits };
}

function scoreRecordLight(record) {
  return normalize(record.leapRatio, 10) * 40 + normalize(record.cpRatio, 4) * 25 + callShare(record) * 20 + normalize(record.premiumFlow, 25_000_000) * 15;
}

function inferLiquidity(record) {
  const stockDollarVolume = number(record.stockDollarVolume);
  const optionVolume = number(record.totalVolume);
  const premium = number(record.premiumFlow);
  let label = "一般";
  let score = 45;
  if (stockDollarVolume >= 100_000_000 || optionVolume >= 100_000 || premium >= 10_000_000) {
    label = "充足";
    score = 82;
  }
  if ((stockDollarVolume > 0 && stockDollarVolume < 30_000_000) || optionVolume < 20_000) {
    label = "不足";
    score = 30;
  }
  return { label, score, stockDollarVolume, optionVolume, premium };
}

function inferValuation(record) {
  if (record.valuationView) return { label: record.valuationView, score: 70 };
  const text = `${record.theme || ""} ${record.catalyst || ""}`.toLowerCase();
  if (text.includes("重估") || text.includes("修复") || text.includes("turnaround")) return { label: "有重估预期", score: 78 };
  if (text.includes("ai") || text.includes("人工智能") || text.includes("gpu")) return { label: "预期较充分，需要业绩兑现", score: 62 };
  if (number(record.leapRatio) >= 8 && number(record.cpRatio) >= 2.5) return { label: "有预期差", score: 70 };
  return { label: "需要补充估值数据", score: 45 };
}

function inferResearchProfile(record) {
  const map = {
    NOK: ["中", "通信设备 / 光网络 / AI 网络基础设施", "光模块、射频器件、芯片、制造外包", "电信运营商、云厂商、政府/国防、企业专网", "ERIC、CSCO、CIEN、ANET"],
    INTC: ["高", "半导体制造 / 晶圆代工 / CPU", "半导体设备、EDA、硅片、材料", "PC、服务器、云厂商、政府项目", "AMD、TSM、NVDA、AVGO"],
    NVDA: ["高", "AI 加速计算 / GPU / 数据中心", "台积电、HBM、先进封装、服务器 ODM", "云厂商、企业 AI、主权 AI、汽车", "AMD、AVGO、GOOGL、MSFT"],
    AMD: ["高", "AI GPU / CPU / 数据中心芯片", "台积电、HBM、主板、服务器 ODM", "云厂商、企业服务器、PC", "NVDA、INTC、AVGO"],
    PLTR: ["高", "AI 软件 / 数据平台 / 政府科技", "云基础设施、数据源、模型能力、系统集成", "政府、国防、企业运营、金融机构", "MSFT、SNOW、DDOG、CRM"],
    SOFI: ["中", "金融科技 / 消费金融", "存款、资本市场、银行牌照、风控模型", "个人贷款、学生贷、投资账户、支付服务", "AFRM、LC、HOOD、ALLY"],
    T: ["中", "电信运营商 / 现金流资产", "网络设备、频谱、光纤建设", "移动用户、企业连接、宽带家庭", "VZ、TMUS、CMCSA"]
  };
  const row = map[record.ticker] || ["低", record.industry || "待补充行业", record.upstream || "待补充上游", record.downstream || "待补充下游", record.competitors || "待补充竞争对手"];
  return { level: row[0], industry: row[1], upstream: row[2], downstream: row[3], competitors: row[4] };
}

function buildTradePlan(record) {
  const score = scoreRecord(record);
  const liquidity = inferLiquidity(record);
  const theme = inferMarketTheme(record);
  const stance =
    record.oiTrend === "下降"
      ? "避免新开仓，先观察资金是否重新回来。"
      : score >= 78 && liquidity.label !== "不足"
        ? "可以小仓试，等待 OI 和股价结构二次确认后再加。"
        : score >= 62
          ? "进入 watchlist，先等次日 OI、板块强度和价差确认。"
          : "只观察，不急着交易。";

  return {
    stance,
    buy: [
      "股价不破关键支撑，或放量突破最近平台。",
      `${record.hotContract || "最热远月合约"} 的 OI 次日继续增长。`,
      `主题判断维持在“${theme.label}”，且板块不是单票孤立异动。`
    ],
    add: [
      "期权成交继续集中在 call 侧，C/P 没有快速回落。",
      "股票成交额和相对强度同步放大。",
      "新闻、财报或订单验证当前叙事。"
    ],
    sell: [
      "LEAP call OI 停止增长或转为下降。",
      "股价跌破突破位或关键均线，且板块同步走弱。",
      "估值预期无法兑现，或催化被证伪。"
    ],
    risk: liquidity.label === "不足" ? "流动性不足时只允许限价单，并降低仓位。" : "避免市价追远月宽价差合约。"
  };
}

function renderOptionChain(record) {
  const rows = Array.isArray(record.optionChain) ? record.optionChain : [];
  const expirations = Array.isArray(record.optionChainExpirations) ? record.optionChainExpirations : [];
  if (!rows.length) {
    return `<p>当前报告没有包含期权链原始数据。请重新运行 <code>npm run scan:futu</code> 生成包含 optionChain 的报告。</p>`;
  }
  return `
    <div class="chain-toolbar">
      <span>共保留 ${rows.length} 条记录，覆盖 ${expirations.length || "-"} 个到期日${expirations.length ? `：${expirations.slice(0, 6).join(" / ")}${expirations.length > 6 ? " ..." : ""}` : ""}</span>
    </div>
    <div class="chain-table-wrap">
      <table class="chain-table">
        <thead>
          <tr>
            <th>合约代码</th>
            <th>类型</th>
            <th>到期日</th>
            <th>DTE</th>
            <th>Strike</th>
            <th>Volume</th>
            <th>OI</th>
            <th>Bid/Ask</th>
            <th>IV</th>
            <th>Delta</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><strong>${row.code || "-"}</strong><div class="small">${row.name || ""}</div></td>
              <td><span class="tag ${row.type === "call" ? "good" : "warn"}">${row.type || "-"}</span>${row.isLeap ? '<div class="small">LEAP</div>' : ""}</td>
              <td>${row.expiration || "-"}</td>
              <td>${row.daysToExpiration ?? "-"}</td>
              <td>${number(row.strike).toFixed(2)}</td>
              <td>${compactNumber(row.volume)}</td>
              <td>${compactNumber(row.openInterest)}</td>
              <td>${number(row.bid).toFixed(2)} / ${number(row.ask).toFixed(2)}</td>
              <td>${number(row.iv).toFixed(2)}</td>
              <td>${number(row.delta).toFixed(3)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function filteredRecords() {
  const q = els.searchInput.value.trim().toLowerCase();
  const onlyActionable = els.onlyActionable?.checked;
  return records
    .map(normalizeRecord)
    .filter((record) => {
      const haystack = [
        record.ticker,
        record.name,
        record.theme,
        record.hotContract,
        record.catalyst,
        record.risk,
        record.industry,
        record.upstream,
        record.downstream,
        record.competitors,
        record.marketTheme,
        record.valuationView
      ].join(" ").toLowerCase();
      return (!q || haystack.includes(q)) && (!onlyActionable || scoreRecord(record) >= 65);
    })
    .sort((a, b) => {
      if (sortKey === "score") return scoreRecord(b) - scoreRecord(a);
      return number(b[sortKey]) - number(a[sortKey]);
    });
}

function renderDashboard() {
  const rows = filteredRecords();
  renderOptionAlerts();
  els.alertRows.innerHTML = rows
    .map((record) => {
      const score = scoreRecord(record);
      const share = callShare(record);
      const theme = inferMarketTheme(record);
      const liquidity = inferLiquidity(record);
      return `
        <tr data-ticker="${record.ticker}">
          <td class="ticker-cell"><strong>${record.ticker}</strong><span>${record.name || ""}</span></td>
          <td><span class="score">${score}</span></td>
          <td>${number(record.cpRatio).toFixed(2)}</td>
          <td>${number(record.leapRatio).toFixed(2)}</td>
          <td><strong>${record.hotContract || "-"}</strong><div class="small">权利金 ${compactNumber(record.premiumFlow)}</div><div class="small">来源期权量 ${compactNumber(record.stockOptionVolume || record.totalVolume)}</div></td>
          <td>${(share * 100).toFixed(1)}%<div class="small">${compactNumber(record.callVolume)} / ${compactNumber(record.totalVolume)}</div></td>
          <td><span class="tag ${theme.label === "是" ? "good" : theme.label === "否" ? "bad" : "warn"}">${theme.label}</span><div class="small">${record.theme || "-"}</div></td>
          <td><span class="tag ${liquidity.label === "充足" ? "good" : liquidity.label === "不足" ? "bad" : "warn"}">${liquidity.label}</span><div class="small">成交额 ${compactNumber(liquidity.stockDollarVolume || 0)}</div></td>
          <td><span class="tag ${badgeClass(record)}">${classify(record)}</span></td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("#alertRows tr").forEach((row) => {
    row.addEventListener("click", () => {
      selectedTicker = row.dataset.ticker;
      switchView("research");
      renderAll();
    });
  });
}

function buildTopOptionAlerts(sourceRecords) {
  const alerts = [];
  for (const record of sourceRecords.map(normalizeRecord)) {
    const chain = Array.isArray(record.optionChain) ? record.optionChain : [];
    for (const row of chain) {
      const volume = number(row.volume);
      const oi = number(row.openInterest);
      const premium = number(row.premium);
      const volumeToOi = volume / Math.max(oi, 1);
      const isLeapCall = row.isLeap && row.type === "call";
      const score =
        normalize(volume, 25_000) * 35 +
        normalize(premium, 5_000_000) * 25 +
        normalize(volumeToOi, 1.5) * 20 +
        (isLeapCall ? 15 : 0) +
        (row.type === "call" ? 5 : 0);
      alerts.push({
        ticker: record.ticker,
        name: record.name,
        contract: row.code,
        type: row.type,
        expiration: row.expiration,
        daysToExpiration: row.daysToExpiration,
        strike: row.strike,
        volume,
        openInterest: oi,
        volumeToOi,
        premium,
        bid: row.bid,
        ask: row.ask,
        iv: row.iv,
        delta: row.delta,
        isLeap: row.isLeap,
        score: Math.round(Math.min(100, score)),
        reason: `${isLeapCall ? "LEAP call / " : ""}${volumeToOi >= 1 ? "成交量接近/超过 OI" : premium >= 2_000_000 ? "权利金流大" : "高成交合约"}`
      });
    }
  }
  return alerts.sort((a, b) => b.score - a.score).slice(0, 5);
}

function dedupeOptionAlerts(alerts) {
  const bestByTicker = new Map();
  for (const alert of alerts) {
    const ticker = String(alert.ticker || "").toUpperCase();
    if (!ticker) continue;
    const normalized = { ...alert, ticker };
    const current = bestByTicker.get(ticker);
    if (!current || number(normalized.score) > number(current.score)) {
      bestByTicker.set(ticker, normalized);
    }
  }
  return Array.from(bestByTicker.values()).sort((a, b) => number(b.score) - number(a.score)).slice(0, 5);
}

function buildTopStockOptionAlerts(sourceRecords) {
  return dedupeOptionAlerts(buildTopOptionAlerts(sourceRecords));
}

function renderOptionAlerts() {
  const alerts = topOptionAlerts.length ? dedupeOptionAlerts(topOptionAlerts) : buildTopStockOptionAlerts(records);
  if (!els.optionAlertRows) return;
  els.optionAlertRows.innerHTML = alerts.length
    ? alerts.map((alert) => `
      <tr data-ticker="${alert.ticker}">
        <td class="ticker-cell"><strong>${alert.ticker}</strong><span>${alert.name || ""}</span></td>
        <td><strong>${alert.contract || "-"}</strong><div class="small">${alert.type || "-"} ${alert.isLeap ? "· LEAP" : ""}</div></td>
        <td><span class="score">${alert.score}</span></td>
        <td>${alert.expiration || "-"}<div class="small">DTE ${alert.daysToExpiration ?? "-"} · ${number(alert.strike).toFixed(2)}</div></td>
        <td>${compactNumber(alert.volume)} / ${compactNumber(alert.openInterest)}<div class="small">V/OI ${number(alert.volumeToOi).toFixed(2)}</div></td>
        <td>${compactNumber(alert.premium)}<div class="small">${number(alert.bid).toFixed(2)} / ${number(alert.ask).toFixed(2)}</div></td>
        <td><span class="tag ${alert.isLeap && alert.type === "call" ? "good" : "warn"}">${alert.reason || "异动"}</span></td>
      </tr>
    `).join("")
    : `<tr><td colspan="7">当前没有合约级原始数据。请运行富途扫描并点击 ⇣ 读取报告。</td></tr>`;

  document.querySelectorAll("#optionAlertRows tr[data-ticker]").forEach((row) => {
    row.addEventListener("click", () => {
      selectedTicker = row.dataset.ticker;
      switchView("research");
      renderAll();
    });
  });
}

function buildStockTradePlan(record) {
  const score = scoreRecord(record);
  const liquidity = inferLiquidity(record);
  const theme = inferMarketTheme(record);
  const stance =
    record.oiTrend === "下降"
      ? "股票避免新开仓，先观察期权资金是否重新回来。"
      : score >= 78 && liquidity.label !== "不足"
        ? "股票可以小仓试，等待 OI 和股价结构二次确认后再加。"
        : score >= 62
          ? "股票进入 watchlist，先等次日 OI、板块强度和股价关键位确认。"
          : "只观察产业逻辑和资金流，不急着交易股票。";

  return {
    stance,
    buy: [
      "股价不破关键支撑，或放量突破最近平台后再考虑买入股票。",
      `${record.hotContract || "最热远月合约"} 的 OI 次日继续增长，说明期权资金没有离场。`,
      `主题判断维持在“${theme.label}”，且板块不是单票孤立异动。`
    ],
    add: [
      "期权成交继续集中在 call 侧，C/P 没有快速回落。",
      "股票成交额、股价趋势和相对强度同步放大。",
      "新闻、财报、订单或产业链数据验证当前叙事。"
    ],
    sell: [
      "LEAP call OI 停止增长或转为下降，说明跟踪逻辑降级。",
      "股价跌破突破位或关键均线，且板块同步走弱。",
      "估值预期无法兑现，或产业催化被证伪。"
    ],
    risk: liquidity.label === "不足"
      ? "股票流动性不足时降低仓位，避免因为期权异动追高。"
      : "期权只作为资金流证据，实际交易计划以股票价格结构为准。"
  };
}

function renderStats() {
  const count = records.length || 1;
  const avgLeap = records.reduce((sum, r) => sum + number(r.leapRatio), 0) / count;
  const avgCp = records.reduce((sum, r) => sum + number(r.cpRatio), 0) / count;
  const streakCount = records.filter((r) => number(r.streak) >= 2).length;
  const strongCount = records.filter((r) => scoreRecord(normalizeRecord(r)) >= 75).length;
  els.sampleCount.textContent = records.length;
  els.avgLeap.textContent = avgLeap.toFixed(2);
  els.avgCp.textContent = avgCp.toFixed(2);
  els.streakCount.textContent = streakCount;
  els.strongCount.textContent = strongCount;
  els.sideSummary.textContent = strongCount ? `${strongCount} 个强信号需要写入观察报告` : "当前没有强信号，等待更多跨天确认";
}

function renderTickerList() {
  const rows = filteredRecords();
  if (!rows.some((record) => record.ticker === selectedTicker)) {
    selectedTicker = rows[0]?.ticker || records[0]?.ticker || "";
  }
  els.tickerList.innerHTML = rows
    .map((record) => `
      <button class="ticker-card ${record.ticker === selectedTicker ? "active" : ""}" data-ticker="${record.ticker}">
        <h4>${displayName(record)} <span class="tag ${badgeClass(record)}">${scoreRecord(record)}</span></h4>
        <p>${record.theme || "暂无主题逻辑"}</p>
      </button>
    `)
    .join("");

  document.querySelectorAll(".ticker-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedTicker = card.dataset.ticker;
      renderAll();
    });
  });
}

function generateNote(record) {
  const score = scoreRecord(record);
  const share = callShare(record);
  const theme = inferMarketTheme(record);
  const liquidity = inferLiquidity(record);
  const valuation = inferValuation(record);
  const research = inferResearchProfile(record);
  const plan = buildStockTradePlan(record);
  const ai = record.aiAnalysis;

  return `
    ${ai ? renderAiAnalysis(record, ai) : renderAiUnavailable()}
    ${renderPremarketSnapshot(record)}
    <section class="local-analysis-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Local Rule Reference</p>
          <h3>本地规则参考</h3>
        </div>
        <span>非大模型分析，仅用于快速校验数据结构</span>
      </div>
    <div class="summary-grid">
      <article><span>主线判断</span><strong>${theme.label}</strong><small>${theme.score}/100</small></article>
      <article><span>流动性</span><strong>${liquidity.label}</strong><small>期权 ${compactNumber(liquidity.optionVolume)}</small></article>
      <article><span>估值预期</span><strong>${valuation.label}</strong><small>需结合财报验证</small></article>
      <article><span>研究深度</span><strong>${research.level}</strong><small>${research.industry}</small></article>
    </div>

    <h4>期权结构</h4>
    <p>${displayName(record)} 当前评分 ${score}/100。C/P ${number(record.cpRatio).toFixed(2)}，LEAP 比 ${number(record.leapRatio).toFixed(2)}，总期权成交 ${compactNumber(record.totalVolume)}，其中 call ${compactNumber(record.callVolume)}，call 占比 ${(share * 100).toFixed(1)}%。最热合约是 ${record.hotContract || "-"}，远月权利金流约 ${compactNumber(record.premiumFlow)}。</p>

    <h4>1. 是否是现在市场上的主线</h4>
    <p>判断：<strong>${theme.label}</strong>。${record.theme || "当前缺少明确主题标签。"} ${theme.label === "是" ? "它和当前强势主题、资金流和相对强度形成了较好共振。" : theme.label === "疑似" || theme.label === "疑似主线" ? "它具备主线苗头，但还需要板块内更多股票同步和新闻催化确认。" : "它更像个股异动，暂时不能当成市场主线处理。"}</p>

    <h4>2. 成交量是否充足</h4>
    <p>判断：<strong>${liquidity.label}</strong>。期权成交 ${compactNumber(record.totalVolume)}，股票成交额 ${liquidity.stockDollarVolume ? compactNumber(liquidity.stockDollarVolume) : "待补充"}。${liquidity.label === "充足" ? "这类标的适合进入交易计划，但远月合约仍要盯 bid-ask spread。" : liquidity.label === "不足" ? "流动性不足时不适合追价，尤其是远月合约。" : "可以研究，但仓位和订单方式要保守。"}</p>

    <h4>3. 估值是否有预期</h4>
    <p>判断：<strong>${valuation.label}</strong>。${record.catalyst || "目前还需要补充订单、财报、政策、产品周期或行业变化，才能判断估值是否有上修空间。"} 重点问题是：市场是否愿意给它更高倍数，还是当前价格已经充分反映预期。</p>

    <h4>4. 研究深度和产业链</h4>
    <p>研究深度：<strong>${research.level}</strong>。行业位置：${research.industry}。</p>
    <ul>
      <li>上游：${research.upstream}</li>
      <li>下游：${research.downstream}</li>
      <li>竞争/对标：${research.competitors}</li>
    </ul>

    <h4>5. 股票买入卖出计划</h4>
    <p>交易态度：<strong>${plan.stance}</strong></p>
    <div class="plan-grid">
      <section><h5>买入条件</h5><ul>${plan.buy.map((item) => `<li>${item}</li>`).join("")}</ul></section>
      <section><h5>加仓条件</h5><ul>${plan.add.map((item) => `<li>${item}</li>`).join("")}</ul></section>
      <section><h5>卖出/降级条件</h5><ul>${plan.sell.map((item) => `<li>${item}</li>`).join("")}</ul></section>
    </div>
    <p>${plan.risk}</p>

    <h4>雷点</h4>
    <p>${record.risk || "主要风险是 OI 不增长、bid-ask spread 过宽、公司催化无法兑现，或者这笔 call flow 其实是组合单的一部分。"}</p>

    <h4>期权链原始数据</h4>
    ${renderOptionChain(record)}
    </section>
  `;
}

function renderAiAnalysis(record, ai) {
  const plan = ai.stockTradePlan || {};
  const industry = ai.industryResearch || {};
  const flow = ai.optionFlowRead || {};
  const futuBrief = ai.futuStyleBrief || {};
  return `
    <section class="ai-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">AI Research</p>
          <h3>AI 基于富途真实数据的分析</h3>
        </div>
        <span>${record.ticker} · ${record.name || ""}</span>
      </div>
      <div class="summary-grid">
        <article><span>主线判断</span><strong>${ai.marketMainline?.verdict || "-"}</strong><small>${ai.marketMainline?.confidence ?? "-"} / 100</small></article>
        <article><span>流动性</span><strong>${ai.liquidity?.verdict || "-"}</strong><small>股票和期权合并判断</small></article>
        <article><span>估值预期</span><strong>${ai.valuationExpectation?.verdict || "-"}</strong><small>不编造估值数字</small></article>
        <article><span>研究深度</span><strong>${industry.level || "-"}</strong><small>产业链覆盖度</small></article>
      </div>
      ${renderFutuStyleBrief(futuBrief)}
      <h4>AI 对期权资金流的解读</h4>
      <p>${flow.summary || "暂无 AI 解读。"}</p>
      ${renderList("异常证据", flow.abnormalEvidence)}
      <h4>AI 产业链判断</h4>
      ${renderList("上游", industry.upstream)}
      ${renderList("下游", industry.downstream)}
      ${renderList("竞争/对标", industry.competitors)}
      ${renderList("关键问题", industry.keyQuestions)}
      <h4>AI 股票交易计划</h4>
      <p><strong>${plan.stance || "暂无明确态度"}</strong></p>
      <div class="plan-grid">
        <section><h5>买入股票条件</h5>${renderPlainList(plan.buyConditions)}</section>
        <section><h5>加仓股票条件</h5>${renderPlainList(plan.addConditions)}</section>
        <section><h5>卖出/降级条件</h5>${renderPlainList(plan.sellOrDowngradeConditions)}</section>
      </div>
      <p>${plan.invalidation || ""}</p>
      ${renderList("风险", ai.risks)}
      ${renderList("下一步研究", ai.nextResearchTasks)}
    </section>
  `;
}

function renderFutuStyleBrief(brief) {
  if (!brief || !Object.keys(brief).length) return "";
  return `
    <div class="futu-brief">
      <div class="futu-brief-head">
        <span>异动速读</span>
        <strong>${brief.headline || "期权异动结构解读"}</strong>
        <small>confidence ${brief.confidence ?? "-"}</small>
      </div>
      ${renderBriefBlock("背景/催化", brief.openingContext)}
      ${renderBriefBlock("板块与同行", brief.sectorAndPeers)}
      ${renderBriefBlock("期权成交", brief.optionTape)}
      ${renderBriefBlock("波动率与持仓", brief.volatilityAndPositioning)}
      ${renderBriefBlock("解读", brief.interpretation)}
      ${renderList("观察项", brief.watchItems)}
    </div>
  `;
}

function renderBriefBlock(title, body) {
  if (!body) return "";
  return `<article class="brief-block"><span>${title}</span><p>${body}</p></article>`;
}

function renderAiUnavailable() {
  return `
    <section class="ai-panel ai-missing">
      <div class="section-head">
        <div>
          <p class="eyebrow">AI Research</p>
          <h3>大模型研究未运行</h3>
        </div>
        <span>OPENAI_API_KEY 未配置或尚未执行 AI 分析</span>
      </div>
      <p>当前页面展示的是本地规则参考，不是大模型投研报告。配置 <code>OPENAI_API_KEY</code> 后运行 <code>npm run analyze:ai</code>，或等待盘后自动任务生成 AI 报告。</p>
    </section>
  `;
}

function renderPremarketSnapshot(record) {
  const snapshot = record.premarketSnapshot;
  if (!snapshot) {
    return `
      <section class="premarket-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">Premarket Check</p>
            <h3>盘前正股确认</h3>
          </div>
          <span>尚未拉取盘前快照</span>
        </div>
        <p>运行 <code>npm run premarket:futu</code> 后，这里会显示当前 Top5 标的的盘前价格、涨跌幅、成交量和市场状态。</p>
      </section>
    `;
  }
  const change = number(snapshot.change);
  const changeRate = number(snapshot.changeRate);
  const direction = change > 0 ? "good" : change < 0 ? "bad" : "warn";
  return `
    <section class="premarket-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Premarket Check</p>
          <h3>盘前正股确认</h3>
        </div>
        <span>${snapshot.session || "unknown"} · ${snapshot.marketState || "-"}</span>
      </div>
      <div class="summary-grid">
        <article><span>盘前/最新价</span><strong>${formatPrice(snapshot.lastPrice)}</strong><small>昨收 ${formatPrice(snapshot.prevClose)}</small></article>
        <article><span>涨跌幅</span><strong class="${direction}">${change >= 0 ? "+" : ""}${formatPrice(change)}</strong><small>${changeRate >= 0 ? "+" : ""}${changeRate.toFixed(2)}%</small></article>
        <article><span>成交量</span><strong>${compactNumber(snapshot.volume)}</strong><small>成交额 ${compactNumber(snapshot.turnover)}</small></article>
        <article><span>更新时间</span><strong>${snapshot.quoteTime || "-"}</strong><small>${String(snapshot.capturedAt || "").slice(0, 19)}</small></article>
      </div>
      <p>这块数据用于验证盘后期权异动是否在次日盘前得到正股价格确认，不改变期权成交量 Top5 的原始排序。</p>
    </section>
  `;
}

function renderList(title, items) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<h5>${title}</h5>${renderPlainList(items)}`;
}

function renderPlainList(items) {
  if (!Array.isArray(items) || !items.length) return "<p>暂无</p>";
  return `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function renderNote() {
  const record = normalizeRecord(records.find((item) => item.ticker === selectedTicker) || records[0]);
  if (!record) return;
  els.noteTitle.textContent = `${displayName(record)} - ${record.theme || "观察报告"}`;
  els.noteScore.textContent = `${scoreRecord(record)} / 100`;
  els.noteContent.innerHTML = generateNote(record);
}

function renderAll() {
  renderStats();
  renderDashboard();
  renderTickerList();
  renderNote();
  renderJobStatus();
  renderCnReview();
}

function switchView(view) {
  if (view === "backtest") view = "dashboard";
  activeView = view;
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.querySelector(`#${view}View`).classList.add("active");
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const titleMap = {
    dashboard: "异常榜",
    research: "研究报告",
    cnReview: "A股全面复盘",
    history: "历史查询",
    pipeline: "数据录入",
    framework: "监控框架"
  };
  els.pageTitle.textContent = titleMap[view];
  if (view === "cnReview" && !cnReview) loadCnReview({ silent: true });
  if (view === "history") renderHistoryReports();
}

function readForm(form) {
  const data = new FormData(form);
  return normalizeRecord({
    ticker: String(data.get("ticker") || "").trim().toUpperCase(),
    name: String(data.get("name") || "").trim(),
    theme: String(data.get("theme") || "").trim(),
    date: String(data.get("date") || "").trim(),
    cpRatio: number(data.get("cpRatio")),
    leapRatio: number(data.get("leapRatio")),
    totalVolume: number(data.get("totalVolume")),
    callVolume: number(data.get("callVolume")),
    hotContract: String(data.get("hotContract") || "").trim().toUpperCase(),
    premiumFlow: number(data.get("premiumFlow")),
    stockDollarVolume: number(data.get("stockDollarVolume")),
    relativeStrength: number(data.get("relativeStrength")),
    streak: number(data.get("streak"), 1),
    oiTrend: String(data.get("oiTrend") || "未知"),
    marketTheme: String(data.get("marketTheme") || "").trim(),
    valuationView: String(data.get("valuationView") || "").trim(),
    researchLevel: String(data.get("researchLevel") || "").trim(),
    industry: String(data.get("industry") || "").trim(),
    upstream: String(data.get("upstream") || "").trim(),
    downstream: String(data.get("downstream") || "").trim(),
    competitors: String(data.get("competitors") || "").trim(),
    catalyst: String(data.get("catalyst") || "").trim(),
    risk: String(data.get("risk") || "").trim()
  });
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    sortKey = button.dataset.sort;
    document.querySelectorAll(".segment").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    renderAll();
  });
});

els.searchInput.addEventListener("input", renderAll);
els.onlyActionable.addEventListener("change", renderAll);

els.resetData.addEventListener("click", () => {
  records = demoRecords;
  topOptionAlerts = [];
  selectedTicker = records[0].ticker;
  saveRecords();
  renderAll();
});

els.loadAutoReport.addEventListener("click", () => {
  loadGeneratedReport();
});
els.loadHkReport?.addEventListener("click", () => {
  loadGeneratedReport({ market: "HK" });
});
els.refreshCnReview?.addEventListener("click", () => {
  if (els.cnReviewDate?.value) loadCnReviewForDate();
  else loadCnReview();
});
els.loadCnReviewDate?.addEventListener("click", () => {
  loadCnReviewForDate();
});
els.cnReviewDate?.addEventListener("change", () => {
  if (els.cnReviewDate.value) loadCnReviewForDate({ silent: true });
});

els.refreshHistory?.addEventListener("click", renderHistoryReports);
// Backtest UI is temporarily disabled.
els.loadTickerHistory?.addEventListener("click", renderTickerHistory);
els.historyTicker?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") renderTickerHistory();
});

els.entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const record = readForm(event.currentTarget);
  if (!record.ticker) return;
  const index = records.findIndex((item) => item.ticker === record.ticker);
  if (index >= 0) records[index] = { ...records[index], ...record };
  else records.unshift(record);
  selectedTicker = record.ticker;
  saveRecords();
  event.currentTarget.reset();
  renderAll();
  switchView("research");
});

els.exportJson.addEventListener("click", () => {
  els.jsonOutput.textContent = JSON.stringify(records, null, 2);
});

els.importJson.addEventListener("click", () => {
  try {
    const parsed = JSON.parse(els.jsonBox.value);
    if (!Array.isArray(parsed)) throw new Error("JSON 必须是数组");
    records = parsed.map(normalizeRecord);
    selectedTicker = records[0]?.ticker || "";
    saveRecords();
    els.jsonOutput.textContent = `已导入 ${records.length} 条记录`;
    renderAll();
  } catch (error) {
    els.jsonOutput.textContent = `导入失败：${error.message}`;
  }
});

renderAll();
loadGeneratedReport({ silent: true });
setInterval(renderJobStatus, 60_000);
