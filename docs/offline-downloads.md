# 离线资源下载清单

本文只记录需要额外准备的非 npm 离线资源；Node.js/npm 等前提环境不在本清单范围。
npm 包通过镜像安装，不再单独列出。

路径相对仓库根目录。下载后保留原包，无需解压。

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

归档校验后由项目自带的 Node `tar` 解包，每次使用独立暂存目录并在结束后清理。无需安装或更换系统 tar；修复脚本后可直接重新执行准备命令，旧的失败暂存目录不会参与本次构建。

## 6. Windows 安装器原生时钟

安装器使用的 `installer-clock.dll` 和 `manifest.json` 已随仓库提供，位于
`resources/installer-clock/win-x86/`。普通 Windows 打包直接校验并嵌入这两个文件，
无需安装 Visual Studio、MSVC 或 Windows SDK，也不会为此联网下载或现场编译。
NSIS 安装器为 x86，因此此 DLL 也是 x86，与应用本体的 x64 架构无冲突。

可提前单独校验：

```powershell
node scripts/packaging/installer-clock-assets.cjs
```

修改时钟 C 源码、导出定义、生成脚本或编译参数后，维护者需在已安装 MSVC x86
工具链和 Windows SDK 的 Windows 电脑上显式重新生成：

```powershell
node scripts/packaging/installer-clock-assets.cjs --rebuild
```

重建中间文件保留在 `build/installer-clock/`；编译成功后更新上述 DLL 和清单。
将两个文件与匹配的源码一起提交或拷贝到离线构建电脑即可，无需复制编译工具链。
清单按固定仓库相对路径和规范化换行后的源码计算哈希，支持不同磁盘路径及 Git
换行设置；DLL 缺失、损坏或与源码不匹配会明确失败，不会自动编译。
旧的 `build/installer-clock/` 编译缓存不能代替这两个随仓库提供的资源。
