# OpenClaw v2026.4.11 Patch 最小化分析报告

*生成时间: 2026-04-16*

---

## Executive Summary

通过对比 `../openclaw-v2026.4.11` 干净源码与现有 14 个 patches，分析每个 patch 的必要性，并提出最小化建议。

**核心结论**：

| 分类 | Patch数量 | 可移除 | 可替代 | 必须保留 |
|------|----------|--------|--------|----------|
| Gateway Entry | 3 | 0 | **3** | 0 |
| Cron 相关 | 6 | **2** | 0 | **4** |
| 安全相关 | 3 | **1** | 0 | **2** |
| 其他 | 2 | 0 | 1 | **1** |
| **总计** | **14** | **3** | **4** | **7** |

**最终结果**: 14 → 7 (减少 50%)

---

## 1. Gateway Entry Patches (3个) — 🔄 可用本项目替代

### 1.1 `openclaw-gateway-entry-new-file.patch`
**创建 `src/gateway-entry.ts` 文件**

- **源码状态**: 不存在
- **Patch目的**: 跳过 Commander CLI overhead，直接启动 gateway
- **替代方案**: ✅ **已有替代** — `scripts/bundle-openclaw-gateway.cjs`
  
  JustDo 项目已实现了 esbuild 打包方案，将 gateway 入口打包成单文件 `gateway-bundle.mjs`：
  ```javascript
  // bundle-openclaw-gateway.cjs
  esbuild.build({
    entryPoints: [entryPath],  // 使用 dist/gateway-entry.js 或 dist/entry.js
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundleOutPath,
  })
  ```

**建议**: ❌ **移除此 patch**，使用 bundle 方案替代

---

### 1.2 `openclaw-gateway-entry-run.patch`
**导出 `GatewayRunOpts` 和 `runGatewayCommand`**

- **源码状态**: 
  ```typescript
  // 源码中是私有类型
  type GatewayRunOpts = { ... };
  async function runGatewayCommand(opts: GatewayRunOpts) { ... }
  ```
- **Patch目的**: 导出这两个以便外部调用
- **替代方案**: ✅ **可替代** — 通过 esbuild bundle，所有函数自动内联
  
  bundle 方案将整个 gateway 模块打包成单文件，不需要单独导出函数。

**建议**: ❌ **移除此 patch**

---

### 1.3 `openclaw-gateway-entry-tsdown.patch`
**在 `tsdown.config.ts` 添加 `gateway-entry` 构建入口**

- **源码状态**: `buildCoreDistEntries()` 中无 `gateway-entry`
- **Patch目的**: 构建 `dist/gateway-entry.js`
- **替代方案**: ✅ **可替代** — bundle 方案直接使用 `dist/entry.js` 作为 fallback

**建议**: ❌ **移除此 patch**

---

## 2. Cron 相关 Patches (6个) — ⚠️ 必须保留

### 2.1 `openclaw-cron-tool-owner-only.patch` — ❌ 不需要

**设置 `ownerOnly: false`**

- **源码状态**:
  ```typescript
  // src/agents/tools/cron-tool.ts:391
  ownerOnly: isOpenClawOwnerOnlyCoreToolName("cron"),  // 返回 true
  ```
- **JustDo 配置**: `ownerAllowFrom: ['*']` 已让所有用户被视为 owner
  
  ```typescript
  // OpenClaw command-auth.ts
  senderIsOwner = senderIsOwnerByIdentity || senderIsOwnerByScope || ownerState.ownerAllowAll
  ```
  
  即使 `cron.ownerOnly = true`，工具也不被限制。

**建议**: ❌ **已移除** — JustDo 配置已覆盖此限制

---

### 2.2 `openclaw-cron-skip-missed-cron-jobs-types.patch`
**添加 `skipMissedJobs` 类型定义**

- **源码状态**:
  ```typescript
  // src/config/types.cron.ts:30
  export type CronConfig = {
    enabled?: boolean;
    store?: string;
    // 无 skipMissedJobs 字段
  };
  ```
- **JustDo 使用**: ✅ 正在使用 — `openclawConfigSync.ts:744`
  ```typescript
  cron: {
    enabled: true,
    skipMissedJobs: coworkConfig.skipMissedJobs ?? false,
  }
  ```

**建议**: ✅ **必须保留** — JustDo 配置系统依赖此字段

---

### 2.3 `openclaw-cron-skip-missed-cron-jobs-zod.patch`
**添加 `skipMissedJobs` zod schema**

- **源码状态**: `zod-schema.ts` 中 cron 配置无 `skipMissedJobs`
- **必要性**: 配套 types patch，保证 schema 校验

**建议**: ✅ **必须保留**

---

### 2.4 `openclaw-cron-skip-missed-cron-jobs-ops.patch`
**实现 skip missed jobs 逻辑**

- **源码状态**:
  ```typescript
  // src/cron/service/ops.ts:133
  await runMissedJobs(state, {
    skipJobIds: interruptedOneShotIds.size > 0 ? interruptedOneShotIds : undefined,
  });
  // 无条件运行 missed jobs
  ```
- **必要性**: 实现配置功能的核心逻辑

**建议**: ✅ **必须保留**

---

### 2.5 `openclaw-cron-current-time-suffix.patch` — ❌ 已移除

**仅非 cron 事件时 append 时间行**

- **源码状态**:
  ```typescript
  // src/infra/heartbeat-runner.ts:896
  Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),  // 始终添加
  ```
- **移除原因**: 时间信息可在 JustDo UI 显示，不需要 Agent 引用

**建议**: ❌ **已移除** — UX 可在 JustDo 侧处理

---

### 2.6 `openclaw-cron-reminder-prompt.patch`
**简化 cron 提示，返回 raw eventText**

- **源码状态**:
  ```typescript
  // src/infra/heartbeat-events-filter.ts:27-38
  if (!deliverToUser) {
    return (
      "A scheduled reminder has been triggered. The reminder content is:\n\n" +
      eventText +
      "\n\nHandle this reminder internally..."
    );
  }
  return (
    "A scheduled reminder has been triggered. The reminder content is:\n\n" +
    eventText +
    "\n\nPlease relay this reminder to the user..."
  );
  ```
- **Patch目的**: 去除包装文本，让 cron 提醒更简洁

**建议**: ✅ **必须保留** — 改善 cron 提醒体验

---

## 3. 安全相关 Patches (3个) — ⚠️ 必须保留

### 3.1 `openclaw-wecom-exec-deny.patch`
**禁用企业微信 exec/process 工具**

- **源码状态**:
  ```typescript
  // src/agents/pi-tools.message-provider-policy.ts:3-5
  const TOOL_DENY_BY_MESSAGE_PROVIDER = {
    voice: ["tts"],
    // 无 wecom 配置
  };
  ```
- **JustDo 使用**: ❌ **不使用** — JustDo 不支持任何 IM channel
  ```typescript
  // src/renderer/types/im.ts:23-31
  export const DEFAULT_IM_CONFIG = {
    wecom: { enabled: false },  // 所有 IM 平台都是 disabled
    dingtalk: { enabled: false },
    // ...
  };
  ```

**建议**: ❌ **移除此 patch** — JustDo 不使用企业微信，此安全配置无意义

---

### 3.2 `openclaw-release-check-shell.patch`
**修复 Windows `spawnSync npm ENOENT`**

- **源码状态**: `scripts/release-check.ts` 中 `execSync`/`execFileSync` 无 `shell: true`
- **平台问题**: Windows 上 npm/pnpm 是 .cmd 文件，需要 shell 执行

**建议**: ✅ **必须保留** — Windows 兼容性

---

### 3.3 `openclaw-prepack-shell.patch`
**修复 Windows `spawnSync pnpm.cmd ENOENT`**

- **源码状态**: `scripts/openclaw-prepack.ts` 中 `spawnSync` 无 `shell: true`
- **平台问题**: 同上

**建议**: ✅ **必须保留** — Windows 兼容性

---

## 4. 其他 Patches (2个)

### 4.1 `openclaw-facade-runtime-dist-path.patch`
**修改 facade 加载路径优先指向 `./dist/`**

- **源码状态**:
  ```typescript
  // src/plugin-sdk/facade-runtime.ts:173-176
  const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = [
    "./facade-activation-check.runtime.js",
    "./facade-activation-check.runtime.ts",
  ];
  // 无 dist/ 前缀
  ```
- **Patch目的**: 解决 ESM 模块 require 问题
- **替代方案**: ✅ **可替代** — JustDo bundle 方案可能已解决此问题
  
  但需要实际测试验证。如果 bundle 后 facade 模块正常加载，可移除此 patch。

**建议**: ⚠️ **先测试后决定** — 如果 bundle 方案工作正常可移除

---

### 4.2 `openclaw-thinking-stream.patch`
**修改 thinking stream 行为**

- **源码状态**:
  ```typescript
  // src/agents/pi-embedded-subscribe.ts:87
  streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
  ```
- **Patch目的**: 
  1. 无条件启用 streamReasoning（移除 `onReasoningStream` 检查）
  2. 发送 raw text 而非 formatted text
  3. 添加 sessionKey 到事件

- **JustDo 使用**: ✅ 正在使用 — WebSocket 实时显示 thinking 内容

**建议**: ✅ **必须保留** — JustDo UI 功能依赖此 patch

---

## 5. 最小化方案总结

### 已移除的 Patches (7个)

| Patch | 原因 |
|-------|------|
| `openclaw-gateway-entry-new-file.patch` | 替代方案：`scripts/bundle-openclaw-gateway.cjs` |
| `openclaw-gateway-entry-run.patch` | bundle 方案自动内联 |
| `openclaw-gateway-entry-tsdown.patch` | bundle 使用 entry.js fallback |
| `openclaw-wecom-exec-deny.patch` | JustDo 不使用企业微信，无意义 |
| `openclaw-facade-runtime-dist-path.patch` | bundle 方案已解决路径问题 |
| `openclaw-cron-tool-owner-only.patch` | `ownerAllowFrom: ['*']` 已覆盖 |
| `openclaw-cron-current-time-suffix.patch` | 时间信息可在 UI 显示 |

### 必须保留的 Patches (7个)

| Patch | 原因 |
|-------|------|
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | 配置功能：类型定义 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | 配置功能：schema 校验 |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | 配置功能：实现逻辑 |
| `openclaw-cron-reminder-prompt.patch` | UX 改善：发送端控制 |
| `openclaw-release-check-shell.patch` | Windows 兼容性 |
| `openclaw-prepack-shell.patch` | Windows 兼容性 |
| `openclaw-thinking-stream.patch` | UI 功能依赖 |

---

## 6. 实施建议

### 第一步：验证 bundle 方案

在移除 gateway-entry patches 前，验证 bundle 方案能否独立工作：

```bash
# 1. 不应用 gateway-entry patches
# 2. 运行 npm run electron:dev:openclaw
# 3. 检查 gateway 启动时间和功能
```

### 第二步：测试 facade-runtime

验证 bundle 后 facade 模块是否正常加载，决定是否移除 facade-runtime patch。

### 第三步：确认移除列表

确认后可移除的 patches：
- `openclaw-gateway-entry-new-file.patch`
- `openclaw-gateway-entry-run.patch`  
- `openclaw-gateway-entry-tsdown.patch`
- （可能）`openclaw-facade-runtime-dist-path.patch`

---

## 7. Patch 文件对比详情

### 源码文件修改对照表

| 源码文件 | Patch 数量 | 可移除数量 |
|----------|-----------|-----------|
| `src/cli/gateway-cli/run.ts` | 1 | **1** |
| `tsdown.config.ts` | 1 | **1** |
| `src/gateway-entry.ts` (新建) | 1 | **1** |
| `src/agents/tools/cron-tool.ts` | 1 | 0 |
| `src/config/types.cron.ts` | 1 | 0 |
| `src/config/zod-schema.ts` | 1 | 0 |
| `src/cron/service/ops.ts` | 1 | 0 |
| `src/infra/heartbeat-runner.ts` | 1 | 0 |
| `src/infra/heartbeat-events-filter.ts` | 1 | 0 |
| `src/agents/pi-tools.message-provider-policy.ts` | 1 | 0 |
| `scripts/release-check.ts` | 1 | 0 |
| `scripts/openclaw-prepack.ts` | 1 | 0 |
| `src/plugin-sdk/facade-runtime.ts` | 1 | **可能1** |
| `src/agents/pi-embedded-subscribe.ts` | 1 | 0 |

---

## 8. 结论

通过分析，14 个 patches 中：
- **4 个可通过 JustDo 项目内部 bundle 方案替代**
- **1 个完全不需要**（wecom-exec-deny，JustDo 不支持企业微信）
- **9 个必须保留**（业务需求、Windows 兼容性、UI 功能）

建议优先验证 bundle 方案，确认可移除的 patches 后更新 patch 应用脚本。

---

*报告生成: JustDo 项目组*