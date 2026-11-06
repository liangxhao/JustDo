# 配置式语音合成 provider

本包是锁定来源的完整 `tts-local-cli` 源码替换，保留原生插件和 provider 身份、CLI 合同及许可证。注册的是原生 `tts` 工具使用的 speech provider，不注册同名自定义工具；扩展启停／deny 同时约束本地和在线分支。原始文件 hash 见 [upstream-source.json](../../../../plugins/extensions/tts-local-cli/upstream-source.json)，包概览见 [README](overview.md)。

## 配置与执行

宿主把明确选中的模型发布到 `tts.providers["tts-local-cli"]`；插件不选择模型、下载权重或创建另一份模型目录。

- 本地模式沿原生 `command`、`args`、`outputFormat`、`timeoutMs`、`cwd`、`env` 合同执行。路径及参数由可信配置提供，不由任务文本变成 shell 命令；模型和运行时须事先安装。源实现保留原生行为，任务文字预览不写日志。
- 在线模式要求 `mode: "online"`、显式 HTTP(S) `baseUrl`、`model` 和 `speakerVoice`；可选 `apiKey` 的 SecretRef 必须经原生准备。请求使用原生 HTTP／SSRF SDK，只信任所配 origin，禁止重定向，响应上限 50 MiB。
- 不从环境寻找凭据、不添加公网默认地址、不在失败后重试本地或另一 provider。在线 telephony 不受支持。

宿主的原生配置须通过实际持久 schema：当前 provider 使用 `speakerVoice`／`speakerVoiceId`，不要把界面别名或未支持字段放进原生配置。插件不拥有产品朗读开关或扩展齿轮的模型选择事务。

## 原生偏好、fallback 与取消

插件内部没有 provider fallback；原生 TTS 上层仍可能按 persona／偏好选择 provider。要求只使用此 provider 的宿主必须建立仅绑定它的 persona，并设置 `fallbackPolicy: fail`，同时隔离工具与其它朗读用途的偏好路径。工具偏好可由原生 `OPENCLAW_TTS_PREFS` 环境入口指定；顶层持久 `tts` schema 不接受 `prefsPath`，显式 API 参数与配置字段不能混淆。

原生 TTS provider 调用不提供 AbortSignal。在线合成由配置超时约束；停止播放不能宣称已取消远端合成。宿主应撤销过期播放结果并在返回后复核当前 owner／设置，而不是盲目重发请求。

## 分发与验证

本包、目标平台依赖及许可证必须随分发产物提供；用户运行时不下载依赖。包内 `tests/` 的 source-replacement、online 和 native-sdk-contract 用例覆盖来源替换、原生 provider schema、origin／响应边界及配置请求行为。集成工作区须提供匹配的 SDK 和测试环境。

宿主还应从锁定运行时的完整 schema 和加载期 legacy 校验确认持久配置可启动，覆盖错误顶层 `tts.prefsPath` 拒绝；宽松 resolver 测试不能替代这一事实。真实模型、内网端点、目标平台 CLI 和播放设备仍需分别验收。
