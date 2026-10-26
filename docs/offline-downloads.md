# 离线资源下载清单

路径均相对于仓库根目录。下载后保留原文件，无需手动解压。

## 1. Windows MinGit

| 下载地址 | 放置位置 |
| --- | --- |
| [MinGit 2.55.0.3 x64](https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip) | `cache/mingit/MinGit-2.55.0.3-64-bit.zip` |

准备：`npm run setup:mingit`，输出到 `build/runtimes/mingit/`。

## 2. Windows Python

| 下载地址 | 放置位置 |
| --- | --- |
| [CPython 3.12.10 x64](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip) | `cache/python/python-3.12.10-embed-amd64.zip` |

准备：`npm run setup:python-runtime`，输出到 `build/runtimes/python-win/`。
受管依赖清单和路径初始化源码位于 `resources/python/`。

## 3. 本地语音引擎（Windows x64）

| 下载地址 | 放置位置 |
| --- | --- |
| [Sherpa ONNX 1.13.7 运行时](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2) | `cache/local-speech/sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2` |
| [Sherpa 许可证](https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.7/LICENSE) | `cache/local-speech/sherpa-onnx-LICENSE` |

准备：`npm run setup:local-tts`，输出到 `build/runtimes/local-tts/win-x64/`。

## 4. 语音模型

| 下载地址 | 放置位置 |
| --- | --- |
| [Kokoro 多语言 INT8](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2) | `cache/local-speech/kokoro-int8-multi-lang-v1_1.tar.bz2` |
| [SenseVoice Small INT8](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2) | `cache/local-speech/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2` |
| [SenseVoice 许可证](https://raw.githubusercontent.com/modelscope/FunASR/main/MODEL_LICENSE) | `cache/local-speech/sensevoice-LICENSE` |
| [Whisper Base](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2) | `cache/local-speech/sherpa-onnx-whisper-base.tar.bz2` |
| [Whisper 许可证](https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE) | `cache/local-speech/sherpa-onnx-whisper-base-LICENSE` |
| [AISHELL3 VITS](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2) | `cache/local-speech/vits-icefall-zh-aishell3.tar.bz2` |
| [Icefall 许可证](https://raw.githubusercontent.com/k2-fsa/icefall/master/LICENSE) | `cache/local-speech/vits-icefall-zh-aishell3-LICENSE` |
| [Piper Lessac INT8](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium-int8.tar.bz2) | `cache/local-speech/vits-piper-en_US-lessac-medium-int8.tar.bz2` |
| [Lessac 数据许可证](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html) | `cache/local-speech/vits-piper-en_US-lessac-medium-int8-LICENSE` |

准备：`npm run setup:local-speech-models`，模型输出到 `build/runtimes/local-tts/win-x64/<model-id>/`，开发环境可直接复用。

生成发布包：`npm run build:local-speech-model-artifacts`，输出到 `build/speech-models/v1/`。

## 5. draw.io 离线编辑器

| 下载地址 | 放置位置 |
| --- | --- |
| [draw.io 锁定源码归档](https://codeload.github.com/jgraph/drawio/tar.gz/9034053fba80a435e27d68d374bc564b83917ae9) | `cache/drawio/drawio-9034053fba80a435e27d68d374bc564b83917ae9.tar.gz` |
| [saxes 6.0.0 许可证](https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE) | `plugins/extensions/drawio/licenses/saxes-6.0.0.txt`（仓库已包含，无需下载） |

准备：`npm run drawio:prepare`；校验：`npm run drawio:verify`。

`npm run electron:dev:openclaw` 和 `npm run dist:win` 已自动准备，优先复用资源和本地归档，归档缺失才下载。断网电脑提前放好归档即可。

## 6. Widget Kit 构建依赖与可选测试输入

可视化库不再随产品内置，不需要浏览器库准备命令或 `widget-kit/assets` 产物。
Three.js 等由具体 widget 按需通过系统代理从原生允许的 CDN 加载。

完整 HTML 适配器使用插件生产依赖 `parse5@8.0.1` 与 `entities@8.1.0`，版本、
下载位置及完整性由 `plugins/extensions/widget-kit/package-lock.json` 固定：

| 下载地址 | 放置位置 |
| --- | --- |
| [parse5 8.0.1](https://registry.npmjs.org/parse5/-/parse5-8.0.1.tgz) | `cache/npm/` npm 内容缓存 |
| [entities 8.1.0](https://registry.npmjs.org/entities/-/entities-8.1.0.tgz) | `cache/npm/` npm 内容缓存 |

联网准备机运行 `npm ci --prefix plugins/extensions/widget-kit --ignore-scripts --cache cache/npm`，
将 `cache/npm/` 复制到离线构建机后，使用相同命令附加 `--offline`。
离线机器执行后续运行时组装前，在仓库根目录设置绝对缓存路径并让子进程继承离线模式：

```powershell
$env:npm_config_cache = (Resolve-Path cache/npm).Path
$env:npm_config_offline = 'true'
```

通用扩展组装从插件 lock 安装生产依赖，随后预编译将 parser 内嵌到入口，保留依赖许可证。
该步骤属于构建准备，安装后的应用不会运行 npm 或首次下载 parser。

可选浏览器验证使用真实 Three.js 作为测试输入，版本与 SHA-512 固定在插件
`tests/three-fixture.cjs`。它只从本地缓存读取三个 ESM 模块，并通过受控 HTTPS
fixture 提供；归档不提取为产品资产、不进入安装包，不在测试中自动下载。

| 下载地址 | 放置位置 |
| --- | --- |
| [Three.js 0.186.1](https://registry.npmjs.org/three/-/three-0.186.1.tgz) | `cache/widget-kit/three-0.186.1.tgz` |

准备机可下载该归档并复制缓存；验证命令为
`node plugins/extensions/widget-kit/tests/verify-image-loading.cjs --runtime <runtime>/dist`，
也可通过 `--three-archive <absolute-path>` 指定同一锁定归档。
本地 OpenSSL 可通过 `WIDGET_FIXTURE_OPENSSL` 指定。此输入只用于开发验证，缺失时测试
明确失败；产品启动和 widget 运行均不需要它。

## 7. Agent CLI 协议依赖

ACP SDK 和 MCP client 的精确版本由根 `package.json` 管理，构建机通过已配置的内部 npm
源或预先准备的 npm 缓存安装。ACP 随应用打包；MCP client 及其内嵌 Ajv 在资源同步和
TypeScript 预编译时随 Runtime Services 打包。安装后无需另装 Node、npm 依赖或首启下载。
客户端提供的 MCP 服务器应提前安装在本机，不由应用自动下载。

新 worktree 运行源码 ACPX 插件单元测试前，还需按插件自身锁文件准备独立依赖；
根目录的依赖安装不包含这份目录。离线命令如下，缺缓存即失败：

```powershell
npm --prefix plugins/extensions/acpx ci --offline --ignore-scripts --no-audit --no-fund --omit=dev
```

该准备仅写源码插件的 `node_modules/`，不修改包/锁文件或已冻结运行时。
`smol-toml@1.9.0` 等依赖仍按插件 lock 的完整 integrity 验证。

## 8. OpenClaw 目录发布修复的 pristine 复验资源

重建只使用锁定原包与完整的同版本依赖树，不能修改已经用于运行的冻结目录。
原包声明的随包依赖也属于该归档的源码证明：`chrome-devtools-mcp@1.10.1`
包含 OpenClaw 的快照身份和 frame 修复，不能用同版本公共 npm 包替代。
准备器在 npm 安装后、生成 shrinkwrap 前，从已验证的 OpenClaw 原包恢复完整
随包目录，并生成逐文件证明；无需另行下载 Chrome MCP。shrinkwrap 中的 registry
integrity 仍只描述公共基础包，随包修复后的完整字节由 OpenClaw 原包和该证明约束。
以下归档用于离线复验；OpenClaw 的 integrity 与 SHA-256 必须匹配当前补丁目录的
`source-lock.json`，两个依赖的 integrity 必须匹配完整依赖树的 `npm-shrinkwrap.json`。

| 下载地址 | 缓存文件 |
| --- | --- |
| [OpenClaw 2026.10.7](https://registry.npmjs.org/openclaw/-/openclaw-2026.10.7.tgz) | `cache/openclaw-publication-pristine/openclaw-2026.10.7.tgz` |
| [fs-safe 0.26.0](https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.26.0.tgz) | `cache/openclaw-publication-pristine/openclaw-fs-safe-0.26.0.tgz` |
| [ai 2026.10.7](https://registry.npmjs.org/@openclaw/ai/-/ai-2026.10.7.tgz) | `cache/openclaw-publication-pristine/openclaw-ai-2026.10.7.tgz` |

已经缓存这些归档时，以下命令只访问 npm 离线缓存；缺失就明确失败，不能在产品
启动或测试中隐式联网补齐：

```powershell
npm pack --offline openclaw@2026.10.7 --pack-destination cache/openclaw-publication-pristine
npm pack --offline https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.26.0.tgz --pack-destination cache/openclaw-publication-pristine
npm pack --offline https://registry.npmjs.org/@openclaw/ai/-/ai-2026.10.7.tgz --pack-destination cache/openclaw-publication-pristine
```

将校验后的原包解压到全新 `build/` 子目录，在完整同版本依赖中恢复这两个依赖
的原包内容。必须先在隔离环境、离线 npm 配置下，经原生
`dist/infra/package-lifecycle.js` 的 `completePendingPackageLifecycle` 正常执行原包
preinstall/postinstall 并释放所属锁，再执行现有 pristine 合同检查、补丁事务、技能同步、真实 asar
打包及 Gateway bundle 构建。源码、原包、依赖锁、构建配方、补丁和最终产物均须
通过正常构建证明；不要手写快照 ready 标记、替换旧 bundle 或补写旧产物证明。
原包的 pending/legacy guard 或 lifecycle lock 仍存在时，最终 manifest、冻结验证和
测试快照都必须拒绝；不能删除标记冒充原生安装脚本已经完成，也不能在补丁之后
补跑会清理 dist 的上游 postinstall。

## 8. 独立 Node 运行时

OpenClaw 2026.10.7 要求 Node 24.22.1+。Electron 继续承载桌面 UI；Gateway、原生 CLI 与子任务使用完整随包 Node/npm，首启不下载。精确归档 SHA-256 锁定于 `src/shared/openclaw/nodeRuntime.json`，准备器验证归档并生成完整逐文件清单。

| 平台 | 下载地址 | 缓存文件 |
| --- | --- | --- |
| win-x64 | [官方 node-v24.22.1-win-x64.zip](https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip) | `cache/node/node-v24.22.1-win-x64.zip` |
| win-arm64 | [官方 node-v24.22.1-win-arm64.zip](https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-arm64.zip) | `cache/node/node-v24.22.1-win-arm64.zip` |
| mac-x64 | [官方 node-v24.22.1-darwin-x64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-x64.tar.gz) | `cache/node/node-v24.22.1-darwin-x64.tar.gz` |
| mac-arm64 | [官方 node-v24.22.1-darwin-arm64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz) | `cache/node/node-v24.22.1-darwin-arm64.tar.gz` |
| linux-x64 | [官方 node-v24.22.1-linux-x64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz) | `cache/node/node-v24.22.1-linux-x64.tar.gz` |
| linux-arm64 | [官方 node-v24.22.1-linux-arm64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz) | `cache/node/node-v24.22.1-linux-arm64.tar.gz` |

离线准备：`npm run setup:node-runtime -- win-x64`；仅构建准备联网下载时使用 `npm run setup:node-runtime -- win-x64 --download`。其他平台替换目标名。输出为 `build/runtimes/node/<target>/`，完整 OpenClaw 组装将其复制为运行时内 `node-runtime/`，包含 npm/npx、许可证和逐文件证明。缺失、哈希不符或平台不符必须失败。
