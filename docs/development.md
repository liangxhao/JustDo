# 开发与排障

本文以当前 package.json 脚本为准。完整构建资源及平台约束见[技术栈](architecture/12-tech-stack.md)，安全和数据位置见[安全模型](architecture/11-security-model.md)与[数据存储](architecture/10-data-storage.md)。

## 1. 准备环境

使用 `.nvmrc` 的 Node.js 24.21.0，支持范围为 `>=24.15.0 <25`，包管理器为 npm。Electron 的实际锁定版本是 42.7.0；不要把 package.json 的 `^42.6.2` 范围当成已安装版本。

```bash
nvm use 24
npm install
npm run electron:dev:openclaw
```

首次运行需要网络以准备依赖和 host runtime。`npm install` 会执行原生模块重建；运行时、模型或凭据未配置就绪，不代表聊天已可执行。

| 命令                            | 用途                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                   | 仅启动 Vite，不启动完整桌面执行环境                           |
| `npm run electron:dev`          | 准备开发资源、编译 Main 并启动 Electron；适用于已准备 runtime |
| `npm run electron:dev:openclaw` | 先准备 host OpenClaw runtime，再启动开发应用                  |
| `npm run electron:dev:isolated` | 使用隔离开发配置；host runtime 仍需先准备                     |

默认 Vite 端口是 43127。隔离预览的目录及启动参数由 `scripts/electron/run-isolated-dev.cjs` 管理；不要把真实用户数据库、凭据或原生日志复制进仓库。

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

`npm test` 的包装脚本切换 better-sqlite3 到 Node ABI，结束后恢复 Electron ABI；不要与 Electron 原生重建或依赖该模块的开发会话并行执行。运行时变更还需按[补丁指南](patches/openclaw-patch-guide.md)验证锁定产物。

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

需要完整顺序时再查原生 JSON。分享前检查正文和上下文中的凭据及用户内容，不提交原始日志、数据库、WAL/SHM 或完整配置。

## 5. 常见定位顺序

- 应用启动失败：先看 Main 初始化和原生模块 ABI，再看 runtime freeze、资源和 Gateway readiness。
- 发送未执行：检查会话身份、模型 readiness、配置同步及 mode/root 收敛；不要只看 Renderer 按钮状态。
- 消息或工具卡缺失：对照原生历史、实时事件与 Renderer 恢复；不往 Main/Redux 加 transcript 缓存补洞。
- 停止后仍活动：区分主运行、后代任务、协作成员和 Goal 续跑；核对原生取消结果与轮次冻结。
- 插件看似启用却不可用：核对用户开关、有效配置、运行态 inventory 和重新加载情况；文件存在不代表注册成功。
