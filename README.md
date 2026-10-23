# TG ⇄ WorkBuddy Bridge

在 Telegram 里和 WorkBuddy / CodeBuddy 的 agent 对话。一个零依赖的 Node 小桥：长轮询收 Telegram 消息，调用本地 agent CLI，把回答发回 Telegram。

> 这是一个可行性验证项目，不是官方功能。Windows 环境实测可用。

## 为什么是这个架构

结论先行：**WorkBuddy 桌面端的 agent 是进程内运行的，没有对外开放的入口**。排查过程中确认的事实：

- `app.asar` 里有完整的 Telegram 通道实现（`telegram.js` / `TelegramConfigAdapter`，含 bot token 校验、`api.telegram.org` 调用），但被产品开关关掉：`productFeatures.ChannelTelegram = false`。Slack / Discord 同理。也就是说「不支持 TG」是产品决策，不是技术做不到。
- 桌面端通过 `wbipc` 命名管道（`%USERPROFILE%\.workbuddy\wbipc\endpoint.json`）与内部组件通信，协议未公开，不适合外接。
- 客户端内置的 CodeBuddy CLI 可以独立运行，但**不共享桌面端登录态**，需要单独登录。
- 因此本项目的做法：用官方 npm 包 `@tencent-ai/codebuddy-code`（WorkBuddy 的引擎本体）作为 agent 后端，桥只负责 Telegram ↔ CLI 的搬运。

代价：TG 里的会话和桌面版 WorkBuddy 的会话是两套，互不可见。

## 架构

```
Telegram 客户端
     │  getUpdates (long poll) / sendMessage
     ▼
bridge.js（本机常驻进程，零依赖）
     │  spawn: codebuddy -p "{prompt}" --output-format text
     ▼
CodeBuddy CLI（无头模式，agent + 工具 + 文件读写）
     ▼
工作目录（可读可写、可执行命令，等同于在该目录下开一个 agent）
```

## 特性

- 长轮询，无需公网 IP、无需反向代理、无需 webhook
- 每个 chat 一个独立 session，持久化在 `sessions.json`，支持多轮上下文
- `/new` 重开会话，`/status` 看状态
- 第一个给 bot 发消息的 chat 自动成为 owner 并写回配置，其他人无效
- 超长回复自动按 4000 字分片；处理期间持续发送 typing 状态
- agent 调用全局串行排队，避免多聊天并发时抢端口
- 日志落盘 `bridge.log`

## 环境要求

- Node.js 22+（内置 `fetch`）
- Windows（脚本按 Windows 写的；`bridge.js` 本身跨平台）
- 能访问 `https://api.telegram.org`（国内需代理 / TUN）
- `npm i -g @tencent-ai/codebuddy-code` 并完成一次登录

## 使用步骤

1. 在 Telegram 找 **@BotFather**，`/newbot`，拿到 bot token。
2. 装 CLI 并登录：
   ```bat
   npm i -g @tencent-ai/codebuddy-code
   login.cmd
   ```
   进入 TUI 后输入 `/login` 回车，浏览器完成登录（国内站 / 国际站按账号选）。
3. 复制配置并填写：
   ```bat
   copy config.example.json config.json
   ```
   - `token`：上一步的 bot token
   - `agent.command`：node.exe 绝对路径
   - `agent.args[0]`：`node_modules/@tencent-ai/codebuddy-code/bin/codebuddy` 绝对路径
   - `agent.cwd`：agent 的工作目录
   - `agent.env.ACC_PRODUCT_CONFIG_PATH`：见下方「踩坑」
4. 启动：`start-bridge.cmd`，或 `node bridge.js`。
5. 在 TG 里给 bot 发一句话，第一条消息的 chat 会成为 owner。

## 踩坑记录（重点）

**1. CLI 启动即卡死、零输出**

CLI 默认要监听 `127.0.0.1:63331`，而 WorkBuddy 桌面端也占着这个端口，于是启动阶段直接挂住且不报错。加 `--port <空闲端口>` 即可。

**2. 无头模式报 `Authentication required`**

现象：TUI 里已经登录成功，但 `-p` 仍然 401。原因：npm 包默认端点走国际站（`https://www.codebuddy.ai`），而你登录的是国内站，凭据对不上。

解决：把 `ACC_PRODUCT_CONFIG_PATH` 指向包内的 `product.internal.json`（端点 `https://copilot.tencent.com`，产品标识 `internal`）。设 `CODEBUDDY_BASE_URL` 无效。

**3. 用 Start-Process / 子进程方式常驻会被回收**

在某些容器化/受限的宿主环境里，启动的子进程会随父任务结束被 job object 一起杀掉。改用 Windows 计划任务常驻：

```bat
schtasks /create /tn "TG-Bridge" /tr "\"C:\path\to\node.exe\" \"C:\path\to\bridge.js\"" /sc onlogon /rl limited /f
schtasks /run /tn "TG-Bridge"
```

管理：`/run`、`/end`、`/delete` 同名任务。

**4. Git Bash 下 `schtasks /create` 会被路径转换**

`/create` 被当成路径展开，要么用 `//create`，要么改用其他 shell 执行。

## 已知限制

- 登录态过期后需重跑 `login.cmd`
- 宿主机器必须开机、代理必须可用
- 每次消息都会冷启动一次 CLI，首响约 15–25 秒；高频对话体验一般
- `config.json` 内含明文 bot token，务必加入 `.gitignore`
- CLI 与桌面端不共享会话，两边上下文互不可见

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `bridge.js` | 主程序：轮询、会话管理、agent 调用、分片发送 |
| `config.example.json` | 配置模板 |
| `mock-test.js` | 本地假 Telegram API，跑通「收消息→调 agent→回消息」全链路 |
| `login.cmd` | 一次性登录 CLI |
| `start-bridge.cmd` | 前台启动桥 |

自测：`node mock-test.js`

## License

仅用于技术研究，未做生产级加固（无鉴权重放防护、无速率限制、无消息去重）。
