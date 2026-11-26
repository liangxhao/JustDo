# OpenAI Provider

OpenClaw 根据模型及能力归属选择加载该插件。配置选中其媒体生成、语音或嵌入等能力时，原生启动计划可提前加载；模型和独立请求也可按清单中的 provider 归属加载。

打包时将响应流、音频转录、嵌入请求和批处理等异步实现拆为独立模块，由对应请求加载。原生注册入口同步提供 provider 身份、能力和配置检查，能力目录及 provider 合同入口仍可独立读取。

- [转录协议](transcription.md)
- [语音合成协议](speech.md)
- [受管实时语音对话](realtime-voice.md)

[返回扩展索引](../README.md) · [全部插件文档](../../README.md)
