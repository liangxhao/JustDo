# 下游插件市场接入指南

本指南面向在桌面应用的下游版本中接入企业插件目录或业务 SDK 的开发者。每个版本可接入一个市场，覆盖扩展 (`extension`)、技能 (`skill`) 和 MCP (`mcp`) 中的一类或多类。插件页复用现有搜索、安装和本地管理入口。Hook 通过本地入口管理。[市场适配与安装身份](../plugins/marketplace/adapter.md)

## 1. 实现业务适配器

在 `src/main/plugins/marketplace/` 新增 `enterpriseMarketplaceProvider.ts`，实现 `PluginMarketplaceProvider`。SDK 的认证、目录查询、下载和响应转换都在 Main 完成。[Provider 接口](../../src/main/plugins/marketplace/types.ts) · [共享类型](../../src/shared/plugins/marketplace.ts)

| 接口                    | 下游实现要点                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `source`                | 提供稳定的 `id`、显示名称和 `supportedKinds`。读取来源时只返回元数据，登录前也可读取。          |
| `search(query)`         | 将类型、关键词、分类和分页参数映射到目录查询。空关键词用于推荐。返回 `{ items, nextCursor? }`。 |
| `prepareInstall(input)` | 按 `pluginId` 和请求版本准备安装输入。扩展和技能交付本地目录或归档，MCP 交付结构化连接配置。    |

下面以仅接入技能目录为例。`searchEnterpriseCatalog` 和 `prepareEnterpriseInstall` 由下游根据实际 SDK 实现并引入，分别对应 Provider 的查询和安装准备接口。

```ts
import { MarketplacePluginKind } from '../../../shared/plugins/marketplace';
import type { PluginMarketplaceProvider } from './types';

export const enterpriseMarketplaceProvider = {
  source: {
    id: 'enterprise-marketplace',
    name: '企业插件市场',
    supportedKinds: [MarketplacePluginKind.SKILL],
  },
  search: searchEnterpriseCatalog,
  prepareInstall: prepareEnterpriseInstall,
} satisfies PluginMarketplaceProvider;
```

- `listCategories`、`getDetail` 和 `checkUpdates` 可按业务能力接入。若需要已安装卡片主动检查更新，实现 `checkUpdates`，并返回对应目录条目的目标版本。保留稳定的来源 ID 和目录 ID，让宿主在重启和更新后识别已安装项。[安装身份与更新](../plugins/marketplace/integration.md#5-安装身份与更新)
- 下载失败时由适配器清理本次下载文件。成功交付安装输入时可附上 `cleanup`，由宿主判断何时释放本次临时资源。安装、启停和已安装清单由宿主处理。[下载与安装输入](../plugins/marketplace/integration.md#4-下载与安装输入)
- 认证、目录查询和下载使用明确配置的内网服务，按桌面端的应用代理设置接入 SDK 客户端。SDK 支持注入请求函数时，先核对宿主传输的响应大小与重定向行为。下载客户端也要单独验证代理路由。[应用代理与 SDK 网络接入](../plugins/marketplace/integration.md#应用代理与-sdk-网络接入)

## 2. 在应用启动时注册

在 `src/main/application.ts` 创建 `PluginManager` 的位置，将业务 Provider 作为 `createPluginMarketplaceService` 的第三个参数传入。沿用现有安装服务和持久化 `store` 回调，市场安装身份会继续记到宿主现有存储中。[生产装配入口](../../src/main/application.ts)

```ts
import { enterpriseMarketplaceProvider } from './plugins/marketplace/enterpriseMarketplaceProvider';

// 替换现有 pluginManager 的构造代码。
const pluginManager = new PluginManager(
  createPluginMarketplaceService(
    pluginInstallationService,
    () => {
      if (!store) throw new Error('Store is not initialized');
      return store;
    },
    enterpriseMarketplaceProvider,
  ),
);
```

需要登录的 SDK 在业务请求发起时读取当前会话。启动时先注册来源能力，账号提交由现有 `LoginService` 负责。登录完成或恢复已认证会话后，已打开的插件页会自动重读市场。真实空目录返回 `{ items: [] }`，认证、网络或代理故障通过请求失败报告。[登录 SDK 接入模板](../features/account/login-sdk-template.md)

企业 SDK 如需从市场令牌接口的 401 恢复，可在 Main 注入登录 SDK 的续期调用，并合并同一账号的并发恢复请求。
只有登录 SDK 验证续期成功且账号仍一致时，才重读已提交的 Cookie，并重试一次市场令牌或目录查询。
续期结果通过 `LoginService` 提交，账号失效由身份服务确认。已发起的安装和更新沿用现有结果确认流程。
[凭据提交接口](outbound-header-user-info-refresh-api.md#sdk-续期应使用现有账号租约)

## 3. 关闭登录后的市场占位提示

下游在应用启动时注册唯一的市场。页面沿用 `listSources(kind)`，由 Main 按当前插件类型返回该市场的来源。市场是否接入由下游的注册决定，来源查询用于当前分类。

接入市场后，在 `MarketplaceUnconfiguredNotice.tsx` 将以下开关改为 `false` 并随下游版本构建。开关只隐藏“插件市场暂未开放，已安装的插件仍可正常管理。”，适用于“全部”和“可更新”视图。未登录时的登录提示继续按账号状态显示。[提示开关](../../src/renderer/features/plugins/marketplace/MarketplaceUnconfiguredNotice.tsx)

```ts
const SHOW_DEFAULT_MARKETPLACE_NOTICE = false;
```

## 4. 联调与发布验证

先在仓库根目录运行市场服务、IPC 和页面的相关测试。

```powershell
npm test -- src/main/plugins/marketplace src/main/ipc/plugins/marketplace.test.ts src/renderer/features/plugins/marketplace/MarketplaceView.test.tsx
```

随后使用下游制品、真实 SDK 和部署网络验证以下场景。

1. 登录前打开插件页，登录完成后在原页面看到目录。重启应用并恢复已认证会话，复核目录可读。
2. 检查每个已声明的分类，确认推荐、关键词查询和分页行为。打开未覆盖的分类，确认本地插件可管理。
3. 对每种已接入类型至少完成一次安装。若接入更新，禁用一项后执行更新，核对目标版本、原有开关和重启后的市场归属。
4. 验证认证失败、超时、代理故障和下载失败的反馈。设置提示开关为 `false` 后，核对来源为空时未登录仍有登录提示，登录后隐藏“市场暂未开放”。

本地市场探针可补充真实安装链路的验证。企业认证、代理和下载仍须使用下游环境验收。[本地市场联调探针](../plugins/marketplace/integration.md#本地市场联调探针)

## 5. 已登录仍看不到市场

在 Windows 上先从应用的 Main 日志中查找 `[PluginMarketplace]`。来源查询成功但返回空列表时，可以在调试构建中核对注册结果。[日志与排障](../development.md#日志与排障)

| 现象                       | 优先核对                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| 已支持的分类查不到市场来源 | 确认用户实际运行的制品包含 Provider 注册，并核对 `supportedKinds` 和 Main 侧 `listSources(kind)` 的返回。 |
| 市场目录加载失败           | 先区分来源读取和目录请求，再查看脱敏错误以及当前会话、内网可达性和应用代理。                              |
| 看得到目录，安装或更新失败 | 核对目录 ID、目标版本和 SDK 下载结果，再按应用反馈确认是否已经提交安装。                                  |

若仅个别用户遇到空来源列表，可在相同制品下对比受影响用户和正常用户登录前后的来源查询。记录构建版本、来源 ID、支持的分类、查询时的登录状态和错误类型。凭据、认证响应和签名下载地址留在 SDK 内部。
