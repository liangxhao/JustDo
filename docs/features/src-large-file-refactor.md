# 超过 3000 行文件的拆分记录

日期：2026-09-24。

## 范围与结果

扫描 Git 跟踪文件及未被忽略的新文件，跳过二进制；依赖、构建产物等被忽略内容不计入。按物理行统计，包含空行和注释，阈值为严格大于 3000 行。

原有 12 个超限文件全部完成拆分。复扫仓库没有超过 3000 行的文本文件，新增模块也均低于该阈值。保留原入口文件、公共 API、IPC、Redux 挂载、SQLite schema 与业务规则。

| 原文件 | 拆分前 | 拆分后 |
| --- | ---: | ---: |
| src/renderer/libs/openclaw-chat/gateway/chat-controller.test.ts | 11588 | 2526 |
| src/renderer/libs/openclaw-chat/gateway/chat-controller.ts | 6917 | 2798 |
| src/main/engine/openclaw/openclawRuntimeAdapter.test.ts | 6412 | 1251 |
| src/renderer/services/i18n/translations.ts | 5622 | 30 |
| src/main/browser/browserAgentBridge.ts | 5253 | 2384 |
| src/main/engine/openclaw/openclawRuntimeAdapter.ts | 4937 | 2858 |
| src/renderer/libs/openclaw-chat/components/justdo-chat.ts | 4911 | 2175 |
| src/main/browser/browserAgentBridge.test.ts | 4067 | 706 |
| src/renderer/features/settings/Settings.tsx | 3664 | 2568 |
| src/renderer/features/cowork/components/CoworkView.tsx | 3601 | 2917 |
| src/renderer/features/cowork/components/composer/CoworkPromptInput.tsx | 3121 | 2831 |
| src/main/openclaw/config/openclawConfigSync.ts | 3108 | 1067 |

## 已落实的职责划分

- **聊天显示与翻译**：Lit 样式移到同目录的 `justdo-chat.styles.ts`，保留第三方样式与自有样式的加载顺序。翻译拆为 app、settings、chat、plugins、scheduledTask 五个双语字典，原 `translations.ts` 继续聚合已有浏览器录制和问候语字典。
- **聊天控制器**：会话连接与切换放在 `chat-controller-session.ts`；历史读取、分页和媒体补全放在 `chat-controller-history.ts`；压缩、恢复/事件处理、进度卡各有对应模块。纯辅助函数和合约放在 `chat-controller-support.ts`。
- **浏览器桥接**：协议解析、类型和纯辅助函数放在 `browserAgentProtocol.ts`；页面快照、ARIA 引用和截图放在 `browserAgentSnapshots.ts`；交互、上传和页面动作放在 `browserAgentActions.ts`。入口继续拥有标签注册、IPC 信任校验、队列、交互锁和资源清理。
- **运行适配器**：Plan/问答、Goal、Gateway 连接、Gateway 事件、历史和运行状态分别移入 `runtimePlanInteractions.ts`、`runtimeGoalOperations.ts`、`runtimeGatewayConnection.ts`、`runtimeGatewayEvents.ts`、`runtimeHistory.ts`、`runtimeSessionStatus.ts`。入口保留运行启动/停止协调和状态所有权。
- **配置同步**：`openclawConfigBuilders.ts` 负责配置构建、裁剪、合并和验证；`openclawConfigSync.ts` 负责同步编排、文件写入和工作区同步。原入口继续导出原有函数，避免同时扩大调用方迁移范围。
- **设置页面**：通用设置与外观组合页放在 preferences；模型连接测试动作放在 models。跨页状态、保存、取消和预览恢复仍由 Settings 协调。
- **会话页面与输入框**：附件处理、浏览器面板、侧边问答、运行轮询、会话列表操作分别抽到所属领域的 Hook，主页布局抽到 `CoworkHomeWorkspace.tsx`。提取后的 Hook 明确列出原先由页面内部持有的稳定 ref/setter 依赖。
- **共享辅助定义**：展示标签 ID/上限、附件文件判断、设置中的 Provider 配置分别由 `displayTabIds.ts`、`composerAttachmentFiles.ts`、`providerSettingsConfig.ts` 维护；页面和抽出的模块共同引用，避免复制常量、类型与辅助函数。
- **测试**：原三个大测试文件按行为拆成 22 个文件，保留 482 个原有测试声明（参数化声明执行时会展开）。每个文件独立建立 Mock、计时器和清理逻辑；辅助定义只保留该文件实际依赖的部分。

## 状态与依赖约束

有状态控制器的这一步拆分不改变状态所有权。领域函数接收显式接口，入口只暴露接口列出的字段和回调，不把整个控制器传入，也不通过强制类型转换绕过 private 限制。

`shared/app/propertyContext.ts` 使用属性访问器将接口映射到入口当前状态。每个上下文在实例构造时创建一次；读取和写入发生时才访问当前字段，回调也在调用时解析，因此异步操作不会因为拆分而继续使用旧连接、旧会话或旧取消标记。领域模块与控制器之间的类引用仅用于类型。

继续保留入口中的转发方法，以维持公共 API 和已有生命周期协调。此轮没有引入新的业务状态机、消息缓存或持久化层。未来若移动状态所有权，应另做有针对性的行为重构，而不是为了缩短入口删除必要的协调。

## 迁移一致性与验证

- 语法树审计确认 181 个抽出的类方法保留原有方法体；原三个大测试文件的 482 个测试声明保持一致。
- 编译并比较拆分前后的翻译对象，中英文各 2686 个最终键值完全一致。
- 新增实时依赖上下文测试，验证状态替换后的读取、写回、回调替换及暴露字段范围。
- `npm run lint`、`npm run build`、`tsc --project electron-tsconfig.json --noEmit` 通过；所有受影响的 TypeScript 文件通过 Prettier 检查，`git diff --check` 通过。构建仍有既有的大 chunk 与静态/动态导入提示。
- 广泛定向回归：212 个测试文件、2307 个测试通过。公共辅助定义合并后，设置/会话 UI 再次回归：103 个文件、622 个测试通过。中间曾出现一个 JSDOM worker 启动错误，单独复测及整组复测均通过。
- 本地 `better-sqlite3` 为 Electron ABI 146，标准 Node 需要 ABI 137。直接使用 Node 时 9 个原生 SQLite 测试无法加载模块；采用匹配的 Electron Node 模式执行完整测试，原生 SQLite 测试通过。
- Electron Node 模式全量结果：539 个文件通过、5 个失败；5308 个测试通过、32 个失败、5 个跳过。失败位于安装器进程测试、两个模拟 ASAR 的测试文件，以及两个临时目录清理测试文件。随后在标准 Node 下复核这些文件并补跑配置同步测试，7 个文件、243 个测试全部通过。
- 上述跨运行时验证不能等同于标准 `npm test` 在单一运行时下全绿；本轮未修改原生依赖、测试超时、断言或跳过条件来消除环境差异。
