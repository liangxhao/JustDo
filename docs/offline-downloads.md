# 离线下载与构建资源准备

本文集中维护构建资源的来源、缓存文件名、目的目录和准备命令。版本以当前脚本、
package.json、各依赖锁及 source lock 为准；下列版本是当前仓库的精确输入，不是最新版本推荐。
准备资源与安装后模型服务联网是不同问题，使用内网模型也不自动使首次构建离线。

只准备在本次构建中需要的目标资源，不将不同平台/架构的 node_modules 或 runtime
混用。以下命令均在仓库根目录运行，先按[开发指南](development.md)准备 Node/npm
和应用依赖；本文是操作说明，本次文档整理不执行下载、安装或运行时重建。

## 1. 资源与校验入口

| 资源                             | 当前来源/版本                                                     | 输入缓存与输出                                                       | 校验/准备入口                                                           |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 应用依赖、Electron/7zip/原生依赖 | package-lock.json；Node 版本由 .nvmrc 指定                        | npm/Electron 及各工具原生缓存 → node_modules 与目标安装包            | package.json、原生 ABI 包装及 Builder 资源检查                          |
| OpenClaw                         | openclaw@2026.10.4，npm registry 精确元数据/tarball               | vendor/openclaw-runtime/<platform>，current 为选定开发产物           | scripts/patches/v2026.10.4/source-lock.json 与 pristine/freeze/manifest |
| Windows MXC                      | @openclaw/mxc-sandbox@2026.10.4；SDK 0.8.0                        | vendor/openclaw-plugins/mxc → 目标 runtime dist/extensions/mxc       | package.json.openclaw.plugins、mxcNativeBinaries.json、插件构建补丁     |
| 本地 OpenAI/ACPX 等扩展          | openclaw-extensions 的源码、独立 package-lock.json 与上游来源记录 | 完整本地源码组装 → 目标 runtime 预编译扩展                           | runtime recipe、setup/worker/依赖/裁剪验证                              |
| Windows MinGit                   | 2.55.0.windows.3                                                  | resources/MinGit-2.55.0.3-64-bit.zip → resources/mingit              | setup-mingit.js 的 SHA-256、版本与必需文件                              |
| Windows Python                   | 默认 CPython 3.12.10 x64 embeddable，依赖目标 cp312/win_amd64     | resources/python-win-runtime.zip 或显式本地包 → resources/python-win | setup-python-runtime.js、hashed requirements 与真实 import              |
| 本地语音引擎                     | Sherpa ONNX 1.13.7 Windows x64                                    | resources/local-tts-cache → resources/local-tts/win-x64/runtime      | setup-local-tts.js 的 SHA-256、版本标记与必需 exe/DLL                   |
| 语音模型                         | 下文锁定源包与许可证                                              | local-tts-cache → 本地发布源目录；用户模型另在 userData              | setup-local-tts.js、shared/speech 目录及模型 artifact 校验              |

npm 包应通过获准 registry/mirror 提供元数据、精确 tarball、全部传递及目标平台可选
依赖，保持锁文件和 source lock 的 integrity。当前脚本没有「随便把 tgz 放进 vendor
即可使用」的准入协议；只预填一个顶层 npm 包缓存不能证明全流程离线。
ACPX 当前包含 acpx 0.19.5、Claude ACP adapter 0.79.0、Codex ACP adapter 1.12.0，
完整依赖以 `openclaw-extensions/acpx/package-lock.json` 为准。开发 Node 与打包后
Electron Node 环境分开，不能用 host 原生 ABI 代替目标 Electron ABI。
ACPX 封装与 TypeSafe 源码均以 OpenClaw v2026.10.4 为上游基线，并保留各自
来源记录中的本地定制。acpx 0.19.5 是独立运行库升级；其版本、传递依赖及目标平台
可选原生包由 ACPX 的生产锁文件固定，不按上游默认命令在用户运行时下载。

已联网或内网准备好的最终 runtime 仍需完整来源、补丁、预编译和 freeze 核验。不得
手工补 generated bundle、跳过 hash 或从旧补丁目录移植文件。各平台准备命令、串行
次序和产物验收见[升级检查清单](openclaw-upgrade-checklist.md#15-重建构建产物与自动化回归)。

## 2. Windows MinGit

下载 [MinGit 2.55.0.3 x64](https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip)，
保存为 `resources/MinGit-2.55.0.3-64-bit.zip`，保持原字节，不自行解包改内容。

```powershell
npm run setup:mingit
```

其他本地位置可通过 `JUSTDO_PORTABLE_GIT_ARCHIVE` 指定，镜像地址通过
`JUSTDO_PORTABLE_GIT_URL` 指定；路径相对当前工作目录解析，允许中文和空格。
镜像仍必须提供同一锁定归档，不能借 URL 覆盖绕过 SHA-256/版本校验。输出是
`resources/mingit/`，标准 Windows 发布流程会再次准备和检查。

## 3. Windows Python 与锁定 Python 依赖

| 默认下载入口                                                                                               | 内容与目的位置                                                                         |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [CPython 3.12.10 embeddable x64](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip) | 原始运行时归档；默认缓存入口 resources/python-win-runtime.zip                          |
| [get-pip.py](https://bootstrap.pypa.io/get-pip.py)                                                         | Windows bootstrap 的临时输入；没有固定手工缓存扫描目录                                 |
| [pip.pyz](https://bootstrap.pypa.io/pip/pip.pyz)                                                           | 需要时准备 resources/python-win/tools/pip.pyz；不是用户安装目录                        |
| Python wheel registry/mirror                                                                               | resources/python-requirements.txt 的完整带 hash 依赖，安装到 Lib/bundled-site-packages |

```powershell
npm run setup:python-runtime
```

完整预构建本地包可放入 `resources/python-win-runtime.zip`，或用
`JUSTDO_PORTABLE_PYTHON_ARCHIVE` 指向它；镜像输入用 `JUSTDO_PORTABLE_PYTHON_URL`。
原始 embeddable zip 不含 pip 和全部受管依赖，不能把「Python 已解压」称为完整离线就绪。
脚本会配置 site-packages、python3 别名、pip 载体及受管依赖，并在 Windows 上验证 import。
每次准备仍重新安装 hashed requirements，已有资源目录不意味着无需 wheel 来源。

完全断网准备需要同时具备运行时、pip 载体和所有受管 wheels；可以使用 pip 支持的
本地 wheelhouse/镜像配置，但脚本当前没有单独的 wheelhouse CLI 参数。`get-pip.py`
和 `pip.pyz` 默认为上游可变入口，不具有本项目 source-lock 级别的原包锁定；需要严格
离线供应链时应使用已审查的预构建包/内部镜像，并保留来源证明，不能虚构脚本已校验它们。

非 Windows 主机默认跳过该准备；跨平台生成 Windows 资源时显式执行：

```powershell
node scripts/runtime/setup-python-runtime.js --required
```

此时还需 host Python，依赖安装仍针对 CPython 3.12/win_amd64，并非给 macOS/Linux
打包一套 Windows Python 作为本机解释器。输出 `resources/python-win/`；
外部 LibreOffice、Poppler 等系统工具不由这份 Python 基线提供。

## 4. 本地语音引擎（Windows x64）

下载以下文件，按指定名称放入 `resources/local-tts-cache/`，保持原内容，无需解压。

| 下载地址                                                                                                                                              | 保存文件名                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Sherpa ONNX 1.13.7 运行时](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2) | sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2 |
| [Sherpa 许可证](https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.7/LICENSE)                                                                 | sherpa-onnx-LICENSE                                      |

```powershell
npm run setup:local-tts
```

该命令默认只准备引擎与许可证，不下载全部权重。脚本按锁定 SHA-256 校验缓存，
有完整版本标记与必需文件时复用；单个 exe 存在不构成完整运行时证明。

## 5. 语音模型源包与发布产物

以下源包与许可证也放在 `resources/local-tts-cache/`。源包不是设置页下载的产品
`.tar.zst` 产物，不能改扩展名后直接发布或复制到用户模型目录冒充已安装。

| 下载地址                                                                                                                                                    | 保存文件名                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [Kokoro 多语言 INT8](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2)                                | kokoro-int8-multi-lang-v1_1.tar.bz2                             |
| [SenseVoice Small INT8](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2) | sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2 |
| [SenseVoice 许可证](https://raw.githubusercontent.com/modelscope/FunASR/main/MODEL_LICENSE)                                                                 | sensevoice-LICENSE                                              |
| [Whisper Base](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2)                                         | sherpa-onnx-whisper-base.tar.bz2                                |
| [Whisper 许可证](https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE)                                                                        | sherpa-onnx-whisper-base-LICENSE                                |
| [AISHELL3 VITS](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2)                                        | vits-icefall-zh-aishell3.tar.bz2                                |
| [Icefall 许可证](https://raw.githubusercontent.com/k2-fsa/icefall/master/LICENSE)                                                                           | vits-icefall-zh-aishell3-LICENSE                                |
| [Piper Lessac INT8](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium-int8.tar.bz2)                         | vits-piper-en_US-lessac-medium-int8.tar.bz2                     |
| [Lessac 数据许可证](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html)                                                      | vits-piper-en_US-lessac-medium-int8-LICENSE                     |

所有归档与独立许可证按 `scripts/runtime/setup-local-tts.js` 的 SHA-256 校验；
Kokoro 的许可证由脚本从模型包材料准备，不另设可猜测的公网地址。上游 main/master
许可证即使地址未变，字节变化也会校验失败，需要重新审查，不能关闭 hash 检查。

```powershell
npm run setup:local-speech-models
npm run build:local-speech-model-artifacts
```

准备目录为 `resources/local-tts/win-x64/<model-id>/`；发布输出在
`build-speech-models/speech-models/v1/`，包含 manifest 与有版本/修订身份的 `.tar.zst`。
产品下载目录、文件名、大小、hash 和音色元数据以 `src/shared/speech/` 模型目录为准。
源包更新或产品包装修订后，更新编译期 metadata 并用新文件身份发布，不原地更换旧包字节。
用户实际安装目录为 `<userData>/local-speech-models/<model-id>`，引擎与用户权重分别判断就绪。

## 6. draw.io 离线编辑器

构建时下载锁定的 [draw.io 源码归档](https://codeload.github.com/jgraph/drawio/tar.gz/9034053fba80a435e27d68d374bc564b83917ae9)，文件名为
`drawio-9034053fba80a435e27d68d374bc564b83917ae9.tar.gz`，放入
`resources/drawio-cache/`。SHA-256：

```text
f02fdcff60653653eef185ad65db3331083bd89c60ab8b4e19edaa11f65ca571
```

来源锁定记录为 `openclaw-extensions/drawio/upstream.json`；资源准备和校验实现归该插件的 `scripts/` 目录所有，根 npm 命令只负责委托。

XML 解析依赖 `saxes@6.0.0` 的 npm 包未携带许可证文件；上游固定版本的[完整许可证](https://raw.githubusercontent.com/lddubeau/saxes/v6.0.0/LICENSE)已保存为 `openclaw-extensions/drawio/licenses/saxes-6.0.0.txt`，原始下载 SHA-256 为 `0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e`。构建从仓库副本复制，不再联网获取；同名依赖的不同版本分别保留许可证目录。

在已有 npm 锁定依赖的构建机上，从本地归档准备：

```powershell
npm run drawio:prepare
npm run drawio:verify
```

归档在其他获准位置时使用 `npm run drawio:prepare -- --archive "D:\离线资源\drawio-9034053fba80a435e27d68d374bc564b83917ae9.tar.gz"`。
允许联网的资源准备机也可显式执行 `npm run drawio:prepare -- --download`；该开关仅用于构建资源准备，产品运行时没有下载入口。

开发入口 `npm run electron:dev:openclaw` 已集成 `drawio:prepare -- --ensure --download`，在准备 host runtime 前校验并复用现有资源；缺失或陈旧时优先使用上述本地缓存归档，缓存不存在才下载锁定归档。内网开发机提前复制该归档即可沿用同一个启动命令；已有缓存校验失败时直接报错，不自动下载覆盖。单独执行 `drawio:prepare` 仍默认只使用本地归档，发布构建和产品启动不自动下载。

输出为 `openclaw-extensions/drawio/assets/`，包含完整 Web 编辑器、布局/worker/WASM/公式/形状资源、本地 stdio 服务、标准 App SDK bundle、逐文件哈希和许可证。原始 tar 包及生成目录不提交 Git。npm 依赖、Node 和 esbuild 仍应按本文件第 1 节由完整内网 registry/cache 提供。

资源组装复制到目标 runtime 的 `dist/extensions/drawio/assets/`，预编译扩展和最终打包再次核对资源。缺失、陈旧、篡改或多余文件直接报错；不在打包或启动阶段自动下载。若适配器、锁定依赖或准备脚本变化，重新准备资源并按 OpenClaw 构建规则重建运行时，不能只修改产物哈希。

安装包不需要上述归档、npm、开发工具或公网连接。平台发布 CI 在构建阶段显式准备资源；内网构建机使用已校验的本地归档。实际使用只运行随包提供的 Node/MCP 服务和本机只读资源 listener；渲染和导出不连接公共 MCP、CDN、云存储或远程转换服务。部署和验收细节见 [draw.io 离线绘图](features/chat/drawio-offline.md)。

## 7. 准备完成后的检查

- 资源对应本次目标平台/架构，版本、hash、许可证与脚本要求一致。
- Python 依赖已通过目标解释器真实 import；语音模型不是半成品解包目录。
- 原生 npm 包具有完整 registry/source-lock 证明，最终 runtime 的 CLI、SDK、worker、
  扩展、ASAR 与 freeze 核验通过，未混用运行中或旧补丁目录。
- 在最终安装包上确认缺网启动不会偷偷补下载运行依赖；模型与认证服务按部署约定联网。

这些是资源验收要求，不是本次已经执行的下载/构建结论。安装包具体链路见
[技术栈](architecture/12-tech-stack.md)、[Windows 安装器](windows-installer.md)和
[本地语音](features/models/local-tts.md)。
