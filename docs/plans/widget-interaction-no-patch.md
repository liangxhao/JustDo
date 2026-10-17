# 交互组件闭环：无需新增运行时补丁的落地计划

## 目标与范围

借鉴 Hermes 桌面端的完整创作约定，让模型知道如何生成界面、收集用户选择、
把确认后的选择带回对话，并生成沿用这些条件的新界面。
沿用锁定的 OpenClaw 2026.10.4 原生 `show_widget`、私有 prompt port、
认证文档读取和当前聊天提交路径，不新增或修改 runtime patch，不改写运行时产物。
本计划基于 `codex/widget-viewer-adaptation` 的 viewer 修复（`9d360323e`）；
应用层视觉与交互改动已实施，当前行为维护在
[交互式回答](../features/chat/interactive-answers.md)和
[聊天渲染](../architecture/15-chat-rendering.md)；本页只保留能力证据与剩余验收。

## 产品体验目标与验收优先级

以用户提出的 ChatGPT Intelligent UI 为视觉与操作体验参考：界面精致、内容直接、
操作简短。这里是设计目标，不代表已验证或复刻其私有能力。
完成标准同时看视觉效果和操作成本，不能仅凭工具调用、文档加载或测试通过交付。

- 信息直接呈现：图表、比较结果和输入控件是主体；模型正文不复述卡片全部内容。
  每张卡片只保留必要的标题、单位、字段标签和会影响判断的假设。
- 视觉统一：沿用宿主字体、颜色、圆角与间距；标题不内外重复，不叠加多层外框。
  按内容选择布局，窄窗口不挤压控件或截断关键数字，明暗主题均需实看。
- 默认无说明尾巴：不常驻展示“不会自动执行”“请在输入框继续”等说明，
  不在成功状态显示协议、权限、文档 ID、JSON 或技术状态。
  必要限制只在相关入口不可用时按需提示；失败只显示短原因和恢复动作。
- 每张卡片最多一个主要后续动作；搜索、排序、选择、滑块和本地计算直接生效，
  不加确认、不请求模型，也不为这些局部动作新增聊天消息。
- 需要模型时才进入现有确认发送流程；本地校验并入主要动作，不先要求
  “提交表单 → 本地审阅 → 确认选择 → 继续分析”。宿主只保留一次紧凑的建议确认，
  不再叠加弹窗、成功确认或下一步教学。已有规则要求的加入草稿确认与用户发送保留。
- 测试同时记录点击数：本地探索零次额外确认；请求模型的路径最多
  “卡片继续分析 → 加入草稿 → 发送”三次主动作，不叠加其他确认步骤。
  若后续要进一步减少这三次动作，先独立确认授权与原生提交语义，不能假装已支持一键发送。

按“视觉与布局 → 模型创作约定 → 精简后续流程”的顺序实施。
每阶段先展示真实渲染结果，再验收数据和交互；不以增加解释文案代替修复设计问题。

## 借鉴对象与差异

本机 Hermes 参考提交为 `dce1e9b375`。关键实现：

- `agent/prompt_builder.py`：桌面提示明确规定 HTML 文件、`::preview`、主题变量、
  `window.hermes.send`，并要求后续通过更新文件回应。
- `apps/desktop/src/components/assistant-ui/inline-preview-directive.tsx`：
  注入 `hermes.send` 与 `data-hermes-send`，500 字符限制、每秒一次和本地投递回执。
- `apps/desktop/src/app/session/hooks/use-prompt-actions/submit.ts`：
  将交互提交为 `display_kind: hidden` 的用户消息。

Hermes 的隐藏发送、文件预览和文件覆盖不是 OpenClaw 内联文档合约。
其桥接成功也不代表模型已接收或回答，不能把 API 名称或返回值语义直接搬过来。

## 实际验证与能力判定

验证日期：2026-10-17，Windows x64 / Node 24.21.0。
使用已准备的 OpenClaw `2026.10.4`，包 SHA-256：
`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`。
Gateway 使用独立临时配置、状态、端口和本机合成模型，未读取个人 transcript。
这里只证明运行时与宿主链路，不代表真实模型会主动生成高质量界面。

| 能力 | 判定与证据 |
| --- | --- |
| 固定 table / compare / chart / form / steps | 原生 registrar 与真实 Gateway 均通过；两个 kind 和资源可同时注册，禁用后资源不可读，原文档不被改写 |
| 认证读取、历史与重启恢复 | 基础 Gateway `--ui` 验证通过；恢复不重新调用模型 |
| `display_kind: hidden` / `displayKind: hidden` / `silent` | 真实 Gateway 参数校验拒绝，且未触发模型；不在本计划支持隐藏发送 |
| 同名 `show_widget` 原位更新内联文档 | 真实调用生成不同 docId，旧 HTML hash 不变；`name` 的稳定更新语义属于 pinned dashboard |
| HTML 输入通过原生私有 port 回传 | 隐藏 Electron 专项通过：真实可信点击把输入值 `5000` 带入私有端口；无用户激活的程序调用返回 false，未产生建议 |
| `prompt.send` 的返回值 | 原生 inline 分支在 `postMessage` 后立即 resolve(true)，没有等待宿主确认、发送回执或模型执行结果；不能展示“已发送给模型” |
| 跨重启保存输入、流式生成组件、内联 dashboard actions | 未在本轮证明支持，不纳入实施；不通过产品 KV、第二份 HTML 或 runtime patch 模拟 |

专项最终输出 `ok: true`，共 6 次本机合成模型请求；
`hiddenSendFieldsRejected`、`sameNameCreatesNewInlineDocument`、`oldDocumentPreserved`、
`nativePromptBridge`、`programmaticPromptBlocked`、`bridgeResolutionIsNotModelReceipt`、
`explicitFollowupReachedModelAndHistory` 均为 true。
基础桥接使用受控最小宿主；新增 `--presentation` 进一步挂载实际 Lit viewer 与原生沙箱，
验证五种固定组件、测算和 HTML 的明暗主题、840/312px 卡片宽度、原生视口动态缩放，
以及一次真实点击产生可读行内建议。29 张截图和验证摘要写入
`.agent-tasks/interactive-ui/presentation/`（合成数据，不提交图片）。
完整 React 应用、真实模型质量及最终安装包验收仍未完成，不能把本轮结果当作产品全链路验收。

可重复运行（在本分支工作区，显式传入已准备的运行时目录）：

```powershell
node scripts/test/interactive-ui/verify-runtime.mjs <runtime-dir>
node scripts/test/interactive-ui/verify-gateway.mjs <runtime-dir> --ui
node scripts/test/interactive-ui/verify-gateway.mjs <runtime-dir> --ui --interaction-contract
node scripts/test/interactive-ui/verify-gateway.mjs <runtime-dir> --ui --interaction-contract --presentation
```

第三条补充真实 Gateway 参数拒绝、同名文档行为，以及隐藏 Electron 内实际原生沙箱的
激活/私有端口测试。之后由探针显式提交回传文字到同一会话，核对合成模型实际收到
参数且原生历史包含该输入；这一步不是 `prompt.send` 自动发送。
探针不通过调试执行构造假点击或修改 `userActivation`；程序调用必须被拒绝，
实际点击由 Chromium 输入驱动，仍通过原生包装器检查。
浏览器配置、用户数据和临时文档均在独立 fixture 中，退出清理。

## 剩余验收

模型指导、固定 renderer 的视觉和可读草稿、行内确认已落实，按需原生 HTML 示例位于
`openclaw-extensions/interactive-ui/skills/interactive-answer/references/native-html.md`。
不再保留已完成的实施步骤；当前产品契约以功能和架构文档为准。

实际配置模型与 Windows 完整开发应用已完成主聊天的固定表单、自由 HTML 表单、
比较/图表和测算组件实测。两类表单均完成“继续分析 → 加入草稿 → 发送 → 模型反馈”，
保留原草稿；后续新表单保留已确认的四项默认值。重启原生历史、切换会话旧建议失效、
测算卡片明暗切换亦有实际记录，详见[验收结果](interactive-answers-acceptance.md)。

- 继续补齐真实模型表格、分步说明与普通问题不调用组件；补测首次可见耗时与生成稳定性。
  自然请求仍出现自由 HTML 布局不佳、额外说明或不存在的操作提示，不能认定视觉质量稳定通过。
- Windows 完整应用仍需覆盖其余组件主题、窄窗口、工作区侧聊、拆出/收回、只读及编辑转录状态，
  附件与断线；最终安装包与物理多显示器/DPI 单独记录。

## 不实施的方案

- 不复制 Hermes 隐藏发送，不用 Renderer 过滤普通用户消息伪装原生隐藏记录。
- 不通过项目文件标记授予原生文档权限，不监听/覆盖 native canvas 文件制造更新。
- 不给 inline iframe dashboard grants、MCP/tools/resource 执行权限。
- 不建立产品侧 HTML/transcript 缓存，不把未确认输入写入 KV 或 Redux。
- 不承诺持续记忆或原位更新；这些能力等待明确、已验证的原生授权和版本合约。

## 完成条件

- 自动化和真实模型场景均有独立结果；合成模型不能替代质量验收。
- 表格、方案比较、图表、表单、自定义 HTML 各有真实渲染截图与操作记录，
  逐项核对冗余文字、重复标题、主要动作数量与点击数；视觉和操作验收未通过不算完成。
- Windows 实际应用核对主聊天/独立工作区、明暗主题与窄窗口；安装包另行验收。
- 同步更新交互式回答和聊天渲染文档，移除本计划中已完成的条目。
- 全部变更位于应用 viewer、按需指导、文案或验证脚本；runtime patch 和运行时产物
  无新增修改。当前证据不代表剩余真实模型和安装包验收已经完成。
