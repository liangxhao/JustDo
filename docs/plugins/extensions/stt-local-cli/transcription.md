# 附件转录工具合同

`stt-local-cli` 保留唯一的 `transcribe_audio` 工具。显式 `mode: local` 使用已安装 Sherpa；`mode: online` 使用模型目录所配置 HTTP(S) 服务的 `/audio/transcriptions`，逐段提交 PCM 音频及所选模型。麦克风实时识别仍走 Talk WebSocket；仅有 WS(S) 地址的目录项不能作为附件转录服务，界面说明这一区别。两种模式均限制 256 MiB、一小时、一次一个转录，使用受限本地解码、有效 fsPolicy root/workspaceOnly 和 sandbox 准入；宿主应先把外部附件按其权限策略 staging 到当前项目再传入真实路径；插件不从消息文字授予文件权限。

在线路径只请求显式配置的服务，可使用内网地址和无认证服务；不读取环境凭据、不添加公共默认服务，不跟随重定向，也不在失败时改用另一模型或本地路径。工具执行与每次发送前核对当前配置和调用权限，中止终止本地解码及在线请求并清理临时文件。

工具描述要求把转录内容当数据而非指令。中止需要终止本地工作并释放 busy 标记，失败不应永久锁住后续转录。

## 输入、配置和依赖

工具输入为 `{"audio_path":"C:\\project\\meeting.mp3"}`；支持的音视频格式由工具 schema／描述公布。`mode`、模型与凭据由宿主配置，不由工具参数覆盖。实时麦克风开关与附件工具独立；只有工具准入和 provider 均有效时执行。

- 本地分支使用宿主已安装的 Sherpa 运行时和模型；本包不下载模型。当前集成提供 Windows x64 运行环境，其它平台须先提供实际运行时，不能把配置存在视为可用。
- 在线分支将受限解码后的 30 秒 PCM WAV 片段逐段发送到已配置 origin，经原生 HTTP／SSRF SDK 执行，重定向上限为零；无 key 的服务不添加 Authorization。一个片段失败即整次失败，不自动重试或返回伪完整结果。
- 解码器是相对本包解析的锁定 FFmpeg 平台依赖，独立进程执行并保留自身许可证；分发前需准备目标平台依赖。
- SecretRef 必须经原生准备后使用；不另建凭据读取器或依赖应用源码。

## 验证

包内 `tests/tool.test.ts` 与 `tests/online.test.ts` 覆盖真实选中配置、原生 multipart／origin trust／零重定向、无认证服务、工作区限制、并发拒绝、撤权／取消和 busy 释放。测试工作区须提供匹配的 OpenClaw SDK 和平台解码依赖；单测不代表真实设备、真实内网服务或最终分发产物已验收。

宿主应另行验证附件 staging、fsPolicy／sandbox、配置轮换、缺失模型、损坏文件、256 MiB／一小时限制和取消后的进程／临时文件回收。来源与包目录见[插件说明](../../../../plugins/extensions/stt-local-cli/README.md)。
