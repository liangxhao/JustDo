# 插件市场适配：从业务目录到原生安装

市场层解决目录查询、下载、来源和版本映射，不拥有插件执行状态。当前共享 MarketplacePluginKind 只包含 extension、skill、mcp；Hook 虽在 PluginKind 中存在，也不是已接通的市场安装类型。仓库默认没有业务 Provider。

产品只对接一个市场。工厂第三参数注入单一 Provider，页面不提供来源选择或聚合。SDK 实施步骤、示例和验收见 [插件市场接入指南](../developer-integration/plugin-marketplace-integration.md)。

市场网络接入应遵循应用代理，浏览器代理独立。Provider 注册不会自动接管 SDK 的网络客户端；目录请求可复用 Main 的 `mainProcessFetch`，独立认证与下载客户端需要显式适配。现有方法在代理模式下缓冲完整响应，且直连与代理的重定向、大小限制行为不同，不能直接视为通用 SDK Fetch 或流式下载器。具体适配和代理验收要求见接入指南的“应用代理与 SDK 网络接入”。

## 1. 最小接入面

`PluginMarketplaceProvider` 位于 `src/main/plugins/marketplace/types.ts`。公司 SDK 只需提供搜索与下载，其他能力按实际支持暴露。

| 接口           | 必需 | 责任                                |
| -------------- | ---- | ----------------------------------- |
| source         | 是   | 稳定 id、名称与支持 kind            |
| search         | 是   | 有界分页目录，返回通用字段          |
| prepareInstall | 是   | 完成下载并提供目录或结构化 MCP 配置 |
| getDetail      | 否   | README、依赖等详情                  |
| listCategories | 否   | 指定 source/kind 的稳定类别目录     |
| checkUpdates   | 否   | 已安装项目的批量更新候选            |

Main 投影 supportsDetail/supportsCategories/supportsUpdates，Renderer 不为缺失能力制造空页面。最小 SDK 不必为了 UI 补造一个不存在的详情接口。

## 2. 查询与响应验证

MarketplaceService 验证 source ID、重复注册、kind、分页 limit/cursor 和返回字段。默认 limit=20、最大 100；类别最多 100 项且 ID 去重。Provider 错误转换成稳定错误分类并脱敏，不能把 SDK 原始响应直接送进 UI。

MarketplacePlugin 只含产品需要的名称、描述、版本、作者、tags、图标、来源和安装提示。没有图标时可稳定生成占位图；downloadCount 只是展示信号，不是安装可信度。

空关键词用于热门推荐，可按 provider 的 categoryId 查询；进入搜索后隐藏并清除类别条件。类别名不能当协议 ID，前端也不能在一页结果上假装实现服务端分类。

## 3. 安装完整链路

```mermaid
sequenceDiagram
  participant UI as 市场 UI
  participant M as MarketplaceService
  participant P as 公司 SDK Provider
  participant I as PluginInstallationService
  participant G as 原生安装器 / inventory
  UI->>M: install(source, id, kind, version)
  M->>M: 校验并按安装身份串行
  M->>P: prepareInstall
  P-->>M: sourcePath / MCP config + cleanup
  M->>I: 类型与准备后的输入
  I->>I: 格式、路径、能力审查
  I->>G: 原生安装 / 配置应用
  G-->>M: runtime id 与结果
  M->>M: 保存市场安装身份
  M-->>UI: 结果并触发 inventory 刷新
  M->>P: finally cleanup
```

SDK 负责下载和认证，Main 不自行拼下载 URL 或重复实现公司协议。Extension/Skill 的 sourcePath 是下载后的本地目录；MCP 是经过映射的结构化配置。通用安装服务位于 `src/main/plugins/installation/`，路由到现有领域安装器。

临时资源无论成功失败都 cleanup。相同安装身份串行，避免重复点击产生交错覆盖；市场查询失败必须明确提示，不能伪装为空结果或影响本地管理。

## 4. 格式与能力审查

本地 Extension 和市场目录共用 conversion 入口。原生 openclaw.plugin.json 交原生安装器验证；异构 bundle 转换当前尚未实现，明确提示并停止。上游支持某种 manifest，不代表当前产品转换路径已经交付。

能力审查得到本次 declared surface、operator grants、source/integrity 及 reviewToken；提交时再验证内容未变。Provider 不能绕过审查直接写 runtime 目录，也不能把可执行安装脚本作为普通 Skill payload 偷渡。

新增 Agent、Command、CLI、Hook 或其他 kind，需要同时完成安装、启停、更新、卸载、状态对账和权限语义；只加一个 enum 与卡片不构成接入。

## 5. 三种 ID 和两种状态

| 字段                | 含义                                  |
| ------------------- | ------------------------------------- |
| sourceId            | 哪个市场负责查询和下载                |
| marketplacePluginId | 市场目录身份                          |
| runtimeId           | 安装后原生管理身份，可能不同于目录 id |
| installedVersion    | 产品记录的已安装版本来源              |
| installPath         | 必要时区分同名不同来源的文件安装      |

安装成功后 registry 在 KV 保存这些映射，但是否真实存在仍以 runtime inventory 为准。外部删除、同名 Skill fallback 或插件安装失败都可能使 registry 与原生清单不同，UI 必须对账。

系统管理/内置项即使同名，也不开放市场更新。Skill 删除同时核对路径，避免删除项目层同名文件时清掉另一个 managed 安装的市场身份。

## 6. 更新检查与 UI 一致性

checkUpdates 仅向已配置的单一 Provider 传递该市场的安装记录；无此接口时可消费搜索结果中的 update-available。不能判断版本就不制造更新提示，也不假设所有版本遵循 semver。

完整候选保留在 Renderer，即使普通推荐结果没再次带更新标记，同一 source/catalog/runtime identity 仍使用候选版本执行更新。成功后刷新 inventory 与 registry，使市场卡片和已安装卡片同时收敛。

分类页通过 `usePluginMarketplace` 共享搜索、更新候选、筛选和逐卡片操作状态。已安装卡片直接执行更新，并在更新期间禁用冲突开关；市场搜索命中已安装项时复用本地卡片，默认发现区去重。新安装卡片在当前查询中保持原位置，刷新后复用原领域卡片，避免重复或丢失配置入口。操作已提交但状态未确认时只刷新清单，不重放安装。

Renderer 会话内的 `marketplaceOperationOwner` 按分类保留有界操作反馈与进行中锁，跨组件卸载继续接收结果；有页面挂载时使用当前页面的清单刷新回调，无页面时将刷新留待下次挂载。它不持有插件清单、凭据或下载输入，不是持久化安装状态。

新增只读 `resolveInstalled` IPC 将本地清单与 Main registry 对账。文件类必须同时匹配原生 ID 与安装目录，MCP 匹配原生记录 ID；响应只包含目录和原生身份，不含内部路径。系统管理项和无市场映射的本地同名项不能获得更新操作。安装事实仍由原生清单决定，身份映射不是授权或新的插件清单。本地导入成功覆盖市场安装时清除旧市场归属，Skill 同时核对 managed 路径。

服务层保留的旧安装兼容检查只用于缺少历史映射的场景；当前页面仍须通过 resolveInstalled 确认归属，不能按同名 ID 猜测。

## 7. 失败和补偿

| 阶段              | 应保留的事实                       |
| ----------------- | ---------------------------------- |
| Provider 查询失败 | 来源错误，不改变原生安装状态       |
| 下载失败          | 原安装及 registry 保持；清临时文件 |
| 格式不支持        | 未进入原生安装，不假装准备成功     |
| reviewToken 失效  | 必须重新审查                       |
| 原生安装失败      | 原生结果与清理状态，不先写成功身份 |
| 更新后读取失败    | 显示无法确认，重新 inventory 对账  |

## 8. 验收入口

MarketplaceService tests 覆盖 provider 校验、可选能力、分页、错误与安装串行；install registry tests 覆盖来源/runtime/path 映射；installation 与 Extension/Skill/MCP 测试覆盖实际 mutation。

接入验收至少用一个仅支持搜索/下载的最小 Provider、一个市场与本地导入同名冲突场景、一次失败更新和临时目录清理。业务 SDK 联网验收与本地协议测试分开记录。
