# dsh-chatgpt-subscription

把 **ChatGPT Plus / Pro 订阅**作为一个模型卡片接进 DeepSeek Harness。

选它之后，模型请求走 ChatGPT 的 Codex 后端（`chatgpt.com/backend-api/codex`），
**由订阅额度付费，不消耗 `platform.openai.com` 的按量计费余额**。

---

## 声明

**ChatGPT 订阅不包含 API 额度。** ChatGPT 和 API 平台是[两套独立计费系统](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)，
因此想用「用 Plus 订阅调模型」只能通过官方提供的**Codex 订阅鉴权**路径
（OpenAI 自己在 [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) 里描述的能力）。

本插件便是通过此原理：

- 复刻 **Codex CLI 官方 OAuth 设备码流程**（`codex login` 同一套端点、同一个 public client id、同一个 `originator`）；
- 凭据落在 **Codex CLI 的 `auth.json`** 里，因此两边可以互相复用：只要 `codex login` 过的机器装上本插件就能直接用。

> 另， API key（按量计费）harness中可在设置-模型中更改。

---

## 前置条件

| 项 | 要求 |
|---|---|
| 订阅 | ChatGPT Plus / Pro / Business 等（Codex 可用的套餐） |
| 出口地区 | **必须是 OpenAI 支持的国家/地区**。不支持地区，会返回 `unsupported_country_region_territory` |
| Node | ≥ 22（与 `package.json` 的 engines 声明一致；先检查桌面端内置 Node 版本） |

出口地区是最容易踩的坑，安装后**先跑自检**再登录：

```bash
node bin/chatgpt-doctor.mjs
```

---

## 安装

### 方式一：装成本地 bundle（推荐）

DSH 自带 `plugin_manager`，用它安装工作区里的 bundle 是官方路径，不需要手工改 profile：

```
plugin_manager { action: "install_bundle", target: "<本插件目录的绝对路径>" }
```

### 方式二：安装脚本（命令行 / 无 GUI 时）

```bash
node bin/chatgpt-install.mjs --profile "$DSH_HOME/profiles/web"
```

需要指定非默认 DSH home 时加 `--dsh-home DIR`；可先加 `--dry-run` 预览且不写文件。
安装脚本默认不会设置代理，完成后需重启 DSH 才会加载 bundle。

### 手动安装

编辑 `$DSH_HOME/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-plugin-chatgpt-subscription": "file:./node_modules/dsh-plugin-chatgpt-subscription"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* 原有内容 */, "dsh-plugin-chatgpt-subscription" ]
    }
  }
}
```

并把插件目录复制到 `$DSH_HOME/profiles/web/node_modules/dsh-plugin-chatgpt-subscription`。

---

## 在模型页里登录（订阅卡片）

「设置 → 模型」里 **ChatGPT 订阅** 那一行的卡片就是完整入口，不需要开终端：

- **登录 ChatGPT / 重新授权**：点一下，卡片里直接出现设备码和
  `https://auth.openai.com/codex/device` 链接。在浏览器里输入设备码并确认，
  卡片会自己变成「授权成功」。
- **刷新额度**：显示服务端返回的真实额度窗口——剩余百分比、重置时间、窗口长度。
  服务端没给窗口时显示「暂不可用」，**不会**用满额或估算值冒充。
- **退出登录**：有二次确认；会删除本机保存的凭据（与 Codex CLI 共用时它也会退出）。

设备码流程不需要本机接收入站回调，所以在 NAT 或防火墙后面也能用。

卡片只拿到脱敏后的状态（掩码邮箱、套餐、额度百分比）。设备码之外的
`device_auth_id`、PKCE 校验串和所有 token **只留在 Host 进程里**，不发到浏览器。

> 卡片是 Host 路由 `/chatgpt-subscription` 的客户端。它复用 DSH 自带的
> Host/Origin + 浏览器登录认证闸门（`connection.admit`），未登录的请求会被
> 挡成 401，不会因为是自己加的路径就绕过鉴权。

---

## 登录

也可以只用命令行：

```bash
node bin/chatgpt-login.mjs
```

终端会打印一个链接和一次性代码：

```
1. 在浏览器打开：https://auth.openai.com/codex/device
2. 输入一次性代码：XXXX-XXXXX
```

浏览器里用 ChatGPT 账号登录并确认后，终端会写入凭据并显示账号/套餐。

- 默认写到 `$CODEX_HOME/auth.json`，否则 `~/.codex/auth.json`；
- 用 `--auth-file PATH` 可以指定别的位置（例如只想给 DSH 用、不碰 CLI 的凭据）；
- 也可以直接用官方 CLI：`codex login`，本插件会读取同一份文件。

查看登录状态：

```bash
node bin/chatgpt-status.mjs
```

退出登录（删除凭据文件）：

```js
import { signOut } from 'dsh-plugin-chatgpt-subscription';
await signOut({});
```

---

## 出口地区与代理

最常见的失败模式：**DSH 宿主进程直连 OpenAI，出口落在不支持的地区**，返回
`unsupported_country_region_territory`。先跑自检确认：

```bash
node bin/chatgpt-doctor.mjs                 # 用当前环境变量里的代理
node bin/chatgpt-doctor.mjs --proxy http://HOST:PORT   # 指定代理
```

它打印代理、**出口 IP**，以及三个端点的可达性。若出口 IP 与直连相同，说明代理
并没有接管这条流量（见第 4 点）。

要点：

1. **改浏览器代理没用。** 请求由 DSH 的宿主进程发起，不走浏览器。
2. 用代理的话，必须在 **DSH 启动前**生效。两种方式：
   - 写进 `$DSH_HOME/.env`：
     ```ini
     HTTPS_PROXY=http://HOST:PORT
     HTTP_PROXY=http://HOST:PORT
     NO_PROXY=127.0.0.1,localhost,::1
     ```
     （仅显式使用 `bin/chatgpt-install.mjs --proxy http://HOST:PORT` 时写入带标记的代理块；`--unset-proxy` 只移除新版完整标记块。旧版无标记代理行须备份 `.env` 后人工核对和删除。）
   - 或在启动 DSH 的环境里导出同样的变量。
3. ⚠️ **这会接管宿主进程的全部出站流量，不只是 OpenAI。** DSH 用这些变量安装一个
   全局 fetch dispatcher，所以代理不稳定时，**其他 provider（含 DeepSeek）也会一起断**。
   如果你的代理软件（TUN / 全局模式）已经在网络层分流，就别再设这些变量——
   多一跳只会多一个故障点。用 `node bin/chatgpt-doctor.mjs` 对比一下出口 IP 再决定：
   两者相同就说明环境变量是多余的。
4. **若出口 IP 和直连一样**，说明这条流量根本没走代理（透明代理/TUN 常把 OpenAI
   域名直连绕过）。这时要改节点或改用真正的全局代理模式。
5. 只支持 HTTP(S) 代理。SOCKS 需要额外依赖，自检会明确报出来。

---

## 配置项

在 Web GUI 的 **设置 → 模型**页里，`ChatGPT 订阅`这就是一张可编辑的卡片。
标了「易变」（volatile）的字段可以即时改，无需重启；其余字段改 `cordis.patch.yml` 后重启。

| 字段 | 默认值 | 即时可改 | 说明 |
|---|---|---|---|
| `authFile` | `$CODEX_HOME/auth.json` | 是 | 凭据文件位置 |
| `codexHome` | `$CODEX_HOME` 或 `~/.codex` | 否 | Codex home 目录 |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | 是 | 后端地址 |
| `issuer` | `https://auth.openai.com` | 否 | OAuth 发行方 |
| `clientId` | Codex public client id | 否 | 一般不用改 |
| `accountId` | 取自凭据 | 是 | 覆盖 `ChatGPT-Account-ID` |
| `models` | 见下 | 是 | 模型目录（GUI 里可编辑） |
| `reasoningEffort` | `medium` | 是 | 默认推理强度 |
| `streamIdleTimeoutMs` | `300000` | 是 | 流空闲超时 |

### 模型目录

默认公布（对齐 OpenAI 官方 Codex CLI 随包附带的
[`codex-rs/models-manager/models.json`](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json)）：

| 模型 id | 名称 | 上下文 | 默认强度 | 可用强度 |
|---|---|---|---|---|
| `gpt-6-astra` | GPT-6-Astra | 272k | low | low…ultra（6 档全） |
| `gpt-6.1-sol` | GPT-6.1-Sol | 272k | low | low…ultra（6 档全） |
| `gpt-6-sol` | GPT-6-Sol | 272k | medium | low…ultra（6 档全） |
| `gpt-6-luna` | GPT-6-Luna | 272k | medium | low…max（无 ultra） |
| `gpt-5.6-sol` | GPT-5.6-Sol | 272k | low | low…ultra（6 档全） |
| `gpt-5.6-terra` | GPT-5.6-Terra | 272k | medium | low…ultra（6 档全） |
| `gpt-5.6-luna` | GPT-5.6-Luna | 272k | medium | low…max（无 ultra） |
| `gpt-5.5` | GPT-5.5 | 272k | medium | low…xhigh（无 max/ultra） |

推理强度完整档位是 **low / medium / high / xhigh / max / ultra**。
每行可以单独声明它支持的档位（`reasoningEfforts`）；不声明就继承全部 6 档。
**跨档使用会被后端拒绝**，所以适配器按模型过滤，并在默认档不被支持时回退，不会把
不支持的档位发出去。

> 这些是**预设**，不是从服务器拉取的。哪些模型对你的套餐可用由后端决定：
> 不可用的模型会在请求时以 `MODEL_NOT_FOUND` 失败。
> 在「模型」页里改这张表即可（每行可编辑 id、显示名、上下文窗口、最大输出、默认强度）。
>
> 目录过时会漏模型（早期版本就漏掉了整个 GPT-6 家族）。模型列表随官方 CLI 更新，
> 更新后可对照上面的 `models.json` 补行。

---

## 故障排查

先跑 `node bin/chatgpt-doctor.mjs`，再看下面对照表：

| 现象 | 原因 | 处理 |
|---|---|---|
| `地区不受支持（unsupported_country_region_territory）` | 出口地区被拒 | 换支持地区节点；确认出口 IP 真的变了 |
| `MISSING_CREDENTIAL` | 没有凭据文件 | 跑 `chatgpt-login.mjs`，或确认 `authFile` 路径 |
| `INVALID_CREDENTIAL`（提示是 API key） | 凭据文件是 `auth_mode: "apikey"` | 用 ChatGPT 账号登录，而不是塞 API key |
| `AUTH` | token 被拒 | 重新登录；确认账号套餐支持 Codex |
| `QUOTA` | 订阅额度用尽 | 等额度重置，或换套餐 |
| `RATE_LIMIT` | 触发限流 | 稍后重试；重试由 `dsh-llm-retry` 负责 |
| `MODEL_NOT_FOUND` | 模型对套餐不可用 | 在模型页把该行删掉或换 id |
| `NO_ADAPTER` | 插件没加载 | 确认 bundle 已登记且**已重启** |
| 模型选择器里没有「ChatGPT 订阅」分组 | 插件未生效 | 查 DSH 日志里 `chatgpt-subscription` 的加载错误 |
| 登录时地区报错 | 登录端点同样受地区限制 | 先修好出口地区再登录 |

---

## 工作原理

```
DSH agent loop
   │  ctx.llm.stream({ provider: 'chatgpt-subscription', ... })
   ▼
LlmRuntime（dsh-llm）              ← 校验模型能力、冻结请求、切分片
   ▼
CodexAdapter                        src/codex-adapter.mjs
   │  buildRequestBody()             Harness 消息/工具 → Responses 请求体
   ▼
CodexAuth                           src/codex-client.mjs
   │  读 auth.json；快过期就刷新（带跨进程文件锁）
   ▼
POST {baseURL}/responses            Bearer + ChatGPT-Account-ID + originator
   ▼
translateResponses()                src/translate.mjs
   │  SSE → block-start / *-delta / block-end / usage / finish
   ▼
BlockAssembler                      ← 组装回 Harness 消息
```

关键实现点：

- **工具调用**：assistant 的 `tool-call` 块序列化成 `function_call` 项，tool-role 结果序列化成
  `function_call_output` 项，靠 `call_id` 关联，因此工具循环能正常续接。
- **推理**：只转发 `reasoning_summary_*` 摘要为 reasoning 块；不回放开外的 reasoning 项，
  由后端自己维护推理状态。
- **恰好一个终止分片**：任何路径（成功、HTTP 失败、传输异常、取消）都以
  `{ type: 'finish' }` 结束，失败带稳定 code。
  分片必须是**无损 JSON 值**——运行时会把每个 chunk 过一个快照校验，class 实例
  （例如活的 `LlmError`）会被直接拒绝，所以失败分片携带的是 `error.failure` 那个
  冻结的普通对象，而不是 Error 本身。
- **token 刷新**：提前 5 分钟刷新；用文件锁串行化，避免多进程同时消费轮换的 refresh token；
  遇到 401/403 会强制刷新后重试一次。

---

## DSH 插件格式

本插件按 Harness 的 bundle 约定组织：

| 文件 | 作用 |
|---|---|
| `package.json` → `dsh.bundle.patch` | 声明这是一个 bundle，并指向它的 loader 补丁 |
| `cordis.patch.yml` | 用 `insert` 把插件条目插进 profile 组合（`id: chatgpt-subscription`） |
| `package.json` → `main` / `exports["."]` | Host 半：导出 `apply(ctx, config)`、`Config`、`inject` |
| `package.json` → `exports["./client"]` + `dsh.client` | Client 半：浏览器侧的模块清单（平台、是否立即加载、依赖顺序） |
| `locale/{zh,en}.json` | 插件管理卡片显示的标题与描述（不激活插件即可读取） |
| `icon.svg` | 插件图标，`package.json` 顶层 `icon` 指向它（≤ 256 KiB） |

两个半的清单缺一不可：少了 `dsh.client` 与 `exports["./client"]`，模型页那一行就只是
一个空壳——Host 侧一切正常，但浏览器永远拿不到卡片代码。

Client 半用 `window.__ModuleLoader__.load({ id, factory })` 形式，`require('react')`
由宿主提供，不需要打包器或额外依赖。它通过 keyed 槽位
`settings.models.provider-card`（`key = settingsNs`）把自己挂到对应提供商的卡片里。

---


## 合规边界

- 只使用 OpenAI 官方客户端（Codex CLI）的公开登录流程与其文档化的订阅能力；
- 不逆向 ChatGPT 网页后端，不使用网页会话令牌，不绕过配额或鉴权；
- 插件不改动 DSH 自身代码；卸载 = 从 `bundles` 里删掉并删除插件目录；
- 请遵守 [OpenAI 使用条款](https://openai.com/policies/row-terms-of-use/)。

## 许可

MIT
