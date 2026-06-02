# LEAP Call Ratio Watch

本项目是一个本地运行的美股期权异动研究系统。主流程使用 Futu OpenD 扫描美股市场中“单独股票”的期权成交量异动 Top5，生成股票研究报告，并用正股价格做 20 / 60 / 120 个交易日收益回测。

期权只作为资金流和研究线索，不输出期权买卖建议。回测验证的是正股买卖表现，不是期权合约收益。

## 核心功能

- 期权成交量 Top5：使用 Futu `get_option_screen(OptMarketCategory.US_STOCK)` 按期权合约成交量扫描，再聚合到股票维度。
- 指数/ETF 剔除：默认排除 `SPY`、`QQQ`、`IWM`、`DIA`、`TQQQ`、`SQQQ`、`SPX`、`NDX`、`RUT`、`VIX` 等指数或 ETF 相关期权。
- 远月合约验证：正式期权成交量扫描会额外抓取 LEAP 到期日，避免只看到当日或近月合约。
- AI 研究报告：用 OpenAI Responses API 生成五段式个股研究；没有 API key 时会标记 `aiStatus.skipped`，前端展示本地规则分析和缺口提示。
- 盘后自动任务：`npm start` 常驻服务会在美东 `16:30` 检查 OpenD 和美股交易日，满足条件后自动扫描、分析并增量回测。
- 正股回测：对每天 Top5 信号，使用 Futu 日线计算扫描日后第 20 / 60 / 120 个美股交易日的正股收益。
- Web 展示：包含异常榜、AI 研究报告、历史报告、Backtest 汇总/明细、任务状态和数据导入导出。

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
scan:futu:volume -> analyze:ai -> backtest:futu
```

如果只想扫描期权成交量 Top5：

```bash
npm run scan:futu:volume
```

如果只想补跑回测：

```bash
npm run backtest:futu
```

如果只想运行 AI 分析：

```bash
npm run analyze:ai
```

## Futu 扫描模式

### 期权成交量 Top5

```bash
npm run scan:futu:volume
```

这是当前推荐模式。它按全市场期权合约成交量取前 `FUTU_OPTION_SCREEN_CONTRACTS=500` 个合约，再按 ticker 聚合成单独股票 Top5。

Top5 全部进入报告。LEAP 阈值只用于标签、评分和回测分组，不再过滤展示。

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

FUTU_OPTION_SCREEN_CONTRACTS=500
FUTU_MAX_SYMBOLS=5
FUTU_MIN_EXPIRATIONS_OPTION_VOLUME=12
FUTU_LEAP_EXPIRATIONS_OPTION_VOLUME=8

FUTU_INCLUDE_ETF_OPTIONS=0
FUTU_EXCLUDE_OPTION_UNDERLYINGS=SPY,QQQ,IWM,DIA,TQQQ,SQQQ,SPX,SPXW,NDX,RUT,VIX
```

远月合约相关参数：

- `FUTU_MIN_EXPIRATIONS_OPTION_VOLUME=12`：期权成交量 Top5 模式至少抓取前 12 个近端到期日，避免调试参数导致只剩 0DTE 或近月合约。
- `FUTU_LEAP_EXPIRATIONS_OPTION_VOLUME=8`：额外抓取 180 天以上的 LEAP 到期日，确保报告能看到远月资金流。

AI 配置：

```text
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_USE_RESPONSES=1
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

## AI 五段式研究

每个 Top5 标的固定回答 5 个问题：

1. 是否属于当前市场主线。
2. 成交量和流动性是否足够。
3. 估值是否已经包含预期，还是存在预期差。
4. 当前研究深度、上下游产业链和竞争格局如何。
5. 股票买入、加仓、卖出、降级计划。

输出字段包括：

- `aiResearch`
- `researchSources`
- `missingData`
- `nextResearchTasks`
- `aiStatus`

原则：

- 优先基于 Futu 数据、期权成交量、OI、权利金、合约结构和正股表现。
- 不能确认的内容必须标记 unknown 或写入 `missingData`。
- 期权只作为资金流证据，不提供期权买卖建议。

## 盘后自动任务

`npm start` 会启动 Web 服务和自动任务。默认逻辑：

1. 按美东 `AUTO_SCAN_TIME_ET=16:30` 触发。
2. 检查 Futu OpenD 是否连接。
3. 使用 Futu 交易日接口跳过美股休市日。
4. 执行 `daily:futu` 流水线。
5. 成功后写入最新报告和回测信号。

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

## 回测

回测只验证正股收益，不验证期权收益。

默认收益口径：

```text
entry = 扫描日正股收盘价
exit = 之后第 20 / 60 / 120 个美股交易日收盘价
```

运行：

```bash
npm run backtest:futu
```

样本不足完整周期时标记为 `pending`，不会纳入已完成统计。

Web Backtest 页面展示：

- 样本数
- 胜率
- 平均收益
- 中位数收益
- 最大回撤
- 20 / 60 / 120 日分组
- LEAP 达标/未达标分组
- Call 主导/Put 主导分组
- Score 分层
- 单票明细

回测 API：

```text
/api/backtest/summary
/api/backtest/signals
/api/backtest/ticker?ticker=NVDA
```

## 数据表

SQLite 数据库：

```text
data/leap_watch.db
```

核心表：

```text
stock_price_bars
backtest_signals
backtest_results
reports
```

最新报告：

```text
data/latest-report.json
```

历史报告：

```text
reports/YYYY-MM-DD-futu-leap-report.md
reports/YYYY-MM-DD-futu-leap-report.html
```

## Web 页面

主要视图：

- 异常榜：展示期权成交量 Top5、来源合约、评分和任务状态。
- 研究报告：展示 AI 五段式研究、本地规则分析、数据缺口和后续研究任务。
- Backtest：展示策略汇总和单票明细。
- 历史查询：加载历史扫描报告，查询单票历史信号。
- 数据录入：手动新增观察记录，支持 JSON 导入/导出。
- 监控框架：展示研究流程和风险提示。

## API

```text
/api/report
/api/reports
/api/ticker-history?ticker=NVDA
/api/job/status
/api/backtest/summary
/api/backtest/signals
/api/backtest/ticker?ticker=NVDA
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
- 本系统用于研究和回测，不构成投资建议。
