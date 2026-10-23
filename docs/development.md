# 开发与排障

本文以当前 package.json 脚本为准。完整构建资源及平台约束见[技术栈](architecture/12-tech-stack.md)，安全和数据位置见[安全模型](architecture/11-security-model.md)与[数据存储](architecture/10-data-storage.md)。

## 1. 准备环境

使用 `.nvmrc` 的 Node.js 24.21.0，支持范围为 `>=24.16.0 <25`，包管理器为 npm。Electron 的实际锁定版本是 42.7.0；不要把 package.json 的 `^42.6.2` 范围当成已安装版本。

```bash
nvm use 24
npm install
npm run electron:dev:openclaw
```

首次运行需要网络以准备依赖和 host runtime。`npm install` 会执行原生模块重建；运行时、模型或凭据未配置就绪，不代表聊天已可执行。

| 命令                            | 用途                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `npm run dev`                   | 仅启动 Vite，不启动完整桌面执行环境                                          |
| `npm run electron:dev`          | 准备开发资源、编译 Main 并启动 Electron；适用于已准备 runtime                |
| `npm run electron:dev:openclaw` | 校验并按需准备 draw.io 离线资源，再准备 host OpenClaw runtime 并启动开发应用 |
| `npm run electron:dev:isolated` | 使用隔离开发配置；host runtime 仍需先准备                                    |

默认 Vite 端口是 43127。隔离预览的目录及启动参数由 `scripts/electron/run-isolated-dev.cjs` 管理；不要把真实用户数据库、凭据或原生日志复制进仓库。

开发版和安装版的 Chrome Native Host 均只发现并连接已运行的应用，不会自行启动或重启应用，
也不通过第二实例处理扩展的重启请求。开发态 Main 与 Gateway 由开发命令启动，输出继承当前终端；
安装版由用户手动启动，日志写入用户日志目录。应用未运行时扩展提示手动启动，后续重试仍只发现实例。
更新 Native Host 后重新运行开发命令，并重新加载 Chrome 扩展使 helper 更新生效。若此前已有
独立运行的应用，应先从托盘彻底退出再启动；复用旧实例无法把它的标准输出转接到新终端，
新开发进程会明确提示这一情况。

开发期的 `react-hooks-refresh` 插件为 Renderer 和扩展 `browser/` 中的普通 `.ts`
Hook 模块补充 React Refresh 签名；Vite 默认只为 JSX 模块生成这些签名。
嵌套 Hook 的调用结构改变时，React 会重新挂载消费组件；结构不变的编辑仍保留状态。
该处理不进入生产构建或 Main/Shared。旧开发进程尚未加载此配置时，Hook 从
`useState/useEffect` 改为 `useSyncExternalStore` 等结构变化可能导致
“change in the order of Hooks” 警告；重启开发进程并重新加载 Renderer 后再验证。

开发启动器直接管理 Vite 与 Electron，不通过 concurrently 对 Windows 子进程树
转发终止信号。Electron GUI 进程必须以 `windowsHide: false` 启动，否则 Windows
会抑制主窗口首次显示，表现为启动后只有托盘图标；后台辅助进程仍可隐藏启动。
开发启动器通过独立的父进程 Node IPC 管道
管理 Electron；Ctrl+C 先请求当前子进程
执行应用正常退出，等待 Main 停止运行及 Gateway、释放原生数据库租约后，再关闭
Vite。Main 的退出预算为 30 秒，紧急 Gateway 清理另有 17 秒；启动器给予 50 秒，
仍未退出才强制结束，并最多再等 5 秒。重复终止信号不提前缩短该窗口。
准备阶段取消后，即使就绪检查迟到完成也不能再启动 Electron。隔离开发入口复用
同一退出通道。正常单实例转交后，Vite 仍持续服务被接管的窗口，直到终端退出；
该窗口沿用开发服务器丢失检测请求正常退出。切换开发服务器后，旧父进程收到释放
回执，不再等待或强制结束已被接管的窗口。安装版不注册开发父进程协议。

该流程减少非正常退出造成的旧租约恢复开销，不跳过 OpenClaw 的完整性检查；
系统强制结束或掉电后的恢复仍由原生数据库负责。

## 2. 更新运行时

Gateway 由锁定的 pristine OpenClaw 包、当前补丁及扩展构建，产物位于 vendor 运行时目录。更换声明版本会重建；同版本补丁或构建输入变化可能触发冻结快照拒绝，需要显式重新安装。

PowerShell：

```powershell
$env:OPENCLAW_FORCE_INSTALL = '1'
try {
  npm run electron:dev:openclaw
} finally {
  Remove-Item Env:OPENCLAW_FORCE_INSTALL -ErrorAction SilentlyContinue
}
```

macOS / Linux：

```bash
OPENCLAW_FORCE_INSTALL=1 npm run electron:dev:openclaw
```

不要在旧 JustDo 补丁产物上加兼容转换或手工补齐部分标记。补丁仅可识别当前精确形态的幂等应用；发现历史或部分应用形态应明确失败，再从 pristine 包构建。扩展修改后仅刷新 Vite 不会替换 Gateway 已加载模块。

## 3. 检查与打包

非平凡代码变更通常运行：

```bash
npm run lint
npm run build
npm run compile:electron
npm test
```

`npm test` 的包装脚本切换 better-sqlite3 到 Node ABI，并在独立子进程中创建内存数据库验证原生绑定；重建命令成功但绑定仍不兼容时立即停止，不启动测试集。结束后恢复 Electron ABI；不要与 Electron 原生重建或依赖该模块的开发会话并行执行。运行时变更还需按[补丁指南](openclaw-runtime-patches.md)验证锁定产物。

全量测试默认使用两个 worker，避免原生模块冷启动及 Windows 进程快照在高并发下争抢资源而超时；可通过 `npm test -- --maxWorkers=N` 显式覆盖。会话存储诊断测试包含独立 CLI 启动，每例使用 30 秒预算，子进程仍保留各自的 10 秒上限。桌面控制开关、原生 provider 环境凭据、portal 策略及 migration receipts 的生命周期矩阵每例连续执行 4–6 次真实配置投影，分别使用 15 秒预算；不放宽全局测试时限或生产进程清理期限。

本地 ACPX 扩展的依赖需在 `plugins/extensions/acpx` 下执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，根目录安装不会更新该目录。OpenClaw 2026.10.4 上游使用 acpx 0.19.1，本项目经独立验证锁定 0.19.5，依据为扩展的 `package.json`、锁文件及 [ACPX 来源记录](../plugins/extensions/acpx/UPSTREAM.md)。遇到版本断言失败应按锁文件恢复依赖，不降低测试期望版本。

文档修改运行 `git diff --check`，并只对改动文件执行格式检查。不要用全库格式化夹带无关变更。

平台发布入口为 `npm run dist:win`、`npm run dist:mac`、`npm run dist:linux`。Windows 流程准备 MinGit 和 Python，Python 依赖来自 hashed lock。`pack`/通用 `dist` 不等于所有平台的资源预备步骤；跨平台发布前核对相应 pre-script 和目标 runtime。

当前 CI 仍有 skill job 调用未定义的 `build:skills`，且使用 `npm install` 与只依赖 package.json 的缓存 key。不要将一次局部构建通过写成所有发布流水线已通过。

## 4. 从日志定位问题

先读取同一日期和时间段的日志，再按 sessionId、runId、时间戳关联；记录故障属于启动、发送、执行、审批、停止、恢复还是展示。

| 日志               | Windows 默认位置                                             | 用途                              |
| ------------------ | ------------------------------------------------------------ | --------------------------------- |
| Main               | `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log`           | 产品生命周期、IPC、配置和服务错误 |
| Gateway 摘要       | `%APPDATA%/<productName>/openclaw/logs/gateway.log`          | Gateway 启动、RPC 与压缩后的事件  |
| OpenClaw 原生 JSON | 以 `[gateway] log file:` 输出为准，通常在 `%TEMP%/openclaw/` | 完整流事件和传输诊断              |

productName 来自 package.json；隔离开发会话使用其独立数据目录。终端重定向文件只是控制台捕获，不是权威原生日志。

`gatewayLogFilter.ts` 对 thinking、assistant、item 流保留每段首尾事件，文本预览限制 80 字符，并省略部分插件加载、schema 提示、可丢弃 delta 和周期心跳。成功的 sessions.list/cron.list 轮询仍保留用于分析频率和延迟。摘要日志没有某事件，不能证明原生事件未发生。

受管模型凭据更新后的 `secrets.reload` 失败时，Main 在停止 Gateway 前记录
`[OpenClaw] Failed to refresh managed model provider credentials (secrets.reload):`，
包含同步原因 `reason`、当前 `gatewayPhase`、累计耗时 `elapsedMs`、`attempt/maxAttempts`、
单次请求预算 `timeoutMs`、是否继续重试 `willRetry`、可识别的受控 `errorCode` 和脱敏异常堆栈 `error`。
短暂失败后恢复会另记 `Managed model provider credentials refreshed after retry`；重试不代表已经收到成功确认。
若 RPC 只返回笼统的 `secrets.reload failed`，仍需按同一时间段检查 Gateway 日志中的具体失败原因。

需要完整顺序时再查原生 JSON。分享前检查正文和上下文中的凭据及用户内容，不提交原始日志、数据库、WAL/SHM 或完整配置。

## 5. 常见定位顺序

- 应用启动失败：先看 Main 初始化和原生模块 ABI，再看 runtime freeze、资源和 Gateway readiness。
- 发送未执行：检查会话身份、模型 readiness、配置同步及 mode/root 收敛；不要只看 Renderer 按钮状态。
- 消息或工具卡缺失：对照原生历史、实时事件与 Renderer 恢复；不往 Main/Redux 加 transcript 缓存补洞。
- 停止后仍活动：区分主运行、后代任务、协作成员和 Goal 续跑；核对原生取消结果与轮次冻结。
- 插件看似启用却不可用：核对用户开关、有效配置、运行态 inventory 和重新加载情况；文件存在不代表注册成功。

## 6. 代码导航与贡献约定

应用采用 Electron + React，并通过 OpenClaw Gateway 执行任务。修改代码前阅读根目录 [AGENTS.md](../AGENTS.md) 及对应领域文档。

| 目录                  | 职责                                                           |
| --------------------- | -------------------------------------------------------------- |
| `src/main/`           | 应用生命周期、IPC、权限、配置、SQLite 元数据与系统资源         |
| `src/main/preload.ts` | 向 Renderer 暴露显式、受控的桥接 API                           |
| `src/renderer/`       | 浏览器端界面、功能状态及聊天展示，不直接导入 Node/Electron     |
| `src/shared/`         | 跨进程纯契约与工具，不依赖运行时状态                           |
| `plugins/`            | 内置扩展、技能、MCP 服务、Hook 和浏览器扩展                    |
| `scripts/`            | 开发、构建、测试与打包工具，见[脚本说明](../scripts/README.md) |
| `build/runtimes/`     | 准备后的运行时载荷；构建中间产物统一放在 `build/`              |
| `cache/`              | 离线下载缓存，不提交到 Git                                     |

Main 通过显式 preload 桥接提供系统能力；聊天控制器直接消费经过认证的 Gateway 历史和实时事件。产品数据库只保存元数据与执行回执，不建立 Main/Redux 消息副本。详细合约见[系统架构](architecture/02-architecture.md)、[进程模型](architecture/03-process-model.md)和[数据存储](architecture/10-data-storage.md)。Redux 状态按功能领域组织，以 `src/renderer/store/index.ts` 的实际挂载为准。

应用版本、OpenClaw 版本、Node 引擎范围和开发端口以根目录 `package.json` 为准，不在文档中维护另一份配置快照。内置技能清单见 `plugins/skills/builtin-skills.json`；技能可用性以 Gateway 返回的运行状态为准。运行时资源准备与离线下载统一见[离线资源说明](offline-downloads.md)。

贡献时遵循以下约定：

- 用户可见文案使用 i18n，并同步中文和英文词条。
- IPC 通道、状态和判别字段使用所属领域的共享常量。
- 保持 Renderer、Main 和插件的职责边界；跨进程修改同步契约、处理器、preload 和 Renderer 类型。
- 合约或数据流变化时同步更新所属架构或功能文档。
- 提交使用英文 Conventional Commits；发布前执行本页的构建与测试检查。
