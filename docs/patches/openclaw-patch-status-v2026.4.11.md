# OpenClaw v2026.4.11 Patch 状态 (精简版)

*更新时间: 2026-04-16*

---

## 当前保留的 Patches (7 个)

以下 patches 已精简，移除了不必要的修改：

### Cron Job 配置 (4 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-cron-reminder-prompt.patch` | `src/infra/heartbeat-events-filter.ts` | 简化 cron 提示，直接返回 raw `eventText` |
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | `src/config/types.cron.ts` | 添加 `skipMissedJobs?: boolean` 类型定义 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | `src/config/zod-schema.ts` | 添加 `skipMissedJobs` zod schema 验证 |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | `src/cron/service/ops.ts` | 实现 skip 逻辑，当配置时跳过运行 missed jobs |

### Thinking Stream (1 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-thinking-stream.patch` | `src/agents/pi-embedded-subscribe.ts` | 修改 thinking stream 发送逻辑：无条件发送 raw text + sessionKey |

### Windows 兼容性 (2 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-release-check-shell.patch` | `scripts/release-check.ts` | 添加 `shell: true` 选项，修复 Windows `spawnSync npm ENOENT` |
| `openclaw-prepack-shell.patch` | `scripts/openclaw-prepack.ts` | 添加 `shell: true` 选项，修复 Windows `spawnSync pnpm ENOENT` |

---

## 已移除的 Patches (7 个)

以下 patches 已移除，原因如下：

| Patch | 移除原因 |
|-------|---------|
| `openclaw-gateway-entry-new-file.patch` | 替代方案：`scripts/bundle-openclaw-gateway.cjs` 打包 |
| `openclaw-gateway-entry-run.patch` | bundle 方案自动内联，不需要单独导出 |
| `openclaw-gateway-entry-tsdown.patch` | bundle 不依赖 dist 构建 |
| `openclaw-wecom-exec-deny.patch` | GucciAI 不支持企业微信，无意义 |
| `openclaw-facade-runtime-dist-path.patch` | bundle 方案已解决路径问题 |
| `openclaw-cron-tool-owner-only.patch` | `ownerAllowFrom: ['*']` 已让所有用户被视为 owner，patch 不生效 |
| `openclaw-cron-current-time-suffix.patch` | 时间信息可在 GucciAI UI 侧显示，不需要 Agent 引用 |

---

## 替代方案说明

### Gateway Entry 优化

原来的 3 个 gateway-entry patches 被 `scripts/bundle-openclaw-gateway.cjs` 替代：

**原理**：
- 使用 esbuild 将 gateway 打包成单文件 `gateway-bundle.mjs`
- 消除 ESM 模块解析开销（从 ~80s 降至 ~15s）
- 不需要修改 OpenClaw 源码

**启动流程**：
```
utilityProcess → gateway-bundle.mjs (esbuild打包) → gateway server
```

### Cron Tool 权限

`ownerAllowFrom: ['*']` 配置已让所有用户被视为 owner：

```typescript
// command-auth.ts
senderIsOwner = senderIsOwnerByIdentity || senderIsOwnerByScope || ownerState.ownerAllowAll
```

即使 `cron.ownerOnly = true`，工具也不被限制。

---

## 验证结果

保留的 7 个 patches 通过 `git apply --check` 验证：

```
✓ openclaw-cron-reminder-prompt.patch
✓ openclaw-cron-skip-missed-cron-jobs-ops.patch
✓ openclaw-cron-skip-missed-cron-jobs-types.patch
✓ openclaw-cron-skip-missed-cron-jobs-zod.patch
✓ openclaw-prepack-shell.patch
✓ openclaw-release-check-shell.patch
✓ openclaw-thinking-stream.patch
```

---

## Patch 文件位置

```
scripts/patches/v2026.4.11/
```

---

## 使用说明

### 应用 patches

```bash
npm run openclaw:apply-patches
```

Patches 会通过 `scripts/apply-openclaw-patches.cjs` 自动应用。

### 构建测试

```bash
npm run electron:dev:openclaw
```

---

## 升级 OpenClaw 的注意事项

升级到新版本时，只需：

1. 更新 `package.json` 中的 `openclaw.version`
2. 创建新的 `scripts/patches/<version>/` 目录
3. 复制或适配这 7 个 patches
4. 运行 `npm run openclaw:apply-patches` 验证

**精简后的好处**：
- Patches 从 14 个减少到 7 个
- 减少约 50% 的 patch 维护成本
- Gateway 启动优化在 GucciAI 内部实现，不依赖 OpenClaw 修改

---

*报告生成: GucciAI 项目组*