# OpenClaw v2026.4.11 Patch 适配分析报告

*生成时间: 2026-04-13 | 最终版本: v2026.4.11 适配完成*

---

## Executive Summary

通过对比 `../openclaw` (v2026.3.2 patched) 和 v2026.4.11 源码，完成了 GucciAI 10 个 patches 的适配工作。

**适配结果汇总**：

| Patch | 适配状态 | 说明 |
|-------|---------|------|
| `openclaw-gateway-entry-new-file.patch` | ✅ 完成 | 新建 gateway-entry.ts 文件 |
| `openclaw-gateway-entry-run.patch` | ✅ 完成 | 导出 GatewayRunOpts 和 runGatewayCommand |
| `openclaw-gateway-entry-tsdown.patch` | ✅ 完成 | 添加 gateway-entry 构建入口 |
| `openclaw-cron-current-time-suffix.patch` | ✅ 完成 | 仅非 cron 事件时 append 时间行 |
| `openclaw-cron-reminder-prompt.patch` | ✅ 完成 | 简化 cron 提示，返回 raw eventText |
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | ✅ 完成 | 添加 skipMissedJobs 类型定义 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | ✅ 完成 | 添加 skipMissedJobs zod schema |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | ✅ 完成 | 实现 skip missed jobs 逻辑 |
| `openclaw-cron-tool-owner-only.patch` | ✅ 完成 | ownerOnly=false，允许所有用户管理 cron |
| `openclaw-wecom-exec-deny.patch` | ✅ 完成 | 禁用企业微信 exec/process 工具 |

---

## 1. Gateway Entry 优化 (3 个 patches)

### 目标
为 Electron utilityProcess 跳过 Commander CLI overhead，直接调用 gateway 命令。

### 适配分析

**v2026.4.11 中 `GatewayRunOpts` type 定义**：
- `type GatewayRunOpts` 存在，结构相同
- `runGatewayCommand` 函数存在
- 两者仍然没有 export（需要 patch）

### 适配方案

**run.ts 导出**：
```diff
-type GatewayRunOpts = {
+export type GatewayRunOpts = {

-async function runGatewayCommand(opts: GatewayRunOpts) {
+export async function runGatewayCommand(opts: GatewayRunOpts) {
```

**tsdown.config.ts 添加入口**：
```diff
function buildCoreDistEntries(): Record<string, string> {
  return {
    index: "src/index.ts",
    entry: "src/entry.ts",
+   "gateway-entry": "src/gateway-entry.ts",
    // ...
  };
}
```

**新建 gateway-entry.ts**：
- 82 行代码
- 使用动态 import 调用 `runGatewayCommand`
- 处理 Electron utilityProcess 特殊场景

---

## 2. Cron Job 配置 (5 个 patches)

### 2.1 cron-current-time-suffix.patch

**目标文件**: `src/infra/heartbeat-runner.ts`

**适配分析**：
- v2026.4.11 引入了 `resolveHeartbeatRunPrompt()` 函数
- 返回 `{ prompt, hasExecCompletion, hasCronEvents }`
- `hasCronEvents` 变量已存在

**适配方案**：
```diff
Body: hasCronEvents ? prompt : appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
```

### 2.2 cron-reminder-prompt.patch

**目标文件**: `src/infra/heartbeat-events-filter.ts`

**适配分析**：
- `buildCronEventPrompt()` 函数结构变化
- 原有复杂的 delivery 条件判断简化为直接返回 `eventText`

**适配方案**：
```diff
-  if (!deliverToUser) {
-    return (
-      "A scheduled reminder has been triggered..."
-    );
-  }
-  return (
-    "A scheduled reminder has been triggered..."
-  );
+  return eventText;
```

### 2.3 cron-skip-missed-cron-jobs (3 个 patches)

**目标文件**：
- `src/config/types.cron.ts` - 类型定义
- `src/config/zod-schema.ts` - schema 验证
- `src/cron/service/ops.ts` - 实现逻辑

**适配方案**：

types.cron.ts：
```diff
+  skipMissedJobs?: boolean;
```

zod-schema.ts：
```diff
+  skipMissedJobs: z.boolean().optional(),
```

ops.ts：
```diff
+  if (!state.deps.cronConfig?.skipMissedJobs) {
+    await runMissedJobs(state, { ... });
+  } else {
+    state.deps.log.info({}, "cron: skipping missed jobs...");
+  }
```

### 2.4 cron-tool-owner-only.patch

**目标文件**: `src/agents/tools/cron-tool.ts`

**适配方案**：
```diff
-ownerOnly: true,
+ownerOnly: false,
```

---

## 3. 安全配置 (1 个 patch)

### wecom-exec-deny.patch

**目标文件**: `src/agents/pi-tools.message-provider-policy.ts`

**代码重构发现**：
v2026.4.11 将 `TOOL_DENY_BY_MESSAGE_PROVIDER` 移到了**新文件**

**适配方案**：
```diff
const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  voice: ["tts"],
+ wecom: ["exec", "process"],
};
```

---

## 4. 可跳过的 Patches

以下 patches 功能已内置或不再必要：

| Patch | 原因 |
|-------|------|
| `openclaw-cron-delivery-inference.patch` | v2026.4.11 已有 `extractDeliveryInfo` 和 `normalizeDeliveryContext` |
| `openclaw-cron-owner-fallback.patch` | 功能由 `cron-tool-owner-only.patch` 覆盖 |

---

## 5. 关键 API 变化总结

| API | v2026.3.2 | v2026.4.11 | 变化说明 |
|-----|-----------|------------|---------|
| `GatewayRunOpts` | 无 export | 无 export | **相同**，patch 仍需 |
| `runGatewayCommand` | 无 export | 无 export | **相同**，patch 仍需 |
| `gateway-entry.ts` | 不存在 | 不存在 | **相同**，patch 仍需 |
| `appendCronStyleCurrentTimeLine` | heartbeat-runner.ts | heartbeat-runner.ts | **相同**，位置变化 |
| `TOOL_DENY_BY_MESSAGE_PROVIDER` | pi-tools.ts | **新文件** pi-tools.message-provider-policy.ts | **重构** |
| `resolveHeartbeatRunPrompt` | 存在 | 存在 | 结构变化，返回更多字段 |

---

## 6. 验证结果

所有 patches 已通过 `git apply --check` 验证：

```bash
cd ../openclaw
git checkout -- .
for patch in ../GucciAI/scripts/patches/v2026.4.11/*.patch; do
  git apply --check "$patch"
done
# 全部通过
```

---

*报告生成: GucciAI 项目组*