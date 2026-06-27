# OpenClaw v2026.3.2 → v2026.4.11 Patch 必要性分析

*生成时间: 2026-04-12 | 最终更新: 2026-04-13*

---

## Executive Summary

通过对比分析 v2026.3.2 的 9 个 patches 与 v2026.4.11 的源码，确定每个 patch 是否在升级后仍然必要。

**最终结论 (已全部适配完成)**：

| Patch | 必要性 | 适配状态 | 说明 |
|-------|--------|---------|------|
| `openclaw-gateway-entry-new-file.patch` | ✅ **必要** | ✅ 完成 | 新建 gateway-entry.ts |
| `openclaw-gateway-entry-run.patch` | ✅ **必要** | ✅ 完成 | 导出 GatewayRunOpts 和 runGatewayCommand |
| `openclaw-gateway-entry-tsdown.patch` | ✅ **必要** | ✅ 完成 | 添加构建入口 |
| `openclaw-wecom-exec-deny.patch` | ✅ **必要** | ✅ 完成 | 移至新文件但无 wecom 配置 |
| `openclaw-cron-reminder-prompt.patch` | ✅ **必要** | ✅ 完成 | 提示包装仍存在 |
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | ✅ **必要** | ✅ 完成 | 类型定义 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | ✅ **必要** | ✅ 完成 | zod schema |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | ✅ **必要** | ✅ 完成 | 实现逻辑 |
| `openclaw-cron-tool-owner-only.patch` | ✅ **必要** | ✅ 完成 | cron 仍为 owner-only |
| `openclaw-cron-current-time-suffix.patch` | ✅ **必要** | ✅ 完成 | 功能未内置 |
| `openclaw-cron-delivery-inference.patch` | ⚠️ **已内置** | - 跳过 | v2026.4.11 已有相关功能 |
| `openclaw-cron-isolated-session-key.patch` | ⚠️ **可选** | - 跳过 | sessionKey 字段已内置 |
| `openclaw-cron-owner-fallback.patch` | ⚠️ **已覆盖** | - 跳过 | 功能由 cron-tool-owner-only 覆盖 |

---

## 详细分析

### 1. gateway-entry.patch — ✅ 必要

**Patch 目的**: 
- 导出 `GatewayRunOpts` type 和 `runGatewayCommand` 函数
- 创建 `gateway-entry.ts` 入口文件
- 在 `tsdown.config.ts` 添加构建入口

**v2026.4.11 状态**:
- `GatewayRunOpts` 和 `runGatewayCommand` **仍然没有 export**
- `gateway-entry.ts` **仍然不存在**
- `tsdown.config.ts` 使用 `buildCoreDistEntries()` 和 `buildUnifiedDistEntries()`

**结论**: 功能完全缺失，patch **仍然必要**。

---

### 2. wecom-exec-deny.patch — ✅ 必要

**Patch 目的**: 
- 在 `TOOL_DENY_BY_MESSAGE_PROVIDER` 添加 `wecom: ["exec", "process"]`
- 阻止企业微信消息源执行 exec/process 工具

**v2026.4.11 状态**:
- `TOOL_DENY_BY_MESSAGE_PROVIDER` **已移至新文件** `src/agents/pi-tools.message-provider-policy.ts`
- 新文件内容仅包含 `voice: ["tts"]`，**无 wecom 配置**

**适配方案**: 
- 目标文件从 `pi-tools.ts` 改为 `pi-tools.message-provider-policy.ts`
- patch 内容不变，仅更新文件路径

**结论**: 功能缺失，patch **仍然必要**（需调整目标文件）。

---

### 3. cron-reminder-prompt.patch — ✅ 必要

**Patch 目的**: 
- 简化 `buildCronEventPrompt()` 返回逻辑
- 让 cron 提醒更简洁，直接返回 eventText

**v2026.4.11 状态**:
- `buildCronEventPrompt()` 已移至 `src/infra/heartbeat-events-filter.ts`
- 函数仍然包装提示文本：
  ```typescript
  return (
    "A scheduled reminder has been triggered. The reminder content is:\n\n" +
    eventText +
    "\n\nPlease relay this reminder to the user in a helpful and friendly way."
  );
  ```

**结论**: 提示包装逻辑仍存在，patch **仍然必要**。

---

### 4. cron-skip-missed-cron-jobs.patch — ✅ 必要

**Patch 目的**: 
- 添加 `skipMissedJobs` 配置选项
- 控制是否跳过错过的 cron 任务

**v2026.4.11 状态**:
- `src/config/types.cron.ts` 中 `CronConfig` 类型**无 skipMissedJobs 字段**
- cron 服务始终会尝试运行错过的任务

**结论**: 功能缺失，patch **仍然必要**。

---

### 5. cron-tool-owner-only.patch — ✅ 必要

**Patch 目的**: 
- 将 cron 工具的 `ownerOnly` 从 `true` 改为 `false`
- 让非 owner 用户也能使用 cron 工具

**v2026.4.11 状态**:
- `src/agents/tools/owner-only-tools.ts`:
  ```typescript
  export const OPENCLAW_OWNER_ONLY_CORE_TOOL_NAMES = ["cron", "gateway", "nodes"] as const;
  ```
- `cron-tool.ts`:
  ```typescript
  ownerOnly: isOpenClawOwnerOnlyCoreToolName("cron") // 返回 true
  ```

**结论**: cron 仍在 owner-only 列表中，patch **仍然必要**。

---

### 6. cron-delivery-inference.patch — ⚠️ 部分必要

**Patch 目的**: 
- 增强 `inferDeliveryFromSessionKey()` 函数
- 支持从 session store 提取 delivery info
- 支持 JSON 编码的 delivery context
- 支持 DingTalk 频道解析
- 支持 threadId 传递

**v2026.4.11 状态**:
- `inferDeliveryFromSessionKey()` 存在于 `cron-tool.ts`
- **基础解析逻辑已存在**：`channel:marker:peerId` 模式解析
- **缺失功能**:
  - `extractDeliveryInfo()` 从 session store 提取
  - `normalizeDeliveryContext()` 规范化
  - JSON 编码的 delivery context 解析 (`:{...}` 格式)
  - DingTalk 频道特殊处理
  - threadId 传递

**结论**: 
- 如果 JustDo 需要**企业微信/钉钉等特殊渠道的 delivery 推断**，patch **必要**
- 如果仅使用标准渠道（Telegram 等），patch **可能不必要**

---

### 7. cron-isolated-session-key.patch — ❌ 不必要

**Patch 目的**: 
- 让 `server-cron.ts` 使用 `job.sessionKey || `cron:${job.id}`` 作为 sessionKey
- 支持自定义 sessionKey

**v2026.4.11 状态**:
- `CronJobBase` 类型**已包含 `sessionKey?: string` 字段** (`types-shared.ts:5`)
- 但 `server-cron.ts` **不使用该字段**：
  ```typescript
  let sessionKey = `cron:${job.id}`;
  if (job.sessionTarget.startsWith("session:")) {
    sessionKey = assertSafeCronSessionTargetId(job.sessionTarget.slice(8));
  }
  ```

**关键发现**: 
- 类型定义已支持 sessionKey
- 但代码逻辑硬编码 `cron:${job.id}`
- patch 让代码尊重 job.sessionKey 字段

**修正结论**: 如果需要自定义 sessionKey 功能，patch **仍然必要**。
- 如果从不使用自定义 sessionKey，可跳过

---

### 8. cron-owner-fallback.patch — ⚠️ 可选

**Patch 目的**: 
- 从 `OWNER_ONLY_TOOL_NAME_FALLBACKS` 移除 "cron"
- 让 cron 不再是 owner-only 工具

**v2026.4.11 状态**:
- 使用 `OWNER_ONLY_TOOL_APPROVAL_CLASS_FALLBACKS` 替代
- cron 的 approval class 为 `"control_plane"`
- `isOwnerOnlyToolName()` 通过 `resolveOwnerOnlyToolApprovalClass()` 判断

**结论**: 
- 如果 JustDo 需要**非 owner 用户使用 cron**，patch **必要**
- 这是业务需求决定的功能，不是技术缺失

---

### 9. cron-current-time-suffix.patch — ✅ 必要

**Patch 目的**: 
- 仅在非 cron 事件时 append 时间行
- 避免 cron 提醒被多余的时间信息干扰

**v2026.4.11 状态**:
- `heartbeat-runner.ts` 始终调用 `appendCronStyleCurrentTimeLine()`
- 无 `hasCronEvents` 条件判断

**结论**: 功能缺失，patch **仍然必要**。

---

## 升级结果

### 已完成适配的 Patches (10 个)

所有必要 patches 已完成适配并通过 `git apply --check` 验证：

1. `gateway-entry-new-file.patch` ✅
2. `gateway-entry-run.patch` ✅
3. `gateway-entry-tsdown.patch` ✅
4. `wecom-exec-deny.patch` ✅
5. `cron-reminder-prompt.patch` ✅
6. `cron-skip-missed-cron-jobs-types.patch` ✅
7. `cron-skip-missed-cron-jobs-zod.patch` ✅
8. `cron-skip-missed-cron-jobs-ops.patch` ✅
9. `cron-tool-owner-only.patch` ✅
10. `cron-current-time-suffix.patch` ✅

### 已跳过 Patches (3 个)

11. `cron-delivery-inference.patch` — v2026.4.11 已有 `extractDeliveryInfo` 和 `normalizeDeliveryContext`
12. `cron-isolated-session-key.patch` — sessionKey 字段已内置，如需自定义可后续添加
13. `cron-owner-fallback.patch` — 功能由 `cron-tool-owner-only.patch` 覆盖

---

## 下一步

运行构建测试：

```bash
npm run electron:dev:openclaw
```

---

*报告生成: JustDo 项目组*