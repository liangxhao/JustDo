# 登录模块接入：内置模型生命周期

登录模块完成账号状态持久化后，只需在 Main 中调用一个对应入口。模型凭据换取、目录刷新、
默认模型恢复、Gateway 同步、Renderer 通知及请求头值缓存刷新由入口内部负责。

产品已提供 [登录 SDK 接入模板](../features/integrations/login-sdk-template.md)：首页账号入口、
`LoginService`、凭据文件写入和显式账号 IPC 均已实现。后续 SDK 应通过
`src/main/core/app/auth/loginSdkAdapter.ts` 接入，复用模板的提交顺序、重试和账号隔离。
默认 SDK 适配器不可用，手工导入登录文件的原有启动恢复流程仍可使用。
未登录点击头像直接调用 SDK 登录入口，不先展开产品账号菜单；失败后才显示单行提示。
登录成功后头像显示用户名首字符的圆形徽标，点击徽标打开账号菜单；真实 SDK 只需接入既有适配器。

## 1. 已有接口

实现与导出位置：[`src/main/main.ts`](../../src/main/main.ts)。

```ts
export declare const refreshAfterLogin: () => Promise<void>;
export declare const refreshAfterLogout: () => Promise<void>;
```

| 接口                         | 调用时机                            | 内部处理                                                                                                         |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `await refreshAfterLogin()`  | 登录凭据写入完成、Main 已确认登录后 | 刷新请求头缓存，恢复换证，读取登录文件并获取模型凭据，刷新内置目录，同步 Gateway，通知界面，启动活动上报         |
| `await refreshAfterLogout()` | Main 已清理本地登录凭据后           | 停止活动上报，刷新请求头缓存，中止旧换证并清除活动模型凭据，移除内置提供商及受管认证配置，同步 Gateway，通知界面 |

这是 **Main 内部函数接口**，不是 HTTP、Gateway RPC 或现有 Renderer IPC。接口不接收 token，
不返回模型列表。未来登录 UI 应走登录模块自己的显式 preload/IPC，由 Main 校验并提交登录状态，
再调用本接口。不要向 Renderer 暴露可任意启用内置模型的无条件回调。

`main.ts` 是应用启动入口；独立登录模块应由 Main 注入这两个回调，避免反向导入入口造成启动副作用
或循环依赖。下例是未来模块的接入示意，`registerLoginHandlers`、`commitLogin`、`clearLogin` 由登录模块实现，
并非当前已有 API：

```ts
// 在 main.ts 中初始化未来登录模块；此时产品 Store 与运行时服务已经初始化。
registerLoginHandlers({
  onLoginCommitted: refreshAfterLogin,
  onLogoutCommitted: refreshAfterLogout,
});

// 登录模块内部的顺序：
await commitLogin(); // 完成身份校验，并等待 user_info.json 原子写入完成
await dependencies.onLoginCommitted();

// 退出登录模块内部的顺序：
await clearLogin(); // 删除登录文件，或清除其中的认证/Cookie 字段
await dependencies.onLogoutCommitted();
```

不要直接调用底层 `BuiltinModelLifecycle.refreshAfterLogin()` 或只修改 `builtin_models.enabled`：
这会绕过换证、退出挂起保护和请求头缓存更新。无需额外调用 `updateOutboundHeaderUserInfoCache()`。

## 2. 登录模块必须准备的数据与配置

登录文件使用 `resolveOutboundHeaderUserInfoPath()`（来自
`src/main/core/network/outboundHeaderPolicyConfig.ts`）解析路径，通常为
`<app.getPath('appData')>/<productName>/huawei/user_info.json`。不要硬编码产品名或 Windows 用户目录。
隔离开发 userData 不改变此登录文件路径。

模型认证必需字段如下，示例均为占位值：

```json
{
  "mtoken": "<login-service-issued-mtoken>",
  "X-User-Account": "<authenticated-account-id>"
}
```

`mtoken` 与账号必须来自同一次可信登录。其他工具需要的 Cookie 字段仍由登录模块写入同一文件。
只写 Cookie 不足以启用内置模型；不需要把模型 JWT 写回该文件。Main 会自行换取、校验及续期 JWT。
不要将登录文件、接口请求体或凭据对象写入日志。

接入前配置：

- `src/config/builtinModelAuth.ts`：填写完整 `tokenExchangeUrl`，并设置与签发服务一致的
  `maxJwtLifetimeSeconds`。仓库换证地址留空，生命周期上限为 10800 秒；未填写换证地址时，即使调用登录入口也不会启用内置模型。
- `src/config/builtinModels.ts`：确认 `enabled` 和模型服务 `baseUrl`。
- 正式登录验证使用 JWT 模式。未打包开发的 API key 模式是独立调试通道，不能据此验证“未登录列表为空”。

换证请求为 `POST` JSON `{ mtoken, deviceId }`；`deviceId` 只使用当前有效网卡 MAC（去冒号、转大写）。Main 公共模块 [`src/main/core/network/macAddress.ts`](../../src/main/core/network/macAddress.ts) 导出 `getMacAddress(): string`，登录模块与模型换证应共同调用，不能在 Renderer 或 `src/shared` 中直接读取系统网卡。无有效 MAC 或查询失败时函数抛错，调用方应处理失败；不回退 UUID，不保存设备 ID 文件。
响应包含 `access_token`、`token_type: "Bearer"`、整数 `expires_in`，可选 `uid` 必须匹配登录账号。
JWT 的 `aud` 必须为字符串 `litellm`，kid 可选。模型请求使用真实 JWT Bearer；换证日志提供脱敏的失败阶段、原因和 HTTP 状态。
JWT claims、期限和部署约定见[认证设计](../features/integrations/authentication-builtin-model-lifecycle.md)
及[客户端部署](../../deploy/client/README.md)。修改编入 Main 的配置后需要重启开发进程或重新打包。

## 3. 调用顺序与账号切换

```text
登录：身份服务确认成功 → Main 写入登录文件 → await refreshAfterLogin()
退出：Main 清理登录文件 → await refreshAfterLogout()
切换账号：清理 A → await refreshAfterLogout() → 写入 B → await refreshAfterLogin()
```

显式退出不能仅清 Redux、关闭登录窗口或通知界面。必须清理文件，否则重启后仍可能重新读取旧登录状态。
账号切换必须先完成退出清理，以免把上一账号的缓存目录带到新账号。文件持久化失败时不调用登录入口。

登录模块应串行提交这些账号操作。底层 generation/abort 会拦截迟到的模型请求，但不会替登录模块
序列化其文件写入。接口应当 `await`；不要以未处理的异步调用结束登录/退出流程。

## 4. 刷新与模型回退规则

- 未登录或无有效模型凭据：内置模型列表为空；自定义提供商配置保留。
- 已登录启动：Main 自动尝试换证和目录刷新；登录模块不需重复启动另一个模型轮询器。
- 登录成功：入口强制刷新目录；设置页手动刷新走现有 `window.electron.builtinModels.refresh()`，
  该接口不能代替登录；内置提供商已被移除时直接返回，不创建登录授权。
- 登录文件变化及凭据续期：现有监控器处理，凭据变化时可能重新同步目录。
- 成功刷新发现原内置默认模型下架或禁用：选取配置列表中第一个已启用且具备请求配置的模型，
  保存默认值，并修复失效的会话选择；仍有效的用户选择保留。
- 目录网络请求失败而凭据仍有效：保留最近成功目录，不把请求失败视为下架。
  没有缓存时列表可以为空；成功返回空目录则按真实空目录处理。
- 没有任何可用替代模型：不制造虚假选择，界面显示无可用模型提示。
- 退出登录：内置模型入口和凭据被清理；不承诺强制终止已经发出的远端推理请求。

Cookie 单独续期且模型登录身份未变化时，可只调用
[请求头值刷新接口](outbound-header-user-info-refresh-api.md)，无需触发完整登录流程。

## 5. 返回、失败与重试

两个接口都是 `Promise<void>`，**resolve 不等于认证成功、目录非空或 Gateway 已健康**：

| 情况                                      | 当前行为                                             | 登录模块的处理                                                 |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| 登录文件缺字段、换证地址为空              | 按无模型凭据处理，清理内置入口；可能正常 resolve     | 检查接入前置条件；不可据此显示“模型连接成功”                   |
| 换证失败                                  | reject；无可用凭据时清理内置入口                     | 保留身份服务实际登录结果，将模型初始化失败作为独立错误提供重试 |
| 目录请求失败                              | 内部记录错误并保留缓存，仍执行配置同步；可能 resolve | 允许已登录状态，使用既有手动刷新重试                           |
| Gateway 配置写入/同步失败                 | 通常 reject，已完成的凭据或配置修改不会整体回滚      | 报告同步失败并可重试对应入口；不要恢复已清理的旧账号凭据       |
| 配置已写入，但 Gateway 健康检查或重启失败 | 内部记录告警，可能 resolve                           | 根据运行时状态展示不可用，不能只看本函数返回                   |

身份登录成功与模型服务就绪是两个状态。退出入口报错也不能把产品登录状态恢复为已登录；
应保留退出结果、报告模型运行时清理未完成，并重试清理。重复调用当前身份对应的入口是允许的，
但登录入口会重新刷新目录，不应高频调用。

## 6. 接入验收

使用合成凭据和测试账号，至少验证：

1. 无登录文件启动：内置列表为空，自定义模型仍在。
2. 登录写入后调用一次入口：模型目录出现，Gateway 可用，界面收到更新。
3. 已登录重启：恢复目录；旧模型下架时默认值、按钮和实际会话一致回退。
4. 手动刷新时服务暂时断网：保留原目录与有效选择；恢复后刷新正常。
5. 退出：文件清理、内置列表消失；后台请求迟到和软件重启均不恢复旧账号。
6. A 退出后登录 B：A 的迟到响应和缓存不会成为 B 的目录。
7. 换证拒绝、空目录、Gateway 不健康：登录状态与模型就绪状态分开展示。

相关自动测试位于 `src/main/providers/` 的 `builtinModelAuthCoordinator.test.ts`、
`builtinModelTokenExchange.test.ts`、`builtinModelCredentialMonitor.test.ts`、
`builtinModelLifecycle.test.ts`、`builtinModelProvider.test.ts`。

这两个生命周期接口自身不实现登录页、身份服务登录/注销、凭据持久化或远端 token 撤销。
产品模板现在负责持久化与本地账号流程；真实 SDK 弹窗、验证、远端会话和 Cookie 续期仍需后续接入。
