# Gateway 能力归属与升级核对矩阵

基线：锁定 OpenClaw v2026.9.6 与当前产品注册代码。本页帮助判断升级需要核对哪些原生契约；逐补丁清单与上游处置统一在[版本目录 README](../../scripts/patches/v2026.9.6/README.md)，不在此复制编号表。

## 1. 能力与产品消费方

| 能力          | 原生权威                        | 产品职责                 | 升级关键检查                             |
| ------------- | ------------------------------- | ------------------------ | ---------------------------------------- |
| chat/history  | transcript、实时与历史协议      | 身份准入、分页、渲染     | delta/snapshot、entry identity、可见分支 |
| session/model | 原生身份和模型设置              | 产品 key、选择与准入     | create/describe/patch、provider/model    |
| Goal          | 内容、状态、预算与原生变更      | 自动续跑 phase、卡片     | 六状态、resume 预算、goalId fence        |
| task/Subagent | admission、queue、join、ledger  | 父子状态、详情与停止     | 分页、blocked outcome、后代取消          |
| approval      | pending、期限、终态与撤销       | modal、选择校验          | stop/restart 及迟到回复                  |
| compaction    | context budget、压缩和恢复      | 进度、取消与详情         | admission 竞态、历史可见性               |
| progress_card | session 当前进度                | 原样展示、显式刷新       | revision、scope、clear、refresh 幂等                   |
| cron          | job/run、调度与 delivery        | CRUD、结果 receipt       | owner 保留、默认 delivery、分页          |
| Skill         | 解析赢家、资格与启停            | 文件事务、来源提示       | 同名 fallback、extension scope           |
| Extension     | inventory、启停、卸载与能力审查 | 导入入口、保护和 UI      | installed-index、reviewToken             |
| peer send     | 原生 sessions_send              | 成员/轮次准入、回执      | 精确目标、可信 provenance、未知接收      |
| Agent files   | 原生角色文件                    | 档案管理与冲突检测       | 工作区/文件身份，删除保留历史            |
| browser       | 原生协议与工具语义              | 模式、guest bridge、配对 | action 对齐、profile、取消与导航         |

窗口、更新、托盘、分组、未读、文件授权和市场 SDK 适配属于产品，不应为 UI 方便增加 Gateway patch。

## 2. 公开 API、Extension 与补丁

先使用公开 Gateway/SDK。需要原生 tool/hook/session extension 时通过受控 Extension；只有锁定 pristine 包缺少且公开能力不能表达的语义才评估补丁。

当前 Runtime Services 提供受限 history detail、回执和进度等投影；AskUserQuestion/Plan/automation/agent-team 等承担各自运行时能力。它们不建立第二份 transcript 或调度器。

同一个功能可能同时依赖原生契约和窄补丁，例如原生 history 加产品 display-history 边界。不能标成“全部由补丁实现”，也不能因为主 API 原生存在就忽略打包后的补充契约。

## 3. 身份与终态核对

原生 session key、实例 ID、run ID、task ID、entry ID 和产品 sessionId 各有用途。升级重点不是名字没变，而是返回值是否仍能证明目标身份、分支和 generation。

Stop 需覆盖 native queue、已完成祖先下的活动后代、部分取消失败、立即终态与审批撤销。required-child join 不能由 Renderer “还有子任务”提示替代。completed+blocked 必须保持 blocked。

tool_calls finish reason 不能被当作最终回答完成；一次 tool error 也不是 run terminal。实时、回执、历史和恢复 snapshot 必须对同一身份收敛。

## 4. 持久数据与恢复

原生 SQLite transcript 是消息权威，产品只保留索引与回执。完整应用重启与同进程 Gateway 重启通过 app-start 边界区分；计划审核恢复、Goal 恢复和协作未知状态分别处理，不自动重放副作用。

升级读取历史要验证 reset 前后 display/model-context、分页 offset、超大行补取、工具输入和失败 detail。不能只检查新会话第一条回复。

## 5. 验证步骤

1. 确认 package/source-lock 与 pristine npm 产物一致。
2. 运行原生契约检查，识别已上游化能力和新增差异。
3. 对照补丁总账决定保留/删除/重写，从 pristine 重建。
4. 验证 SDK 动态加载与 Gateway bundle 共享能力注册，尤其 scoped access。
5. 运行 Adapter wire、Extension、controller/history 和打包资源测试。
6. 用最终目标运行时检查启动、发送、审批、停止、重连、历史和平台工具。

## 6. 证据如何记录

契约测试证明产物形态或协议；行为测试证明指定场景；真实模型测试证明该次交互；安装包验证证明对应平台与资源。四者不能互相替代。

报告失败时保留阶段、原生/产品身份和脱敏错误，不复制 raw transcript 或凭据。发现缺口写成明确限制，不通过恢复旧消息缓存、扩大权限或盲目重试把 UI 暂时修成绿色。
