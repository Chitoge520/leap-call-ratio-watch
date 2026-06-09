# LEAP Call Ratio Watch

## A股数据源：Tushare

`npm run review:cn` 现在使用 Tushare HTTP API 生成 A股全面复盘，不再依赖 Futu OpenD 的 A股快照。输出路径仍然保持不变：

```text
data/latest-cn-review.json
reports/YYYY-MM-DD-cn-market-review.md
reports/YYYY-MM-DD-cn-market-review.html
```

在 `.env` 中配置：

```text
TUSHARE_TOKEN=your_tushare_token
CN_REVIEW_MAX_STOCKS=5000
CN_REVIEW_TRADE_DATE=
TUSHARE_SLEEP_MS=250
TUSHARE_RETRIES=3
TUSHARE_RETRY_DELAY_MS=1500
CN_REVIEW_FETCH_ALL_INDICES=0
```

- `TUSHARE_TOKEN`：Tushare token。
- `CN_REVIEW_MAX_STOCKS`：A股复盘最多覆盖的股票数量，默认 5000。
- `CN_REVIEW_TRADE_DATE`：可选，指定交易日，格式 `YYYYMMDD`；为空时自动取最近一个 A股交易日。
- `TUSHARE_SLEEP_MS`：每次 Tushare 请求后的等待时间，默认 250ms，用于降低触发频控的概率。
- `TUSHARE_RETRIES` / `TUSHARE_RETRY_DELAY_MS`：Tushare 请求失败时的重试次数和退避间隔。
- `CN_REVIEW_FETCH_ALL_INDICES=0`：低权限 token 默认只取上证指数，避免 `index_daily` 连续请求触发频控；如果权限足够可设为 `1`。

当前复盘使用 `stock_basic`、`trade_cal`、`daily`、`daily_basic`、`index_daily` 等接口，适合盘后研究。策略候选仍然是正股买入/卖出计划，不输出期权交易建议。

低权限 Tushare token 可能遇到 `1次/分钟` 或 `1次/小时` 的接口频控。脚本会把成功返回的接口缓存到 `data/tushare-cache/`，后续遇到频控时优先复用缓存；如果 `stock_basic` 暂时被限频，会先用 `daily` 的真实日线数据生成报告，名称字段临时显示为代码，等基础资料接口恢复后会自动补回股票名称和行业。

本项目是一个本地运行的股票期权异动研究系统。主流程使用 Futu OpenD 扫描美股市场中“单独股票”的期权成交量异动 Top5，生成股票研究报告；同时支持港股市场的单独股票期权异动 Top5 扫描和 AI 研究报告。回测功能目前已暂停。

期权只作为资金流和研究线索，不输出期权买卖建议。回测验证的是正股买卖表现，不是期权合约收益。

## 核心功能

- 期权成交量 Top5：美股使用 Futu `get_option_screen(OptMarketCategory.US_STOCK)`，港股使用 `get_option_screen(OptMarketCategory.HK_STOCK)`，按期权合约成交量扫描，再聚合到股票维度。
- 指数/ETF 剔除：默认排除 `SPY`、`QQQ`、`IWM`、`DIA`、`TQQQ`、`SQQQ`、`SPX`、`NDX`、`RUT`、`VIX` 等指数或 ETF 相关期权。
- 远月合约验证：正式期权成交量扫描会额外抓取 LEAP 到期日，避免只看到当日或近月合约。
- AI 研究报告：用 OpenAI Responses API 生成五段式个股研究；没有 API key 时会标记 `aiStatus.skipped`，前端展示本地规则分析和缺口提示。
- 盘后自动任务：`npm start` 常驻服务会在美东 `16:30` 检查 OpenD 和美股交易日，满足条件后自动扫描并分析；也会在香港时间 `16:30` 检查港股交易日并自动生成港股期权异动报告。
- 盘前正股确认：在美东 `08:30` 自动拉取当前 Top5 的正股盘前/最新快照，并重新运行 AI 分析，把盘前涨跌幅、成交量和市场状态加入报告。
- 正股回测：功能代码保留，但当前默认暂停，不再自动生成新回测样本。
- Web 展示：包含异常榜、AI 研究报告、历史报告、任务状态和数据导入导出。

## 快速启动

安装依赖：

```bash
npm install
pip install -r requirements-futu.txt
```

启动 Futu OpenD，默认连接地址为：

```text
127.0.0.1:11111
```

启动 Web 服务：

```bash
npm start
```

打开：

```text
http://localhost:4173
```

## 推荐主流程

手动执行一次完整 Futu 流水线：

```bash
npm run daily:futu
```

这个命令会依次执行：

```text
scan:futu:volume -> analyze:ai
```

如果只想扫描期权成交量 Top5：

```bash
npm run scan:futu:volume
```

回测功能目前暂停，`npm run backtest:futu` 只会输出禁用提示。

如果只想运行 AI 分析：

```bash
npm run analyze:ai
```

如果只想在盘前更新当前 Top5 的正股快照：

```bash
npm run premarket:futu
```

如果想更新盘前快照后立刻重跑 AI：

```bash
npm run premarket:futu:ai
```

如果想手动执行一次港股期权异动 Top5 扫描 + AI 分析：

```bash
npm run daily:futu:hk
```

这个命令会生成：

```text
data/latest-hk-report.json
reports/YYYY-MM-DD-hk-futu-leap-report.md
reports/YYYY-MM-DD-hk-futu-leap-report.html
```

如果想生成 A 股全面复盘：

```bash
npm run review:cn
```

这个命令会通过 Futu OpenD 抓取沪深 A 股快照，生成指数结构、市场宽度、成交额、情绪温度、主题强度、领涨/领跌、高成交额股票和次日观察清单：

```text
data/latest-cn-review.json
reports/YYYY-MM-DD-cn-market-review.md
reports/YYYY-MM-DD-cn-market-review.html
```

## Futu 扫描模式

### 期权成交量 Top5

```bash
npm run scan:futu:volume
```

这是当前推荐模式。它按全市场期权合约成交量取前 `FUTU_OPTION_SCREEN_CONTRACTS=500` 个合约，再按 ticker 聚合成单独股票 Top5。

Top5 全部进入报告。LEAP 阈值只用于标签、评分和回测分组，不再过滤展示。

### 港股期权成交量 Top5

```bash
npm run scan:futu:hk-volume
```

该模式设置 `FUTU_MARKET=HK`，使用 `OptMarketCategory.HK_STOCK` 扫描港股期权合约成交量，再按 `00700`、`09988` 这类港股正股代码聚合为 Top5。默认剔除港股 ETF/指数相关代码，例如 `02800`、`02828`、`03033`、`03188`、`07200`、`07500` 等。

### 高成交额股票池

```bash
npm run scan:futu:liquid
```

该模式先按正股成交额筛选股票池，再逐个拉取期权链。它适合验证特定高流动性股票池，但不是“期权成交量 Top5”主流程。

### 正股成交量股票池

```bash
npm run scan:futu:stock-volume
```

该模式按正股每日成交量筛选股票池。注意：这不是期权成交量 Top5。

### Watchlist 扫描

```bash
npm run scan:futu
```

使用 `config/watchlist.json` 中的标的逐个扫描期权链，适合手动观察固定股票列表。

## 关键环境变量

复制模板：

```bash
copy .env.example .env
```

常用配置：

```text
FUTU_OPEND_HOST=127.0.0.1
FUTU_OPEND_PORT=11111

AUTO_SCAN_ENABLED=1
AUTO_SCAN_TIME_ET=16:30
AUTO_PREMARKET_ENABLED=1
AUTO_PREMARKET_TIME_ET=08:30
AUTO_PREMARKET_PROTECT_MINUTES=90
AUTO_HK_SCAN_ENABLED=1
AUTO_HK_SCAN_TIME_HKT=16:30
AUTO_JOB_RETRY_MINUTES=60

FUTU_OPTION_SCREEN_CONTRACTS=500
FUTU_MAX_SYMBOLS=5
FUTU_HK_OPTION_SCREEN_CONTRACTS=500
FUTU_HK_MAX_SYMBOLS=5
FUTU_MIN_EXPIRATIONS_OPTION_VOLUME=12
FUTU_LEAP_EXPIRATIONS_OPTION_VOLUME=8

FUTU_INCLUDE_ETF_OPTIONS=0
FUTU_EXCLUDE_OPTION_UNDERLYINGS=SPY,QQQ,IWM,DIA,TQQQ,SQQQ,SPX,SPXW,NDX,RUT,VIX
```

港股自动任务使用香港时间：

- `AUTO_HK_SCAN_ENABLED=1`：`npm start` 常驻时启用港股盘后期权异动扫描。
- `AUTO_HK_SCAN_TIME_HKT=16:30`：港股收盘后触发时间。
- `AUTO_JOB_RETRY_MINUTES=60`：自动流水线失败后的冷却时间，避免 AI 临时失败时反复扫描并覆盖报告。
- `AUTO_PREMARKET_PROTECT_MINUTES=90`：美股盘前任务前 90 分钟内，不补跑逾期港股任务，避免占用调度器。
- `FUTU_HK_OPTION_SCREEN_CONTRACTS=500`：港股期权成交量筛选时读取的合约数量。
- `FUTU_HK_MAX_SYMBOLS=5`：港股报告保留的正股 TopN。

远月合约相关参数：

- `FUTU_MIN_EXPIRATIONS_OPTION_VOLUME=12`：期权成交量 Top5 模式至少抓取前 12 个近端到期日，避免调试参数导致只剩 0DTE 或近月合约。
- `FUTU_LEAP_EXPIRATIONS_OPTION_VOLUME=8`：额外抓取 180 天以上的 LEAP 到期日，确保报告能看到远月资金流。

AI 配置：

```text
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_USE_RESPONSES=1
OPENAI_RETRY_ATTEMPTS=3
OPENAI_RETRY_DELAY_MS=15000
OPENAI_MAX_OUTPUT_TOKENS=2400
AI_DAILY_SUMMARY_MODE=local
AI_OPTION_CHAIN_SAMPLE_LIMIT=0
AI_USAGE_LOG_PATH=logs/ai-usage.jsonl
STOCK_AGENT_PRESET=tradingagents
STOCK_AGENT_REFERENCE=TauricResearch/TradingAgents
DEEPSEEK_BALANCE_ENABLED=1
DEEPSEEK_BALANCE_CACHE_MS=300000
```

DeepSeek 配置示例：

```text
OPENAI_API_KEY=your_deepseek_api_key
OPENAI_MODEL=deepseek-v4-flash
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_USE_RESPONSES=0
STOCK_AGENT_PRESET=tradingagents
STOCK_AGENT_REFERENCE=TauricResearch/TradingAgents
```

如果没有配置 `OPENAI_API_KEY`，`npm run analyze:ai` 不会中断主流程，而是写入：

```json
{
  "aiStatus": {
    "state": "skipped",
    "reason": "missing_openai_api_key"
  }
}
```

前端会显示 AI 缺失提示，并保留本地规则分析。

## AI Agent 研究

当前 AI 层接入的是 TradingAgents-style 多角色研究结构，参考开源项目 `TauricResearch/TradingAgents` 的分析师、研究员、交易员、风控和组合经理分工。项目不会直接安装或运行完整 TradingAgents Python 框架，而是在现有 `npm run analyze:ai` 里用 DeepSeek/OpenAI-compatible API 模拟同样的研究委员会结构，并把结论写入 Web 报告。

AI 报告会先生成一段“期权异动资讯流”风格的 `futuStyleBrief`：先交代市场/事件背景，再连接板块和同行，随后拆解期权成交、Put/Call、成交/持仓、权利金、到期日/行权价集中度、LEAP 与近端合约差异，以及 IV/波动率数据是否可用。缺少新闻、估值或 IV 百分位时必须写入 unknown 或 `missingData`，不得编造。

每个 Top5 标的仍然固定回答 5 个问题：

1. 是否属于当前市场主线。
2. 成交量和流动性是否足够。
3. 估值是否已经包含预期，还是存在预期差。
4. 当前研究深度、上下游产业链和竞争格局如何。
5. 股票买入、加仓、卖出、降级计划。

输出字段包括：

- `tradingAgentsReview`
- `aiResearch`
- `researchSources`
- `missingData`
- `nextResearchTasks`
- `aiStatus`

原则：

- 优先基于 Futu 数据、期权成交量、OI、权利金、合约结构和正股表现。
- 不能确认的内容必须标记 unknown 或写入 `missingData`。
- 期权只作为资金流证据，不提供期权买卖建议。

### 降低 AI 成本

默认配置已经按低 token 消耗优化：

- `AI_DAILY_SUMMARY_MODE=local`：日度总览由本地聚合生成，不额外调用一次大模型。需要模型写组合层总结时可改为 `ai`。
- `AI_OPTION_CHAIN_SAMPLE_LIMIT=0`：AI 只接收聚合指标和 Top 合约，不发送完整期权链样本。需要让模型看原始链样本时可设为 `8` 或 `12`。
- `OPENAI_MAX_OUTPUT_TOKENS=2400`：限制单只股票输出长度；当前 schema 已精简，通常不会触顶。
- `AI_USAGE_LOG_PATH=logs/ai-usage.jsonl`：记录每次 AI 调用的模型、阶段、ticker、耗时、真实 token usage 和估算 token，便于检查消耗。

完整期权链仍保存在本地 JSON、SQLite 和 Web 期权链表格里，只是不再默认发送给 DeepSeek。

查看最近 AI 消耗：

```powershell
Get-Content logs\ai-usage.jsonl -Tail 20 | ConvertFrom-Json |
  Select-Object timestamp,stage,ticker,status,totalTokens,promptTokens,completionTokens,estimatedInputTokens,estimatedOutputTokens,durationMs
```

DeepSeek 余额监控：

```text
/api/deepseek/balance
/api/deepseek/balance?force=1
```

`npm start` 会在后台按 `DEEPSEEK_BALANCE_CACHE_MS` 缓存查询 DeepSeek 官方 `/user/balance` 接口，并在首页任务状态面板展示余额和最近检查时间。该接口只在后端使用 `OPENAI_API_KEY`，不会把 key 暴露给前端。

## 盘后自动任务

`npm start` 会启动 Web 服务、盘前任务和盘后任务。盘后默认逻辑：

1. 按美东 `AUTO_SCAN_TIME_ET=16:30` 触发。
2. 检查 Futu OpenD 是否连接。
3. 使用 Futu 交易日接口跳过美股休市日。
4. 执行 `daily:futu` 流水线。
5. 成功后写入最新报告。回测当前暂停，不写入新回测信号。

任务状态 API：

```text
/api/job/status
```

Web 首页也会显示：

- OpenD 连接状态
- 是否交易日
- 上次运行时间
- 下次运行时间
- 最近错误

盘前任务默认在美东 `08:30` 触发，执行：

```text
premarket:futu -> analyze:ai
```

它不会重新扫描期权链，也不会改变盘后期权成交量 Top5 排名，只会给当前 Top5 补充 `premarketSnapshot`：

```json
{
  "lastPrice": 0,
  "prevClose": 0,
  "change": 0,
  "changeRate": 0,
  "volume": 0,
  "turnover": 0,
  "marketState": "",
  "session": "premarket"
}
```

## 回测（暂停）

回测功能当前暂停。历史表和脚本保留，但自动任务不会运行回测，扫描也不会写入新的回测信号。

默认收益口径：

```text
entry = 扫描日正股收盘价
exit = 之后第 20 / 60 / 120 个美股交易日收盘价
```

当前暂停运行：

```bash
npm run backtest:futu
```

该命令目前只输出 `Backtest is temporarily disabled.`。历史表和脚本仍保留，后续需要时可以恢复。

## 数据表

SQLite 数据库：

```text
data/leap_watch.db
```

核心表：

```text
stock_price_bars        # 历史保留，当前暂停写入
backtest_signals        # 历史保留，当前暂停写入
backtest_results        # 历史保留，当前暂停写入
reports
```

最新报告：

```text
data/latest-report.json
data/latest-hk-report.json
```

历史报告：

```text
reports/YYYY-MM-DD-futu-leap-report.md
reports/YYYY-MM-DD-futu-leap-report.html
reports/YYYY-MM-DD-hk-futu-leap-report.md
reports/YYYY-MM-DD-hk-futu-leap-report.html
```

## Web 页面

主要视图：

- 异常榜：展示期权成交量 Top5、来源合约、评分和任务状态。
- 研究报告：展示 AI 五段式研究、本地规则分析、数据缺口和后续研究任务。
- Backtest：当前暂停，Web 入口已隐藏。
- 历史查询：加载历史扫描报告，查询单票历史信号。
- 数据录入：手动新增观察记录，支持 JSON 导入/导出。
- 监控框架：展示研究流程和风险提示。

## API

```text
/api/report
/api/reports
/api/ticker-history?ticker=NVDA
/api/job/status
/api/backtest/*  # 当前返回 disabled
```

## 可选旧数据源

### Polygon

配置：

```text
POLYGON_API_KEY=your_polygon_api_key
```

运行：

```bash
npm run scan
```

### Alpha Vantage

配置：

```text
ALPHAVANTAGE_API_KEY=your_alpha_vantage_api_key
```

运行：

```bash
npm run scan:alpha
```

这两个入口主要用于早期验证和备用数据源。当前主流程建议使用 Futu OpenD。

## 检查命令

```bash
npm run check
python -m py_compile scripts\scan_futu.py scripts\backtest_futu.py scripts\futu_healthcheck.py
```

如果系统 PATH 没有 `python`，请使用你安装了 `futu-api` 的 Python 解释器。

## 注意事项

- Futu 里的美股代码通常使用 `US.NVDA` 这种格式，报告中会转换为普通 ticker 展示。
- OpenD 未启动时，自动任务会跳过，并在 `/api/job/status` 显示 disconnected。
- 非交易日不会生成空报告。
- 期权成交量 Top5 默认剔除指数和 ETF；如果确实要包含 ETF，可设置 `FUTU_INCLUDE_ETF_OPTIONS=1`。
- OI 通常需要次日再确认，不能把单日成交量直接等同于持续持仓。
- 本系统用于研究，不构成投资建议；回测功能当前暂停。
