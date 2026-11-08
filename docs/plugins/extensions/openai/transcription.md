# 实时输入配置与会话合同

本包基于锁定的 OpenClaw OpenAI 扩展；保留源码的上游原始 hash 见 [upstream-source.json](../../../../plugins/extensions/openai/upstream-source.json)。该清单记录来源，不要求保留不支持的服务专属实现。本地语音只开放明确配置的通用协议，不保留上游的公共服务兜底。本文只定义实时转录入口，不把它等同于附件文件转录或语音合成。

## 显式配置

实时输入读取本插件自有 `plugins.entries.openai.config.transcription`，由原生 `resolveConfig` 在使用时解析。宿主负责发布所选端点、模型和原生准备的 SecretRef；配置明确撤下、模型缺失或选择失效时，不借用 `voice-call`、环境凭据、通用 provider 或默认模型补齐。

模型必须来自明确配置，公开 provider 工厂、底层会话和媒体文件音频转录都不内置在线转录模型目录或默认模型。媒体转录的 manifest 元数据不发布默认音频模型；缺少实际模型标识时在网络发送前拒绝，不能依赖自动探测补齐。

当前协议为 `openai-transcription-realtime`，`baseUrl` 支持显式 HTTP(S)／WS(S) 实时服务地址，不能包含 URL 用户名／密码或 fragment，query 仅兼容唯一的 `intent=transcription`。HTTP(S) 转换为 WS(S)，必要时追加 `/realtime`，并使用 `intent=transcription`。服务与 `model` 必须真实支持当前转录协议，仅有聊天接口不够。不添加公共服务默认值、公开目录探测或服务 fallback。

## 原生会话与宿主责任

使用公开 Talk Gateway 的 gateway-relay、brain=none transcription-only 会话，当前输入为 G711 μ-law / 8 kHz。音频 append 串行发送，partial／final 只属于对应 transcriptionSessionId；宿主另核对窗口、设置和连接代次。正常停止采集后有界等待 final，取消、导航、设备丢失、权限失败或设置变化关闭原会话并丢弃迟到事件，不能自动把转录发成聊天消息。

provider 的冷注册与运行路径共用同一配置解析合同。保留原生 SDK 的秘密准备、会话和错误归属，不通过应用私有导入、另一套凭据读取器或运行时补丁实现。

## 验证与范围

包内 `tests/transcription-profile.test.ts` 与配套 native probe 核对实际 manifest、明确端点、原生凭据准备、独立转录配置及显式撤下后的拒绝。它们是宿主集成测试：当前 probe 仍要求集成工作区提供相符的源码布局、构建工具及冻结的 Gateway／SDK，不能只安装本包就宣称可独立运行；缺少准备运行时会跳过，跳过不是通过。独立迁仓时需显式重接该测试环境，不能回退搜索另一仓库。

`tests/speech-realtime-wire.test.ts` 与配套 native probe 另用真实 `127.0.0.1` 随机端口 WebSocket 假模型服务，运行本包实际 provider 和锁定 SDK 的公开 WebSocket session，传输层不使用 stub。服务独立核对部署路径前缀、`intent=transcription`、Bearer／无密钥握手、`session.update` 中的 PCMU 格式与任意已配置模型，以及 Base64 帧解码后的实际音频字节。它验证增量与最终文字、重复 final、停止时未提交音频的 commit／最后结果、原生重连后的 item／增量隔离，以及启动错误。显式关闭后以有界连接事件守卫检查没有额外连接；实时转录仍保留原生重连能力，不能把此断言解释为禁止异常断线重连。

wire probe 将配置、状态、debug proxy 和凭据环境隔离到测试子进程；等待真实事件并设置截止时间，不启动 Gateway、不读取用户转录或调用真实模型。集成运行可用 `OPENCLAW_TEST_NATIVE_RUNTIME_DIR` 显式指定冻结运行时；显式路径缺失会失败，不能跳过后计为通过。未显式指定且默认准备运行时缺失时保留 skip，报告时须单列。

宿主还必须测试采集、草稿不自动发送、设置换代和真实服务兼容性。本机 wire、合成事件和配置测试均不能证明设备或目标内网服务已经可用。

本包还有聊天、媒体及其他 provider 能力，注册与 schema 以 [manifest](../../../../plugins/extensions/openai/openclaw.plugin.json) 和 [入口](../../../../plugins/extensions/openai/index.ts) 为准；本文不替代这些能力的各自契约。
