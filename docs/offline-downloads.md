# 离线资源下载清单

本文只记录开发启动或 Windows EXE 打包前，无法自动下载、需手动放入仓库 `cache/` 的文件。
每项必须给出下载地址、完整文件名和 `cache/` 下的放置路径。

路径相对仓库根目录。下载后保留原包，无需解压。

## 1. Windows MinGit

| 下载地址 | 放置位置 |
| --- | --- |
| [MinGit 2.55.0.3 x64](https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip) | `cache/mingit/MinGit-2.55.0.3-64-bit.zip` |

## 2. Windows Python

| 下载地址 | 放置位置 |
| --- | --- |
| [CPython 3.12.10 x64](https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip) | `cache/python/python-3.12.10-embed-amd64.zip` |

## 3. 本地语音引擎（Windows x64）

| 下载地址 | 放置位置 |
| --- | --- |
| [Sherpa ONNX 1.13.7 运行时](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2) | `cache/local-speech/sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2` |
| [Sherpa 许可证](https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.7/LICENSE) | `cache/local-speech/sherpa-onnx-LICENSE` |

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

## 5. draw.io 离线编辑器

| 下载地址 | 放置位置 |
| --- | --- |
| [draw.io 锁定源码归档](https://codeload.github.com/jgraph/drawio/tar.gz/9034053fba80a435e27d68d374bc564b83917ae9) | `cache/drawio/drawio-9034053fba80a435e27d68d374bc564b83917ae9.tar.gz` |
