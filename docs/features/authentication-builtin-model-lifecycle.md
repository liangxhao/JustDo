# 登录模块接入：内置模型生命周期同步

本文面向登录模块开发人员，说明认证状态变化后如何同步内置模型、SQLite、
`openclaw.json`、Gateway 环境和 Renderer。登录模块只负责在可信认证状态提交后调用
统一入口，不应自行拼装模型配置、同步原因或 Gateway 参数。

## 接入入口

Main 进程提供两个入口：

```ts
await refreshAfterLogin();
await refreshAfterLogout();
```

它们定义在 `src/main/main.ts`，分别委托给
`BuiltinModelLifecycle.refreshAfterLogin()` 和 `refreshAfterLogout()`。

认证模块必须遵守以下顺序：

### 登录

1. 在 Main 进程完成登录校验并持久化可信登录状态。
2. 阻止并发退出操作覆盖本次状态提交。
3. 调用且等待 `refreshAfterLogin()`。
4. 根据认证产品流程继续返回登录结果。

### 退出

1. 在 Main 进程确认退出操作，并先阻止新的内置模型任务。
2. 提交可信退出状态；不要信任 Renderer 传入的 `isLoggedIn` 布尔值。
3. 调用且等待 `refreshAfterLogout()`。
4. 按认证模块自身规则清理 token、cookie 等认证凭据。

不要从认证模块直接调用 `syncBuiltinModelProvider()`、`syncOpenClawConfig()`，也不要传
`enabled`、`disabled`、`auth-login` 或 `auth-logout`。这些细节由生命周期协调器管理。

## 当前接入状态

当前 Main 进程已经导出 `refreshAfterLogin()` 和 `refreshAfterLogout()`，但仓库内尚未
包含调用它们的认证 handler。启动路径在认证模块接入前仍以 `Enabled` 刷新内置 provider。
登录模块开发时必须同时完成实际 handler 调用点，以及启动时从可信持久化认证状态选择
`Enabled` 或 `Disabled`，不能只实现登录/退出按钮。

## 生命周期执行内容

两个入口按顺序执行：

1. 根据认证状态更新 SQLite `app_config.providers.builtin_models`。
2. 以认证专用同步原因更新实际 `openclaw.json`。
3. 从实际 `configPath` 重新读取文件并校验落盘内容。
4. 更新 Gateway 下一次启动使用的密钥环境。
5. 尝试让正在运行的 Gateway 应用配置。
6. 发送 `builtinModels:changed`，通知所有 Renderer 重新读取配置。

Renderer 收到通知后会刷新 `configService`、Redux 模型列表和已打开的模型设置页。退出
后没有其他可用模型时，当前模型选择会被清空。

生命周期协调器与 provider 同步均使用 generation。较早的登录刷新如果被后续退出覆盖，
不得重新写回 provider、OpenClaw 配置或发送过期通知；OpenClaw 配置写入也会串行执行，
确保最后提交的认证状态获胜。

## 配置修改边界

认证生命周期同步只修改：

- `builtin_models` provider；
- 直接引用内置模型的默认模型；
- 内置模型 memory search 配置；
- 直接引用内置模型的逐 Agent 模型字段。

以下内容必须保留：

- 自定义 provider；
- 已有 `models.pricing`；
- Gateway 设置；
- 插件与技能配置；
- 其他未知或用户维护的配置字段。

认证同步不得顺带更新扩展 manifest、session store、exec approval 或 Agent workspace。

退出后若仍有自定义 provider，指向已删除内置模型的默认和逐 Agent 模型必须回退到当前
可用默认模型。若没有其他 provider，则删除所有 provider 和模型引用，并显式禁用
memory search。

## 落盘强校验

配置写入返回成功后，必须重新读取同步结果中的实际 `configPath`，不能假设固定路径。
通用校验确认磁盘内容与目标配置一致；退出还要额外确认：

- 不存在 `builtin_models` provider；
- 不存在 `${JUSTDO_APIKEY_BUILTIN_MODELS}`；
- 默认模型不再引用 `builtin_models/...`；
- memory search 不再引用内置 provider；
- 任一 Agent 都不再引用 `builtin_models/...`。

校验失败时：

- 认证入口返回失败；
- 不更新 Gateway 密钥环境；
- 不应用配置或重启 Gateway；
- 错误包含实际配置路径和残留项。

## Gateway 行为

| 场景 | Gateway 行为 |
| --- | --- |
| 登录新增内置 API key，Gateway 正在运行 | 必须重启，使子进程获得新增环境变量 |
| 登录配置变化但环境变量未变化 | 优先原生热加载，失败时按普通策略回退 |
| Gateway 未运行 | 只更新配置和下一次启动环境，不主动启动 |
| 退出登录 | 不得 hard restart；运行中只尝试原生热加载 |
| 退出热加载超时 | 不回退重启；退出继续完成并记录独立警告 |

`openclaw.json` 已通过强校验但 Gateway 应用失败时，生命周期记录警告并继续认证流程。
只有配置本身未成功写入或未通过强校验时，登录/退出入口才抛出错误。

退出不 hard restart 意味着当前 Gateway 进程的操作系统环境在进程结束前不会改变；但
配置已移除内置 provider，管理器保存的环境也已更新，下一次 Gateway 启动不会再注入
`JUSTDO_APIKEY_BUILTIN_MODELS`。

## 认证模块不负责的事项

模型生命周期入口不负责：

- 创建、刷新或撤销认证凭据；
- 判断用户是否真的登录；
- 决定活动任务的停止策略；
- 保证已经启动的内置模型任务立即中止；
- 展示认证 UI 或错误文案。

认证模块应在调用入口前阻止新的内置模型任务，并按产品的撤权语义处理已经运行的任务。

## 接入检查清单

- 登录状态只由 Main 进程可信来源决定。
- 登录成功状态提交后调用并等待 `refreshAfterLogin()`。
- 退出状态提交后调用并等待 `refreshAfterLogout()`。
- 不从 Renderer 直接暴露认证生命周期 IPC。
- 不在认证 handler 中重复修改模型 provider 或 `openclaw.json`。
- 配置落盘失败会阻止认证流程继续。
- Gateway 应用失败不会被误报成配置写入失败。
- 登录与退出快速交错时，以最后提交的状态为准。
- 覆盖“内置 + 自定义 provider + Agent 指定内置模型后退出”的集成测试。

## 相关实现

- `src/main/main.ts`
- `src/main/cowork/builtinModelLifecycle.ts`
- `src/main/cowork/builtinModelProvider.ts`
- `src/main/openclaw/config/openclawConfigSync.ts`
- `src/main/openclaw/config/openclawConfigSyncService.ts`
- `src/shared/builtinModels.ts`
