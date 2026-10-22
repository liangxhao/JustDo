# Goal 续跑协调验收

实现与独立代码复审已完成。现行设计、状态图和原生准入契约见
[Goal 模式](../features/chat/goal-mode.md)。基于 dev
`0b71723bbc6eb039adb5d5ecb129ac09a942e3f1` 和锁定的 OpenClaw v2026.10.4。

## 当前验证边界

Main、协调器、Goal 卡片、原生准入及相关运行时回归共 29 个文件、887 项测试通过，
1 项跳过；包含真正完整 Gateway bundle 的绑定验证。原生准入 41 项亦由独立 Agent
复跑通过。应用构建、lint、Electron 类型检查，以及 fresh runtime 的全部 32 个补丁和
冻结校验通过。

隔离真实 Gateway 配合本地合成模型的 RPC 检查通过：原生创建 Goal、精确结算与前驱查询、
条件续跑接纳及累计一次、同候选重放不重复执行、旧前驱不同候选拒绝，以及缺少 revision
和非 backend 请求拒绝。重放沿用原生终态 status=ok，通过 describe 核对精确持久回执。
测试实例与模型服务已正常退出。真实检查发现的终态后 cleanup 窗口已补上无通知时的
退避重查；持续阻塞、用户输入、Stop、原生后继接管及 ACK 未知的回归均通过。

全量测试曾执行，未全绿；本次涉及的失败已修复并定向复测。仍有本次未修改模块的失败，
涉及浏览器与 Runtime Services 测试 mock、退出登录配置、Widget，以及 acpx 子项目依赖。
不能将定向通过解释为整个仓库通过。

## 尚需产品环境验收

| 场景 | 必须观察的结果 |
| --- | --- |
| 真实模型普通 subagent + sessions_yield，或主回合直接 final | 原生通知及回交仍由 OpenClaw 持有，Goal 不抢跑；Waiting 显示正确 |
| 真实 collect:true / Swarm collector 与 Code Mode awaitResults | 后继读取原任务，主 run 活动时不追加；原生同 run wait 和取消语义保持一致 |
| 实际 UI 中准备期间新输入、Stop、暂停、替换 Goal、reset | 旧异步结果不覆盖新意图；精确取消与原生实例约束生效 |
| 实际断连、ACK 丢失、Gateway 重启与应用重启组合 | 恢复精确原 run，原生累计次数保留，启动前目标停止边界生效 |
| 最终 Windows 安装包与内网冷启动 | 携带完整冻结运行时，不依赖已有缓存或公网下载 |

合成 owner/事务测试和本地模型夹具只证明覆盖的协议路径，不替代以上验收。
完成后将必要限制写入现行说明并删除本文件。
