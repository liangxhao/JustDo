# OpenClaw Runtime Patch 操作指南

## 1. 定位

JustDo 是 OpenClaw 的桌面前端和运行时宿主，不是 OpenClaw 的长期 fork。Runtime patch 只用于当前锁定 npm 版本缺失、且无法在 JustDo Adapter/UI/config 层正确补齐的兼容能力。每个 patch 必须可审计、幂等、原子、可验证并有明确删除条件。

当前版本来自 `package.json.openclaw.version`：

```text
v2026.8.1
```

当前 patch 目录：

```text
scripts/patches/v2026.8.1/
```

该目录的 `README.md` 是能力、上游原始证据、依赖关系、测试和删除条件的唯一权威总账。本文只说明工程流程，不能维护另一份逐文件行为副本。

## 2. 当前锁定供应链

目标是未经修改的 `openclaw@2026.8.1` npm 产物。`source-lock.json` 记录精确 npm integrity 与 tarball SHA-256。运行时要求 Node `24.15.0`，项目支持范围为 `>=24.15.0 <25`。

Patch 工具拒绝：

- 未通过 pristine contracts 的源码；
- npm integrity/tarball hash 不匹配的包；
- 来源未知、部分修改或旧版本 bundle；
- 已经部分应用、但没有完整证明的 runtime；
- patch 顺序、helper、source lock 或 build recipe 改变后的陈旧 manifest。

历史 `v2026.6.9` 与 `v2026.6.11` 目录仅供追溯；已移除的 `v2026.7.1-2` 补丁由 Git 历史保存。不能从旧编号推断当前依赖，也不能复制旧 anchor 伪装成升级。

## 3. 当前十二个能力补丁

v2026.8.1 已原生承担 thinking/history/tool directory/goal/subagent queue+join/approval/compaction/context budget/task query。JustDo 只保留十二个无法在 Adapter/config/extension 层补齐的缺口：

| Patch       | 能力                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `001`       | value-bound managed Python 环境                                             |
| `002`       | Windows 通用 npm/npx MCP runner                                             |
| `003`–`004` | Chrome MCP Windows/早期 stderr 与空页面恢复                                 |
| `005`       | 最终 system-prompt-only replacements                                        |
| `006`–`007` | agent/session/parent/user-initiated 与 compaction/reviewer purpose metadata |
| `008`       | 同 app-start 内恢复、跨完整 JustDo 重启终止旧 active task                   |
| `009`       | 手动 memory reindex 一次性 no-cache                                         |
| `010`       | host 配置 OpenClaw 原生 exec approval 等待时限                              |
| `011`       | 把 trusted policy 的 reviewer-only detail 转发到原生 plugin approval        |
| `012`       | host 配置 OpenClaw 原生 plugin approval 等待时限                            |

运行进度、embedding proxy 和只读 history detail 已迁入 `justdo-runtime-bridge`，cron 默认无外发由 JustDo config 显式发送 `{mode:'none'}`，均不应重新加入 patch。若新增能力，先证明公共 plugin/Gateway API 不足，并同步总账、source lock、测试和引用。

## 4. 何时允许增加 Patch

只有以下类型通常成立：

- OpenClaw 当前版本缺少 JustDo 必需的 Gateway/API 语义；
- 平台或打包 runtime 兼容缺口只能在上游生成物处修正；
- 已证实的 upstream race 需要窄范围 guard；
- 产品短期不能等待上游发布，但已有可删除条件。

以下情况应改 JustDo，而非 patch runtime：

- Renderer 显示或 i18n bug；
- Preload/IPC/SQLite/Adapter 映射错误；
- JustDo 自己的配置生成不正确；
- 想在 Gateway 深处硬编码产品 UI policy；
- 通过另一套 session/run/task 数据库弥补设计问题。

提交 patch 前必须记录：复现、pristine 上游控制流、为什么公共 API 不足、最小修改点、安全围栏和 upstream/removal 路径。

## 5. 必需文件头

每个 `.cjs` 在前 16 行必须包含：

```js
// Capability: Independently removable user-visible behavior.
// Target: Exact pristine OpenClaw npm version and missing native behavior.
// Scope: Files, request paths, sessions and platforms affected.
// Safety: Fail-closed boundaries and native paths preserved.
// Remove when: Concrete upstream condition that makes this unnecessary.
```

`Remove when` 不能写“以后上游修复”。应指出可验证的 API/行为，例如“上游所有 context-engine recovery 入口都发布带 session id 的 start/update/end/failed 生命周期”。

## 6. Patch 模块契约

模块至少提供 `applyPatch(runtimeDir, options)` 与 `verifyPatch(runtimeDir, options)`。实现要求：

1. 原始 anchor 唯一；0 个或多个都失败；
2. 已完整 patch 时再次应用不改任何字节；
3. 混合 pristine/patched 状态失败，不尝试猜测修复；
4. 多文件能力先完成全部内存变换和验证，再写入；
5. source pass 与 bundle pass 分别验证；
6. 所有 runtime JavaScript 写入通过 `_patch-utils.js` 的 `writeIfChanged()`；
7. `verifyPatch` 对最终行为 marker/控制流做只读验证，而不是只看注释；
8. 不使用过宽 regex 只为让新上游版本“也能匹配”。

当前 patch phase 使用原子快照建立文件/内容索引，同一文件只解码一次，搜索结果按写入增量更新。绕过 `writeIfChanged` 会让索引和实际文件分叉，因此禁止直接 `fs.writeFile` 修改 runtime JS。

## 7. Pristine 验证

`verify-openclaw-pristine-contracts.cjs` 在任何写入前运行。它需要同时证明：

- npm 包确实是目标原始产物；
- 已被上游吸收并从本地删除的能力仍存在；
- 所有保留 patch 的 `verifyPatch` 在 pristine runtime 上失败；
- 每个 anchor 与预期上游控制流一致。

最后一点很重要：若 `verifyPatch` 在原始包上已经成功，说明 patch 可能已经上游化或验证过弱，应停止升级审计，而不是继续应用。

## 8. 原子应用与回滚

`scripts/patch-openclaw-runtime.cjs`：

1. 验证 runtime provenance；
2. 列出按编号排序的 patch；
3. 创建所有 JS 目标的事务快照；
4. 顺序运行 `applyPatch`；
5. 对 source 与最终 bundle 运行每个 `verifyPatch`；
6. 全部成功后才写 manifest format 2；
7. 任一 apply/verify 失败时恢复整个快照。

回滚不是“删除 marker”，而是 byte-for-byte 恢复。若回滚自身不完整，runtime 被视为不可用，必须从锁定 tarball 重建。

## 9. Manifest Format 2

`runtime-patch-manifest.json` 是打包证明，不只是 patch 文件名列表。它绑定：

- npm integrity 与 tarball hash；
- platform/architecture；
- 有序 patch 内容哈希；
- patch helper 与 source-lock 哈希；
- build recipe fingerprint；
- package/dependency lock；
- immutable runtime artifacts；
- 最终 bundle/package/companion 文件字节。

任何 patch 重排、helper 改动、bundle 重建、cache 污染或打包遗漏都会使 manifest 失效。Electron Builder 在打包前和 staged product 上再次验证；Windows 还会流式解码并验证 `win-resources.tar.zst`，仅允许设计上单独省略的 asar。

## 10. 常用命令

为当前开发平台准备 runtime：

```bash
npm run openclaw:runtime:host
```

显式平台 runtime：

```bash
npm run openclaw:runtime:win-x64
npm run openclaw:runtime:win-arm64
npm run openclaw:runtime:mac-x64
npm run openclaw:runtime:mac-arm64
npm run openclaw:runtime:linux-x64
npm run openclaw:runtime:linux-arm64
```

只验证已准备 runtime：

```bash
npm run openclaw:patches:verify
```

完整平台命令依次安装/同步 runtime、bundle Gateway、同步 plugins/resources、预编译 extensions 并 prune。不要把仅运行 patch 单元测试当作 platform runtime 已准备完成。

## 11. 变更验证

Patch 修改至少执行：

1. 对锁定 pristine runtime 的首次应用；
2. 对已 patch runtime 的第二次应用，确认零字节变化；
3. `npm run openclaw:patches:verify`；
4. 对应 `tests/openclaw/patches/v2026.8.1/` focused tests；
5. 受影响 Main Adapter/Renderer tests；
6. 真实 runtime smoke；
7. 若涉及平台兼容，至少目标平台的打包/启动 smoke；
8. `git diff --check` 和文档同步。

目标 README 的测试表是能力到 test 的权威映射。测试要同时覆盖 pristine failure、patched behavior、idempotence、source/bundle 原子性和安全负例。

## 12. OpenClaw 升级流程

升级 `package.json.openclaw.version` 时：

1. 获取新 npm tarball，记录 integrity/hash/schema/Node 要求；
2. 在完全未修改产物上复现每个旧能力缺口；
3. 标记“上游已吸收、仍缺失、语义变化、JustDo 已不需要”；
4. 先删除已吸收 patch 及只为其存在的 Adapter 兼容；
5. 新建 `scripts/patches/<new-version>/`，不要复制旧目录后逐个修到能跑；
6. 为仍缺失能力重新定位唯一 anchor、重写 pristine evidence；
7. 重新建立连续编号和依赖图；
8. 更新 source lock、build recipe、manifest 验证与 focused tests；
9. 运行全部目标平台 runtime/packaging 验证；
10. 更新目标 README、本指南及相关 feature/architecture 文档。

Generated bundle 的变量名、顺序和文本随版本变化。Anchor 改变应被视为重新审计信号，禁止把 regex 放宽到“差不多匹配”。

## 13. 删除 Patch

删除是一项完整迁移：

- 用 pristine 新版本证明上游行为等价；
- 删除当前版本 patch 或在新版本不再创建；
- 删除依赖该 patch 的事件兼容、feature flag 或测试假设；
- 更新依赖 patch 的编号/顺序；
- 添加“上游承担能力”的 pristine test；
- 重跑原故障场景，尤其是竞态、重启和负例；
- 更新 README 的 upstream disposition。

如果上游只覆盖 happy path，而缺失持久恢复、权限 fence 或错误归因，不能因为名称相似就删除。

## 14. 能力族升级重点

### Thinking/history/tasks

用 pristine contract 测试核对实时 reasoning、history display projection、tool directory、task events 与 `tasks.list/get`，不能以旧 patch 名称或 UI 表象代替上游证据。

### Subagent

核对 `maxConcurrent=1` 时多 child 均被接受、超额 child queued、父 agent 等待所有 required child、Gateway restart 后恢复，以及完整 JustDo restart 后旧 task 被 `008` 取消。

### Approvals

验证可信 ancestry、无限交互等待、run suspension、隐藏恢复、stop/failure 清理。普通 cron/native channel 的上游 timeout 必须保持。

### Compaction

验证 retained user originals、首次/重复/split compaction、90% trigger、provider overflow convergence、emergency handoff、进度 publication 和真实错误归因。至少连续压缩两次并测试 auth/timeout/no-op/abort。

### Platform/MCP

Windows `.cmd`/package runner、Chrome MCP 启动/空页恢复必须在实际 packaged runtime 验证，不能只测字符串 replacement。

## 15. 禁止事项

- 手工编辑已经安装的 runtime 作为最终修复；
- 在历史版本目录上继续叠加当前能力；
- 直接写 generated JS 绕过 patch transaction；
- 用总 marker 代替各子修改验证；
- 在 patch 中读取 SQLite/UI label 决定 Gateway 事实；
- 打印 prompt、reasoning、凭证或原生日志敏感内容；
- 为赶上游升级而接受部分 patch 状态；
- 未更新目标 README 就合并 patch 变更。

## 16. 故障处理

Patch 失败时保留完整错误中的 patch label、target file、anchor count 与 phase，但分享日志前检查敏感内容。不要在未知 runtime 上继续试探性修改。正确恢复路径是删除/隔离该构建产物，从锁定 tarball 重新安装，再用修正后的 patch pass 完整应用。

打包验证失败时区分：provenance、manifest stale、artifact hash、platform mismatch、patch verify 或 staged package omission。不要通过跳过 Electron Builder hook 生成安装包。

## 17. 文档责任

- `scripts/patches/v2026.8.1/README.md`：当前能力事实与逐 patch总账；
- 本文：通用生命周期与操作规范；
- `docs/architecture/openclaw-gateway-capability-matrix.md`：App 与 Gateway 能力边界；
- feature docs：用户可见行为与维护约束；
- `docs/patches/` 不保存旧 patch 清单副本。

任何 patch 增删、编号、职责或删除条件变化，都必须在同一变更中同步这些受影响文档。

## 18. 工具链代码地图

| 阶段                  | 实现入口                                                         | 证明内容                                          |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| Pristine contract     | `scripts/verify-openclaw-pristine-contracts.cjs`                 | provenance、上游已吸收能力、保留patch在原包未生效 |
| Patch transaction     | `scripts/patch-openclaw-runtime.cjs`                             | 顺序、快照、apply/verify、失败回滚、manifest写入  |
| Patch utilities       | `scripts/patches/v2026.8.1/_patch-utils.js`                      | 唯一anchor、write-if-changed、索引一致性          |
| Runtime install/stage | `install-openclaw-runtime.cjs`、`openclaw-runtime-staging.cjs`   | 固定source到目标platform staging                  |
| Gateway bundle        | `bundle-openclaw-gateway.cjs`、`openclaw-runtime-companions.cjs` | 固定 worker/module companion URL 并验证产物完整性 |
| Freeze                | `openclaw-runtime-freeze.cjs`                                    | 构建输入和immutable artifact指纹                  |
| Package verify        | `verify-openclaw-runtime-patches.cjs`                            | prepared/staged runtime与manifest一致             |
| Prune                 | `prune-openclaw-runtime.cjs`                                     | 删除非运行文件且保留allowlisted capability资源    |

## 19. 失败分类与恢复

| 失败                 | 含义                                 | 正确恢复                            |
| -------------------- | ------------------------------------ | ----------------------------------- |
| Provenance/hash不符  | 输入不是锁定pristine npm产物         | 丢弃构建目录，从锁定tarball重装     |
| Anchor 0/multiple    | 上游控制流变化或匹配过宽             | 重新审计源码并重写唯一anchor        |
| Verify在pristine成功 | 能力可能已上游化或验证器太弱         | 停止应用，确认upstream disposition  |
| Apply中途失败        | transaction未完成                    | 自动字节回滚；回滚异常则重建runtime |
| Idempotence改变字节  | patch检测/写入不稳定                 | 修复完整patched-state识别           |
| Manifest stale       | patch/helper/recipe/artifact发生变化 | 从合法输入完整重建，不手改manifest  |
| Staged package遗漏   | builder/prune/archive配置错误        | 修正pack pipeline并重新生成产物     |

不要通过跳过verify、删除manifest或手工补generated bundle“救活”发布目录。这会让源码、bundle和证明永久分叉。

## 20. 测试层级与不能互相替代的证据

1. `openclawPristineContracts.test.ts`：证明目标原包与缺口。
2. `openclawV202671*.test.ts`：证明单项能力、负例和补丁安全。
3. `openclawPatchUtilsIndex.test.ts`：证明索引/写入工具约束。
4. `openclawRuntimePatchManifest.test.ts`：证明manifest绑定与篡改检测。
5. Runtime staging/freeze/prune tests：证明供应链与最终文件集。
6. Main adapter/shared/Renderer tests：证明JustDo consumer理解patched wire contract。
7. Packaged runtime smoke：证明目标OS、Node、bundle、child process和真实Gateway协作。

前五层通过但consumer失败，能力仍不可用；mock consumer通过但packaged smoke失败，也不能发布。

## 21. Patch Review 模板

每个新增或重写patch的审查描述应回答：

- 用户可见故障和最小复现是什么？
- pristine目标文件、函数、控制流和唯一anchor证据是什么？
- 为什么Gateway公共RPC/event/config或JustDo adapter无法承担？
- 修改哪些source/bundle文件，跨文件写入是否原子？
- 正常、重复应用、partial state、错误输入和竞态如何处理？
- 是否改变权限、credential、prompt/history、文件/命令或外部投递边界？
- consumer如何检测/使用能力，wire contract是什么？
- upstream issue/等价能力与可删除条件是什么？
- 需要更新哪些feature、architecture、matrix、manifest和platform测试？

## 22. Patch 变更完成条件

锁定输入可验证；pristine缺口可复现；首次应用成功且二次零字节变化；任一失败全量回滚；source/bundle verify均检查真实控制流；manifest format 2更新；focused、consumer、staging/freeze/prune与目标平台smoke通过；README记录能力/关系/删除条件；release构建没有使用历史或手工修改runtime。
