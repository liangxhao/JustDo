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

## 6. Widget Kit 离线可视化库

六个 npm 归档是构建输入，不整体装入安装包。版本及 SHA-512 锁定在
`plugins/extensions/widget-kit/libraries/upstreams.json`，准备程序逐包校验后提取浏览器
脚本和许可证，仅 Three.js 需要本地 esbuild 合并 OrbitControls。归档路径如下：

| 下载地址 | 放置位置 |
| --- | --- |
| [Three.js 0.186.1](https://registry.npmjs.org/three/-/three-0.186.1.tgz) | `cache/widget-kit/three-0.186.1.tgz` |
| [ECharts 6.1.0](https://registry.npmjs.org/echarts/-/echarts-6.1.0.tgz) | `cache/widget-kit/echarts-6.1.0.tgz` |
| [KaTeX 0.17.0](https://registry.npmjs.org/katex/-/katex-0.17.0.tgz) | `cache/widget-kit/katex-0.17.0.tgz` |
| [Mermaid 10.9.8](https://registry.npmjs.org/mermaid/-/mermaid-10.9.8.tgz) | `cache/widget-kit/mermaid-10.9.8.tgz` |
| [D3 7.9.0](https://registry.npmjs.org/d3/-/d3-7.9.0.tgz) | `cache/widget-kit/d3-7.9.0.tgz` |
| [Matter.js 0.20.0](https://registry.npmjs.org/matter-js/-/matter-js-0.20.0.tgz) | `cache/widget-kit/matter-js-0.20.0.tgz` |

联网准备机可手动下载表中归档，然后将整个 `cache/widget-kit/` 复制到离线构建机。
准备：`npm run widget-kit:prepare`；复用已验证产物：
`npm run widget-kit:prepare -- --ensure`；校验：`npm run widget-kit:verify`。
这些命令均不联网，缺失或哈希不匹配明确失败；不运行包生命周期脚本，也不安装插件 npm 依赖。

中间解包目录位于 `build/widget-kit/`；生成资源位于忽略提交的
`plugins/extensions/widget-kit/assets/`，包含六个独立脚本、KaTeX 字体字节、完整性清单及
各库许可证/NOTICE。资源同步将其复制到 `dist/extensions/widget-kit/assets/`，
安装包构建验证源产物和运行时副本，产品首次使用不访问缓存或下载地址。
`openclaw:resources`、`electron:dev:openclaw` 和 Windows 分发准备已串联离线准备步骤。
Mermaid 原 npm 归档缺少独立 LICENSE，补充的锁版本 MIT 许可证保存在插件
`libraries/licenses/mermaid-10.9.8-LICENSE.txt` 下并纳入构建来源哈希，来源为
[对应提交的官方 LICENSE](https://raw.githubusercontent.com/mermaid-js/mermaid/49c1a1c7d1faa995b07cc7224543bd0d9a7a9e70/LICENSE)，仓库已包含，无需另外下载。

## 7. Agent CLI 协议依赖

ACP SDK 和 MCP client 的精确版本由根 `package.json` 管理，构建机通过已配置的内部 npm
源或预先准备的 npm 缓存安装。ACP 随应用打包；MCP client 及其内嵌 Ajv 在资源同步和
TypeScript 预编译时随 Runtime Services 打包。安装后无需另装 Node、npm 依赖或首启下载。
客户端提供的 MCP 服务器应提前安装在本机，不由应用自动下载。

## 8. OpenClaw 目录发布修复的 pristine 复验资源

重建只使用锁定原包与完整的同版本依赖树，不能修改已经用于运行的冻结目录。
以下归档用于离线复验；OpenClaw 的 integrity 与 SHA-256 必须匹配当前补丁目录的
`source-lock.json`，两个依赖的 integrity 必须匹配完整依赖树的 `npm-shrinkwrap.json`。

| 下载地址 | 缓存文件 |
| --- | --- |
| [OpenClaw 2026.10.6](https://registry.npmjs.org/openclaw/-/openclaw-2026.10.6.tgz) | `cache/openclaw-publication-pristine/openclaw-2026.10.6.tgz` |
| [fs-safe 0.25.0](https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.25.0.tgz) | `cache/openclaw-publication-pristine/openclaw-fs-safe-0.25.0.tgz` |
| [ai 2026.10.6](https://registry.npmjs.org/@openclaw/ai/-/ai-2026.10.6.tgz) | `cache/openclaw-publication-pristine/openclaw-ai-2026.10.6.tgz` |

已经缓存这些归档时，以下命令只访问 npm 离线缓存；缺失就明确失败，不能在产品
启动或测试中隐式联网补齐：

```powershell
npm pack --offline openclaw@2026.10.6 --pack-destination cache/openclaw-publication-pristine
npm pack --offline https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.25.0.tgz --pack-destination cache/openclaw-publication-pristine
npm pack --offline https://registry.npmjs.org/@openclaw/ai/-/ai-2026.10.6.tgz --pack-destination cache/openclaw-publication-pristine
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

OpenClaw 2026.10.6 要求 Node 24.22.1+。Electron 继续承载桌面 UI；Gateway、原生 CLI 与子任务使用完整随包 Node/npm，首启不下载。精确归档 SHA-256 锁定于 `src/shared/openclaw/nodeRuntime.json`，准备器验证归档并生成完整逐文件清单。

| 平台 | 下载地址 | 缓存文件 |
| --- | --- | --- |
| win-x64 | [官方 node-v24.22.1-win-x64.zip](https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip) | `cache/node/node-v24.22.1-win-x64.zip` |
| win-arm64 | [官方 node-v24.22.1-win-arm64.zip](https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-arm64.zip) | `cache/node/node-v24.22.1-win-arm64.zip` |
| mac-x64 | [官方 node-v24.22.1-darwin-x64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-x64.tar.gz) | `cache/node/node-v24.22.1-darwin-x64.tar.gz` |
| mac-arm64 | [官方 node-v24.22.1-darwin-arm64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz) | `cache/node/node-v24.22.1-darwin-arm64.tar.gz` |
| linux-x64 | [官方 node-v24.22.1-linux-x64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.gz) | `cache/node/node-v24.22.1-linux-x64.tar.gz` |
| linux-arm64 | [官方 node-v24.22.1-linux-arm64.tar.gz](https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz) | `cache/node/node-v24.22.1-linux-arm64.tar.gz` |

离线准备：`npm run setup:node-runtime -- win-x64`；仅构建准备联网下载时使用 `npm run setup:node-runtime -- win-x64 --download`。其他平台替换目标名。输出为 `build/runtimes/node/<target>/`，完整 OpenClaw 组装将其复制为运行时内 `node-runtime/`，包含 npm/npx、许可证和逐文件证明。缺失、哈希不符或平台不符必须失败。
