# 开发、打包与排障

日常命令统一放在这里。使用 npm 和 Node.js 24，具体版本见 [`.nvmrc`](../.nvmrc)；脚本、引擎要求及开发端口以 [`package.json`](../package.json) 为准。

## 开发启动

在仓库根目录执行：

```bash
nvm use 24
npm install
npm run electron:dev:openclaw
```

首次启动会准备当前平台的 OpenClaw runtime 和开发资源。后续只修改应用代码时，可直接运行 `npm run electron:dev`；修改运行时补丁或扩展后需重新准备 runtime，再重启应用。

| 命令                                                                     | 用途                                        |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| `npm run electron:dev:openclaw`                                          | 准备 host runtime 并启动完整桌面应用        |
| `npm run electron:dev`                                                   | 使用已准备的 runtime，编译并启动桌面应用    |
| `npm run dev`                                                            | 只启动 Vite，调试前端                       |
| `npm run electron:dev:isolated`                                          | 使用独立数据目录启动；需先准备 host runtime |
| `npm run startup:preview -- --route upgrade --language zh --theme light` | 单独预览启动界面，不连接用户数据或 Gateway  |

退出开发会话时按 Ctrl+C，等待应用和 Gateway 清理完成。已有应用实例时，先从托盘彻底退出，再启动开发版。进程监督机制见[进程模型](architecture/03-process-model.md)，退出预算由 [`shutdownPolicy.json`](../src/shared/app/shutdownPolicy.json) 统一定义。

## 打包

| 命令                     | 产物 / 用途                                    |
| ------------------------ | ---------------------------------------------- |
| `npm run dist:win`       | Windows x64 安装包（NSIS）                     |
| `npm run dist:mac`       | macOS 打包入口；前置脚本准备 arm64 runtime     |
| `npm run dist:mac:arm64` | Apple Silicon 安装包（DMG），显式指定 arm64    |
| `npm run dist:mac:x64`   | Intel Mac 安装包（DMG），显式指定 x64          |
| `npm run dist:linux`     | Linux AppImage / deb；前置脚本准备 x64 runtime |
| `npm run pack`           | 生成应用目录包，不生成安装器                   |
| `npm run dist`           | 按 Electron Builder 默认平台配置生成安装包     |

产物统一输出到 `release/`。**`dist:win` 会先清空 `release/`**，然后校验并复用或重建 Windows runtime，准备 draw.io、MinGit、Python 和本地语音引擎，再构建安装包。正常重复打包无需设置 `OPENCLAW_FORCE_INSTALL`。

`pack` / `dist` 需要事先准备匹配目标平台的 runtime；发布时优先使用对应平台命令。macOS 建议使用显式架构命令，确保应用与 runtime 架构一致。

离线资源的下载与准备统一见[离线下载清单](offline-downloads.md)。打包机制见[工程构建与发布](architecture/12-tech-stack.md)，Windows 安装问题见[安装器说明](windows-installer.md)。

## 重新准备运行时

只准备当前平台 runtime、不启动应用：

```bash
npm run openclaw:runtime:host
```

开发准备提示冻结快照过期时，从锁定的原始包完整重建，不手工修改旧产物。PowerShell：

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

升级 OpenClaw 版本前阅读[升级检查清单](upgrade-checklist/checklist.md)；补丁规则与验证见[运行时补丁指南](openclaw-runtime-patches.md)。

## 检查与测试

代码变更按影响范围运行检查；发布前通常执行：

```bash
npm run lint
npm run build
npm run compile:electron
npm test
```

`npm test` 会先将 better-sqlite3 切到 Node ABI，结束后恢复 Electron ABI。不要与依赖该模块的开发会话或原生重建并行执行。需要手动修复 Electron 原生依赖时运行 `npm run rebuild:electron-native`。

仅修改文档时运行 `git diff --check`，并检查改动 Markdown 的格式和本地链接；不需要构建或运行全量测试。

## 日志与排障

先查看故障时间段的 Main 和 Gateway 日志，再按 `sessionId`、`runId` 和时间戳关联。

| 日志                    | Windows 默认位置                                    |
| ----------------------- | --------------------------------------------------- |
| Main                    | `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log`  |
| Gateway 摘要            | `%APPDATA%/<productName>/openclaw/logs/gateway.log` |
| OpenClaw 完整 JSON 日志 | 以 `[gateway] log file:` 输出的路径为准             |

`productName` 来自 `package.json`；隔离开发会话使用独立数据目录。Gateway 摘要会省略部分事件，缺少记录不能证明事件未发生；终端重定向文件只是控制台捕获。

启动失败先查 Main 初始化、原生模块和 runtime；聊天执行异常再对照 Gateway 日志与[会话诊断](features/chat/session-diagnostics.md)。分享日志前脱敏，不提交原始日志、数据库或完整配置。

代码职责与协作约定见根目录 [AGENTS.md](../AGENTS.md)；按领域查阅[功能索引](features/README.md)，脚本实现见 [`scripts/README.md`](../scripts/README.md)。
