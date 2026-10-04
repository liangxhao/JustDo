# OpenClaw 9.8 升级完整性复核

后续逐功能再次复核、追加修复及最新验证见 [33 项功能复核报告](recheck-v2026.9.8.md)。本文保留上一轮验证时点，不替代后续结果。

日期：2026-10-04。此次复核在移除未发布 9.6 的历史兼容后进行，由三个 Agent 分别审查运行包与补丁、聊天与执行协议、模型与功能集成，再对新增修复交叉审查。功能取舍仍以[升级总报告](review-v2026.9.8.md)为准。

## 发现与处理

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| 主聊天忽略原生 `pendingInputs` | 刷新或重开后，尚未进入正式历史的输入不可见 | 增加会话隔离的临时显示投影、独立分页、原生回执核实、消费后历史刷新、取消／中断状态及截断补全 |
| 浏览器侧栏独立历史链也忽略该字段 | 仅修改主 Renderer 无法修复扩展对话 | Main 显式只读选项按原生分页取得待处理输入，当次投影后返回；侧栏同步显示状态并响应较早位置的撤回 |
| 待处理输入参与侧栏完成判断 | 上一轮回答可能被误认为新一轮已经完成 | 完成基线只比较正式历史，待处理变化不能单独证明本轮完成；增加错误状态回归 |
| 相同文字的乐观输入与原生记录混淆 | 旧输入可能隐藏新发送，或撤回后重新显示 | 优先使用原生 runId、用户消息的 `idempotencyKey` 与 `__openclaw.id`；读取失败前不提前隐藏未确认的乐观输入 |
| 六个登录生命周期测试仍要求旧字段迁移 | 与用户明确删除历史兼容的要求冲突 | 测试改用当前 `serviceUrl` 和 SecretRef 配置，继续验证启动、设置、登录及退出时的配置所有权 |
| 两处文档仍描述旧视频兼容 | 补丁清单与模型说明不符合现行代码 | 更新补丁 README 和模型管理说明，不恢复兼容分支 |
| 扩展样式生成仍读取拆分前文件 | 再生成时遗漏聊天标注样式 | 改为读取 `justdo-chat.styles.ts`，缺少提取边界时明确失败，重新生成资源 |

待处理正文不进入 Renderer transcript、Redux 或 Main 的正式历史快照。主聊天使用当前页面生命周期内的临时投影；侧栏 Main 只保留当次请求数据，普通轮询继续使用正式历史游标，不因本次功能改为反复全量扫描。显式撤回的 `display:false` 记录不显示，仍可见的取消记录不冒充正式执行结果，也不提供正式历史编辑／分叉操作。

## 协议实测

新增 `tests/openclaw/runtime/pending-input-smoke.cjs`，对正式 9.8 运行包启动隔离 Gateway 和本地 SSE 模型，不使用真实账户或付费提供方。最终合成目录为 `C:/Users/lianghao/AppData/Local/Temp/justdo-pending-input-smoke-2rgyhO`。

- 忙碌时接受 21 条输入，独立分页为 20+1，重新连接后仍可读取。
- 原生 `queuedCount` 可以为 0，但持久输入仍存在；显示不能依赖该计数。
- `sessions.abort(clearQueued:true)` 后，21 条记录保留取消状态，回执数量为 21。
- 消费后正文只进入正式历史一次，待处理记录消失；实测消费回执可以为空。
- 正式用户消息使用 `runId + ':user'` 形式的 `idempotencyKey`，消息身份在 `__openclaw.id`，不能仅比较相同文字。

扩展离线脚本也增加了真实 Chromium 中的待处理状态显示与刷新移除检查。Chromium 149.0.7827.55 通过认证向量、四条拒绝路径、严格 JSON 重复键拒绝、历史、发送、Thinking、折叠、回答、停止和待处理记录刷新；页面错误为 0。该测试采用回环 WebSocket 和 Chrome API 测试替身，不等同于完整 MV3 安装和操作系统 native-host 配对。

## 构建与补丁

正式运行包的 23 个补丁、ASAR/package/依赖锁/bundle 冻结证明均通过。bundle 引用的 61 个 companion 文件存在，没有失效 worker URL。浏览器的 26 个原生基线文件与本地 9.8 源码一致（忽略换行差异），配对基线与对话 overlay 保持分离。构建专项 24 文件、126 项测试通过。

源码、Vite、打包脚本与主入口没有已删除 `nativeRuntimeMigration` 的失效引用。未重新添加旧 SQLite、旧决策模型字段、旧工具名或旧视频配置的兼容处理。

## 最终代码验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 全量 Vitest | 655 文件：647 通过、5 失败、3 跳过；6652 项：6589 通过、17 失败、46 跳过 | `.tmp/review-98-complete-full-tests.log`；剩余 17 项与既有基线一致 |
| 本轮新增测试 | 27 项通过；另外修正的 6 项旧迁移断言通过 | 纳入上述最终全量结果，不重复累加专项数量 |
| 构建、主进程编译、源码 ESLint | 通过 | `.tmp/review-98-complete-build.log`、`review-98-complete-compile.log`、`review-98-complete-lint.log` |
| 实际 Chromium | 待处理记录显示／移除及原有对话、认证检查通过，页面错误 0 | `.tmp/review-98-pending-chromium.log` |
| 实际 Electron | 9 项页面检查通过，Gateway running/2026.9.8，Renderer 错误 0 | `.tmp/review-98-complete-electron-ui.log`；隔离目录 `C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-1DqW7O` |

全量测试完成后已恢复并核验 Electron ABI 146。最终 Electron 检查使用重新构建的主进程和 Renderer，临时隔离 appData/userData/home，没有改写真实用户配置。

源码及文档的差异空白检查通过。生成的 `sidepanel-rich-content.js` 中，esbuild 保留的第三方 Lit 正则模板字面量包含实际制表符／换行，`git diff --check` 对两行报告行尾空白；未直接修剪这些有语义的字面量。实际浏览器已加载并验证该生成文件。

可复跑命令（浏览器命令使用本机既有 Playwright，不下载新浏览器）：

```powershell
npm test -- --maxWorkers=4 --reporter=dot
npm run build
npm run compile:electron
npm run lint
node tests/openclaw/runtime/pending-input-smoke.cjs vendor/openclaw-runtime/current
node tests/browser-extension/chromium-offline-smoke.cjs ../openclaw/node_modules/playwright-core
```

## 验收边界

输入恢复属于必须修复的现有聊天行为。专用队列数量展示、逐条取消入口、插件能力预览、Incognito、新的云执行及新认证产品入口仍按总报告列为后续或可选能力，不以运行包升级宣称全部接入。

本轮没有调用真实付费语言／视频服务，没有执行已登录 Codex／Claude 账户任务，没有制作完整 NSIS 安装包，也未验证其他操作系统产物。全量测试中原有 17 个基线失败的归属记录于[主目录验收报告](host-validation-v2026.9.8.md)，不能将专项通过写成全仓零失败。
