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

`electron:dev` 和隔离开发入口都会先构建独立 App 插件，首次检出无需手工生成 `build/app-plugins/catalog.json`。修改插件源码后重新运行对应启动命令即可生成当前产物；运行中的应用仍遵守插件代次与重启契约。

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

`npm test` 先应用仓库已有的依赖补丁，再为本次测试准备独立的 Node SQLite 模块；
不替换应用的 Electron 原生二进制，因此运行中的桌面实例不会与测试争用该文件。
模块在真实 Node 子进程中创建内存数据库验证，通过后传入主工程和独立插件测试，
全部子进程退出后只清理本次拥有的目录。实现见[测试依赖准备脚本](../scripts/test/sqlite-test-module.cjs)。
显式设置 `SQLITE_TEST_MODULE` 可以使用已经准备好的兼容模块；运行器仍验证它，但不删除外部模块。
需要修复应用的 Electron 原生依赖时运行 `npm run rebuild:electron-native`。

默认全量运行会执行主工程和所有独立 App 插件测试，即使其中某个套件失败也继续收集其余结果，
最终只要存在失败就返回失败。使用 `npm test -- <测试文件>` 只执行指定范围。

原生 reasoning 测试优先选择已准备的锁定版本构建目录，其次选择
`vendor/openclaw-runtime/current`。显式的 `JUSTDO_EXECUTION_PRISTINE_DIR` 或
`OPENCLAW_TEST_NATIVE_RUNTIME_DIR` 不可用、选中的产物不完整或版本不匹配时明确失败，
不会悄悄改用另一份运行时或跳过必需覆盖。当前补丁形态继续由实际转换与原生行为测试核验。

仅修改文档时运行 `git diff --check`，并检查改动 Markdown 的格式和本地链接；不需要构建或运行全量测试。

## 日志与排障

先查看故障时间段的 Main 和 Gateway 日志，再按 `sessionId`、`runId` 和时间戳关联。

| 日志                    | Windows 默认位置                                    |
| ----------------------- | --------------------------------------------------- |
| Main                    | `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log`  |
| Cowork                  | `%APPDATA%/<productName>/logs/cowork.log`          |
| Gateway 摘要            | `%APPDATA%/<productName>/openclaw/logs/gateway.log` |
| OpenClaw 完整 JSON 日志 | 以 `[gateway] log file:` 输出的路径为准             |

`productName` 来自 `package.json`；隔离开发会话使用独立数据目录。Gateway 摘要会省略部分事件，缺少记录不能证明事件未发生；终端重定向文件只是控制台捕获。

收到用户日志后，需要分享小体积认证证据时，可运行
[`collect-model-auth-evidence.ps1`](../scripts/diagnostics/collect-model-auth-evidence.ps1)：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File .\scripts\diagnostics\collect-model-auth-evidence.ps1
```

弹窗中多选收到的 Main、Gateway 或原生 JSON 日志，脚本自动定位最近一次认证故障，
默认提取前 30 分钟和后 5 分钟的受控字段，桌面生成最多 16 KiB 的单行事件 TXT。
`-ErrorTime '2026-11-04T21:30:00+08:00'` 可指定故障时间，`-MaxKiB 4` 可进一步缩小。
报告仅保留事件、固定原因码、数值／布尔状态和源文件别名行号，不复制日志原文、
文件名／路径、账号、凭据或聊天内容。未知字段与未识别的记录会被丢弃；
报告缺少某事件不能证明它未发生，需结合读取／截断统计和原日志范围判断。
重复统计表示日志记录数，不能据此推算故障次数。提取不修改原文件，
也不读取本机登录配置或启动 Gateway。

Main 统一维护应用写入的 Main、Cowork 和 Gateway 摘要日志。单文件上限分别为
80 MiB、5 MiB 和 20 MiB；写入前检查本条记录是否会超限，必要时先轮转，每个
文件只保留一个备份，名称分别为 `main-YYYY-MM-DD.old.log`、`cowork.log.old`
和 `gateway.log.old`。单条记录本身超过所属文件上限时，保留有界 UTF-8 内容和
明确的截断标记。Main 仍按 UTC 日期分文件。

首次真实日志写入后执行维护，运行期间每 5 分钟再次执行，不要求重启。超过
7 天未修改的日志会被清理，包括空闲的 Cowork、Gateway 当前文件；受管日志在
用户日志目录、安装目录回退日志及 `openclaw/logs` 中共享 500 MiB 的总容量预算。
写入即将超过预算时也会触发清理，按修改
时间优先删除最旧的非活动文件。macOS 的 Main 日志目录同样计入预算。已有
超大文件也纳入轮转与容量维护。维护只匹配明确的日志文件名，不递归扫描或
跟随符号链接、目录联接，不清理数据库、会话记录或其他文件。

轮转或容量回收失败时，不继续向已超限文件追加；Main 尝试安装目录的 `logs`
保留原始错误，后续维护周期再重试。两个位置都不可用时保留控制台输出。
若任一受管目录无法枚举、总容量无法确认，暂停后续磁盘日志写入，保留控制台
输出，待后续盘点恢复；无法删除的既有超额文件不能强制回收，也不继续扩大占用。
清理、轮转及导出失败不阻断应用启动。日志导出与诊断包含仍保留的轮转备份；
达到保留期或容量预算后删除的历史不能恢复。上述 500 MiB 预算仅覆盖应用受管
日志，OpenClaw 完整 JSON 日志的写入与保留仍由 OpenClaw 负责。

启动失败先查 Main 初始化、原生模块和 runtime；聊天执行异常再对照 Gateway 日志与[会话诊断](features/chat/session-diagnostics.md)。分享日志前脱敏，不提交原始日志、数据库或完整配置。

代码职责与协作约定见根目录 [AGENTS.md](../AGENTS.md)；按领域查阅[功能索引](features/README.md)，脚本实现见 [`scripts/README.md`](../scripts/README.md)。
