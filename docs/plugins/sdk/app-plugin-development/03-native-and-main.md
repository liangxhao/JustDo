# 03 Native 与 Main 开发

先读 [02](02-package-and-manifests.md) 的所有权和清单约定。本章重点说明什么代码应该在哪个进程执行，以及异步任务、数据库和关闭清理如何接入。

## Native：工具和执行事实留在原生运行时

原生入口默认导出插件对象，保持 `register(api)` 简短，在领域模块中注册真实工具、Gateway handler、hook 或服务。参考 [Workflow 原生入口](../../../../plugins/extensions/swarm-workflow/index.ts)和 [Team 原生入口](../../../../plugins/extensions/agent-team/index.ts)。原生入口不能导入应用 `host/` 或 `app/browser/`；跨入口共享的 facade 只引用纯合同、校验或 prompt。

原生 SDK 使用锁定版本公开的 `openclaw/plugin-sdk/<module>`。具体 API 签名优先参考本仓库已经使用的相同能力，不照搬其他版本示例，更不要为了读取原生内部状态导入 OpenClaw 私有源码。

当前应用插件原生 profile 是 `single-file-v1`：

- 业务代码和可打包依赖进入一个原生 ESM `index.js`。
- 允许字面量的公开 OpenClaw SDK 子模块导入，以及支持的 Node 内建模块。
- 不支持 `require` / `createRequire`、动态计算 import、`eval` / `Function` 或替代加载器；`module`、`vm`、`worker_threads`、`child_process` 也被当前 profile 排除。
- 不把原生执行改成 Browser 直接调用，也不在 Main 复制原生消息历史或执行状态机。

这是受支持的产物格式，不是恶意代码隔离。准确判定见 [native-profile.ts](../../../../plugins/sdk/app-plugin-sdk/native-profile.ts)。需要超出该 profile 的能力时先讨论公共合同，不能只修改产物绕过校验。原生执行使用哪些 npm 依赖，由插件自己的 `package.json` 声明和构建器解析，不从相邻应用源码隐式取得。

## Main：返回注册描述，不直接改宿主

从 `@app-plugin/sdk/main` 导入 `AppMainHost` / `AppMainRegistration` 类型，导出同步的 `register(host)`。入口返回命令和可选参与者，不注册 Electron IPC、不取得整份应用 controller，也不写 Core 专属分支。

```ts
import type { AppMainHost, AppMainRegistration } from '@app-plugin/sdk/main';

export function register(host: AppMainHost): AppMainRegistration {
  return {
    commands: [
      {
        id: 'session.title',
        invoke: (...args: unknown[]) => {
          const [sessionId] = args;
          if (
            args.length !== 1 ||
            typeof sessionId !== 'string' ||
            sessionId.length === 0 ||
            sessionId.length > 256
          ) {
            throw new Error('invalidSession');
          }
          const session = host.getSessions().getSession(sessionId);
          return session ? { title: session.title } : null;
        },
      },
    ],
  };
}
```

该片段替换一个 Main 入口时，还必须把 `session.title` 加入应用清单。示例只说明只读命令，不替代业务需要的会话归属、删除状态、权限及目标身份校验。

命令参数是 `unknown[]`。作者负责校验类型、数量、边界和业务授权；类型断言不是校验。返回有界普通数据，不返回函数、循环对象、数据库连接或宿主对象。通用 IPC 会限制数据形状和体积。

### 生命周期的执行顺序

| 时机                          | 注册点                           | 应做的事                                                                    |
| ----------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| 加载可信产物                  | 模块加载、`register`             | 定义协调器和注册描述；避免顶层副作用、读用户状态或启动后台业务              |
| 产品数据库初始化              | `schemas[].initialize(database)` | 同步建立或验证自己的元数据表；使用给定同一数据库连接                        |
| 应用运行资源建立后            | `activate()`                     | 每个 Main 实例一次的同步生命周期初始化；不能据此推断插件业务已启用          |
| 原生身份确认且当前 epoch 启用 | `onEnable()`                     | 同步建立当前业务监听，可返回 disposer；异步业务放入被授权的命令或明确参与者 |
| 保留实例定期核对收据          | `maintenance()`                  | 由宿主提供新的 cleanup-only 作用域，包括关闭期间；只核对和清理既有资源      |
| 关闭前                        | `beforeDisable()`                | 在清理作用域完成必要元数据保存或待发输入围栏，异步返回释放函数              |
| 安装、替换、删除等包变更前    | `beforePackageMutation()`        | 预检所有自有执行及 custody 是否可安全处理，无法证明时拒绝                   |
| 实例退休                      | `dispose()`、`host.signal`       | 释放实例资源，取消迟到任务，不重新创建业务                                  |

`register`、`activate` 和 `onEnable` 不能声明为 `async`，也不能返回 thenable。不要在同步 hook 中启动一个游离 Promise，再期望它延续该 hook 的临时写入或清理权限。宿主会在真实效果边界重新检查作用域、epoch 和原生身份。

Main 的 `host.signal` 属于整个保留实例，关闭业务后实例可能继续提供清理/收据处理，signal 不一定立即 abort。当前业务监听必须由 `onEnable` 返回的 disposer 和 epoch 共同约束；不要仅凭这个 signal 判断业务仍可写入。

`onEnable(resources)` 接收本次业务 epoch 的资源作用域。让作用域托管订阅，并在该 epoch 撤回时统一释放：

```ts
onEnable(resources) {
  resources.defer(host.onNativeEvent(event => {
    if (event.event === 'sample.changed') host.publishEvent('changed', {});
  }));
}
```

作用域在关闭、围栏、换代、注册失败或实例退休时释放，重新启用取得新作用域。它不能替代 Main 原有调用授权、Native 身份检查或清理租约。托管后台任务的取消是协作式信号；任务仍需在 await 后检查寿命，不能把本地 Promise 结束或取消当成原生执行已结算。

需要原生变更通知时，在 `onEnable` 中订阅 `host.onNativeEvent` 并返回取消订阅函数；参考 [Workflow Main 注册](../../../../plugins/extensions/swarm-workflow/host/app.ts)。不要只根据“收到一个事件”就信任任意 payload。

普通已安装插件的启用、关闭通过当前 Gateway 热更新完成，不能以重启 Gateway 或软件代替。安装、卸载、替换 Native 二进制等包变更则由宿主统一预检并重新启动后台 Gateway，软件保持打开；`beforePackageMutation` 不能绕过这一流程。

## 公共产品端口

| 端口                                             | 用途与边界                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `getSessions()`                                  | 读取产品会话、助手、运行收据等元数据；创建/删除有生命周期限制                    |
| `getExecution()`                                 | 准备、查询或停止明确的产品会话；Stop ACK 本身不是运行结束证据                    |
| `getRuntime()`                                   | 按需读取当前 runtime，不缓存整个宿主状态；可能返回 `null`                        |
| `requestGateway()` / `requestConnectedGateway()` | 经宿主连接路径发起受绑定的请求；后者使用已有连接，业务不能假定离线时自动恢复成功 |
| `getDatabase()`                                  | 真实产品 SQLite 连接的受控端口；遵守 schema/业务/清理等作用域                    |
| `getNativeStateDirectory()`                      | 既有原生状态定位端口；私有文件与执行安全记录使用受管数据合同                    |
| `getPluginDataDirectory()`                       | 当前业务作用域中的本插件受管私有目录                                          |
| `getRetainedPluginDataDirectory()`               | 已登记保留目录的只读元数据定位；不创建目录或授予业务写权限                      |
| `onExecutionReceipt()`                           | 消费宿主投影的精确已结算生命周期收据，仍需校验自己的 session / run               |
| `executionSessionsChanged()`                     | 精确执行来源元数据改变后，请宿主重新读取关联；不建立终态或发布正文               |
| `publishEvent()`                                 | 发布瞬时、有界、无正文的业务元数据变化通知                                       |

完整签名见 [main.ts](../../../../plugins/sdk/app-plugin-sdk/main.ts)。清单的 `capabilities` 应如实描述这些用途；它不是一个新增字符串就能解锁的 API，也不能替代原生 profile/device 授权。

`getRuntime()` 可能返回空值或在异步读取期间更换。读取前保留具体 runtime 和 `captureGatewayResponseContext()`，读取后核对实例及 `isCurrent()`；不要把旧响应用于当前会话。该上下文只证明读取寿命，不是发送或修改授权。

## 元数据、事务和原生历史

插件可以维护自己的产品元数据表，schema 在同步 `initialize` 中完成，领域 CRUD 与消费者放在同一个插件中。表、列、配置键、RPC 名和状态槽使用领域中立命名；不要拼接当前产品名作为新标识。

同库业务事务使用宿主提供的同一 SQLite 连接，不重新打开产品数据库，不把多表原子操作拆成另一连接。事务回调保持同步，不用一个数据库事务包住网络 await。

原生执行调度的插件状态可以归原生插件自己的存储，例如 Workflow 的流程库；产品会话身份、原生运行事实和调度元数据必须分别持有。设置放在哪里也应由插件自己的合同明确，不通过写全局应用配置来制造第二份权威。

消息正文、原生会话历史和 holding 继续归 OpenClaw。不要重建 `cowork_messages`、Main/Redux transcript 缓存，或扫描原生数据库来“恢复”界面历史。Browser 需要展示时使用宿主提供的历史视图。存储边界详见[数据存储](../../../architecture/10-data-storage.md)。

### 私有文件、保留数据与卸载

插件的缓存、下载、业务文件和执行安全记录使用受管私有数据目录。清单用 `data` 声明目录；执行收据、未结算任务等安全记录声明 `retention: "retain"`，卸载时保留。Main 只有当前业务作用域可使用 `getPluginDataDirectory()`；合法清理或只读来源解析可用 `getRetainedPluginDataDirectory()` 定位已存在、精确登记的保留目录并读取元数据，不能据此取得普通数据目录或恢复业务写权限。缺少目录或 receipt 时拒绝，不创建、迁移或降低保留策略。Native 侧按公开 `@app-plugin/sdk/data` 读取同一 owner 描述，详细字段与兼容边界见[数据 SDK](../app-plugin-sdk.md)。

## 配置投影

如果原生配置由产品元数据派生，通过 `projectNativeConfig(agents)` 返回插件自己的配置内容；返回值必须与原生 schema 一致，不返回整个 `plugins` 或 `openclaw.json` 文档。

投影是同步、只读操作，不做数据库写入、发送、创建会话或清理。`nativePolicy` 可以声明自己托管的技能、sandbox tools 和 surfaces，宿主负责合并与保护通用配置，并保留用户显式开关和无关权限。参考两个示例的 `host/app.ts` / `host/config.ts`，不要在 Core 增加按插件名称判断的分支。

## 执行、提交和未知结果

输入模式需要关联产品发送时，实现 `submission` 参与者，处理注册、开始、发送前取消、取消和已结算释放。匹配当前结构化 `AppSubmission` 的 pluginId / mode / input，不以普通提示文本标记判断授权。

Browser 的模式只准备 `{ prompt, input? }`；宿主决定当前 owner/epoch 并在实际发送边界复查。原生执行仍校验准确 session/run/instance 身份。未知提交、超时或断线不能被转换为“肯定没执行”，也不能直接重发。

只有准确整轮终态且 `executionSettled: true` 才是结算依据。聊天 final、attempt 完成、Stop ACK、空闲状态、owner 变化都不能替代它。参考[执行引擎](../../../architecture/05-agent-engine.md)与 Team 的发送/holding 实现。

### 将子执行关联到正确产品会话

需要把成员浏览器或 Ask User 放到来源聊天时，实现注册描述中的 `resolveExecutionSession(query)`。输入包含实际 `sessionKey`、`nativeSessionId`、可选 `lifecycleRevision`、`runId` 和原生证明的 owner。返回值只含 `{ ownerSessionId?, label?, pending?: true }`；宿主补入当前插件 ID、Native ID 和 epoch，插件不能自选这些身份。

关联必须来自当前原生执行的精确记录。异步读取前后核对 runtime、响应上下文、业务代次及查询身份；普通成员的独立聊天仍属于该成员，不能只因它在某个 Team 中就挂到组织者。只有已证明的委派关系才能显示到来源会话。关联未知、借用关系无法证明或出现冲突时返回 `null`，不能用最新房间、最近消息、运行 ID 后缀或用户当前聊天来猜测。

若业务已经知道这是自己的当前执行，但来源关联还在等待精确 ACK，可以返回 `{ pending: true }`。宿主保留待处理问题，但此时不显示问答或准入浏览器效果。精确 ACK、停止或删除的元数据持久化后，在相应业务、收据或清理回调内调用 `host.executionSessionsChanged()`；宿主再读 resolver。resolver 本身必须只读，不能反过来发通知制造读取循环，也不能把这条无正文通知当成一次真正启停。

该映射只决定界面和资源归属，不继承父会话权限、PTY、MCP 客户端租约或原生工具能力。参考 [Team 来源解析](../../../../plugins/extensions/agent-team/host/executionSession.ts)、[Workflow 来源解析](../../../../plugins/extensions/swarm-workflow/host/executionSession.ts)和[多 Agent 工具边界](../../../features/execution/multi-agent-tools.md)。

## 资源删除和关闭后的清理

创建自有会话或长期保护资源时，应实现 `resources`：列出 `protectedResources`，用 `expandResources` 扩展删除集合，用 `acquireDeletion` 取得删除 lease，再完成 `prepareDelete` 和受控删除。完整方法签名见 SDK，参考 [Workflow resources](../../../../plugins/extensions/swarm-workflow/host/resources.ts)。

宿主将删除集合扩展到固定点，先获取全部 lease、完成全部预检，再删除。任意 owner 缺失、失败或未知都应否决，不允许只删一半。借用的来源会话不是插件自有会话，不能一并删除。

需要在关闭后调用原生清理方法时，显式声明 `cleanupGatewayMethods`，必要时用同步且严格返回 `true` 的 `allowCleanupGatewayRequest` 缩小参数范围。该合同不会启用普通业务命令，也不会获得额外原生授权；不能用它发送或创建新业务。

`maintenance` 获得 cleanup-only 作用域不表示用户请求取消。只因插件关闭、记录暂缺或一次读取失败就停止一个仍在运行的执行，会改变原有功能。根据持久化的停止/删除意图和精确收据决定是否取消；结果未知继续保留围栏和待核对状态，不能自动重放发送或把 Stop ACK 结算为终态。

旧版本产物只在资源账本引用精确 hash 时恢复清理，不注册旧 UI、不执行新业务。读取清单/schema/清理失败导致的安全阻塞，不得在包预检取消时被当成临时围栏清除。演进时不能把 `protectedResources()` 返回空数组当作已证明没有旧资源；跨版本采用需显式确认完整集合。
