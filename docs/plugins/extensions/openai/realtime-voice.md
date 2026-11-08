# 受管实时语音对话合同

本插件注册受管 Realtime voice provider，配置来自自己的 `plugins.entries.openai.config.realtimeVoice`。仅接受 `openai-voice-realtime`，要求显式端点、模型、预置 `speakerVoice`、`inputTranscriptionModel` 和经原生准备的凭据；配置撤下时不借用转录、电话插件、环境凭据、公共模型或地址。输入转录模型用于强制助手委托，不能由宿主自动替换为其它用途模型。

公开的实时对话工厂使用同一受管配置入口；底层 bridge 和 wire 配置也要求完整参数，不保留自动补模型、音色或输入转录模型的旧分支。不提供固定在线模型或音色目录，不根据模型名称推断协议或能力。

源码不保留专属服务的账号头、订阅认证、私有 live/session 或浏览器通话实现；相关 Worker、专用媒体依赖和打包入口一并移除。这里的 OpenAI 名称只标识兼容协议和既有原生 provider 身份，不选择某个官方服务。

端点支持 HTTP(S)／WS(S) 规范化为服务 WebSocket，保留部署前缀，拒绝 URL 用户名/密码、fragment 和全部 query。当前只支持 `gateway-relay`、PCM16 单声道 24 kHz 输入/输出、VAD 自动轮次和 `agent-consult`。未接入浏览器 WebRTC、SIP、managed-room、手动音频 commit 或断线续传。

原生 Talk 持有实时会话、字幕、双向音频和助手委托。宿主须准备并核对精确的 native session/进程/连接身份，再桥接有界音频和播放标记；创建结果未知时不重试创建或重放音频。旧代次 close/interrupt 不能作用于替换后的会话。麦克风/扬声器静音属于宿主本地媒体控制；`cancelOutput` 和关闭 Talk 可请求取消关联助手运行，关闭 ACK 不构成准确 whole-run 终态。

Gateway relay 的 `toolCall` 通知需要宿主完成公开协议握手：对本会话的助手委托调用 `talk.client.toolCall`，按 ACK 中的确切 `runId` 取得可呈现结果，再交回 `talk.session.submitToolResult`。原生准入负责转录 flush、权限与运行绑定；宿主不重复 `chat.send`，不使用最新消息猜测结果，也不因 ACK 未知而重试。助手委托最终正文可能由原生隐藏，实际语音字幕才是最终可见回答。partial 字幕仅是原生实时事件，final 提供真实 `voice:<relaySessionId>:<entryId>` 标识，与原生消息 ID 相同；宿主可在现有聊天控制器中临时渲染并按 ID 接替，不能据此制造执行终态。

原生同时声明的 `openclaw_agent_control` 通过固定 `talk.session.steer` 调用处理，保留原生模式分类、当前 voice session 运行归属及权限检查，有界结果原样交回对应 `submitToolResult`。执行取消的回执与工具调用本身被撤销保持区分。未知工具仅得到固定的不支持错误；所有工具共用 callId 防重与连接/来源栅栏，不提供任意 RPC 转发。

包内 `tests/realtime-voice-profile.test.ts` 与配套显式 native probe 验证受管注册、配置、SecretRef、音频 descriptor 和当前锁定 SDK。

`tests/speech-realtime-wire.test.ts` 与配套 native probe 使用真实 `127.0.0.1` 随机端口 WebSocket 假模型服务，运行受管 provider 和实际 OpenAI bridge。服务独立核对部署前缀与 model query、Bearer／无密钥握手，以及 `session.update` 中任意已配置模型、音色、输入转录模型、PCM16／24 kHz 和 VAD 设置；不从生产 codec 生成期望值。测试传输实际音频字节，覆盖用户及助手增量／最终字幕、响应结束、function call／结果帧、输出取消与截断、取消后的迟到音频、正常关闭、启动错误和非法 Base64 音频。非法音频关闭后以有界连接事件守卫确认受管 bridge 没有重连。

wire probe 在独立子进程禁用 debug proxy／捕获，使用隔离配置与固定假凭据，不启动 Gateway 或读取用户数据；事件等待均有截止时间。探针仍依赖集成工作区提供的准备运行时；`OPENCLAW_TEST_NATIVE_RUNTIME_DIR` 显式路径不可用会失败，默认运行时缺失才跳过，跳过不算通过。这里验证的是假服务与实际协议实现之间的网络合同；宿主的媒体、换代和取消测试也不代替真实设备、目标服务及代理的现场验证。
