# 独立回复朗读服务

`runtimeServices.speech.synthesize` 是受认证的回复朗读 RPC，只接收有界文字和非敏感 `configurationId`，不接收调用方任意端点、模型或密钥。配置由宿主发布为本扩展自有 `replySpeech`。RPC 只有在所提交 ID 与当前原生 profile 的 ID 一致时才调用服务；磁盘写入或配置同步成功不能代替原生配置已应用。

服务从当前 profile 构建请求内 provider 视图，通过公开 `tts-runtime.synthesizeSpeech`、明确 provider 校验和 `disableFallback: true` 执行。标准 Speech 合成使用[在线 provider](../openai/speech.md)，保留显式协议和结构化音色选择，不覆盖助手工具的全局 `tts` 或音色偏好；废弃协议、兼容字段和默认音色选择不能执行。

独立 `reply-reading` persona 仅绑定所选 provider。服务使用公开 `runtime.state.resolveStateDir()` 定位 `speech-tools/reply-preferences.json`，作为 `resolveExplicitTtsOverrides` / `synthesizeSpeech` 的独立 `prefsPath` 参数，不写进持久 `cfg.tts`，不读取工具偏好路径；显式参数优先于工具偏好环境变量。禁用可选 TTS 工具插件不关闭此回复朗读服务。

响应完整缓冲、校验后才返回，HTTP SSE 与逐块播放未接入。原生公开 TTS API 暂无取消信号，宿主仍须按窗口、有效设置及配置代次撤销迟到播放，停止本地声音不能宣称远端已停止合成。

本扩展的 speech 测试及宿主的合成 IPC 测试验证配置匹配、协议、偏好隔离和迟到结果。模拟服务与锁定 SDK 不证明真实模型、设备、内网代理或最终分发产物已验收。
