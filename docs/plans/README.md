# 待办方案与验收

本目录只保存仍需推进的候选设计和未完成验收。已实施能力归入功能或架构文档；已完成、被替代的方案及旧测试流水删除，历史由 Git 追溯。

| 文档                                                      | 仍需处理的内容                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| [启动与历史升级验收](startup-upgrade-acceptance.md)       | 真实覆盖安装、企业账号、客户现场初始化问题与公共网络阻断验收 |
| [Goal 续跑协调验收](goal-continuation-coordination.md)      | 真实模型、UI、断连/重启组合及最终安装包验收 |
| [产品体验候选](openclaw-control-ui-adoption-plan.md)      | 导航剩余增强、门户、成果联动、活动与管理；已接入 Widget/终端不重复排期 |
| [MCP Apps 接入](mcp-apps-integration-plan.md)             | ChatGPT/Hermes 对照调研、消息与工作区展示、完整宿主及跨窗口生命周期    |
| [MCP Apps 大表格](mcp-apps-large-spreadsheets.md)         | 待实施；50 MiB 目标、分片传输、后台解析和表格容量压测                  |
| [MCP Apps Office 文件](mcp-apps-office-files.md)          | XLSX 结构编辑写回、PPTX 离线预览及 DOCX 候选                         |
| [高级协作候选](multi-agent-adaptation-plan.md)            | 角色委派、运行中指导及其授权/身份准入条件                              |
| [Agent Team 验收](agent-team-acceptance.md)               | 生产 FIFO、来源转发、完整界面与语音、未知执行及后续候选                |
| [MoA 独立扩展](moa-extension-plan.md)                     | Provider SDK 原型、多参考模型聚合、权限与调用成本验收                  |
| [Worktree 验收](worktree-integration-plan.md)             | 真实 Gateway/模型、重启恢复、失败清理与平台验证                        |
| [内网功能验收](intranet-feature-acceptance.md)            | 公司模型技能审核、企业网页人工介入、冷历史恢复                         |
| [交互式回答验收](interactive-answers-acceptance.md)       | 真实模型、最终安装包、多平台及原生状态/渐进呈现的依赖                  |
| [工具调用格式错误恢复](tool-call-format-recovery-plan.md) | 同原生循环接线已替代跨 attempt 方案；真实模型与重连验收              |
| [工具调用具体错误反馈](tool-call-format-feedback-plan.md) | 有界反馈、混合 schema/JSON 纠正与审查已实施；内网纠正率验收           |

计划不能作为产品已支持的证明；单元测试或旧环境通过不能替代当前真实验收。完成后将必要规则和限制写入对应现行说明，并清除本目录的已完成内容。
