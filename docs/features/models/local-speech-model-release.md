# 语音模型打包与发布

本文面向开发、打包和部署人员，说明本地语音模型从原始资源到内网下载服务的发布流程。
EXE 携带 Sherpa 运行时；模型权重独立打包并上传服务，用户在模型页按需下载。
用户侧使用和安装事务见[语音与本地转录](local-tts.md)。

## 准备模型

在仓库根目录使用 `.nvmrc` 指定的 Node.js，并先安装仓库依赖。原始归档和许可证的下载地址、
文件名、缓存路径统一见[离线下载清单](../../offline-downloads.md#4-语音模型)；
同时准备该清单中的本地语音引擎及其许可证。断网准备时先把文件放到 `cache/local-speech/`，保留原文件。

```sh
npm run setup:local-speech-models
```

该命令校验缓存、解包并裁剪模型，输出至 `build/runtimes/local-tts/win-x64/`。
缓存缺失时准备脚本会尝试下载，因此离线机器应提前备齐清单中的文件。
开发环境可以直接复用此目录中的运行时和模型。

## 生成发布包

```sh
npm run build:local-speech-model-artifacts
```

命令读取准备好的模型目录，生成 `build/speech-models/v1/`。每个 `.tar.zst` 包包含以模型 ID
命名的顶层目录，以及对应的 `MODEL-LICENSE.txt`。缺少模型目录或许可证时构建失败。

当前产物如下，实际文件名与包装修订以[构建脚本](../../../scripts/runtime/build-local-speech-model-artifacts.cjs)为准：

| 模型 | 发布文件 |
| --- | --- |
| Kokoro 多语言 INT8 | `kokoro-int8-multi-lang-v1_1.tar.zst` |
| SenseVoice Small INT8 | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.r2.tar.zst` |
| Whisper Base INT8 | `sherpa-onnx-whisper-base.tar.zst` |
| AISHELL3 VITS | `vits-icefall-zh-aishell3.tar.zst` |
| Piper Lessac INT8 | `vits-piper-en_US-lessac-medium-int8.r2.tar.zst` |
| 发布清单 | `manifest.json` |

`manifest.json` 记录各模型的 `id`、`file`、`sha256`、`compressedBytes`。
发布前核对这些值与客户端的
[`LOCAL_SPEECH_MODEL_ARTIFACTS`](../../../src/main/speech/localSpeechModelService.ts)一致，
不要在文档中重复维护大小与 hash。打包命令只生成本地产物，上传由部署人员完成。

## 上传与服务配置

将本次生成的模型包和 `manifest.json` 上传至内网静态文件服务，保留以下相对目录和完整文件名：

```text
<feedUrl>/
└── speech-models/
    └── v1/
        ├── manifest.json
        └── <发布文件名>.tar.zst
```

先上传模型包，再更新清单。上传过程应保持文件原始字节，不解包、不重新压缩或重命名。
部署目录中的旧客户端仍需使用的旧包也应保留。

在 [`src/config/appUpdate.ts`](../../../src/config/appUpdate.ts) 中配置 `APP_UPDATE_CONFIG.feedUrl`
为上述服务根地址，`speechModels.path` 当前为 `speech-models/v1`。
客户端据此拼接模型下载地址；开发时修改后重启 Electron，安装版需要重新打包。
地址留空时不会发起模型下载，界面提示联系管理员配置。

服务及其代理应支持 HTTP Range：客户端按 16 MiB 分段请求，服务返回 `206` 和匹配的
`Content-Range`，并保持原始文件字节。首次请求返回完整 `200` 也可下载，但无法避开代理的
单响应大小限制；后续分段返回完整文件会失败。下载完成后客户端校验总大小与 SHA-256。

## 更新与验证

已发布文件不可原地换字节。模型内容或包装变化时，使用新的模型身份或包装修订文件名，
同步更新构建脚本、客户端文件名、大小与 hash；模型布局变化还需更新共享运行契约。
当前内置模型使用编译期完整性元数据，上传新的 `manifest.json` 不会覆盖这些校验值。

发布后从目标内网环境确认模型包地址可访问、Range 响应和大小正确；再通过模型页下载，
确认安装完成，并按模型类型做一次语音识别或合成。已安装模型的复用不依赖下载服务。
