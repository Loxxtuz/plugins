# Zed Billing for Magpie

在 Magpie 显示 Zed 网页账单的模型用量：已用金额、支出上限、剩余金额和进度条。金额均为 USD，直接读取网页账单数据。

这是独立的额度插件，可以和已有的 `@magpie-community/opencode-zed-auth` 同时安装。模型调用继续使用原来的 Zed 插件；新增的 **Zed Billing (web account)** 卡片只显示网页账号用量，不参与模型路由。

## 安装

从此 fork 的独立安装分支安装：

```sh
magpie plugin add github:Loxxtuz/plugins#zed-billing
magpie plugin login zed-billing
```

也可将本目录下载或复制到本机后安装：

```sh
magpie plugin add /absolute/path/to/zed-billing
```

保留目录用于后续使用；本地目录插件由 Magpie 原地加载。

## 登录与查看额度

1. 在浏览器登录 [Zed 控制台](https://dashboard.zed.dev)，打开 Billing 页面。
2. 在浏览器开发者工具的 Network 中刷新页面，选择发往 `cloud.zed.dev` 的账单请求。
3. 在 Request Headers 中复制 Cookie 字段。该字段需要包含 `zed.session=...`。
4. 在 Magpie 的 Zed Billing 账号卡中登录，或运行 `magpie plugin login zed-billing`，将 Cookie 粘贴到本机登录提示中。
5. 登录时插件会验证账单接口，成功后在 Magpie 用量页面显示已用金额、上限、剩余金额和使用比例。

凭据只交给本机 Magpie，勿粘贴到聊天、GitHub issue、提交或公开日志。插件只保留 `zed.session` 这一项，并只发送至固定的 Zed 账单地址，不转发其他 Cookie。

**账单卡片属于该 Cookie 登录的网页账号。** 编辑器登录和网页登录是两套会话；插件不自动把它们当作同一个账号。请在浏览器确认你要查看的账号，尤其是在管理多个 Zed 账号时。

浏览器会话失效后，额度卡片会提示重新登录。重新取得 Cookie 后，更新 Zed Billing 登录即可；不影响原 Zed 模型账号。查看额度的 CLI 命令：

```sh
magpie quota zed-billing
```

## 显示规则

- 已用 2.75 美元、上限 10 美元时，显示 `$2.75 / $10.00 used; $7.25 remaining`，使用比例为 27.5%。
- 接口未报告上限时，只显示已用金额和上限未知，不根据 Student/Pro 名称猜测额度，不把未知显示成 0。
- 金额超过上限时保留实际已用金额，剩余金额最低显示为 0，进度条最高为 100%。
- 上限来自 `limit_in_cents`，表示该接口报告的支出上限；不自行解释成赠送额度或额外可付费额度。
- 成功或失败的读取缓存 60 秒，并合并同一网页会话的并发读取。更新 Cookie 后使用新的缓存。
- 不根据本机请求记录估算，也不编造重置日期。

## 接口与限制

读取：`GET https://cloud.zed.dev/frontend/billing/usage`。

字段：`current_usage.token_spend.spend_in_cents`、`limit_in_cents`，从美分换算为美元。

此地址是 Zed 网页使用的接口，没有公开稳定的 API 契约，后续可能变化。格式错误、登录失效、限流或连接失败时显示明确错误，不显示上一次缓存的金额作为新读数。没有浏览器会话时不会扫描浏览器、系统钥匙串或其他软件的凭据。

接口与字段参考：[CodexBar 的 Zed 数据源说明](https://github.com/steipete/CodexBar/blob/main/docs/zed.md)。Zed 官方提供的查看入口和套餐额度见[官方套餐说明](https://zed.dev/docs/account/plans-and-pricing#usage)。

## 验证

```sh
bun test packages/zed-billing packages/zed
bun scripts/check.mjs zed-billing
```

测试覆盖金额与进度、未知或零上限、超额、失效会话、限流、异常响应、敏感信息保护、缓存和插件入口。测试使用模拟响应，不读取真实账号，也不发送真实模型请求。

## License

MIT。保留上游 magpie-community contributors 的许可。
