# OpenClaw

> **历史参考**：本文档记录 v2026.4.11 时期的 Patch 状态。当前 OpenClaw 版本为 v2026.6.9，部分 Patch 可能已合并上游或在升级中不再需要。保留作为适配历史记录。
 v2026.4.11 Patch 状态 (精简版)

*更新时间: 2026-05-07*

---

## 当前保留的 Patches (5 个)

以下 patches 已精简：

### Runtime 兼容 (1 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-facade-runtime-static-import.patch` | 运行时 facade | 修复 facade 模块静态导入兼容 |

### Thinking Stream (1 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-thinking-stream.patch` | `src/agents/pi-embedded-subscribe.ts` | 修改 thinking stream 发送逻辑：无条件发送 raw text + sessionKey |

### Windows 兼容性 (2 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-release-check-shell.patch` | `scripts/release-check.ts` | 添加 `shell: true` 选项，修复 Windows `spawnSync npm ENOENT` |
| `openclaw-prepack-shell.patch` | `scripts/openclaw-prepack.ts` | 添加 `shell: true` 选项，修复 Windows `spawnSync pnpm ENOENT` |

### Skills 管理 (1 个)

| Patch | 文件 | 说明 |
|-------|------|------|
| `openclaw-skills-snapshot-managed-dir.patch` | skills snapshot | 支持从 GucciAI resources/skills 目录拷贝技能到运行时 |

---

## 已移除的 Patches

| Patch | 移除原因 |
|-------|---------|
| `openclaw-cron-reminder-prompt.patch` | 自定义 cron 提示词逻辑不再需要 |
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | skipMissedJobs 功能已从前端彻底移除 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | skipMissedJobs 功能已从前端彻底移除 |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | skipMissedJobs 功能已从前端彻底移除 |
| `openclaw-gateway-entry-new-file.patch` | 替代方案：`scripts/bundle-openclaw-gateway.cjs` 打包 |
| `openclaw-gateway-entry-run.patch` | bundle 方案自动内联，不需要单独导出 |
| `openclaw-gateway-entry-tsdown.patch` | bundle 不依赖 dist 构建 |
| `openclaw-wecom-exec-deny.patch` | GucciAI 不支持企业微信，无意义 |
| `openclaw-facade-runtime-dist-path.patch` | bundle 方案已解决路径问题 |
| `openclaw-cron-tool-owner-only.patch` | `ownerAllowFrom: ['*']` 已让所有用户被视为 owner |
| `openclaw-cron-current-time-suffix.patch` | 时间信息可在 GucciAI UI 侧显示，不需要 Agent 引用 |

---

## 验证结果

保留的 5 个 patches 通过 `git apply --check` 验证：

```
✓ openclaw-facade-runtime-static-import.patch
✓ openclaw-prepack-shell.patch
✓ openclaw-release-check-shell.patch
✓ openclaw-skills-snapshot-managed-dir.patch
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
3. 复制或适配这 5 个 patches
4. 运行 `npm run openclaw:apply-patches` 验证

**精简后的好处**：
- Patches 从 14 个减少到 5 个
- 移除了不必要的 cron 自定义修改，保持与 OpenClaw 原生 cron 行为一致
- 减少 patch 维护成本

---

*报告生成: GucciAI 项目组*
