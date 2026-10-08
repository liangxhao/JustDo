# 离线下载指南

## 本地语音运行时（Windows x64）

下载以下文件，按指定名称放入项目根目录下的 `resources/local-tts-cache/`，保持原文件内容，无需解压。

| 下载地址 | 保存文件名 |
| --- | --- |
| [Sherpa ONNX 1.13.7 运行时](https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2) | `sherpa-onnx-v1.13.7-win-x64-shared-MD-MinSizeRel.tar.bz2` |
| [许可证原文件](https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.7/LICENSE) | `sherpa-onnx-LICENSE` |

在项目根目录运行：

```powershell
npm run setup:local-tts
```
