# OpenClaw v2026.4.11 Patch 精简报告

*生成时间: 2026-04-16*

---

## Executive Summary

通过分析 OpenClaw v2026.4.11 源码与 JustDo 使用场景，将 patches 从 **14 个精简为 7 个**。

**精简结果**：

| 操作 | 数量 | 说明 |
|------|------|------|
| 移除 | 7 | bundle替代 / JustDo不使用 / 配置已覆盖 |
| 保留 | 7 | 业务需求 / Windows兼容 / UX改善 |

---

## 移除的 Patches 详细说明

### 1. Gateway Entry Patches (3个) — bundle替代

| Patch | 移除原因 |
|-------|---------|
| `openclaw-gateway-entry-new-file.patch` | `scripts/bundle-openclaw-gateway.cjs` 打包替代 |
| `openclaw-gateway-entry-run.patch` | bundle 自动内联函数，无需导出 |
| `openclaw-gateway-entry-tsdown.patch` | bundle 使用 `entry.js` fallback |

**替代方案代码位置**: `scripts/bundle-openclaw-gateway.cjs`

```javascript
// bundle 方案核心逻辑
const entryPath = fs.existsSync(gatewayEntryPath) 
  ? gatewayEntryPath 
  : fullEntryPath;  // fallback 到 entry.js

esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'gateway-bundle.mjs',
});
```

### 2. wecom-exec-deny.patch — 不使用企业微信

**移除原因**: JustDo 不支持任何 IM channel

```typescript
// src/renderer/types/im.ts:23-31
export const DEFAULT_IM_CONFIG = {
  wecom: { enabled: false },      // 企业微信未启用
  dingtalk: { enabled: false },   // 钉钉未启用
  feishu: { enabled: false },     // 飞书未启用
  // ... 所有 IM 平台都是 disabled
};
```

### 3. facade-runtime-dist-path.patch — bundle已解决

**移除原因**: bundle 方案将 facade 模块打包在一起，路径问题已解决。

### 4. cron-tool-owner-only.patch — 配置已覆盖

**移除原因**: JustDo 配置 `ownerAllowFrom: ['*']` 已让所有用户被视为 owner

```typescript
// src/main/libs/openclawConfigSync.ts:128-137
const MANAGED_OWNER_ALLOW_FROM = [
  'gateway-client',
  '*',  // 通配符：所有用户被视为 owner
];

// OpenClaw 源码 command-auth.ts
senderIsOwner = senderIsOwnerByIdentity || senderIsOwnerByScope || ownerState.ownerAllowAll
```

即使 `cron.ownerOnly = true`，`wrapOwnerOnlyToolExecution()` 也不会限制工具执行。

### 5. cron-current-time-suffix.patch — UI侧可处理

**移除原因**: 时间信息可在 JustDo UI 显示，不需要 Agent 引用

---

## 保留的 Patches 详细说明

### 1. Cron Patches (4个) — 必须在OpenClaw端修改

#### skipMissedJobs patches (3个)

**为什么必须在OpenClaw**:
- 类型定义 (`types.cron.ts`) 在 OpenClaw
- Schema验证 (`zod-schema.ts`) 在 OpenClaw  
- 业务逻辑 (`ops.ts`) 在 OpenClaw

**JustDo使用证据**:
```typescript
// src/main/libs/openclawConfigSync.ts:744
cron: {
  skipMissedJobs: coworkConfig.skipMissedJobs ?? false,  // ✅ 写入配置
}

// src/renderer/components/Settings.tsx:748-779
const [skipMissedJobs, setSkipMissedJobs] = useState(false);  // ✅ UI配置
```

#### reminder-prompt patch

**为什么必须在OpenClaw端**:
- Prompt 是发给 Agent 的，不是发给用户的
- Agent 回复内容不可预测，JustDo 无法从回复中智能提取核心内容
- 在发送端简化 prompt → Agent 自然生成简洁回复

### 2. thinking-stream.patch — 控制发送方行为

**为什么必须在OpenClaw**:
```typescript
// OpenClaw决定是否发送thinking事件
streamReasoning: reasoningMode === "stream" 
  && typeof params.onReasoningStream === "function"  // JustDo无法控制

// JustDo只是WebSocket接收方
runtime.on('thinkingUpdate', (sessionId, messageId, thinkingDelta) => {
  win.webContents.send('cowork:stream:thinkingUpdate', data);  // 被动接收
});
```

### 3. Shell Patches (2个) — Windows构建必须

**原因**: `npm`/`pnpm` 在 Windows 是 `.cmd` 文件，需要 `shell: true`

```typescript
// 不加shell: true会报错
spawnSync("npm", [...])  // ENOENT on Windows
spawnSync("npm", [...], { shell: true })  // 正常工作
```

---

## 升级便利性对比

| 场景 | 原方案(14 patches) | 精简方案(7 patches) |
|------|-------------------|-------------------|
| 升级到新版本 | 需适配14个patches | 需适配7个patches |
| Gateway启动优化 | 依赖OpenClaw修改 | JustDo内部bundle |
| 新版本gateway-entry冲突 | 必须重新patch | 无需patch |
| Cron权限控制 | 依赖patch | 配置已覆盖 |

---

## 后续维护建议

1. **升级时**: 先复制7个patches到新版本目录，验证应用
2. **bundle方案**: 保持 `bundle-openclaw-gateway.cjs` 与OpenClaw版本兼容
3. **测试验证**: 升级后运行 `npm run electron:dev:openclaw` 确认功能

---

*报告生成: JustDo 项目组*