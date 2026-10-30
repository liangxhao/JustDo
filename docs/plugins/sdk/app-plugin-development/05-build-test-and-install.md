# 05 构建、验证、安装与排障

## 选择构建方式

| 工作                     | 命令或入口                                                                                             | 说明                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 检查仓库捆绑应用插件类型 | `npm run plugins:app:typecheck`                                                                        | 发现 `plugins/extensions/*` 中的 `package.json.app` 源码；不自动检查外部目录或文档示例 |
| 构建全部捆绑应用插件     | `npm run plugins:app:build`                                                                            | 先类型检查，再构建公共 SDK、所有清单及 `catalog.json`                                  |
| 检查或构建一个独立插件   | `app-plugin-build check --source <source>` / `app-plugin-build build --source <source> --out <output>` | 使用安装的公共构建工具；显式提供源码和输出，不更新宿主捆绑 catalog                     |
| 发射公共 SDK             | `npm run plugins:app:sdk`                                                                              | 输出 `build/app-plugin-sdk` 中的 JS、声明和 npm exports                                |
| 验证仓库真实插件产物     | `npm run plugins:app:verify`                                                                           | 检查当前 Team / Workflow 和公共宿主路径；不是任意第三方插件的自动验收器                |

所有仓库脚本从仓库根目录执行。构建输出的完整可安装包是 `<output>/packages/<id>/<hash>`，不是只含 Main / Browser 的 `<output>/<id>/<hash>`。

新插件从 [Hello Panel 完整示例](examples/hello-panel)开始。开发时使用 SDK 的真实类型与现有编译、打包流程；运行、启用、关闭和代码审核通过桌面应用的管理流程完成。本章的终端命令仅属于开发工具链，不表示软件提供命令行运行入口。构建成功也不等于原生授权或业务验收通过。

## 在独立作者项目中使用 SDK

作者使用 `@app-plugin/sdk` 和 `@app-plugin/build` 两个公开包。不要假定它们已经发布到公共 npm registry；可在已准备依赖的宿主仓库从当前版本构建并打包：

```powershell
npm run plugins:app:sdk
New-Item -ItemType Directory -Force build/sdk-tarballs | Out-Null
npm pack ./build/app-plugin-sdk --pack-destination ./build/sdk-tarballs
npm pack ./plugins/sdk/app-plugin-build --pack-destination ./build/sdk-tarballs
```

记录 `npm pack` 返回的 tgz 路径，然后在自己的项目中安装该实际文件，并配置相同 React 基线的 peer/type 依赖。例如：

```powershell
npm install "<App SDK打包结果的绝对路径.tgz>"
npm install --save-dev "<构建工具打包结果的绝对路径.tgz>" typescript @types/node
```

上面的尖括号需要替换，不是可直接执行的路径。使用 React 的插件还需按当前 SDK/示例声明兼容的 React、ReactDOM 及类型依赖；产物仍使用宿主的 React 单例。按所使用的原生能力取得匹配宿主锁定版本的 OpenClaw 公共类型，独立项目通过 `OPENCLAW_SDK_ROOT` 或 `check --sdk-root` 明确提供，不借用应用源码或任意最新版本。

Team / Workflow 还依赖独立的 `@runtime-services/sdk`：在仓库运行 `npm run plugins:runtime:sdk`，将 `build/runtime-services-sdk` 打成 tgz 后安装。仅引入这个库不会安装、启动或授权 Required Runtime Services；运行时所需的 managed execution 等能力须另经真实握手确认。最小 Hello Panel 不需要该依赖。

可使用如下 `tsconfig.json`，并确保自己的源码都在 `include` 内：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  },
  "include": ["index.ts", "contracts/**/*.ts", "host/**/*.ts", "app/**/*.ts", "app/**/*.tsx"]
}
```

可用项目自己的 `tsc --project tsconfig.json` 补充检查；发布前仍使用同版本公共工具检查并构建完整包。在已安装上述包的作者项目中运行：

```powershell
npx --no -- app-plugin-build check --source . --sdk-root "<匹配宿主的OpenClaw公共SDK目录>"
npx --no -- app-plugin-build build --source . --out ./build/app-plugins
```

公共构建器解析已安装的 npm exports，不读取祖先 TypeScript aliases、宿主主题或兄弟插件源码。Browser React 单例、CSS、原生 profile、binding、依赖许可证和文件 hash 都属于构建合同；任意通用打包器的输出不能自动代替这个完整包。

## 仓库捆绑和开发启动

加入 `plugins/extensions/<id>` 的捆绑应用插件还要遵循 [02](02-package-and-manifests.md#仓库捆绑与独立安装的区别) 的清单及目录约定。当前 `package.json.app` 是通用源码声明，不再要求旧宿主专属 bundle 标记。仅产出应用 catalog 不代表原生 runtime 中已更新到相同入口。

当前 npm 生命周期会在 `openclaw:resources`、普通 Electron 启动和隔离开发启动前构建当前应用插件，避免首次构建缺产物或复制旧 catalog。资源同步复制完整已构建包，保证实际原生入口与 binding 一致。

直接运行 `scripts/openclaw/sync-openclaw-runtime-resources.cjs` 时需要自己先执行 `npm run plugins:app:build`。该脚本会修改目标运行时，不是只读检查；不要把仍在使用或与其他 worktree 共享的运行时当成临时输出。

修改原生入口后，还要按[开发与排障](../../../development.md)准备相应锁定运行时；普通界面开发启动不能证明旧 runtime 已经更新。运行时补丁应应用于锁定 pristine 包，不对旧的部分补丁形状做就地修补。离线依赖统一查[离线下载](../../../offline-downloads.md)，这里不另维护下载来源。

## 验证顺序

1. **静态检查：** 严格类型、清单/schema、import 边界、双语文案、格式和本地链接。
2. **领域行为：** 参数拒绝、会话/owner 身份、提交未知结果、配置投影、事务、关闭清理、旧版本资源保留。
3. **真实构建产物：** 原生入口 binding、Main 加载、Browser 共享 React、实际视图渲染、CSS 和资源撤回。
4. **生命周期：** 关闭时无设置/历史入口；快速关开拒绝旧请求；新 epoch 重读，不重放未知发送或重开旧 Tab；普通预检否决与安全阻塞分开处理。
5. **实际应用：** 在交付策略开放相应入口的环境验证本地安装、精确信任登记、后台 Gateway 重新加载、启用、业务使用、关闭、同 ID 新版替换及卸载；软件全程保持打开。

仓库测试入口：

```powershell
npm run plugins:app:typecheck
npm run plugins:app:verify
npm test -- --config plugins/extensions/agent-team/vitest.config.ts
npm test -- --config plugins/extensions/swarm-workflow/vitest.config.ts
```

后两条分别运行两个插件自己的业务测试配置；它们不包含显式宿主集成目录 `tests/host/`。根目录不带筛选的 `npm test` 先运行宿主/SDK边界测试，再发现并运行独立插件配置。带文件筛选的根测试不会自动附加独立业务套件。新插件应维护自己的领域、入口和配置端口 fixture，宿主集成测试通过 `APP_PLUGIN_HOST_ROOT` 显式接入；不要在业务测试中依赖私有应用源码。

`npm test` 在 `build/test-dependencies/` 准备私有 Node `better-sqlite3`，不替换应用的 Electron 二进制。需要修复应用原生依赖时使用 `npm run rebuild:electron-native`。测试与 Electron 探针仍应按各自的独立配置和资源范围运行。

### 按问题选 probe

| 要证明的事情                                  | 仓库 probe                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK 可从独立目录消费                          | [verify-portable-app-sdk.mjs](../../../../scripts/test/plugin-host/verify-portable-app-sdk.mjs)                                                                                                              |
| 实际 Main 产物、schema 和关闭后元数据         | [verify-built-app-artifacts.mjs](../../../../scripts/test/plugin-host/verify-built-app-artifacts.mjs)                                                                                                        |
| 实际浏览器视图、首次发现、摘要、关闭/新 epoch | [verify-built-browser-artifacts.mjs](../../../../scripts/test/plugin-host/verify-built-browser-artifacts.mjs)                                                                                                |
| 作用域与异步尾部                              | [verify-registry-scopes.mjs](../../../../scripts/test/plugin-host/verify-registry-scopes.mjs)、[verify-lifecycle-return-contracts.mjs](../../../../scripts/test/plugin-host/verify-lifecycle-return-contracts.mjs) |
| 旧批准版本恢复清理                            | [verify-retained-cleanup-recovery.mjs](../../../../scripts/test/plugin-host/verify-retained-cleanup-recovery.mjs)                                                                                            |
| 包变更否决与资源读取失败                      | [verify-package-mutation-veto.mjs](../../../../scripts/test/plugin-host/verify-package-mutation-veto.mjs)、[verify-inventory-veto.mjs](../../../../scripts/test/plugin-host/verify-inventory-veto.mjs)             |
| 实际原生注册和请求绑定                        | [verify-native-gateway-bridge.mjs](../../../../scripts/test/plugin-host/verify-native-gateway-bridge.mjs)；需按脚本约定准备隔离运行时                                                                        |

这些 probe 有各自 fixture 和参数条件。先读脚本说明；不要把用户 Gateway、用户会话或共享 vendor 指给需要私有状态的 probe。正式安装包、真实模型和其它平台仍需分别验收，当前验证边界见[宿主架构](../app-plugin-runtime.md#验证入口与限制)及所属功能文档。

## 安装、更新和关闭

当前产品随软件内置交付；本地安装、替换和卸载入口是否开放由产品策略决定。本节描述支持这些操作的宿主流程，不表示正式安装包已经向用户开放任意第三方安装。

开放本地安装的环境遵循：用户选择完整包 → 受管安装接受原生能力 → 确认原生安装回执 → 核对身份、绑定与应用产物 hash → 登记该 hash 的代码信任 → 后台 Gateway 重新加载并核对实际注册 → 显式启用。软件保持打开。安装未知或校验失败时不登记信任；原生提交成功而信任登记失败时，保留已安装回执并报告原因，不自动重放安装。托管流程之外的目录或旧产物不能取得准入，原生 review token 也不替代精确 App 产物信任。

同 ID 自定义包遮蔽捆绑包，不能在自定义版未批准或无效时悄悄执行另一个同名版本。修改后重建整个包，并经受管安装重新核对当前 hash，不单独覆盖一个文件。

安装、替换、删除等代码包变更是冷操作：宿主先撤回业务和检查资源 owner，确认实际 Gateway 停止后才能改变包，再在原应用进程内恢复 Gateway 和 Main/UI 准入；停止超时不等于进程已退出。不要绕过这个流程直接改运行中的生成文件。

**普通已安装插件的启用、关闭必须热生效，不重启 Gateway。** 宿主使用已连接 Gateway 的公开 `plugins.setEnabled` 并核对实际注册；关闭同步撤回 UI 和业务 epoch，重新启用取得新 epoch。热更新失败或原生要求重启时明确报告失败，不通过后台重启、CLI 或自动重试掩盖结果；未确认的副作用继续按未知处理。

关闭保留必要数据和清理 owner，但移除插件的业务设置/历史/UI。卸载或升级前若仍有自有执行、custody 或未知清理状态，应该明确拒绝；不要通过删审批记录、资源账本或用户目录强行“修复”。

## 排查接入失败

| 现象                                                        | 优先检查                                                                                                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid app build declaration` / 清单不合法                | 三份配置、API 版本、包 ID、`nativePluginId`、源码入口及未知字段                                                                              |
| `App plugin cannot import application source`               | 是否导入 `@/`、`@shared/` 或应用 `src`；改用公开 SDK / 纯插件合同                                                                            |
| `Undeclared app command` / `appPluginInvalidRequest`        | 实际注册/调用的 command、slot、数据形状是否与当前清单一致                                                                                    |
| `Build app plugins before syncing native runtime resources` | 是否先构建了当前全部捆绑产物、catalog 是否完整；单包构建不能替代它                                                                           |
| `Native source differs from its app companion`              | 是否混用了不同构建的原生入口和 `app/`，或直接改了生成文件                                                                                    |
| 已安装但没有插件 UI                                         | 应用代码 hash 是否已批准、包变更后的 Gateway 重新加载是否完成、原生是否显式启用/已加载、实际 Native 身份/字节是否匹配；再查 Browser 注册错误 |
| 摘要始终不自动出现                                          | 发现是否只写在未挂载的摘要组件里，是否使用常驻 observer、`summaryAvailable` 与变更通知                                                       |
| `appPluginUnavailable` / `appPluginRetired`                 | 当前 scope、epoch、连接和实际原生身份；重新读取当前状态，不复用旧回调重发                                                                    |
| `appPluginCleanupUnresolved`                                | 自有运行和 custody 是否结算、protected resources 是否可读取、旧批准清理产物是否可用                                                          |
| 换包后仍显示旧审核或旧界面                                  | 是否完整替换、卡片是否收到当前安装变化、新版 hash 是否在安装中完成校验与信任登记，以及后台 Gateway 重新加载是否完成                                                      |

日志从 `<appData>/<productName>/logs/main-YYYY-MM-DD.log` 和对应 `openclaw/logs/gateway.log` 开始。`productName` 取当前产品元数据，不猜硬编码目录。日志缺失不证明事件未发生；不要粘贴凭据或原始用户 transcript，详见[会话诊断](../../../features/execution/session-diagnostics.md)。

## 交付给使用者的内容

提供完整安装目录或当前本地导入支持的归档、版本/API 要求、所需能力、安装/审核/后台 Gateway 重新加载步骤、已测场景及保留数据/卸载条件。包里不带开发机器路径、测试凭据、用户数据、原始日志或自己的 `node_modules` 树。

作者应记录实际通过的检查与限制。应用代码格式验证、单元测试、fixture probe、真实模型和正式安装包是不同证据，不能互相代替。
