# 实时输入配置与会话合同

本包保留锁定 OpenClaw OpenAI 扩展的完整能力实现；来源文件 hash 见 [upstream-source.json](../../../../plugins/extensions/openai/upstream-source.json)。本文只定义本地适配的实时转录入口，不把它等同于附件文件转录或语音合成。

## 显式配置

实时输入读取本插件自有 `plugins.entries.openai.config.transcription`，由原生 `resolveConfig` 在使用时解析。宿主负责发布所选端点、模型和原生准备的 SecretRef；配置明确撤下、模型缺失或选择失效时，不借用 `voice-call`、环境凭据、通用 provider 或默认模型补齐。

`baseUrl` 支持显式 HTTP(S)／WS(S) 实时服务地址，不能包含 URL 用户名／密码或 fragment。HTTP(S) 转换为 WS(S)，必要时追加 `/realtime`，并使用 `intent=transcription`。服务与 `model` 必须真实支持当前转录协议，仅有聊天接口不够。不添加公共服务默认值、公开目录探测或服务 fallback。

## 原生会话与宿主责任

使用公开 Talk Gateway 的 gateway-relay、brain=none transcription-only 会话。音频 append 串行发送，partial／final 只属于对应 transcriptionSessionId；宿主另核对窗口、设置和连接代次。停止、导航、设备丢失、权限失败或设置变化应关闭原会话并丢弃迟到事件，不能自动把转录发成聊天消息。

provider 的冷注册与运行路径共用同一配置解析合同。保留原生 SDK 的秘密准备、会话和错误归属，不通过应用私有导入、另一套凭据读取器或运行时补丁实现。

## 验证与范围

包内 `tests/transcription-profile.test.ts` 与配套 native probe 核对实际 manifest、明确端点、原生凭据准备、独立转录配置和有界实时状态。它们是宿主集成测试：当前 probe 仍要求集成工作区提供相符的源码布局、构建工具及冻结的 Gateway／SDK，不能只安装本包就宣称可独立运行；缺少准备运行时会跳过，跳过不是通过。独立迁仓时需显式重接该测试环境，不能回退搜索另一仓库。

宿主还必须测试采集、会话关闭、草稿不自动发送、设置换代和真实服务兼容性。合成事件和配置测试不能证明设备或内网服务已经可用。

本包还有聊天、媒体及其他 provider 能力，注册与 schema 以 [manifest](../../../../plugins/extensions/openai/openclaw.plugin.json) 和 [入口](../../../../plugins/extensions/openai/index.ts) 为准；本文不替代这些能力的各自契约。
