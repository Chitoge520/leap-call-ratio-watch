# LEAP Call Ratio 异常监控台

这是一个本地使用的美股期权异常观察网页项目。它围绕 LEAP call ratio、C/P、call 成交占比、权利金流、连续上榜天数和 OI 趋势生成异常榜，并把单票数据整理成类似交易研究札记的观察报告。

## 直接使用

打开 `index.html` 即可运行，不需要安装依赖。

如果要读取自动扫描生成的数据，建议启动本地服务器：

```bash
npm start
```

然后打开：

```text
http://localhost:4173
```

## 当前功能

- 异常榜：按综合评分、LEAP 比、C/P、权利金流排序。
- 研究报告：自动生成单票观察报告，回答主线、流动性、估值、产业链和交易计划。
- 数据录入：手动新增或更新 ticker。
- JSON 导入/导出：方便把外部扫描结果粘贴进来。
- 自动扫描：通过 Polygon Option Chain Snapshot API 拉取期权链快照。
- 自动报告：生成 `data/latest-report.json`、`reports/YYYY-MM-DD-leap-report.md` 和 HTML 报告。
- 自动发送：支持 Resend 邮件 API 或通用 Webhook。
- 本地保存：数据保存在浏览器 localStorage。
- 示例数据：内置 NOK、INTC、T、PLTR。

## 五段式研究报告

每只股票的研究页会回答：

```text
1. 这只股票是否是现在市场上的主线
2. 这只股票是否有充足成交量
3. 这只股票的估值是否有预期
4. 当前研究深度如何，上下游产业链是什么
5. 根据期权异动、股价结构和产业逻辑生成股票买入、加仓、卖出/降级计划
```

首页的 `Top 5 个股期权异动榜` 按股票去重：每只股票只保留最异常的一个期权合约作为证据，避免同一只股票的多个合约刷屏。这个榜的目的不是提示买卖期权，而是发现“哪只股票因为期权流突然值得研究”。

可选补充字段：

```json
{
  "stockDollarVolume": 420000000,
  "relativeStrength": 72,
  "marketTheme": "疑似",
  "valuationView": "有重估预期",
  "researchLevel": "中",
  "industry": "通信设备 / AI 网络基础设施",
  "upstream": "光模块、射频器件、芯片",
  "downstream": "运营商、云厂商、政府/国防",
  "competitors": "ERIC、CSCO、CIEN、ANET"
}
```

如果这些字段为空，系统会根据主题、期权结构、成交量和内置行业知识先生成自动判断。

## 自动获取期权数据

### Polygon 付费/延迟数据

复制环境变量模板：

```bash
copy .env.example .env
```

编辑 `.env`，至少填入：

```text
POLYGON_API_KEY=你的 Polygon API Key
```

运行扫描：

```bash
npm run scan
```

扫描完成后会生成：

```text
data/latest-report.json
reports/YYYY-MM-DD-leap-report.md
reports/YYYY-MM-DD-leap-report.html
```

启动网页后，右上角点击 `⇣` 可以读取最新自动报告。

### Alpha Vantage 免费验证版

如果你只是想先验证程序是否可行，可以先用 Alpha Vantage 的免费 API key。它的免费额度和字段稳定性不适合大规模正式监控，但足够验证这条链路：

```text
获取期权链 -> 识别 180 天以上 LEAP call -> 计算比率 -> 生成报告 -> Web 端读取
```

申请免费 key：

```text
https://www.alphavantage.co/support/#api-key
```

在 `.env` 中填写：

```text
ALPHAVANTAGE_API_KEY=你的 Alpha Vantage API Key
```

运行：

```bash
npm run scan:alpha
```

注意：免费 key 通常有严格频率限制，所以脚本默认最多扫描 watchlist 前 10 个标的，并在请求之间等待。若报告没有入选标的，可以临时降低 `config/watchlist.json` 里的 `minTotalOptionVolume` 和 `minLeapCallVolume`。

### 富途 OpenD 数据源

富途更适合本地盘后研究，因为程序通过本机 OpenD 网关读取行情。官方文档里，`get_option_chain` 用于通过标的股票查询期权链；它主要返回期权链静态信息，若要获取报价、成交、OI 等动态数据，需要用返回的期权合约代码再订阅/获取行情快照。

参考：

- 富途获取期权链：`https://openapi.futunn.com/futu-api-doc/quote/get-option-chain.html`
- 富途行情接口总览：`https://openapi.futunn.com/futu-api-doc/quote/overview.html`
- 富途 OpenAPI 下载：`https://www.futunn.com/en/download/OpenAPI`

使用步骤：

1. 安装并启动 Futu OpenD。
2. 确认 OpenD 监听地址，一般是：

```text
127.0.0.1:11111
```

3. 安装 Python SDK：

```bash
pip install -r requirements-futu.txt
```

4. 如你修改过 OpenD 端口，在 `.env` 里设置：

```text
FUTU_OPEND_HOST=127.0.0.1
FUTU_OPEND_PORT=11111
```

5. 运行富途扫描：

```bash
npm run scan:futu
```

如果要按“股票成交额超过 10 亿美元”的美股股票池扫描，而不是使用 `config/watchlist.json`，运行：

```bash
npm run scan:futu:liquid
```

这会先从富途美股基础池获取股票列表，再批量读取快照，用 `turnover >= 1,000,000,000` 筛选股票，最后扫描这些股票的期权链。

可选环境变量：

```text
FUTU_USE_DOLLAR_VOLUME_UNIVERSE=1
FUTU_MIN_STOCK_DOLLAR_VOLUME=1000000000
FUTU_MAX_SYMBOLS=20
FUTU_MAX_DAYS=420
```

说明：

- 不设置 `FUTU_MAX_SYMBOLS` 时，会尽量扫描所有成交额超过 10 亿美元的股票。
- 设置 `FUTU_MAX_SYMBOLS=20` 可以先验证前 20 只，速度更可控。
- `FUTU_MAX_DAYS` 控制扫描未来多少期权到期日；数值越大，越慢，但覆盖 LEAP 更完整。

它会生成：

```text
data/latest-report.json
reports/YYYY-MM-DD-futu-leap-report.md
reports/YYYY-MM-DD-futu-leap-report.html
```

然后启动 Web 端：

```bash
npm start
```

打开 `http://localhost:4173`，点击右上角 `⇣` 读取最新报告。

注意事项：

- 美股代码在富途里会转换成 `US.NOK`、`US.AAPL` 这种格式。
- 第一次验证时建议把 `config/watchlist.json` 里的标的减少到 5-10 个，避免触发订阅/频率限制。
- 富途 `get_option_chain` 限制每次时间跨度不超过 30 天，并且每 30 秒最多 10 次请求；扫描器已按到期日查询并自动节流，所以完整 watchlist 可能需要几分钟。
- 如果报告为空，先降低 `minTotalOptionVolume` 和 `minLeapCallVolume`，确认链路能跑通。
- OI 不是实时资金流，通常需要次日再看是否增长，用来确认“这笔钱是否留下来”。

## 自动发送报告

### 邮件发送

在 `.env` 中配置：

```text
RESEND_API_KEY=你的 Resend API Key
REPORT_FROM=LEAP Watch <reports@yourdomain.com>
REPORT_TO=you@example.com
```

然后运行：

```bash
npm run scan
```

### Webhook 发送

适合接 Discord、Slack、Telegram bot、n8n、Make 或自己的接口。

```text
REPORT_WEBHOOK_URL=https://your-webhook-url
```

## AI 分析层

AI 分析层只基于富途 OpenD 采集到的真实数据、期权链、OI、成交量和权利金做研究，不编造新闻或估值数字。输出的交易计划是股票买入/卖出计划，期权只作为资金流证据。

在 `.env` 中配置：

```text
OPENAI_API_KEY=你的 API Key
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

运行流程：

```bash
npm run scan:futu:liquid
npm run analyze:ai
npm start
```

如果你使用 OpenAI-compatible 的其他模型服务，修改 `OPENAI_BASE_URL` 和 `OPENAI_MODEL` 即可。

AI 会把结果写回：

```text
data/latest-report.json
data/leap_watch.db
```

前端个股研究页会优先展示 `AI 基于富途真实数据的分析` 模块。

## 定时运行

Windows 可以用任务计划程序每天美股收盘后运行：

```text
程序：node
参数：scripts/scan.mjs
起始目录：C:\Users\80941\Documents\Codex\2026-05-27\leap-call-ratio
```

建议时间：美东 16:30 之后，也就是北京时间夏令时次日 04:30 之后、冬令时次日 05:30 之后。

## 综合评分

当前评分是研究优先级，不是买卖建议。

```text
score =
  LEAP 比权重
+ C/P 权重
+ Call 成交占比权重
+ 权利金流权重
+ 连续上榜权重
+ OI 趋势权重
```

系统重点寻找这种结构：

```text
远月 call 高浓度
+ C/P 偏强
+ Call 成交占比高
+ 连续多日上榜
+ OI 增长
+ 公司叙事可以解释这笔钱
```

## 建议的数据字段

导入 JSON 时，每条记录建议包含：

```json
{
  "ticker": "NOK",
  "name": "Nokia",
  "theme": "AI 网络基础设施 + 光网络 + 国防通信供应链重估",
  "date": "2026-05-27",
  "cpRatio": 5.32,
  "leapRatio": 16.64,
  "totalVolume": 345900,
  "callVolume": 291200,
  "hotContract": "260618.C.15",
  "premiumFlow": 18800000,
  "streak": 3,
  "oiTrend": "增长",
  "catalyst": "远月 call 连续多日高浓度，市场可能在押 Network Infrastructure 恢复。",
  "risk": "若最热合约 OI 停止增长，异动可能退化为 meme flow。"
}
```

## 后续升级方向

- 接入 Polygon / ORATS / Tradier / Nasdaq Data Link。
- 增加每日定时任务，自动拉取期权链、成交、OI、Greeks。
- 增加股票价格、相对强度、财报日、新闻催化和行业 ETF 对比。
- 增加历史回测，验证 LEAP call ratio 异常后的 20/60/120 日表现。
- 增加单票时间序列，跟踪 LEAP 比和 OI 是否持续。
