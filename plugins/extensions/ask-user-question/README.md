# Ask User Question

本包提供结构化提问工具，工具、问题期限、选项与回答结果归本包；宿主负责当前会话的可信交互界面与原生权限。

结构化提问工具以 `ask_user_question` 注册；插件 ID 仍为 `ask-user-question`，
配置及 `askUserQuestion.list` / `askUserQuestion.resolve` RPC 保持原契约。
插件在成功工具结果中返回版本化问答快照，覆盖用户提交、超时默认、超时未答及取消。

原生允许保留的完整 JSON text envelope 与实时 details 承载相同结果，历史不依赖自定义 details；
插件 `contracts/` 负责纯校验，`browser/` 负责只读问答呈现，宿主仅适配原生工具投影与现有过程折叠。
原生 transcript、问题窗口及响应 RPC 继续持有原所有权，不追加模拟用户消息或 runtime patch。

接口与配置由 `openclaw.plugin.json`、包内 `contracts/`、`browser/` 和实现共同维护。迁仓时必须接入兼容的原生注册、问题事件和宿主回答通道；仅构建成功不代表真实交互验收通过。
