# 配置式语音合成 provider

本包是锁定来源的完整 `tts-local-cli` 源码替换，保留原生插件和 provider 身份、CLI 合同及许可证。注册的是原生 `tts` 工具使用的 speech provider，不注册同名自定义工具；扩展启停／deny 同时约束本地和在线分支。原始文件 hash 见 [upstream-source.json](../../../../plugins/extensions/tts-local-cli/upstream-source.json)，包概览见 [README](overview.md)。

## 配置与执行

宿主把明确选中的模型发布到 `tts.providers["tts-local-cli"]`；插件不选择模型、下载权重或创建另一份模型目录。

- 本地模式沿原生 `command`、`args`、`outputFormat`、`timeoutMs`、`cwd`、`env` 合同执行。路径及参数由可信配置提供，不由任务文本变成 shell 命令；模型和运行时须事先安装。源实现保留原生行为，任务文字预览不写日志。
- 在线模式要求 `mode: "online"`、显式 HTTP(S) `baseUrl`、`model`、有效协议和 `voiceSelection`；可选 `apiKey` 的 SecretRef 必须经原生准备。支持 `openai-speech-http`，缺协议保留旧标准 Speech 语义；显式未知协议或废弃兼容字段拒绝执行。
- 音色为 `{kind: 'preset', voiceId}`，不省略或猜测默认音色。旧配置缺少选择字段时可读取 `speakerVoice`；显式空选择或废弃默认选择不恢复旧音色。克隆和音色设计不准入普通合成。
- 在线分支通过公开 `speech-core.getSpeechProvider('openai', cfg)` 查找并验证对应 provider，再以请求内配置委托同一[在线合成实现](../openai/speech.md)，不导入另一个扩展源码。HTTP、origin trust、零重定向和有界完整响应由该实现执行；插件继续持有自己的身份、启停准入和工具偏好。
- 不从环境寻找凭据、不添加公网默认地址、不在失败后重试本地或另一 provider。在线 telephony 不受支持。

宿主的原生配置须通过实际持久 schema，保留协议和结构化音色选择；有效预置选择映射为 `speakerVoice`／`speakerVoiceId`，缺少选择时不可合成。插件不拥有产品朗读开关或扩展齿轮的模型选择事务。

## 原生偏好、fallback 与取消

插件内部没有 provider fallback；原生 TTS 上层仍可能按 persona／偏好选择 provider。要求只使用此 provider 的宿主必须建立仅绑定它的 persona，并设置 `fallbackPolicy: fail`，同时隔离工具与其它朗读用途的偏好路径。工具偏好可由原生 `OPENCLAW_TTS_PREFS` 环境入口指定；顶层持久 `tts` schema 不接受 `prefsPath`，显式 API 参数与配置字段不能混淆。

原生 TTS provider 调用不提供 AbortSignal。在线合成由配置超时约束；停止播放不能宣称已取消远端合成。宿主应撤销过期播放结果并在返回后复核当前 owner／设置，而不是盲目重发请求。

## 分发与验证

本包、目标平台依赖及许可证必须随分发产物提供；用户运行时不下载依赖。包内 `tests/` 的 source-replacement、online 和 native-sdk-contract 用例覆盖来源替换、原生 provider schema、origin／响应边界及配置请求行为。集成工作区须提供匹配的 SDK 和测试环境。

`native-sdk-contract.test.ts` 启动隔离 Node 子进程，显式加载锁定 SDK，并用随机端口的 `127.0.0.1` HTTP 假服务测试标准录音转写和 Speech 合成。它通过真实 OpenAI Speech provider 和本工具的公共注册表委托发送请求，独立校验方法、部署前缀、认证、模型、音色及返回字节，覆盖废弃配置拒绝发送、错误响应、重定向零泄漏和 TTS 超时断链。TTS 没有取消信号，超时证据不能表述为用户取消了远端合成。

探针通过 `SPEECH_TEST_RUNTIME_ROOT` 显式选择已准备的运行时；未指定时只使用约定的工作区准备路径，缺失即跳过，跳过不是通过。子进程的 HOME/STATE/CONFIG/PREFS 指向临时 fixture，并隔离代理、debug proxy、证书与环境模型凭证；父进程环境不变。网络和 SDK 未被模拟，解码/播放设备和真实模型则不在此探针范围内。

宿主还应从锁定运行时的完整 schema 和加载期 legacy 校验确认持久配置可启动，覆盖错误顶层 `tts.prefsPath` 拒绝；宽松 resolver 测试不能替代这一事实。真实模型、内网端点、目标平台 CLI 和播放设备仍需分别验收。
