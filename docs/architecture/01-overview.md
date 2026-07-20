# JustDo 总览

JustDo 是一个 24/7 个人 AI 助理桌面应用。当前版本是 `v2026.7.6`，使用 Electron `42.6.0`、Node.js `>=24 <25`、React 18、Redux Toolkit、Lit 和 SQLite。AI 执行能力由 OpenClaw Gateway `v2026.6.11` 提供。

## 产品定位

JustDo 是 OpenClaw Gateway 的桌面前端和本地控制面：

- 提供桌面窗口、托盘、日志、代理、开机启动、防休眠等桌面能力。
- 提供 Cowork 会话、Agent、模型、Skills、MCP、Hooks、Extensions、定时任务等管理 UI。
- 通过 SQLite 保存本地 UI 缓存、配置和产品元数据。
- 通过 IPC 和 OpenClaw Gateway 通信，把真实任务执行交给 Gateway。

## 当前关键事实

| 主题 | 当前状态 |
| --- | --- |
| AI 引擎 | 只有 OpenClaw Gateway，不保留第二套 Agent runtime |
| 消息权威 | Gateway `chat.history` 是执行历史权威；SQLite 是本地 UI 缓存 |
| Chat UI | React 包装 `<justdo-chat>` Lit 元素，后者连接 Gateway WebSocket |
| Redux | 7 个 slice，位于 `src/renderer/features/**` |
| SQLite | `justdo.sqlite` 位于 Electron `userData/<package.json.productName>` |
| Skills | 15 个内置 skill 声明，14 个默认启用 |
| Runtime patches | 当前 OpenClaw 版本保留 6 个 patch |
| Dev server | `http://localhost:4175` |

## 产品名与内部标识

`package.json` 中的两个名字职责不同，禁止混用：

| 字段 | 当前值 | 含义 | 更名规则 |
| --- | --- | --- | --- |
| `name` | `justdo` | npm 包名和稳定内部标识 | 产品换名时不修改 |
| `productName` | `JustDo` | 对外产品名和可见目录名 | 未来换名只修改该字段 |

`productName` 必须是长度 1–64 的单个 ASCII 英文单词。它通过
`src/shared/productMetadata.ts` 和 `electron-builder.config.cjs` 驱动安装包、
可执行文件、快捷方式、窗口/托盘/终端文案、`userData` 与默认工程目录。
该限制不影响用户选择包含中文或空格的 Windows 安装路径。

`name` 及其他内部标识保持稳定，包括 `com.justdo.app`、`justdo://`、
`justdo.sqlite`、`JUSTDO_*`、`.justdo-tasks`、`--justdo-*`、`<justdo-chat>` 和各种
provider/export 格式标识。更换 `productName` 后不读取或迁移旧品牌目录。

## 用户可见模块

- Cowork：AI 工作会话、附件、流式输出、ask-user 交互、子任务状态。
- Agents：Agent 列表、默认 Agent、模型绑定、技能绑定。
- Models：OpenAI-compatible provider 和模型配置。
- Plugins：Skills、MCP、Hooks、Extensions 和 marketplace 入口。
- Scheduled Tasks：定时任务 CRUD、手动运行、运行历史和 Gateway 会话关联。
- Settings：主题、语言、代理、快捷键、系统能力等配置。

## 高层结构

```text
src/main/
  core/        Electron 桌面基础设施
  data/        SQLite store
  engine/      Cowork router 和 OpenClaw adapter
  ipc/         IPC handler 注册
  openclaw/    Gateway runtime、配置、模型、会话、slash commands
  plugins/     skills、mcp、hooks、extensions、marketplace
  scheduler/   scheduled task runtime bridge

src/renderer/
  app/         React app shell
  features/    业务 feature
  libs/        openclaw-chat Lit renderer
  services/    i18n、theme、config、store 等
  shared/      renderer-only common UI

src/shared/
  cowork/ scheduledTask/ openclaw/ providers/ plugins/
```

## 非目标

- JustDo 不 fork OpenClaw Gateway 的长期行为。
- JustDo 不让 renderer 直接访问 Node.js、Electron、SQLite 或文件系统。
- JustDo 不把 SQLite 变成 Gateway history 的第二权威。
- JustDo 不在 renderer 中直接连接外部 marketplace 或本地 runtime 文件。
