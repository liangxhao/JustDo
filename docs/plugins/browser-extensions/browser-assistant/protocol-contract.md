# 宿主接入要求

本包是浏览器扩展客户端，不包含桌面应用、执行引擎或 Native Messaging 可执行文件。
移入独立仓库时，应由集成方提供兼容宿主；复制这些文档或成功构建客户端不代表已经完成宿主集成。

## 标准协议

基础 Thread、Turn、Item 和双向 RPC 采用 [Codex app-server 协议](https://learn.chatgpt.com/docs/app-server)的已实现子集。
客户端每条连接先执行 initialize/initialized，再调用 model/list、thread/start/resume/read/list、
turn/start/interrupt，并按 ID 匹配响应和服务端请求。客户端必须忽略未知附加字段。
本包支持范围、固定验证基线及附加字段以[协议](protocol/app-server.md)、[数据模型](protocol/data-models.md)
和[兼容性](protocol/compatibility.md)为准，不宣称支持全部上游接口。

### 客户端使用的标准载体

Thread 以 id 标识线程，包含来源、目录、标题及加载状态；Turn 包含 id、status、items、itemsView 和错误信息。
Thread/Turn 的创建和起止时间采用 Unix 秒，Item 的 startedAtMs、completedAtMs 和 durationMs 采用毫秒。
富显示字段见[数据模型](protocol/data-models.md)，显示分组不是执行完成证明。

多段文字以换行合并，图片保持相对顺序；原生输入采用合并文字和有序附件，实时用户 Item 与历史采用同一归一化含义。
不承诺保留文字与图片交错位置，纯图片不生成空文字占位。
文本合并后最多 2 MiB UTF-8，规范化 content JSON 最多 6 MiB；还需同时满足本包 32,000 UTF-16 code units 和帧限额。
非空 text_elements、音频、fileId 和非 auto 图片 detail 未接入，明确拒绝。
原生历史可能使用受管 localImage 媒体引用；客户端通过已授权的图片接口读取，不取得任意文件读取或本地路径输入权限。

## 发现与鉴权

宿主须提供与本包固定扩展身份匹配的 Native Messaging 注册和发现程序，只发现已启动实例，
不由业务网页启动应用。发现协议版本和帧格式见[实例发现](protocol/native-messaging.md)。
WebSocket 校验 loopback、精确路径、扩展 Origin 和本进程 capability；发现能力不能授予任意会话或工具权限。
宿主不得向网页、侧栏或发现文件交付执行引擎凭据，发现凭据和工具授权分别管理。

## 会话、输入与执行

宿主只允许此客户端操作扩展创建的产品会话，并为原生会话、运行和连接代次提供精确绑定。
标准图片只接受 data URL；PNG、JPEG、GIF、WebP 校验真实字节，图片与文档附件合计最多 5 项、4 MiB，
消息入站最多 8 MiB。文本最多 32,000 个 UTF-16 code units，模型图片能力取自真实目录。
本包不获得宿主任意文件路径读取或任意远程图片下载权限。

本客户端的原生发送使用 chat.send，依靠精确 SID、权限与发送前后身份校验；该路径没有原子 lifecycle revision CAS，不得宣称与原生 agent 的 revision 准入等价。ACK 不匹配或身份变化仍保留 unknown。

执行结果只采用精确整轮终态。发送 ACK、停止 ACK、正文结束、idle 和视图关闭都不证明结算。
未知提交不能重放；断线撤回观察和审批交互，已接纳工作可继续，恢复时重新查询同一精确身份。
宿主历史必须保持原生权威，不以产品计时、显示分组或客户端缓存补造执行结果。

## 审批与网页入口

只有实际发送连接可回答其运行的审批；观察者不能接管。服务端已解决、撤销、到期或换代后旧回复无效。
命令会话授权须实验握手及明确提供的选项，每次仍为原生一次性许可；App 持久权限只接受真实原生 action。
网页站点的连接、直接发送和结果分享许可与工具审批独立。
网页 SDK 使用方式见[接入指南](website-sdk.md)，精确输入、结果与取消边界见[网页入口](website-launch.md)。

## 集成验收

集成方需验证真实 Native Host、匹配扩展身份、已打包桌面应用、原生授权和实际模型。
本包单元测试及本机 HTTP/WebSocket 夹具只验证对应客户端行为，不替代这条完整链路。
