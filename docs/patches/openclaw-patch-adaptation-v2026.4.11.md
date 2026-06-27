# OpenClaw v2026.4.11 Patch 适配分析报告

*生成时间: 2026-04-13 | 最终版本: v2026.4.11 适配完成*

---

## Executive Summary

通过对比 `../openclaw` (v2026.3.2 patched) 和 v2026.4.11 源码，完成了 JustDo patches 的适配工作。

**适配结果汇总**：

| Patch | 适配状态 | 说明 |
|-------|---------|------|
| `openclaw-facade-runtime-static-import.patch` | ✅ 完成 | 修复 facade 模块静态导入兼容 |
| `openclaw-thinking-stream.patch` | ✅ 完成 | thinking stream 发送逻辑修改 |
| `openclaw-prepack-shell.patch` | ✅ 完成 | Windows spawnSync pnpm 兼容 |
| `openclaw-release-check-shell.patch` | ✅ 完成 | Windows spawnSync npm 兼容 |
| `openclaw-skills-snapshot-managed-dir.patch` | ✅ 完成 | skills 从 JustDo 目录拷贝 |

---

## 1. Runtime 兼容

### facade-runtime-static-import.patch

修复 facade 模块的静态导入兼容性问题。

---

## 2. Thinking Stream

### thinking-stream.patch

修改 thinking stream 发送逻辑，无条件发送 raw text + sessionKey。

---

## 3. Windows 兼容性

### prepack-shell.patch & release-check-shell.patch

添加 `shell: true` 选项，修复 Windows 下 `spawnSync` 无法找到 npm/pnpm 的问题。

---

## 4. Skills 管理

### skills-snapshot-managed-dir.patch

支持从 JustDo `resources/skills` 目录拷贝技能到运行时目录。

---

## 已移除的 Patches

以下 patches 已移除：

### Cron 相关 (4 个)
| Patch | 移除原因 |
|-------|---------|
| `openclaw-cron-reminder-prompt.patch` | 自定义 cron 提示词逻辑不再需要 |
| `openclaw-cron-skip-missed-cron-jobs-types.patch` | skipMissedJobs 功能已从前端彻底移除 |
| `openclaw-cron-skip-missed-cron-jobs-zod.patch` | skipMissedJobs 功能已从前端彻底移除 |
| `openclaw-cron-skip-missed-cron-jobs-ops.patch` | skipMissedJobs 功能已从前端彻底移除 |

### Gateway Entry (3 个)
| Patch | 移除原因 |
|-------|---------|
| `openclaw-gateway-entry-new-file.patch` | 替代方案：`scripts/bundle-openclaw-gateway.cjs` 打包 |
| `openclaw-gateway-entry-run.patch` | bundle 方案自动内联，不需要单独导出 |
| `openclaw-gateway-entry-tsdown.patch` | bundle 不依赖 dist 构建 |

### 其他 (4 个)
| Patch | 移除原因 |
|-------|---------|
| `openclaw-wecom-exec-deny.patch` | JustDo 不支持企业微信，无意义 |
| `openclaw-facade-runtime-dist-path.patch` | bundle 方案已解决路径问题 |
| `openclaw-cron-tool-owner-only.patch` | `ownerAllowFrom: ['*']` 已让所有用户被视为 owner |
| `openclaw-cron-current-time-suffix.patch` | 时间信息可在 JustDo UI 侧显示，不需要 Agent 引用 |

---

*报告生成: JustDo 项目组*
