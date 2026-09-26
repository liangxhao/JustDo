# 登录模块调用：刷新 outbound header 值

适用调用方：后续登录模块、退出登录流程和 Cookie 定时续期任务。接口在 Main 进程执行。

## 接口

Main 进程从 `src/main/core/network/outboundHeaderPolicyConfig.ts` 导入：

以下相对导入路径以 `src/main/main.ts` 为例，其他模块按所在目录调整。

```ts
import { updateOutboundHeaderUserInfoCache } from './core/network/outboundHeaderPolicyConfig';

updateOutboundHeaderUserInfoCache();
```

签名为 `updateOutboundHeaderUserInfoCache(userInfoPath?, headerNames?)`，同步返回
`Readonly<Record<string, string>>`。生产代码使用无参调用；可选参数供测试或明确指定
文件路径、请求头名称的调用方使用。默认文件是
`%APPDATA%/<productName>/huawei/user_info.json`，`productName` 由产品元数据决定。

## 调用时机

登录模块在**完成** `user_info.json` 的写入或替换后调用该函数。定时更新 Cookie 时也
按同样顺序调用：

```text
获取新 Cookie → 写入 user_info.json → updateOutboundHeaderUserInfoCache()
```

退出登录时，先删除或清空文件中的相关值，再调用该函数。它只更新 Main 进程内的请求头值
缓存；调用返回后，后续匹配活动策略的请求使用新值。现有调用示例见 `src/main/main.ts`
中的显式登录/退出入口 `refreshAfterLogin` 和 `refreshAfterLogout`；定时 Cookie 更新完成后
可直接调用本接口，无需执行完整登录流程。

如果登录模块已经调用上述 `refreshAfterLogin` 或 `refreshAfterLogout`，它们内部已调用
值刷新接口，无需重复调用。文件写入失败时，不应调用刷新接口；异步写入必须等待完成。

## 边界与返回值

- 只读取 `user_info.json`，不会读取或改写 `outbound-header-proxy/config.json`，也不会读取
  扩展的 `outbound-header-policy.json`。
- 请求头名称来自当前已激活的策略，包括代码预定义组、手动组和扩展组。刷新值不会修改
  这些组，也不会触发 `OutboundHeaderPolicyService.reconcile()` 或代理重启。
- 返回对象只含当前策略声明的请求头名称；缺失、非标量或不安全的值归一为 `''`。
  `user_info.json` 不存在时也会得到这些名称对应的空值。读取或解析失败会记录警告，
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
