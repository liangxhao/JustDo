# OpenClaw v2026.4.11 Patch 适配状态

*更新时间: 2026-04-13*

---

## 已完成适配的 Patches (13 个)

以下 patches 已成功适配并通过 `git apply --check` 验证：

### Gateway Entry 优化 (3 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-gateway-entry-new-file.patch` | `src/gateway-entry.ts` (新建) | 创建 gateway-entry.ts，跳过 Commander CLI overhead，直接用于 Electron utilityProcess |
| `openclaw-gateway-entry-run.patch` | `src/cli/gateway-cli/run.ts` | 导出 `GatewayRunOpts` 类型 和 `runGatewayCommand` 函数 |
| `openclaw-gateway-entry-tsdown.patch` | `tsdown.config.ts` | 添加 `gateway-entry` 构建入口 |

### Facade Runtime 加载修复 (1 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-facade-runtime-dist-path.patch` | `src/plugin-sdk/facade-runtime.ts` | 修改 facade 加载路径优先指向 `./dist/facade-activation-check.runtime.js`，避免 ESM 模块 require 问题 |

### Cron Job 配置 (5 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-cron-tool-owner-only.patch` | `src/agents/tools/cron-tool.ts` | 设置 `ownerOnly: false`，允许所有用户管理 cron jobs |
| `openclaw-cron-current-time-suffix.patch` | `src/infra/heartbeat-runner.ts` | 仅非 cron 事件时 append 时间行，cron 事件跳过时间 suffix |
| `openclaw-cron-reminder-prompt.patch` | `src/infra/heartbeat-events-filter.ts` | 简化 cron 提示，直接返回 raw `eventText` 而非包装消息 |
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | `src/config/types.cron.ts` | 添加 `skipMissedJobs?: boolean` 类型定义 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | `src/config/zod-schema.ts` | 添加 `skipMissedJobs` zod schema 验证 |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | `src/cron/service/ops.ts` | 实现 skip 逻辑，当配置时跳过运行 missed jobs |

### 安全配置 (4 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-wecom-exec-deny.patch` | `src/agents/pi-tools.message-provider-policy.ts` | 禁用企业微信 `exec` 和 `process` 工具，防止安全风险 |
| `openclaw-release-check-shell.patch` | `scripts/release-check.ts` | 添加 `shell: true` 选项，修复 Windows 上 `spawnSync npm ENOENT` 问题 |
| `openclaw-prepack-shell.patch` | `scripts/openclaw-prepack.ts` | 添加 `shell: true` 选项，修复 Windows 上 `spawnSync pnpm.cmd ENOENT` 问题 |

---

## GucciAI Runtime 适配修改 (非 Patch)

以下修改直接在 GucciAI 项目中实现，用于适配 v2026.4.11 的 bundled gateway 机制：

### 1. GatewayClient 模块解析修复

**文件**: `src/main/libs/openclawEngineManager.ts`

**问题**: v2026.4.11 将多个客户端模块（Slack、Gateway 等）打包成带哈希的文件名，如 `client-Bwja9dzi.js`。原逻辑按字母顺序返回第一个 `client*.js` 文件，错误选择了 Slack 的客户端而非 GatewayClient。

**修复**: 遍历所有候选文件，检查模块是否实际导出 `GatewayClient`（包括 minified 导出 `t`）。

### 2. sync-openclaw-runtime-current.cjs 简化

**文件**: `scripts/sync-openclaw-runtime-current.cjs`

**变更**: 移除了 facade 文件复制逻辑。现在 facade 文件通过 `openclaw-facade-runtime-dist-path.patch` 从 `dist/` 目录直接加载，避免了需要复制 ~1610 个依赖文件的问题。

---

## 可跳过的 Patches

以下 patches 功能已内置或不再必要：

- `openclaw-cron-delivery-inference.patch` - v2026.4.11 已有 `extractDeliveryInfo` 和 `normalizeDeliveryContext`
- `openclaw-cron-owner-fallback.patch` - 功能由 `cron-tool-owner-only.patch` 覆盖

---

## 验证结果

所有 13 个 patches 已通过 `git apply --check` 验证：

```
✓ openclaw-cron-current-time-suffix.patch
✓ openclaw-cron-reminder-prompt.patch
✓ openclaw-cron-skip-missed-cron-jobs-ops.patch
✓ openclaw-cron-skip-missed-cron-jobs-types.patch
✓ openclaw-cron-skip-missed-cron-jobs-zod.patch
✓ openclaw-cron-tool-owner-only.patch
✓ openclaw-facade-runtime-dist-path.patch
✓ openclaw-gateway-entry-new-file.patch
✓ openclaw-gateway-entry-run.patch
✓ openclaw-gateway-entry-tsdown.patch
✓ openclaw-prepack-shell.patch
✓ openclaw-release-check-shell.patch
✓ openclaw-wecom-exec-deny.patch
```

---

## Patch 文件位置

```
scripts/patches/v2026.4.11/
```

---

## 使用说明

### 应用 patches

Patches 会通过 `scripts/apply-openclaw-patches.cjs` 自动应用。

### 构建测试

完成所有修改后，运行构建测试：

```bash
npm run electron:dev:openclaw
```

---

*报告生成: GucciAI 项目组*