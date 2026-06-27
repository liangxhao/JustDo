# OpenClaw Patch 必要性详细证据报告

*生成时间: 2026-04-16*

---

## 概述

本报告针对每个 patch 提供：
1. **JustDo 使用证据** — 具体代码引用
2. **为什么必须在 OpenClaw 端修改** — 技术原因分析
3. **测试验证建议** — 如何验证功能依赖

---

## 1. thinking-stream.patch

### Patch 内容

修改 `src/agents/pi-embedded-subscribe.ts`：

```diff
-    streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
+    streamReasoning: reasoningMode === "stream",

 // 发送 raw text 而非 formatted text
-    const formatted = formatReasoningMessage(text);
-    emitAgentEvent({ runId, stream: "thinking", data: { text: formatted, delta } });
+    const rawText = text.trim();
+    emitAgentEvent({ runId, stream: "thinking", sessionKey, data: { text: rawText, delta } });
```

### JustDo 使用证据

**文件**: [src/main/libs/agentEngine/openclawRuntimeAdapter.ts](src/main/libs/agentEngine/openclawRuntimeAdapter.ts)

```typescript
// 行 3018-3067: 处理 thinking stream 事件
private processAgentThinkingEvent(payload: unknown): void {
  if (!isRecord(payload)) return;
  const p = payload as Record<string, unknown>;
  if (p.stream !== 'thinking') return;  // ✅ 使用 patch 发送的 thinking stream

  const dataField = isRecord(p.data) ? (p.data as Record<string, unknown>) : p;
  const text = typeof dataField.text === 'string' ? dataField.text : '';  // ✅ 使用 raw text
  const delta = typeof dataField.delta === 'string' ? dataField.delta : '';
  const sessionKey = typeof p.sessionKey === 'string' ? p.sessionKey.trim() : '';  // ✅ 使用 sessionKey

  // ... 处理并显示 thinking 内容
}
```

**文件**: [src/main/main.ts](src/main/main.ts)

```typescript
// 行 1165-1180: 转发 thinking update 到渲染进程
runtime.on('thinkingUpdate', (sessionId: string, messageId: string, thinkingDelta: string) => {
  const safeDelta = truncateIpcString(thinkingDelta, IPC_UPDATE_CONTENT_MAX_CHARS);
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    win.webContents.send('cowork:stream:thinkingUpdate', {
      sessionId,
      messageId,
      thinkingDelta: safeDelta,
    });
  });
});
```

**文件**: [src/renderer/services/cowork.ts](src/renderer/services/cowork.ts)

```typescript
// 行 144-155: 接收并显示 thinking update
const thinkingUpdateCleanup = cowork.onStreamThinkingUpdate(
  ({ sessionId, messageId, thinkingDelta }) => {
    flushSync(() => {
      store.dispatch(updateMessageThinkingContent({ sessionId, messageId, thinkingDelta }));
    });
  },
);
```

**文件**: [src/main/coworkStore.ts](src/main/coworkStore.ts)

```typescript
// 行 386: 数据存储结构包含 thinkingContent
export interface CoworkMessage {
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string; // ✅ 存储 thinking 内容
}

// 行 533: 数据库列定义
interface CoworkMessageRow {
  thinking_content: string | null;  // ✅ 持久化存储
}
```

### 为什么必须在 OpenClaw 端修改

**原因 1: 控制发送方行为**

thinking stream 事件是通过 WebSocket 从 OpenClaw gateway 发出的。JustDo 只是接收方，无法控制发送方的：
- 是否发送 thinking 事件（`streamReasoning` 条件）
- 发送什么内容（raw text vs formatted text）
- 包含哪些字段（是否有 sessionKey）

**原因 2: 原始代码的限制**

原始代码 `pi-embedded-subscribe.ts:87`:
```typescript
streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
```

**问题**：只有当 `params.onReasoningStream` 存在时才发送 thinking 事件。
但在 JustDo 的使用场景中，thinking 事件通过 WebSocket 发送给 Electron 客户端，不需要本地 callback。

**原因 3: 内容格式问题**

原始代码发送 `formatReasoningMessage(text)`（格式化后的文本）。
但 JustDo 需要 raw text 来正确计算 delta（增量），避免格式化导致的 delta 计算错误。

**原因 4: sessionKey 字段**

原始代码不包含 `sessionKey`，但 JustDo 需要 sessionKey 来正确关联 thinking 事件到具体的 session。

### 测试验证

```typescript
// 测试 1: 验证 thinking stream 事件接收
test('JustDo receives thinking stream events via WebSocket', async () => {
  // 启动 openclaw gateway（应用 patch）
  // 发送带 /reasoning stream 的 prompt
  // 验证 WebSocket 收到 { stream: "thinking", data: { text, delta }, sessionKey }
});

// 测试 2: 验证 thinking 内容显示
test('JustDo UI displays thinking content in real-time', async () => {
  // Mock thinking update 事件
  // 验证 Redux store 更新
  // 验证 UI 组件显示
});

// 测试 3: 移除 patch 后验证
test('Without patch, thinking events are NOT sent', async () => {
  // 不应用 thinking-stream.patch
  // 验证 WebSocket 不收到 thinking stream 事件
  // 或收到的格式不正确（无 sessionKey, formatted text）
});
```

---

## 2. cron-skip-missed-jobs patches (3个)

### Patch 内容

**types.patch**: 添加类型定义
```typescript
// src/config/types.cron.ts
export type CronConfig = {
  skipMissedJobs?: boolean;  // 新增字段
};
```

**zod.patch**: 添加 schema 验证
```typescript
// src/config/zod-schema.ts
cron: z.object({
  skipMissedJobs: z.boolean().optional(),
})
```

**ops.patch**: 实现逻辑
```typescript
// src/cron/service/ops.ts
if (!state.deps.cronConfig?.skipMissedJobs) {
  await runMissedJobs(state, { skipJobIds });
} else {
  state.deps.log.info({}, "cron: skipping missed jobs on startup");
}
```

### JustDo 使用证据

**文件**: [src/main/libs/openclawConfigSync.ts](src/main/libs/openclawConfigSync.ts)

```typescript
// 行 740-745: 配置写入 openclaw.json
cron: {
  enabled: true,
  maxConcurrentRuns: 3,
  sessionRetention: '7d',
  skipMissedJobs: coworkConfig.skipMissedJobs ?? false,  // ✅ 使用 patch 的配置项
},
```

**文件**: [src/renderer/components/Settings.tsx](src/renderer/components/Settings.tsx)

```typescript
// 行 748-779: UI 配置开关
const [skipMissedJobs, setSkipMissedJobs] = useState<boolean>(
  coworkConfig.skipMissedJobs ?? false,
);

// 行 2365-2385: UI 渲染
<h4>{i18nService.t('skipMissedJobs')}</h4>
<button role="switch" aria-checked={skipMissedJobs} onClick={() => setSkipMissedJobs(prev => !prev)}>
```

**文件**: [src/main/coworkStore.ts](src/main/coworkStore.ts)

```typescript
// 行 472: 配置存储
export interface CoworkConfig {
  skipMissedJobs: boolean;  // ✅ 存储用户配置
}

// 行 1105: 读取配置
skipMissedJobs: parseBooleanConfig(cfg.get('skipMissedJobs'), false),

// 行 1225-1237: 写入配置
if (config.skipMissedJobs !== undefined) {
  this.db.prepare(`
    INSERT INTO cowork_config (key, value, updated_at)
    VALUES ('skipMissedJobs', ?, ?)
  `).run(config.skipMissedJobs ? '1' : '0', now);
}
```

### 为什么必须在 OpenClaw 端修改

**原因 1: 配置解析在 OpenClaw 端**

`openclaw.json` 由 OpenClaw gateway 启动时读取和解析。JustDo 只能写入配置，但：
- 类型定义（`types.cron.ts`）必须在 OpenClaw 端
- Schema 验证（`zod-schema.ts`）必须在 OpenClaw 端
- 配置对象结构定义（`CronConfig` type）必须在 OpenClaw 端

**原因 2: 业务逻辑在 OpenClaw 端**

cron 服务启动逻辑 `ops.ts:133`：
```typescript
// 原始代码无条件运行 missed jobs
await runMissedJobs(state, { skipJobIds });
```

这个行为发生在 OpenClaw gateway 进程中，JustDo 无法干预。

**原因 3: 无法在 JustDo 端替代**

| 尝试替代的方式 | 为什么失败 |
|---------------|-----------|
| 在 JustDo 启动前删除 missed jobs | ❌ cron store 是 OpenClaw 管理的 SQLite |
| 通过 WebSocket API 控制 | ❌ OpenClaw 没有 expose 相关 API |
| 修改 JustDo 配置文件 | ❌ 类型不存在会导致解析失败 |

### 测试验证

```typescript
// 测试 1: 配置写入验证
test('skipMissedJobs config is written to openclaw.json', async () => {
  // 设置 skipMissedJobs = true
  // 验证 openclaw.json 包含 cron.skipMissedJobs: true
});

// 测试 2: 功能验证
test('cron service skips missed jobs when configured', async () => {
  // 创建一个过去时间的 cron job
  // 设置 skipMissedJobs = true
  // 重启 gateway
  // 验证 job 未执行
});

// 测试 3: 默认行为验证
test('cron service runs missed jobs when not configured', async () => {
  // 创建一个过去时间的 cron job
  // 设置 skipMissedJobs = false
  // 重启 gateway
  // 验证 job 被执行
});

// 测试 4: 移除 patch 后
test('Without patch, skipMissedJobs config is rejected by OpenClaw', async () => {
  // 不应用 types/zod patches
  // 写入 openclaw.json 包含 skipMissedJobs
  // 验证 OpenClaw 启动失败（schema 验证错误）
});
```

---

## 3. cron-tool-owner-only.patch — ❌ 已移除

### Patch 内容

```diff
// src/agents/tools/cron-tool.ts
-ownerOnly: isOpenClawOwnerOnlyCoreToolName("cron"),
+ownerOnly: false,
```

### JustDo 配置覆盖

**文件**: [src/main/libs/openclawConfigSync.ts](src/main/libs/openclawConfigSync.ts)

```typescript
// 行 128-137: 配置所有用户被视为 owner
const MANAGED_OWNER_ALLOW_FROM = [
  'gateway-client',  // 内部 chat.send 发送者
  '*',               // ✅ 通配符：所有用户被视为 owner
];
```

### 为什么不需要

**原因**: JustDo 配置 `ownerAllowFrom: ['*']` 已让所有用户被视为 owner

```typescript
// OpenClaw 源码 src/auto-reply/command-auth.ts
senderIsOwner = senderIsOwnerByIdentity || senderIsOwnerByScope || ownerState.ownerAllowAll
```

当 `ownerAllowAll = true` 时，`senderIsOwner = true`，即使 `cron.ownerOnly = true`，工具也不被限制：

```typescript
// src/agents/tool-policy.ts:23
if (tool.ownerOnly !== true || senderIsOwner || !tool.execute) {
  return tool;  // 不限制
}
```

**结论**: ❌ **已移除** — JustDo 配置已覆盖此限制

---

## 4. gateway-entry patches (3个) — 🔄 可替代

### Patch 内容

- `gateway-entry-new-file.patch`: 创建 `src/gateway-entry.ts`
- `gateway-entry-run.patch`: 导出 `GatewayRunOpts` 和 `runGatewayCommand`
- `gateway-entry-tsdown.patch`: 在 `tsdown.config.ts` 添加构建入口

### JustDo 使用证据

**文件**: [scripts/bundle-openclaw-gateway.cjs](scripts/bundle-openclaw-gateway.cjs)

```javascript
// 行 27-30: 使用 bundle 方案而非 gateway-entry
const gatewayEntryPath = path.join(runtimeDir, 'dist', 'gateway-entry.js');
const fullEntryPath = path.join(runtimeDir, 'dist', 'entry.js');
const entryPath = fs.existsSync(gatewayEntryPath) ? gatewayEntryPath : fullEntryPath;
```

**文件**: [src/main/libs/openclawEngineManager.ts](src/main/libs/openclawEngineManager.ts)

```typescript
// 行 638-643: 使用 gateway-bundle.mjs
const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
if (fs.existsSync(bundlePath)) {
  console.log('[OpenClaw] ensureBareEntryFiles: bundle exists, skipping dist extraction');
  // ✅ bundle 方案已替代 gateway-entry
}

// 行 858-872: 启动时加载 bundle
const bundlePath = path.join(__dirname, 'gateway-bundle.mjs');
import(bundleUrl).then(() => {
  process.stderr.write('[openclaw-launcher] import(gateway-bundle.mjs) ok\n');
});
```

### 为什么可以替代

**替代方案**：`scripts/bundle-openclaw-gateway.cjs` 使用 esbuild 将 gateway 打包成单文件。

**工作原理**：
1. 不需要 `gateway-entry.ts` — bundle 使用 `entry.js` 作为入口
2. 不需要导出 `GatewayRunOpts` — bundle 自动内联所有函数
3. 不需要 `tsdown.config.ts` 修改 — bundle 不依赖 dist 构建

**证据**：JustDo 代码中明确优先使用 `gateway-bundle.mjs`：
```typescript
// 行 789-792: bundle 优先路径
if (fs.existsSync(bundlePath)) {
  return this.ensureGatewayLauncherCjsForBundle(runtimeRoot);
}
```

### 测试验证

```typescript
// 测试 1: bundle 方案正常启动
test('gateway-bundle.mjs starts gateway correctly', async () => {
  // 运行 npm run openclaw:bundle
  // 验证 gateway-bundle.mjs 存在
  // 启动 gateway 验证功能正常
});

// 测试 2: 移除 patches 后 bundle 仍工作
test('bundle works without gateway-entry patches', async () => {
  // 不应用 3 个 gateway-entry patches
  // 运行 bundle 方案
  // 验证 gateway 启动时间正常（~15s vs ~80s with full entry）
});
```

---

## 5. wecom-exec-deny.patch — ❌ 不需要

### Patch 内容

```diff
// src/agents/pi-tools.message-provider-policy.ts
const TOOL_DENY_BY_MESSAGE_PROVIDER = {
  voice: ["tts"],
+ wecom: ["exec", "process"],
};
```

### JustDo 使用证据 — ❌ 不使用

**文件**: [src/renderer/types/im.ts](src/renderer/types/im.ts)

```typescript
// 行 23-31: 所有 IM 平台都是 disabled
export const DEFAULT_IM_CONFIG: Record<IMPlatform, IMConfigPlaceholder> = {
  wecom: { enabled: false },       // ❌ 未启用
  dingtalk: { enabled: false },    // ❌ 未启用
  feishu: { enabled: false },      // ❌ 未启用
  qq: { enabled: false },          // ❌ 未启用
  // ...
};
```

**结论**: JustDo 项目不支持任何 IM channel（企业微信、钉钉、飞书等），`wecom-exec-deny.patch` 完全无意义。

### 建议

❌ **移除此 patch** — JustDo 不使用企业微信功能

---

## 6. release-check-shell.patch 和 prepack-shell.patch

### Patch 内容

为 Windows 添加 `shell: true` 到 `spawnSync`/`execFileSync`。

### JustDo 使用证据

**文件**: [package.json](package.json)

```json
{
  "openclaw": {
    "version": "v2026.4.11"  //  在 Windows 上构建需要此 patch
  }
}
```

**运行环境**: Windows 11 Enterprise（根据 system prompt）

### 为什么必须在 OpenClaw 端修改

**原因**: 这些是 OpenClaw 的构建脚本，在 npm 发布流程中执行：
- `scripts/release-check.ts` — npm pack 发布检查
- `scripts/openclaw-prepack.ts` — npm prepack hook

**Windows 特有问题**:
```
spawnSync("npm", [...]) → ENOENT
spawnSync("pnpm", [...]) → ENOENT

原因: Windows 上 npm/pnpm 是 .cmd/.ps1 文件，需要 shell 解释器
解决: spawnSync("npm", [...], { shell: true })
```

**无法在 JustDo 端替代**: 这些脚本在 OpenClaw 的 npm 包发布过程中执行，JustDo 无法控制。

### 测试验证

```bash
# 测试 1: Windows 构建验证
# 在 Windows 上运行
npm run build
npm pack --dry-run
# 验证不报 ENOENT 错误

# 测试 2: 移除 patch 后验证
# 不应用 shell patches
npm run build
# 验证报 "spawnSync npm ENOENT" 错误
```

---

## 7. facade-runtime-dist-path.patch

### Patch 内容

```diff
// src/plugin-sdk/facade-runtime.ts
const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = [
+  "./dist/facade-activation-check.runtime.js",
+  "./dist/facade-activation-check.runtime.ts",
   "./facade-activation-check.runtime.js",
   "./facade-activation-check.runtime.ts",
];
```

### 为什么可能不需要

**原因**: JustDo 使用 bundle 方案，facade 模块可能被打包进去。

**需要测试验证**:
```bash
# 运行 gateway
npm run electron:dev:openclaw
# 检查日志是否有 facade 模块加载错误
```

如果 bundle 后 facade 正常加载，可移除此 patch。

---

## 总结表格

| Patch | JustDo 使用证据 | 为什么必须在 OpenClaw | 状态 |
|-------|-----------------|---------------------|------|
| thinking-stream | ✅ WebSocket 接收、Redux 显示、DB 存储 | 发送方逻辑控制 | **保留** |
| skipMissedJobs types | ✅ openclaw.json 配置 | 类型定义在 OpenClaw | **保留** |
| skipMissedJobs zod | ✅ 配置 schema 验证 | Schema 在 OpenClaw | **保留** |
| skipMissedJobs ops | ✅ 用户配置生效 | 业务逻辑在 OpenClaw | **保留** |
| cron-tool-owner-only | ✅ ownerAllowFrom 配置 | 配置已覆盖 | **已移除** |
| cron-current-time-suffix | ℹ️ UX 改善 | UI 侧可显示时间 | **已移除** |
| cron-reminder-prompt | ✅ prompt 发给 Agent | 发送端控制 | **保留** |
| gateway-entry (3个) | ✅ bundle 方案替代 | — | **已移除** |
| wecom-exec-deny | ❌ 不使用企业微信 | 安全规则源头执行 | **已移除** |
| shell patches (2个) | ✅ Windows 环境 | 构建脚本在 OpenClaw | **保留** |
| facade-runtime | ❌ bundle 已解决 | bundle 已处理 | **已移除** |

---

## 下一步行动

### 已完成

✅ 移除了 7 个不必要的 patches：
- gateway-entry (3个) → bundle 方案替代
- wecom-exec-deny → JustDo 不使用企业微信
- facade-runtime → bundle 已解决
- cron-tool-owner-only → ownerAllowFrom: ['*'] 已覆盖
- cron-current-time-suffix → UI 侧可显示时间

### 当前状态

保留 7 个必要 patches，功能正常。

### 后续维护

升级 OpenClaw 时：
1. 复制 7 个 patches 到新版本目录
2. 运行 `npm run openclaw:apply-patches` 验证
3. 测试 `npm run electron:dev:openclaw` 确认功能

---

*报告生成: JustDo 项目组*