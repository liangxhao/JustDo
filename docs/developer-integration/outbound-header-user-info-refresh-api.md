# 登录模块调用：刷新 outbound header 值

适用调用方：后续登录模块、退出登录流程和 Cookie 定时续期任务。接口在 Main 进程执行。

完整登录/退出应优先使用[登录与模型生命周期入口](login-model-lifecycle-api.md)，它已包含本页的缓存刷新；
只有独立 Cookie 更新等场景需要直接调用本页接口。

## SDK 续期应使用现有账号租约

已有 `LoginService` 接入的 SDK 不应先自行改登录文件、再调用缓存函数。
应在开始异步续期之前捕获 `captureCredentialLease()`，取得结果后交给
`updateCredentials(lease, update)`。服务会重新核对账号身份、操作代次和文件凭据版本，
原子提交到现有文件。应用内的 `LoginService` 用已提交的值直接刷新请求头缓存。`mtoken` 变化时也重新执行模型认证。

```ts
// Main 中续期协调器的接入示意；loginService、sdkAdapter 和 signal 由现有装配层持有。
if (!sdkAdapter.available || !sdkAdapter.refreshCredentials) return;
const lease = loginService.captureCredentialLease();
if (!lease) return;
const update = await sdkAdapter.refreshCredentials({ signal });
const result = await loginService.updateCredentials(lease, update);
// 根据 result.success / errorCode 展示或记录安全状态，不记录 update 中的凭据。
```

只有 SDK 已确认该租约对应的登录会话失效时，才调用 `expireSession(lease)`；
旧账号的迟到失效事件不能清除新账号。单次网络错误不等于身份失效。
`mtoken` 轮换会重新进入模型认证；仅 Cookie 更新保留 mtoken，不重新执行完整登录。
真实 SDK 及其续期调度仍待部署方接入，以上现有方法不是自动定时续期服务。
实现位于 `src/main/core/app/auth/loginService.ts`，适配器类型见同目录 `loginSdkAdapter.ts`。

Main 日志中的 `[LoginService] Credential update` 记录提交结果和两个布尔值。
`cookieProvided` 表示此次提交是否包含 `headerValues['X-Cookie']`，`cookieChanged` 表示已保存的同名字段是否变化。
`session-changed` 和 `storage-failed` 表示提交未写入。`sync-failed` 也可能发生在文件已经保存、随后模型认证未完成时。
这些记录不包含 Cookie 值，也不代表目标服务已经验证通过。

## 接口

Main 进程从 `src/main/core/network/outboundHeaderPolicyConfig.ts` 导入：

以下相对导入路径以 `src/main/main.ts` 为例，其他模块按所在目录调整。

```ts
import { updateOutboundHeaderUserInfoCache } from './core/network/outboundHeaderPolicyConfig';

updateOutboundHeaderUserInfoCache();
```

签名为 `updateOutboundHeaderUserInfoCache(userInfoPath?, sourceKeys?)`，同步返回
`Readonly<Record<string, string>>`。生产代码使用无参调用；可选参数供测试或明确指定
文件路径、用户信息源字段的调用方使用。默认文件是
`%APPDATA%/<productName>/<directoryName>/<userInfoFileName>`，`productName` 由产品元数据决定，
目录名与文件名由 `src/config/loginStorage.ts` 分别配置，实际名称以构建配置为准。

## 调用时机

对不经过 `LoginService` 的可信 Main 调用方，只有在确认仍属同一账号、并且**完成**登录文件
写入或替换后才能调用该函数。独立更新 Cookie 时的底层顺序为：

```text
获取新 Cookie → 写入 user_info.json → updateOutboundHeaderUserInfoCache()
```

这个底层顺序不提供账号租约保护；SDK 的异步续期必须使用前述服务入口，
不能在退出／切换账号后把旧 Cookie 再写回文件。已有文件应保留同账号的 mtoken 和其他字段，不能用仅含 Cookie 的示例覆盖。

退出登录时，先删除或清空文件中的相关值，再调用该函数。它只更新 Main 进程内的请求头值
缓存；调用返回后，后续匹配活动策略的请求使用新值。现有调用示例见 `src/main/main.ts`
中的显式登录/退出入口 `refreshAfterLogin` 和 `refreshAfterLogout`；定时 Cookie 更新完成后
可直接调用本接口，无需执行完整登录流程。

如果登录模块已经调用上述 `refreshAfterLogin` 或 `refreshAfterLogout`，它们内部已调用
值刷新接口，无需重复调用。文件写入失败时，不应调用刷新接口；异步写入必须等待完成。

## 边界与返回值

- 只读取 `user_info.json`，不会读取或改写 `outbound-header-proxy/config.json`，也不会读取
  扩展的 `outbound-header-policy.json`。
- 用户信息源字段来自当前已激活策略中的字符串条目和 `from`。策略中的固定 `value` 随策略加载生效。
  刷新用户信息值不会修改策略组或触发代理重启。
- 返回对象按源字段键名索引。缺失、非标量或不安全的值归一为 `''`。
  `user_info.json` 不存在时也会得到这些源字段对应的空值。读取或解析失败会记录警告，
  缓存同样按空值刷新。
- 函数不负责写入文件、获取或续期 Cookie，也不向 Renderer 暴露接口。调用方不要记录
  返回值或文件内容，以免泄露凭据。

策略变更有独立入口：应用启动、扩展安装/卸载/启停等变更，以及 Gateway 启动或重启准备网络策略时，由
`OutboundHeaderPolicyService.reconcile()` 读取并合并配置。登录模块仅更新 Cookie 等
`user_info.json` 中的值时，应使用本页的缓存刷新接口。

每次策略合并都会重新读取手工 `config.json` 和扩展策略文件；没有文件监听器，手工修改后需
等到上述合并时机才生效。内置模型凭据监控的重试、到期刷新和文件变化回调不调用本接口。
请求头值由登录模块在登录、退出或 Cookie 更新完成后显式刷新；策略激活时也会读取一次，
以初始化当前策略所需的请求头值。

## 接入验证

- 登录成功：写入值后调用接口，后续匹配规则的请求使用新值。
- Cookie 续期：只调用值刷新接口，确认规则不变、请求使用新值且代理不重启。
- 退出登录：清理文件中的凭据后调用接口，确认缓存中不再保留旧值。
- 文件损坏或缺失：调用后使用空值，不保留旧凭据；日志不包含文件内容。

验证时使用合成凭据，不记录真实 Cookie 或接口返回对象。
