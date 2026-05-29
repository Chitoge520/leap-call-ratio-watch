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
- 研究报告：自动生成单票观察报告，风格接近 NOK 示例。
- 数据录入：手动新增或更新 ticker。
- JSON 导入/导出：方便把外部扫描结果粘贴进来。
- 自动扫描：通过 Polygon Option Chain Snapshot API 拉取期权链快照。
- 自动报告：生成 `data/latest-report.json`、`reports/YYYY-MM-DD-leap-report.md` 和 HTML 报告。
- 自动发送：支持 Resend 邮件 API 或通用 Webhook。
- 本地保存：数据保存在浏览器 localStorage。
- 示例数据：内置 NOK、INTC、T、PLTR。

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
