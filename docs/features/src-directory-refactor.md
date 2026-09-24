# src 目录重构：第一轮

## 分析口径

以直接文件数（包含测试）识别拥挤区域，再根据职责、调用方和进程边界决定归属。测试与实现同目录会自然增加文件数，文件多不代表必须拆分；独立入口或清晰领域只有少量文件也合理。

调整前的主要观察：

| 位置 | 直接文件数 | 判断 |
| --- | ---: | --- |
| `renderer/features/settings/components/` | 45 | 混合模型、浏览器、更新、语音等职责；专属辅助逻辑又散落在上层 |
| `renderer/features/settings/` | 23 | 模型验证、浏览器连接和更新状态与所属组件分离 |
| `renderer/features/plugins/` 下的文件类型目录 | 合计 44 | 同一能力分散在 components、services、types、slices、data，优先按能力聚合 |
| `main/cowork/` | 24 | 其中 16 个供应商配置/认证文件被启动、网络和 Gateway 配置等多个领域使用，应该独立归属 |
| `renderer/libs/openclaw-chat/model/` | 55 | 状态归约、历史协调和消息处理需要进一步依赖分析，本轮保留 |
| `shared/openclaw/` | 41 | Gateway 合约聚集，但按协议归属有合理性；不机械套用 UI 分类 |
| `renderer/features/cowork/components/preview/` | 39 | 有文件、终端和展示标签等子职责，可作为后续独立一轮 |

## 已完成的划分

第一轮迁移 125 个文件，保留源文件名称、导出符号和测试文件，仅调整目录及引用：

- 设置：63 个文件归入 `models`、`browser`、`speech`、`updates`、`integrations`、`preferences`、`runtime`、`usage`。根目录留下页面组合和跨页签保存/恢复逻辑，共 5 个文件。
- 插件：44 个文件改为按 `skills`、`mcp`、`hooks`、`extensions`、`marketplace` 聚合，跨能力 UI 放在 `shared`，页面入口放在根目录。移除原来的文件类型分层。
- 主进程：16 个供应商配置、内置模型认证及对应测试移到 `main/providers/`；`cowork/` 根目录留下 8 个会话相关文件，已批准计划继续在原领域子目录。
- 共享合约：`agents.ts` 和测试放入 `shared/agents/`，与其他按领域组织的合约一致。

引用直接指向新位置，不保留旧路径转发层。现有别名、IPC 名称、Redux 挂载、SQLite schema、运行时资源路径和构建入口保持原语义。

## 后续推进边界

下一轮可单独分析聊天显示库的 `model/`，以依赖方向区分历史协调、流事件处理和消息状态；或者梳理预览区的终端、文件预览和标签生命周期。每轮先确认模块所有者和对外调用方，再迁移，不同时混入业务行为修改。

`src/config/` 是部署预设的独立来源，`main/security/` 是主进程权限领域，`renderer/image-preview/` 是独立页面入口。这些小目录不因文件少而并入通用工具目录。设置页模型编辑与运行时模型选择也保持各自职责。

完整职责约定见 [系统架构](../architecture/02-architecture.md)。验证应覆盖 ESLint、Renderer/Electron 构建、主进程类型检查与现有测试，特别检查测试 mock 和静态源码路径是否仍指向迁移后的模块。

## 本轮验证结果

- `npm run lint`、`npm run build`、主进程 `tsc --project electron-tsconfig.json --noEmit` 和 `git diff --check` 通过。
- 对 159 个受影响的 TypeScript 文件做语法树比对，除模块路径与 import 排序外结构一致。
- 迁移领域的定向测试：54 个文件、323 个测试全部通过。
- 标准 `npm test` 在准备阶段被占用中的 `better-sqlite3.node` 阻断，无法切换 Node ABI；恢复检查确认仍可用于 Electron ABI 146。
- 使用 Electron Node 模式执行全量测试：518 个文件通过、6 个文件失败，5305 个测试通过、33 个失败、5 个跳过。随后在标准 Node 下复核这 6 个文件及相关调用方：76 个文件、730 个测试通过；其中另一个涉及原生 SQLite 的文件因 ABI 不匹配失败，该文件已在 Electron 测试中通过。

这些交叉验证覆盖了本轮遇到的失败项，但不等同于标准 `npm test` 单次全绿。释放原生模块占用后，可按仓库标准命令重新完成单一环境的全量验证；本轮未修改测试逻辑或原生依赖配置来绕过环境限制。

## 第二次扫描：单文件目录

区分“直接只有一个文件，但仍有多个子目录”和“递归后总共只有一个文件”。前者如 `renderer/theme/`、`renderer/shared/components/` 是正常的目录聚合，不应按单文件目录处理。本次发现后者共 8 处：

| 原位置 | 处理 | 依据 |
| --- | --- | --- |
| `renderer/app/constants/app.ts` | 合并为 `renderer/app/constants.ts` | 只是一个常量文件，额外的文件类型目录没有提供领域边界 |
| `renderer/theme/scripts/generate-css.ts` | 移到 `scripts/theme/generate-css.ts` | 使用 Node 文件写入，属于离线构建工具；显式保持 CSS 输出位置 |
| `renderer/theme/tailwind/plugin.cjs` | 移到 `scripts/theme/plugin.cjs` | 属于构建配置，与主题生成工具放在一起；更新 Tailwind 引用 |
| `main/types/opencc-js-t2cn.d.ts` | 保留 | 主进程编译环境的第三方模块声明，不混入运行时代码或 Shared |
| `renderer/types/electron.d.ts` | 保留 | Renderer 专属 preload/window 类型声明，不属于跨进程纯合约 |
| `renderer/store/index.ts` | 保留 | Redux 全局组合入口，与各 feature 的 slice 所有权不同，已有统一 `@/store` 引用 |
| `renderer/features/memory/MemoryView.tsx` | 保留 | 独立记忆功能，与其他 features 保持同级，文件数量不能否定领域边界 |
| `shared/integrations/multica.ts` | 保留 | 跨 Main/Renderer 的外部集成合约，对应已有主进程集成领域 |

本次合并 3 个单文件目录，剩余 5 个均有明确边界。没有为增加文件数而拆分实现，也没有将不同进程的声明文件合并。

验证包括：常量调用方的 19 项测试通过；主题生成脚本经 esbuild 打包执行验证，输出路径与 CSS token 正确（拦截文件写入以保留现有生成文件）；Tailwind 插件可加载。目录调整不修改主题内容或业务行为。
