# 模型管理：能力目录与运行选择

设置中的模型页统一管理在线语言、决策、语音识别、语音合成、图像生成和原生视频生成。离线语音模型下载和设备选择留在语音设置。视频选择使用原生服务商身份，其地址和凭据与该服务商的其他模型共用；配置仅接受当前支持的原生视频服务商。

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

| 能力     | 原生入口/位置                     | 隔离要求                                                                |
| -------- | --------------------------------- | ----------------------------------------------------------------------- |
| 语言     | models providers 与会话模型       | builtin 与用户 provider 分开                                            |
| 在线识别 | talk.catalog、config API          | transcription-only Talk，不触发对话脑                                   |
| 在线合成 | tts.providers、config API         | voice 属于具体模型                                                      |
| 图像生成 | agents.defaults.mediaModels.image | justdo-image-openai 配置域                                              |
| 视频生成 | agents.defaults.mediaModels.video | Kie AI、Z.AI、NovitaAI 原生服务商、模型及 API Key；旧自定义配置保留备份 |
| 图像理解 | agents.defaults.imageModel        | 不等同图像生成                                                          |

原生 image 使用能力限定的配置视图，保留 manifest 的 canonical provider ID，不改写语言模型的 models.providers.openai。多个能力同用一种协议也不能互相覆盖 endpoint/key。

## 4. 发现与端点规范化

发现先尝试 OpenAI-compatible /models，缺失或为空时检查服务根 /openapi.json 中对应请求 schema 的默认值/enum。新 ID 合并而不删除手工模型。完整能力 URL 粘贴后去除已知 suffix，避免原生再次追加造成重复路径。

请求具有 timeout/cancel 和上下文 generation；切换 Provider 或模型后旧响应不能覆盖新表单。模型发现成功只能证明目录接口，不证明执行协议完全兼容。

## 5. 协议支持边界

在线识别需要匹配原生 Realtime transcription WebSocket 与音频格式，普通 REST transcription URL 不能冒充等价。TTS 和 Images 也需实现对应请求与下载协议，不是任意同名 HTTP 服务都可用。

TTS voice 最佳努力查询 audio/voices、voices、服务根 api/voices，并支持手填。没有 voice 的合成模型不会自动配一个任意默认值进入语音选择器。

OpenClaw 2026.9.8 已移除 OpenAI 视频生成器。视频设置提供 Kie AI、Z.AI、NovitaAI 原生服务商选择、对应模型目录、服务地址和 API Key；目录来自固定版本的原生 provider 契约，不请求付费服务或伪造 `/models` 视频发现接口。Kie 使用内置插件，Z.AI 与 NovitaAI 使用随应用固定打包的官方 provider 插件。

保存的视频条目带有 `nativeVideoProvider`，由应用配置同步器在启动、设置保存及登录状态变化时投影到 `agents.defaults.mediaModels.video` 和原生 `models.providers.<id>`，并启用所选插件。API Key 通过权限受限的 `extension-secrets.json` 文件 SecretRef 提供给运行时；Gateway 配置不包含明文凭据。视频服务商使用原生身份，因此同身份的语言模型共用地址和凭据。取消默认视频模型仅清除该默认选择，不关闭可能供其他能力使用的插件；原生运行时仍可按已有凭据和会话工具权限发现其他视频能力。导入导出沿用加密凭据流程并保留原生服务商标记。

9.6 未发布，本次新增的旧 `/videos` 配置兼容读取与专用展示已移除。Main 与设置页均拒绝不支持的服务商配置，Main 继续拒绝 OpenAI 视频 primary/fallback 和任意兼容端点写入。图像生成的独立端点不受影响。

## 6. 凭据、保存与错误

在线配置通过 preload 到 Main，不让 Renderer 直接管理 Gateway secret。builtin 使用短期 JWT 和空 apiKey 投影；用户 provider 保留自身配置及派生 SecretRef，具体保护见[安全模型](../architecture/11-security-model.md)。

保存本地目录、应用原生配置和连接测试是不同阶段。失败应保留可编辑数据并说明阶段，不能显示“成功”后实际仍用旧 endpoint。当前 catalog UI 不提供任意 fallback 策略编辑。

## 7. 回归检查

验证同名/改名、手工模型保留、过时发现响应、完整 URL 规范化、多能力凭据隔离、voice 缺失、main 默认与助手 override，以及真实原生请求。入口在 settings/models、providers、mediaGenerationModels 和 onlineAsr/onlineTts IPC 及其测试。
