# Plugin Hub：现行管理体验与能力边界

Plugin Hub 已整合插件管理，本文按当前行为重写。早期设计中的候选能力不再混在现行交互中；原生安装与事务见[插件系统](../../architecture/07-plugin-system.md)，市场合同见[市场适配](../../architecture/16-skill-marketplace-adapter.md)。

## 1. 页面如何组织

PluginsView 组合 skills、mcp、hooks、extensions、marketplace，各域服务、类型和组件就近维护。页面统一视觉与操作反馈，但保留每种类型不同 owner，不要求所有卡片都能启停、删除或更新。

系统与内置、用户安装、当前项目等归属用于展示；运行管理 scope 决定动作。例如 Extension 提供的 Skill 可属于用户安装，但删除仍需操作父 Extension。

用户安装与系统内置组内按名称固定排序：使用 `zh-CN` 比较规则，忽略大小写、数字按自然顺序排列，
名称等价时按唯一 ID 排列。该规则适用于扩展、技能、MCP 和 Hook，不随接口返回顺序或界面语言变化。
用户自建与用户扩展附带的 MCP 合并后排序；系统内置扩展保留可切换项在前、加锁项在后的优先级。

## 2. 操作从能力而非名称推导

| 条目          | 列表依据                     | 操作依据                         |
| ------------- | ---------------------------- | -------------------------------- |
| Skill         | skills.status 的当前有效赢家 | 原生状态与文件来源               |
| 用户 MCP      | Store + 原生配置             | 产品 CRUD 与 probe               |
| Extension MCP | 父 Extension 发现            | 只读，不复制成用户 server        |
| Hook          | 包与产品开关                 | 受管文件/同步规则                |
| Extension     | 原生 plugins inventory       | 原生 removable 与产品保护        |
| 市场卡片      | Provider metadata            | catalog kind、安装身份与原生对账 |

不能用“名称包含 builtin”或某个目录存在决定安全动作。Main 同样验证能力，隐藏按钮不是唯一防线。

## 3. 同名 Skill 的真实行为

主列表显示 Gateway 解析后的有效来源。关闭赢家不自动换到下一份；删除赢家目录可能触发 fallback。操作完成后比较 name/source/path，来源变化应明确提示。

当前没有 authoritative variants contract，UI 不显示猜测的 shadowed 数量或逐来源开关。文件服务只能管理用户文件，不能越过原生解析器列举并认定全部可用变体。

## 4. 本地导入的用户流程

选择目录或支持的压缩包 → 安全检查和格式识别 → Extension 能力审查 → 提交当前 reviewToken → 受管安装 → 原生 inventory 回读。失败必须标明阶段，不能只提示“安装失败”而留下成功卡片。

原生 openclaw.plugin.json 包进入原生安装器；异构格式转换尚未交付，会明确停止。上游能识别 Codex/Claude 等 bundle 不代表产品已经提供可用转换。

安装期间的进度属于当前操作，不因关闭页面重复触发安装。临时源按原生提交阶段和结束证据清理；Windows 文件夹隔离副本在原生安装已发起但结果不明时保留，不能以超时认定未安装或安全删除。文件锁/链接错误如实报告，不停止 Gateway 重放破坏性操作，也不指引用户任意杀进程。具体事务见[插件系统](../../architecture/07-plugin-system.md)。

## 5. 市场查询、推荐与更新

仓库默认没有 Provider，页面显示未配置，而不是虚假热门插件。最小 SDK 可只支持搜索与下载；无详情或类别接口时不渲染无效操作。

空关键词推荐可按稳定 categoryId 查询，进入关键词搜索后清除类别。安装后记录 source/catalog/runtime 身份，更新候选与已安装列表共同对账；同名系统项不开放市场覆盖。

Marketplace 只接入 extension/skill/mcp 三种类型。Hook、Agent、Command、CLI 等需要完整生命周期后才能添加，不能只加一个筛选标签。

## 6. 可选与受保护扩展

agent-team 默认关闭，启用后提供协作工具与 Skill；禁用保留历史。stt-local-cli 尊重显式关闭，附件转录独立于麦克风。原生 browser 与 embedded-browser 由浏览器模式互斥管理，不能在插件页分别开启导致出现两个 browser Tool。

Runtime Services、必要审批和产品桥接的保护由后端检查。配置同步必须保留用户明确的可选开关，不以“恢复默认”覆盖。

## 7. 错误和刷新

列表读取失败保留错误状态，不能把空列表解释成全部卸载。安装/更新成功后重新 inventory，界面与市场身份一致才展示最终状态。启停失败不得仅回滚按钮而隐瞒原生状态不确定。

## 8. 验收

检查来源分组与管理 scope、同名 fallback、父插件托管动作、受保护项、取消审查、换包 token 失效、更新后市场/原生双列表收敛、市场与本地导入同名冲突、无 Provider 和 Windows 锁/链接失败。产品只接入一个业务市场，不将协议保留的 sourceId 解释成已支持多市场。行为测试分布在插件服务、installation、marketplace 与 Renderer 各领域。
