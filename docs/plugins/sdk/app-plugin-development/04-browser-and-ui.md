# 04 Browser 与界面扩展

Browser 部分导出同步 `register(host: AppBrowserHost)`，按清单注册视图、模式、翻译或投影，必要时返回 disposer。业务 UI 放在插件自己的 `app/browser/`，不能导入应用 `src` 或 Main 实现。

宿主会记录这些注册并在 Browser 实例退休时统一撤回；示例无需再返回一个重复撤回相同注册的 disposer。自己建立的其他实例资源仍应显式清理，组件资源通过 effect cleanup 释放。需要提前撤回某项注册时，可以使用注册方法返回的释放函数。

完整最小实现见 [Hello Panel 界面](examples/hello-panel/app/browser/index.tsx)，完整合同见 [browser.ts](../../../../plugins/sdk/app-plugin-sdk/browser.ts)。

注册本身必须同步完整成功：不要返回 Promise/thenable，也不要先异步加载业务后再声称原有注册已经可用。宿主在整次注册成功后才发布业务上下文，半注册、加载失败和迟到的旧实例均不能恢复入口。组件内的异步数据读取则按下面的寿命检查处理。

## 当前应用提供的插槽

| 插槽                        | 注册方式                          | 宿主如何使用                                        |
| --------------------------- | --------------------------------- | --------------------------------------------------- |
| `workspace.tab`             | `registerView`                    | 当前聊天的工作区 Tab；注册后仍需要明确打开          |
| `plugin.settings`           | `registerView`                    | 对应扩展的设置入口和内容                            |
| `plugin.history`            | `registerView`                    | 对应扩展的业务历史入口和内容                        |
| `composer.mode`             | `registerMode`                    | 输入框模式、选项和提交前准备                        |
| `chat.action`               | `registerView`                    | 当前聊天操作区域的插件组件                          |
| `session.summary`           | `registerView`                    | 摘要中的业务记录入口                                |
| `session.details`           | `registerView`                    | 会话详情中的插件组件                                |
| `application.page`          | `registerView`                    | 应用级组件或常驻 observer；不会自动新增一个侧栏路由 |
| `interactions.presentation` | `registerInteractionPresentation` | 交互项可见性和显示标签                              |
| `session.presentation`      | `registerSessionPresentation`     | 会话状态、复制/导出提示、摘要提示及关联导航         |
| `messages.presentation`     | `registerMessagePresentation`     | 消息显示文本和原生输入发送者投影                    |

所用插槽都要先写入 `app.plugin.json.slots`。后三类投影使用专门方法，不是把一个普通 React view 注册成同名 slot。自造一个 slot 不会让宿主自动知道把它放在哪里。

同一插件的视图 ID 不得重复，`labelKey` 指向已登记的双语文案。`AppViewContext` 会按实际入口提供当前会话、selection、草稿、导航或关闭回调；不要假定所有入口都有 `session`、`draft` 或 `submitUserTurn`。

视图和模式可以声明有限数值 `order`；相同顺序保留注册顺序。模式的 `group` 提供“+”菜单分组、图标和返回文案，不能靠加载顺序或 Core 按插件 ID 排列。`session.details` 的 `detailsPresentation(sessionId)` 可返回 `append`、`replace` 或 `hidden`，应只替换自己能明确识别的会话详情。

### 工作区可见性与窗口归属

工作区 Tab 隐藏后可能继续挂载，以保留草稿；用 `AppViewContext.active` 决定是否持有“当前可见记录”的焦点及相关监听。用 `selectionRevision` 区分一次新的明确打开与普通 Tab 切换；不能每次重新显示都重置用户的成员选择或输入。effect cleanup 只释放当前视图自己取得的焦点，避免清掉稍后显示的另一个房间。

有产品来源的业务入口应进入该聊天的 `workspace.tab`。没有有效来源的应用级页面，可由 `application.page` 组件使用当前上下文的 `page.setVisible` 显示；它不是一个可任意接管导航的全局路由。设置临时覆盖页面、普通导航和插件退休的处理，以当前上下文的导航和关闭回调为准，不缓存旧回调。

## 使用宿主共享的 React 和 UI

代码可以正常 `import { useEffect } from 'react'`。独立构建器会将 React、JSX runtime 以及支持的 ReactDOM 适配到宿主实际单例，不需要作者写全局变量或手工注入脚本。

公共 UI 从 `@app-plugin/sdk/browser-runtime` 的 `runtime.services.ui` 获取，例如 Modal、i18n、`useOwnerDocument` 和 `useOwnerWindow`。`@app-plugin/sdk/ui` 提供相关类型，并不是一个可直接导入 `Modal` 的运行时组件模块。

Portal 使用当前 owner document，尺寸、事件和 ResizeObserver 使用当前 owner window，避免弹窗或独立工作区跑到错误窗口。完整示例中使用 `createPortal(..., ownerDocument.body)`；宿主负责挂载已注册视图，插件不需要另建 React root 或导入 `react-dom/client`。

交互展示贡献可返回 `{ visible, label?, ownerDocument? }`，把自己能准确识别的问题交给当前可见视图及窗口；房间或窗口改变后调用 `host.interactionContextChanged()`。这只是显示提示，不是答复授权；不能因为当前聊天刚好可见就接收另一原生会话的问题。原生来源与 epoch 校验仍由 Main 及宿主执行。

当前共享 primitives / rendering / composer styles 的类型和能力分别在 SDK 的 `presentation`、`rendering`、`browser-runtime`。可用组件不是任意 Core 组件目录的别名；缺少通用能力时应提公共 SDK 变更。

## 命令调用和异步结果

通过 `host.invoke('command', ...args)` 调用自己插件声明的 Main 命令。宿主补齐当前插件和 epoch，作者不手工拼 IPC channel、原生 token 或 owner 身份。

返回的 TypeScript 泛型只帮助类型检查，不能替代运行时校验。调用可能抛出异常；插件自己的命令也可以约定 `{ success: false, error }` 等结果结构，但宿主不会把所有命令统一转换成该结构。Browser 按自己命令的合同校验返回值并呈现错误，不把任何返回对象直接当成成功数据，也不自动重试未知发送。

组件内请求使用卸载标志和 `host.signal.aborted` 防止迟到结果提交。元数据订阅要返回取消函数，定时器、DOM listener 和在途刷新都应在卸载/退休时清理。Browser host 随当前活动 epoch 退休；Main 实例可能继续保留清理职责，二者 signal 的生命周期不能混为一谈。

### 让 SDK 托管监听器和定时器

`host.resources` 随 Browser 实例自动退休，提供 `defer`、`listen`、`setTimeout`、`setInterval`、`run` 和子作用域。React effect 使用自己的子作用域，既响应组件卸载，也响应整个插件关闭：

```ts
useEffect(() => {
  const resources = host.resources.child();
  resources.listen(ownerDocument, 'visibilitychange', refresh);
  resources.defer(host.onEvent('changed', refresh));
  return () => resources.dispose();
}, [host, ownerDocument, refresh]);
```

手动释放和自动释放均幂等；清理按逆序继续执行，一个释放函数出错不会阻断其余资源。排队的监听器和定时器会检查所属作用域，不能在重新启用后复活旧回调。独立辅助模块也可以从 `@app-plugin/sdk/resources` 使用 `createResourceScope`，显式绑定父 signal 并释放自己创建的作用域。

这不是强制终止 JavaScript 的机制。异步任务收到 abort 后应停止后续工作，在每次提交结果前检查 signal，并继续使用有身份围栏的宿主端口；SDK 不会重发失败任务，也不能撤销已经发生的外部副作用。

### 保留安全的界面草稿

`host.uiState.get(key)` / `.set(key, value)` 提供当前插件 ID 和已批准产物 hash 隔离的有界内存数据。关闭、断线或可恢复围栏可以保留草稿；真正卸载或换 hash 后清除。它不写入插件业务数据库，也不持久化到下次软件启动。

只保存普通草稿数据和明确的未知请求定位，例如文本、附件路径、草稿 ID；不要保存函数、DOM、controller、授权、模式提交回调或 transcript。读写使用克隆值，不靠原地修改更新；重新启用后重新读取权威状态，不能凭恢复的草稿自动发送。

## 元数据和事件

只读产品投影使用：

```ts
import { useSyncExternalStore } from 'react';

const metadata = useSyncExternalStore(
  host.application.metadata.subscribe,
  host.application.metadata.getSnapshot,
);
const sessionId = metadata.cowork.currentSession?.id;
```

这是组件内部读取宿主活动状态的片段，不是插件可以写回的 Redux store，也不是第二份会话历史。草稿、文件选择、会话导航等明确效果使用 `host.application` 中已有的端口。

完整会话目录使用 `metadata.cowork.sessionDirectory`，它是轻量元数据而不是全量标题或正文。列表中的 `sessions` 可能只包含已加载摘要，不能据此断言某个历史来源已不存在；完整目录尚不可用时应保留未知状态。需要标题时通过 `host.application.sessions.ensureSummaries(ids)` 按需读取；不要为了列表自行读取原生 transcript。

Main 的 `host.publishEvent(name, payload)` 与 Browser 的 `host.onEvent(name, listener)` 用于瞬时元数据失效通知。桥接会绑定 plugin ID、hash、epoch 并拒绝外来/过期通知；插件仍需校验 payload 的业务会话、revision 和资源归属。

推荐先订阅，再读取权威快照；读取中出现变化时合并后补读，拒绝旧响应覆盖新状态。事件不能作为持久事实、运行终态或消息历史，重连/重新启用后应重新读取。

## 先发现记录，再展示摘要

不要把发现逻辑只写进 `session.summary` 组件：摘要尚未展开时，该组件可能根本没有挂载。

应注册一个轻量 `application.page` observer，由它持续读取插件元数据，并通过 `registerSessionPresentation` 返回 `{ summaryAvailable: true }`；内容变化后调用 `interactionContextChanged()` 通知宿主。摘要 view 只负责绘制入口，Core 按通用提示执行原有的单次自动展开规则。

如果业务需要在当前聊天首次创建记录时自动打开工作区，在插件 observer 中调用 `host.openWorkspace(contributionId, sessionId, selection)`。先检查当前产品会话和当前插件 lifetime：初始加载的旧记录、后台聊天的新记录、重复通知以及已关闭记录都不应反复弹开。

真实实现和测试见：

- [Team 会话投影与 observer](../../../../plugins/extensions/agent-team/app/browser/sessionPresentation.tsx)。
- [Workflow 注册与 observer](../../../../plugins/extensions/swarm-workflow/app/browser/index.tsx)。
- [Workflow 发现 hook](../../../../plugins/extensions/swarm-workflow/app/browser/useSwarmWorkflowDiscovery.ts)。

不需要为了自动展开摘要在 Core 新增 `if (pluginId === ...)`。

## 输入模式和发送

`registerMode` 的 `prepare` 收到草稿、会话 ID、模式选项等输入，返回 `{ prompt, input? }`。它准备当前提交内容，不应自行调用原生发送、创建一套消息队列或预先占有下一轮执行。

宿主把选择封装成有界 `<app-plugin-input>`，填入当前 pluginId / epoch / mode，并在真正发送前复查。需要协调产品侧登记时由 Main 的 `submission` 参与者接入。精确匹配结构化合同，不以模型正文中的提示标签判断授权。

失败和取消不能清空之后输入的新草稿；返回结果未知时不重放发送。普通 turn、队列、附件和模式支持范围应由插件明确校验，必要时拒绝不支持的组合。

## 原生历史和消息显示

通过 `host.renderHistory` 使用宿主维护的原生历史视图，具体参数参考当前 Team / Workflow 的已接入用法。它由真实 ChatController/Gateway 的挂载状态驱动；不是任意文件阅读器，也没有把 chat controller 直接交给插件。

需要在该视图续写时，使用当前挂载历史状态提供的受控 `send`，在实际效果前核对 `readCurrent`、Native session/run、业务代次和插件寿命。该端口保留原生准备与未知回执检查；不能把首次挂载得到的发送函数长期存入草稿。准备中或准备失败不等于空历史，恢复仍交给原控制器。

`registerMessagePresentation` 只处理显示投影，例如隐藏精确的当前插件提示后缀或显示原生发送者标签。不要改写存储的原生正文，不能把显示字符串当成执行成功证据。

如果关闭业务后仍需保持既有消息的显示规则，可以声明独立的 `app.presentation` / `entries.presentation` 纯入口，只导出 `presentation`。它允许文本清洗、精确镜像识别、原生输入身份展示和双语词典；不能取得 Browser host、React、命令、导航、数据或发送端口。接口见 [`@app-plugin/sdk/history-presentation`](../../../../plugins/sdk/app-plugin-sdk/history-presentation.ts)。

这种纯展示按当前已安装且获批产物的 ID/hash 单独租用，业务关闭或临时断线不会撤回；真正卸载、替换选定包或身份未知才撤回。它不新增历史、设置或其他业务入口，也不能读取额外历史。普通 `registerMessagePresentation` 仍随 Browser 业务实例退休，不能借它维持关闭后的业务能力。

## 文案和样式随插件交付

`registerTranslations({ zh, en })` 为用户可见字符串提供成对翻译。使用带领域含义的 key，避免与其他插件或 Core 的 key 冲突。不要为了插件文案把业务字典放回 Core 的组合文件。

样式从 Browser 源码静态导入。当前构建器会合并 CSS，使用公开的 `@app-plugin/build/theme-preset` 生成插件源码中的 Tailwind utilities，不包含重复的 Tailwind preflight。生成的 utilities 限定到本插件的 `data-ui-style-scope` 祖先；宿主的共享 React/Portal 适配保留这层样式归属。手写 CSS 仍应加领域前缀，避免全局 `body` / `button` reset；这不是 Shadow DOM 或恶意 CSS 隔离。

当前构建器不是任意资源发布器。新增图片、字体、Worker 或拆分模块前，要验证它们确实进入受校验产物、模块图和宿主同源服务；不能仅把文件放在源码旁边就假定它可访问。

界面资源必须随包或来自显式配置的内部服务，不依赖公共 CDN 或首次启动时下载。插件有动画时，显式处理 `prefers-reduced-motion: reduce` 及动画库设置，保证 Windows 关闭系统动画后该功能仍按产品要求运行。

## 关闭时应该发生什么

关闭后，当前插件 Browser 业务实例的设置/历史入口、工作区、模式、页面、样式、翻译和投影都应撤回，已打开弹窗及旧回调一同退休。独立纯历史展示遵循上一节的 ID/hash 租约，不提供业务入口；宿主还可以保留最后确认的运行提示，但这不恢复插件 resolver、历史、设置或导航。Browser 不应继续监听或提交业务效果。

业务历史可以保留，但关闭期间不能继续提供插件历史入口；重新启用后重新读取，再由用户进入。扩展管理自身的启停、卸载和代码审核属于管理功能，不等于插件提供的参数/历史入口。

必须测试快速关开、切换聊天、卸载时请求未完成、重复通知和新 epoch，不能只测试第一次正常打开。
