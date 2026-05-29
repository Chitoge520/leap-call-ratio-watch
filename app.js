const STORAGE_KEY = "leap-watch-records-v1";

const demoRecords = [
  {
    ticker: "NOK",
    name: "Nokia",
    theme: "AI 网络基础设施 + 光网络 + 国防通信供应链重估",
    date: "2026-05-27",
    cpRatio: 5.32,
    leapRatio: 16.64,
    totalVolume: 345900,
    callVolume: 291200,
    hotContract: "260618.C.15",
    premiumFlow: 18800000,
    streak: 3,
    oiTrend: "增长",
    catalyst:
      "远月 call 连续多日高浓度，市场可能在押 Network Infrastructure 恢复、AI/Cloud 订单、光网络需求和可信通信供应链的估值身份切换。",
    risk:
      "NOK 历史上有散户抱团痕迹。若最热合约 OI 停止增长，或宽价差吞掉入场优势，异动可能从 conviction bet 退化为 meme flow。"
  },
  {
    ticker: "INTC",
    name: "Intel",
    theme: "晶圆制造周期反转与政策补贴兑现",
    date: "2026-05-27",
    cpRatio: 3.18,
    leapRatio: 9.42,
    totalVolume: 228600,
    callVolume: 171300,
    hotContract: "270115.C.45",
    premiumFlow: 24600000,
    streak: 2,
    oiTrend: "增长",
    catalyst:
      "远月资金更像押制造业务拐点和美国本土半导体政策红利，而不是短线财报波动。若毛利率和代工订单连续改善，估值弹性会放大。",
    risk:
      "资本开支重、执行周期长。若订单兑现慢或现金流继续承压，远月 call 会变成时间价值消耗。"
  },
  {
    ticker: "T",
    name: "AT&T",
    theme: "低估值现金流资产再定价",
    date: "2026-05-27",
    cpRatio: 2.46,
    leapRatio: 7.85,
    totalVolume: 183400,
    callVolume: 128700,
    hotContract: "260918.C.25",
    premiumFlow: 9200000,
    streak: 1,
    oiTrend: "持平",
    catalyst:
      "远月 call 可能在押自由现金流、降杠杆和股息资产重新被市场接纳。结构偏稳，不像爆发型成长股。",
    risk:
      "OI 暂未确认持续增长，可能只是低波动率环境下的收益增强或覆盖式结构。"
  },
  {
    ticker: "PLTR",
    name: "Palantir",
    theme: "AI 软件平台持续扩张",
    date: "2026-05-27",
    cpRatio: 1.78,
    leapRatio: 4.9,
    totalVolume: 412000,
    callVolume: 249200,
    hotContract: "260618.C.90",
    premiumFlow: 31400000,
    streak: 4,
    oiTrend: "增长",
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

const els = {
  pageTitle: document.querySelector("#pageTitle"),
  sampleCount: document.querySelector("#sampleCount"),
  sideSummary: document.querySelector("#sideSummary"),
  searchInput: document.querySelector("#searchInput"),
  resetData: document.querySelector("#resetData"),
  loadAutoReport: document.querySelector("#loadAutoReport"),
  avgLeap: document.querySelector("#avgLeap"),
  avgCp: document.querySelector("#avgCp"),
  streakCount: document.querySelector("#streakCount"),
  strongCount: document.querySelector("#strongCount"),
  onlyActionable: document.querySelector("#onlyActionable"),
  alertRows: document.querySelector("#alertRows"),
  tickerList: document.querySelector("#tickerList"),
  noteTitle: document.querySelector("#noteTitle"),
  noteScore: document.querySelector("#noteScore"),
  noteContent: document.querySelector("#noteContent"),
  entryForm: document.querySelector("#entryForm"),
  jsonBox: document.querySelector("#jsonBox"),
  jsonOutput: document.querySelector("#jsonOutput"),
  importJson: document.querySelector("#importJson"),
  exportJson: document.querySelector("#exportJson")
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

async function loadGeneratedReport({ silent = false } = {}) {
  try {
    const response = await fetch("data/latest-report.json", { cache: "no-store" });
    if (!response.ok) throw new Error("没有找到自动扫描报告");
    const report = await response.json();
    if (!Array.isArray(report.records)) throw new Error("报告格式不正确");
    records = report.records.map((record) => ({
      ...record,
      cpRatio: number(record.cpRatio),
      leapRatio: number(record.leapRatio),
      totalVolume: number(record.totalVolume),
      callVolume: number(record.callVolume),
      premiumFlow: number(record.premiumFlow),
      streak: number(record.streak, 1),
      catalyst: record.catalyst || record.note || "",
      risk: record.risk || "自动扫描记录需要继续确认 OI、价差、公司催化和股价相对强度。"
    }));
    selectedTicker = records[0]?.ticker || "";
    saveRecords();
    renderAll();
    if (!silent) alert(`已载入自动扫描报告：${records.length} 条记录`);
  } catch (error) {
    if (!silent) alert(`读取失败：${error.message}。请先运行 npm run scan，并通过 npm start 打开网页。`);
  }
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactNumber(value) {
  const n = number(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function callShare(record) {
  const total = number(record.totalVolume);
  if (!total) return 0;
  return number(record.callVolume) / total;
}

function normalize(value, max) {
  return Math.min(number(value) / max, 1);
}

function scoreRecord(record) {
  const leap = normalize(record.leapRatio, 18) * 34;
  const cp = normalize(record.cpRatio, 6) * 18;
  const call = callShare(record) * 14;
  const premium = normalize(record.premiumFlow, 35_000_000) * 12;
  const streak = normalize(record.streak, 5) * 12;
  const oi = record.oiTrend === "增长" ? 10 : record.oiTrend === "持平" ? 4 : record.oiTrend === "未知" ? 2 : -8;
  return Math.max(0, Math.min(100, Math.round(leap + cp + call + premium + streak + oi)));
}

function classify(record) {
  const score = scoreRecord(record);
  if (record.oiTrend === "下降") return "退场警报";
  if (score >= 78 && record.streak >= 2 && number(record.leapRatio) >= 10) return "Conviction bet";
  if (number(record.leapRatio) >= 8 && number(record.cpRatio) >= 2.5) return "定向押注";
  if (number(record.premiumFlow) >= 20_000_000 && number(record.cpRatio) < 2) return "混合资金流";
  return "待确认异动";
}

function badgeClass(record) {
  const label = classify(record);
  if (label === "Conviction bet" || label === "定向押注") return "good";
  if (label === "退场警报") return "bad";
  return "warn";
}

function filteredRecords() {
  const q = els.searchInput.value.trim().toLowerCase();
  const onlyActionable = els.onlyActionable?.checked;
  return records
    .filter((record) => {
      const haystack = [
        record.ticker,
        record.name,
        record.theme,
        record.hotContract,
        record.catalyst,
        record.risk
      ]
        .join(" ")
        .toLowerCase();
      const passesSearch = !q || haystack.includes(q);
      const passesSignal = !onlyActionable || scoreRecord(record) >= 65;
      return passesSearch && passesSignal;
    })
    .sort((a, b) => {
      if (sortKey === "score") return scoreRecord(b) - scoreRecord(a);
      return number(b[sortKey]) - number(a[sortKey]);
    });
}

function renderDashboard() {
  const rows = filteredRecords();
  els.alertRows.innerHTML = rows
    .map((record) => {
      const score = scoreRecord(record);
      const share = callShare(record);
      return `
        <tr data-ticker="${record.ticker}">
          <td class="ticker-cell"><strong>${record.ticker}</strong><span>${record.name || record.theme || ""}</span></td>
          <td><span class="score">${score}</span></td>
          <td>${number(record.cpRatio).toFixed(2)}</td>
          <td>${number(record.leapRatio).toFixed(2)}</td>
          <td><strong>${record.hotContract || "-"}</strong><div class="small">权利金 ${compactNumber(record.premiumFlow)}</div></td>
          <td>${(share * 100).toFixed(1)}%<div class="small">${compactNumber(record.callVolume)} / ${compactNumber(record.totalVolume)}</div></td>
          <td>${record.streak || 1} 天<div class="small">OI ${record.oiTrend || "未知"}</div></td>
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

function renderStats() {
  const count = records.length || 1;
  const avgLeap = records.reduce((sum, r) => sum + number(r.leapRatio), 0) / count;
  const avgCp = records.reduce((sum, r) => sum + number(r.cpRatio), 0) / count;
  const streakCount = records.filter((r) => number(r.streak) >= 2).length;
  const strongCount = records.filter((r) => scoreRecord(r) >= 75).length;

  els.sampleCount.textContent = records.length;
  els.avgLeap.textContent = avgLeap.toFixed(2);
  els.avgCp.textContent = avgCp.toFixed(2);
  els.streakCount.textContent = streakCount;
  els.strongCount.textContent = strongCount;
  els.sideSummary.textContent = strongCount
    ? `${strongCount} 个强信号需要写入观察报告`
    : "当前没有强信号，等待更多跨天确认";
}

function renderTickerList() {
  const rows = filteredRecords();
  if (!rows.some((record) => record.ticker === selectedTicker)) {
    selectedTicker = rows[0]?.ticker || records[0]?.ticker || "";
  }
  els.tickerList.innerHTML = rows
    .map(
      (record) => `
        <button class="ticker-card ${record.ticker === selectedTicker ? "active" : ""}" data-ticker="${record.ticker}">
          <h4>${record.ticker} <span class="tag ${badgeClass(record)}">${scoreRecord(record)}</span></h4>
          <p>${record.theme || "暂无主题逻辑"}</p>
        </button>
      `
    )
    .join("");

  document.querySelectorAll(".ticker-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectedTicker = card.dataset.ticker;
      renderAll();
    });
  });
}

function inferContractMeaning(record) {
  const contract = record.hotContract || "";
  const parts = contract.split(".");
  if (parts.length < 3) return "最热合约格式不足，暂时无法从 strike 和到期日判断资金时间窗。";
  const expiry = parts[0];
  const strike = parts[2];
  return `最热合约集中在 ${contract}，时间窗被推到 ${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4)}，strike 在 ${strike}。这说明资金不是只赌隔夜波动，而是在给公司逻辑留出几个季度的兑现时间。`;
}

function generateNote(record) {
  const score = scoreRecord(record);
  const label = classify(record);
  const share = callShare(record);
  const cpText = number(record.cpRatio).toFixed(2);
  const leapText = number(record.leapRatio).toFixed(2);
  const premium = compactNumber(record.premiumFlow);
  const callVol = compactNumber(record.callVolume);
  const totalVol = compactNumber(record.totalVolume);
  const streak = number(record.streak, 1);
  const opening =
    streak >= 3
      ? `${record.ticker} 已经不是第一次上榜，可以从“今天发现的异动”升级成跨天资金行为。`
      : streak === 2
        ? `${record.ticker} 连续第二次进入观察区，开始具备跨天跟踪价值。`
        : `${record.ticker} 目前还是单日异动，先进入观察池，不急着把它当成主线。`;

  const oiSentence =
    record.oiTrend === "增长"
      ? "更关键的是 OI 趋势显示增长，这意味着这笔钱大概率还没有走，成交量不是单纯日内换手。"
      : record.oiTrend === "下降"
        ? "但 OI 已经转弱，这是最需要警惕的部分：如果远月 call 成交很热而持仓不留下来，资金可能只是在撤退或换手。"
        : "目前 OI 没有给出强确认，所以这笔交易还需要下一天的持仓变化来验证。";

  const conviction =
    label === "Conviction bet"
      ? "这更像 conviction bet，而不是普通 hedge book。远月 call 高浓度、C/P 偏强、连续上榜和 OI 增长同时出现，说明资金在押一个 6-12 个月维度的方向性故事。"
      : label === "定向押注"
        ? "这像一笔定向押注，但还没有强到可以直接归类为机构级 conviction。下一步要看 OI 是否继续增长，以及最热合约的价差有没有收窄。"
        : label === "混合资金流"
          ? "这笔流量里可能混有对冲、滚仓或波动率交易。权利金不小，但 C/P 和 LEAP 浓度还没有形成特别干净的方向性结构。"
          : "现在更适合把它当成待确认异动。没有连续性和 OI 之前，先不要把单日成交解释成大资金押注。";

  return `
    <p>${opening}</p>
    <p>C/P ${cpText}，LEAP 比 ${leapText}，总成交量 ${totalVol}，其中 call ${callVol}，call 占比 ${(share * 100).toFixed(1)}%。最值得看的不是单个数字，而是这些数字是否同时指向同一个方向：远月、call、跨天、持仓留下来。</p>
    <p>${inferContractMeaning(record)}</p>
    <p>${oiSentence}</p>
    <h4>这笔钱可能在押什么</h4>
    <p>${record.theme ? `${record.ticker} 的核心叙事是：${record.theme}。` : `${record.ticker} 还缺少明确主题，需要补充公司催化。`} ${record.catalyst || "现在还需要补充财报、订单、政策、产品周期或行业变化，才能把期权流翻译成公司逻辑。"}</p>
    <h4>资金性质</h4>
    <p>${conviction} 当前综合评分 ${score}/100，研究优先级${score >= 75 ? "很高" : score >= 60 ? "中等偏高" : "仍需等待确认"}。</p>
    <h4>我的交易态度</h4>
    <p>${buildTradeStance(record)}</p>
    <h4>雷点</h4>
    <p>${record.risk || "主要风险是 OI 不增长、bid-ask spread 过宽、公司催化无法兑现，或者这笔 call flow 其实是组合单的一部分。"}</p>
    <h4>下一步确认</h4>
    <ul>
      <li>看 ${record.hotContract || "最热合约"} 的 OI 是否继续增长，而不只是成交量继续放大。</li>
      <li>看 bid-ask spread 是否收窄，避免在低流动性远月合约里被价差吃掉。</li>
      <li>把公司新闻、财报口径、订单、行业 ETF 相对强度和股价结构放在一起验证。</li>
      <li>若 LEAP 比回落、C/P 回落且 OI 停止增长，把它从主观察区降级。</li>
    </ul>
  `;
}

function buildTradeStance(record) {
  const score = scoreRecord(record);
  if (record.oiTrend === "下降") {
    return "不追。先把它当成退场或换手信号，除非后续 OI 重新增长并且股价结构修复。";
  }
  if (score >= 78 && number(record.streak) >= 2) {
    return "可以进入小仓位研究级别。更适合用远月、控制仓位、分批观察，而不是因为榜单排名直接重仓追。";
  }
  if (score >= 60) {
    return "进入 watchlist，但还需要下一天确认。重点不是价格立刻涨，而是远月 call OI 是否继续留下。";
  }
  return "只记录，不行动。当前证据还不足以支持主升前资金布局的判断。";
}

function renderNote() {
  const record = records.find((item) => item.ticker === selectedTicker);
  if (!record) return;
  els.noteTitle.textContent = `${record.ticker} - ${record.theme || record.name || "观察报告"}`;
  els.noteScore.textContent = `${scoreRecord(record)} / 100`;
  els.noteContent.innerHTML = generateNote(record);
}

function renderAll() {
  renderStats();
  renderDashboard();
  renderTickerList();
  renderNote();
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.querySelector(`#${view}View`).classList.add("active");
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const titleMap = {
    dashboard: "异常榜",
    research: "研究报告",
    pipeline: "数据录入",
    framework: "监控框架"
  };
  els.pageTitle.textContent = titleMap[view];
}

function readForm(form) {
  const data = new FormData(form);
  return {
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
    streak: number(data.get("streak"), 1),
    oiTrend: String(data.get("oiTrend") || "未知"),
    catalyst: String(data.get("catalyst") || "").trim(),
    risk: String(data.get("risk") || "").trim()
  };
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
  selectedTicker = records[0].ticker;
  saveRecords();
  renderAll();
});

els.loadAutoReport.addEventListener("click", () => {
  loadGeneratedReport();
});

els.entryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const record = readForm(event.currentTarget);
  if (!record.ticker) return;
  const index = records.findIndex((item) => item.ticker === record.ticker);
  if (index >= 0) {
    records[index] = { ...records[index], ...record };
  } else {
    records.unshift(record);
  }
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
    records = parsed.map((item) => ({
      ...item,
      ticker: String(item.ticker || "").toUpperCase(),
      cpRatio: number(item.cpRatio),
      leapRatio: number(item.leapRatio),
      totalVolume: number(item.totalVolume),
      callVolume: number(item.callVolume),
      premiumFlow: number(item.premiumFlow),
      streak: number(item.streak, 1)
    }));
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
