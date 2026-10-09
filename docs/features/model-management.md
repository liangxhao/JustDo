# 模型管理：能力目录与运行选择

设置中的模型页统一管理在线语言、决策、语音识别、语音合成、图像生成和原生视频生成。离线语音模型下载和设备选择留在语音设置。视频提供方包含随应用打包的视频协议适配器，以及实际安装的受支持原生服务商。

## 1. 目录不等于当前执行模型

Provider 目录描述可选择模型，应用默认决定新用户会话，session override 决定特定会话，专用助手可有独立模型。main 的旧档案 model 不再覆盖应用默认。

一次实际回复的模型以原生 progress/final 与历史为证据，不能用发送前选择覆盖 fallback 结果。model 字段可能含斜杠，必须保留 provider/model 身份，不能根据字符串前缀猜归属。

## 2. 用户配置流程

1. 在对应能力页添加 Provider，填写名称、端点和凭据。
2. 手工添加模型，或执行发现后与已有模型合并。
3. 配置能力所需选项，例如 TTS 模型自己的 voice。
4. 选择默认并保存，由 Main 应用到原生配置。
5. 语音页选择在线模型时立即采用其端点、凭据和模型，不再重复编辑 Provider。

非语言能力目录初始为空，不预填公共厂商或猜测模型。名称遵循原生安全格式、保留名与大小写不敏感唯一规则；改名使用产品稳定身份识别。

## 3. 原生配置落点

| 能力     | 原生入口/位置                     | 隔离要求                                                                    |
| -------- | --------------------------------- | --------------------------------------------------------------------------- |
| 语言     | models providers 与会话模型       | builtin 与用户 provider 分开                                                |
| 在线识别 | talk.catalog、config API          | transcription-only Talk，不触发对话脑                                       |
| 在线合成 | tts.providers、config API         | voice 属于具体模型                                                          |
| 图像生成 | agents.defaults.mediaModels.image | justdo-image-openai 配置域                                                  |
| 视频生成 | agents.defaults.mediaModels.video | video-openai 独立配置域；已安装的 Kie、Z.AI、Novita 使用各自原生身份 |
| 图像理解 | agents.defaults.imageModel        | 不等同图像生成                                                              |

原生 image 使用能力限定的配置视图，保留 manifest 的 canonical provider ID，不改写语言模型的 models.providers.openai。多个能力同用一种协议也不能互相覆盖 endpoint/key。

## 4. 发现与端点规范化

发现先尝试 OpenAI-compatible /models，缺失或为空时检查服务根 /openapi.json 中对应请求 schema 的默认值/enum。新 ID 合并而不删除手工模型。完整能力 URL 粘贴后去除已知 suffix，避免原生再次追加造成重复路径。

请求具有 timeout/cancel 和上下文 generation；切换 Provider 或模型后旧响应不能覆盖新表单。模型发现成功只能证明目录接口，不证明执行协议完全兼容。

## 5. 协议支持边界

在线识别需要匹配原生 Realtime transcription WebSocket 与音频格式，普通 REST transcription URL 不能冒充等价。TTS 和 Images 也需实现对应请求与下载协议，不是任意同名 HTTP 服务都可用。

TTS voice 最佳努力查询 audio/voices、voices、服务根 api/voices，并支持手填。没有 voice 的合成模型不会自动配一个任意默认值进入语音选择器。

内网发行版保留 OpenAI 插件作为兼容协议适配器，在线识别和在线合成使用用户选择的内网端点、模型及凭据。保留该插件不要求使用 OpenAI 官方服务；兼容协议与模型实际部署位置是两回事。ElevenLabs 插件不再打包，也不再列入受管语音提供方。

ASR/TTS IPC 只返回 Gateway 实际注册的受支持适配器及凭据状态，不维护厂商默认模型或音色目录，也不透传 Gateway 插件的预设模型与音色。当前受支持的在线语音适配器只有 OpenAI；Deepgram、Mistral 等未打包适配器不进入配置选项。端点、模型、音色均从用户显式配置读取；目录为空或 Gateway 不可用时返回空选项，保存缺失模型或音色的配置会被拒绝。

OpenClaw 2026.9.8 已移除其 OpenAI 视频生成器。应用新增原生 provider 插件 `video-openai`，随运行时打包，默认关闭，保存视频配置后启用。“视频模型”与图像、决策等类别共用同一模型编辑组件：左侧供应商列表和添加/删除入口，右侧依次为显示名称、凭据卡片、模型列表；使用相同的模型添加/编辑弹窗、默认标记和密码显示按钮。标题不附加协议名称。添加自定义供应商后，填写 API 基础地址（包含服务实际使用的版本前缀，例如 `http://127.0.0.1:8000/v1`）和可选 API Key，再添加模型 ID/显示名称并选择默认模型。不预填公网地址或厂商模型；打开、编辑或保存页面均不请求模型服务。仅点击“自动识别模型”时查询所配置服务的 `/models`，空目录时再尝试服务根路径下的 `/openapi.json`，支持 Videos multipart 请求体中的模型枚举；不会提交测试生成任务。完整 `/videos` 地址在失焦和保存时规范化为基础地址。实际安装多个视频适配器时，在添加供应商弹窗中选择视频服务；固定目录服务的模型 ID 只能从原生目录选择。

该适配器使用 OpenAI-compatible 异步 Videos API：`POST <baseUrl>/videos` 以 multipart 提交 `model`、`prompt`、可选 `seconds` 和 `size`；通过 `GET <baseUrl>/videos/{id}` 查询 queued/in_progress/completed/failed 状态，完成后从 `GET <baseUrl>/videos/{id}/content` 下载视频。支持文生视频、单张 PNG/JPEG/WebP 参考图片（`input_reference`，最大 20 MiB），以及服务支持时的 fps、num_frames、num_inference_steps、guidance_scale、seed、negative_prompt 参数；服务端负责具体模型参数限制。不声明视频/音频参考、音频生成或水印能力。接口契约参考 [vLLM-Omni Videos API](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/videos_api/)，协议兼容不要求访问 OpenAI 官网。

生成继续使用原生 `video_generate` 工具、权限和素材读取。所有请求使用已配置地址、原生 HTTP 策略与有界响应读取；仅对该受管适配器允许私网访问，拒绝重定向，不读取环境或聊天凭据，不重试结果不确定的提交。提交、查询、下载共用总超时（默认 10 分钟），视频下载遵循原生媒体大小限制。

Kie AI、Z.AI、NovitaAI 仍按固定版本原生契约提供目录，三个插件均不随当前发行版打包，仅实际安装后显示。配置同步会清除缺失插件的注册和视频默认选择，并跳过相应凭据写入；应用中已保存的服务商配置及其他模型凭据仍保留。

保存的视频条目带有 `nativeVideoProvider`，由应用配置同步器在启动、设置保存及登录状态变化时投影到 `agents.defaults.mediaModels.video` 和原生 `models.providers.<id>`，并启用所选插件。非空 API Key 通过权限受限的 `extension-secrets.json` 文件 SecretRef 提供给运行时；Gateway 配置不包含明文凭据。清空视频适配器的 API Key 会移除其运行时凭据引用。该适配器的地址和凭据独立于聊天和图像模型；其他原生视频服务商与同身份语言模型共用地址和凭据。浏览其他供应商不会改变默认选择；多个供应商条目可保存独立地址和凭据，但仅所选默认条目投影到运行时。取消默认视频模型、删除最后一个默认模型或删除全部供应商会清除受管默认选择，不关闭插件。视频适配器没有预设默认模型，取消默认后不会自动选择一个模型；原生服务商仍可按已有凭据和会话工具权限发现其他视频能力。导入导出沿用加密凭据流程并保留原生服务商标记。

视频服务通过新的原生 provider 插件和受管设置接入；不恢复 9.6 的旧自定义视频配置、兼容读取或迁移。旧 media IPC 的 OpenAI 视频 primary/fallback 和任意兼容端点写入仍被拒绝，图像生成的独立端点不受影响。

## 6. 凭据、保存与错误

在线配置通过 preload 到 Main，不让 Renderer 直接管理 Gateway secret。builtin 使用短期 JWT 和空 apiKey 投影；用户 provider 保留自身配置及派生 SecretRef，具体保护见[安全模型](../architecture/11-security-model.md)。

保存本地目录、应用原生配置和连接测试是不同阶段。失败应保留可编辑数据并说明阶段，不能显示“成功”后实际仍用旧 endpoint。当前 catalog UI 不提供任意 fallback 策略编辑。

## 7. 回归检查

验证同名/改名、手工模型保留、过时发现响应、完整 URL 规范化、多能力凭据隔离、voice 缺失、main 默认与助手 override，以及真实原生请求。入口在 settings/models、providers、mediaGenerationModels 和 onlineAsr/onlineTts IPC 及其测试。
