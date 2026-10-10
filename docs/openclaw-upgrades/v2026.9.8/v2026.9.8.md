# OpenClaw v2026.9.8 升级说明

本页汇总从 v2026.9.6 到 v2026.9.8 的主要变化与最终取舍。9.6 应用构建未发布；本次新增的旧 SQLite 迁移桥接、启动门禁、测试及构建资产已撤回，不提供 9.6→9.8 自动迁移。旧 Decision 模型搬迁、旧工具名转换与旧自定义视频配置兼容也已移除。既有产品数据库初始化和原生存储所有权保持独立，见[数据存储](../../architecture/10-data-storage.md)。

## 依据与范围

升级对照固定的上游 v2026.9.6..v2026.9.8 源码与两版 CHANGELOG；对应源码 commit 为 eb377ac59e6c9fd6c7705028034812becf00271b 与 fc23bc864e4553c2d215e479eeec47b67a0bf943，不能将 tag 对象当作源码 commit。交付的 npm 原包另由[source-lock](../../../scripts/patches/v2026.9.8/source-lock.json)固定 integrity 和 SHA-256，不假定源码标签与发布产物布局相同。

9.7 带来主要架构与功能变化，9.8 以可靠性修复为主；模型目录仍按实际源码与原生发现结果核对。升级必须覆盖应用消费方、运行时模块与最终产物，不能只替换版本号。

## 主要变化与接入

| 上游变化                                                             | 产品处理与边界                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 统一 decision_evaluate，TypeSafe 专用工具/skill 与 config.model 退役 | 使用原生 Boolean/Choice/Score 评估和 agents.defaults.decisionModel；保留内网 serviceUrl、file SecretRef、显式禁用与工具 deny，见[决策模型](../../features/models/jev-integration.md)                                      |
| 通用 tasks.list/get 与 task event 移除                               | 子代理改用 sessions.list/describe 和会话生命周期；控制操作复核原生身份及 spawnedBy/controlOwner，不建立应用任务账本                                                                                                       |
| 首帧快照、追加 delta、正文替换与 skipped 工具状态                    | 自有 Renderer 消费原生事件；区分展示结果、工具结果与整轮终态，不新增 Main/Redux 正文缓存                                                                                                                                  |
| durable pendingInputs 与独立分页                                     | 主聊天和浏览器侧栏恢复临时显示投影；按原生 run/message 身份与回执去重，消费后追读正式历史；排队数量为零不能证明没有待处理输入                                                                                             |
| 历史、文件、数据库及 metadata worker 化                              | 适配异步读取、共享进程工厂、动态模块与 worker 原始位置；在最终 Gateway bundle 验证所有可达入口                                                                                                                            |
| 原生子代理限流、队列、完成唤醒与托管 Worktree                        | 继承原生执行/调度及 Git 生命周期；应用只做入口、可信身份映射与显示，不创建替代调度器或 Git 所有权                                                                                                                         |
| 插件热加载、配置应用及重启连续性                                     | 等待原生 applied/failed 完成回执；deferred/coalesced 重启保留原生协调者，不以冷重启争抢活动任务                                                                                                                           |
| Windows MCP/Chrome 启动、缓存、Cron 与只读技能修复                   | 保留新版启动参数与 env；宿主启动器同步遵守原生缓存路径保护，任务权限与清理继续使用原生身份约束                                                                                                                            |
| 模型目录、fallback、记忆与 Cron 可靠性                               | 继承原生实现；保留完整 provider/model 身份、助手默认继承、原生记忆权威及任务回执/结果的产品职责                                                                                                                           |
| 原生 OpenAI 视频实现移除                                             | 退役旧视频 patch 和自定义配置。初期曾验证 Kie/Z.AI/Novita 的激活与目录；当前随包策略及 video-openai 独立端点、凭据与启停规则统一见[模型管理](../../features/models/model-management.md)，旧报告不能作为当前内置提供方清单 |
| 浏览器 pairing/relay 基线变化                                        | 从锁定原包刷新基线，补入 strict-json 模块，按实际模块所有者检查协议锚点；conversation-overlay 继续独立构建                                                                                                                |

## 关键修复与必须保留的约束

- **整轮结算：**queued、旧 session/run 列表行和 attempt 级 end/error 不结束当前执行；只有 executionSettled:true 的匹配终态允许整轮收尾。chat final、工具完成与结果交付分别处理。
- **待处理输入：**主聊天与扩展分别消费原生 pending 分页；明确 not_found/not_visible 退役旧截断占位，临时传输失败保留占位。同文输入按身份区分，display:false 的撤回记录不展示，正文不进入应用持久历史。
- **诊断身份：**由 Main 的可信原生绑定确定助手/子会话，采集前后复核；改绑后丢弃旧证据，不能拼接默认 main key 或从 Renderer 接受身份授权。
- **任务结果清理：**沿 spawnedBy 控制归属建树，导航 parentSessionKey 不作为删除授权；删除前复核会话身份、控制归属、生命周期修订及更新时间。
- **浏览器基线：**升级后原生文件与 overlay 分离；严格 JSON 的独立模块、协议常量所有者和构建哈希一同核对，不能用旧文件彼此一致证明版本正确。构建样式读取拆分后的聊天样式源。
- **ACP 状态目录：**默认采用原生 stateDir/acpx，显式用户目录优先；不自动移动旧目录或历史，不在运行时缺适配器时下载替代品。
- **Windows 会话创建：**SQLite namespaced 路径比较两侧规范化，仍保留大小写、数据库、agent/key 与所有权检查，不通过扩大路径授权解决拒绝。
- **配置生效：**动态字段等待发布结果；SecretRef 轮换与失效有明确状态。ask/auto/full 分别映射 guarded/workspace/full，运行中权限变更按产品规则延后，保存成功不等于原生已应用。

## 补丁与构建原则

补丁按 9.8 原包的真实缺口重写。旧任务注册表部分和旧 OpenAI 视频部分退役；不因保留编号而恢复上游已实现的能力，也不在本页维护会过时的补丁数量与逐文件清单。

源模块、只读 worker、activation-recovery 内嵌入口、动态 SDK 模块及最终 bundle 按实际可达职责验证。历史或部分补丁 marker 必须失败，并从锁定 pristine 包重建；不原地升级旧 patched runtime，不修改 manifest 伪造证明。staging 验证后原子提交，冻结证明绑定原包、补丁、构建规则和交付资源。

Windows MXC 的宿主技能路径、SID/ACL 与生命周期配置有独立适配；静态转换器通过不能替代真实沙盒执行。操作流程见[运行时补丁指南](../../openclaw-runtime-patches.md)，能力、上游处置和移除条件见[补丁总账](../../../scripts/patches/v2026.9.8/README.md)。

## 未自动引入的产品能力

本次升级没有新增专用逐条队列取消/数量管理、Incognito、插件能力与账户状态预览等入口；原生接口可用不等于产品 UI 已接入。

Gemini Interactions、OpenAI Agents API、ChatGPT Beta 登录、Telnyx、Codex Ultrafast/Ultra、Lightpanda、多用户/在线成员、Portal/云 worker、会议与通话渠道需要各自的认证、部署、权限及界面设计，没有静默启用。其他平台的原生客户端 UI 与上游 Control UI 不直接移植到 Electron。

原生 updater 的快照、回滚及 Doctor 改进不替代应用锁包、重建补丁与打包验证；也不构成本次已撤回的旧数据迁移承诺。后续产品候选见[计划索引](../../plans/README.md)，已执行验证与剩余环境限制见[验收摘要](validation.md)。
