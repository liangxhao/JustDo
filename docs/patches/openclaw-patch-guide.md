# OpenClaw Runtime Patch 文档

**Last Updated:** 2026-07-01
**OpenClaw Version:** v2026.6.9
**JustDo Version:** v2026.7.1

## 1. 概述

JustDo 作为 OpenClaw Gateway 的桌面前端，通过 patch 机制对 OpenClaw Runtime 进行最小化兼容适配。Patch 是临时性的兼容层，**不是长期 fork**，始终保持小而可审计、可移除。

### Patch 执行流程

```
npm run openclaw:runtime:host
  └── scripts/patch-openclaw-runtime.cjs
        ├── 读取 package.json → openclaw.version (v2026.6.9)
        ├── 加载 scripts/patches/v2026.6.9/*.cjs
        ├── 按文件名排序依次执行 applyPatch(runtimeDir)
        └── 记录结果并输出 patched 文件列表
```

### 目录结构

```
scripts/
├── patches/
│   ├── README.md                         # Patch 编写规范
│   └── v2026.6.9/                        # 按 OpenClaw 版本组织
│       ├── 001-thinking-stream.cjs       # Reasoning stream 无条件发送
│       ├── 002-session-write-lock-self-timeout.cjs  # 会话写锁自恢复
│       ├── 003-agent-announce-reasoning-stream.cjs  # Subagent announce reasoning
│       ├── 004-openai-content-reasoning-tags.cjs    # OpenAI reasoning 标签
│       ├── 005-subagent-registry-runtime-import.cjs # Subagent registry 路径
│       └── 006-provider-auth-worker-import.cjs      # Worker URL 路径
└── patch-openclaw-runtime.cjs            # Patch 执行引擎
```

## 2. Patch 编写规范

每个 patch 文件必须以元数据头注释开头：

```js
// Purpose: Why this patch exists.
// Affected OpenClaw version: vYYYY.M.DD.
// Risk: What behavior can diverge from upstream.
// Remove when: The exact condition that makes this patch unnecessary.
// Upstream tracking: Issue or PR URL, or TODO with owner/date if not filed yet.
// Temporary: yes/no.
```

### 规则

- 所有 patch 必须有上述头注释
- 优先向 OpenClaw 上游提交 issue/PR，而不是在 JustDo 侧扩展 patch
- Bug-fix 和 prompt 语义类 patch 标记为 `Temporary: yes`
- Electron/Windows/打包兼容性 patch 可标记为 temporary 或 permanent，但必须有明确的移除条件
- Patch 失败必须在构建或启动日志中可见
- Patch 不得使 SQLite、tool-call id、标签或本地状态成为 Runtime 行为的第二权威来源

### 审查检查清单

- [ ] Patch 命名了目标 OpenClaw 版本
- [ ] Patch 可以回答"为什么存在"和"何时可以删除"
- [ ] Patch 不会创建与 OpenClaw Runtime 冲突的第二数据权威
- [ ] Patch 有上游修复路径或有文档记录的兼容性原因

## 3. 当前 Patches（v2026.6.9，共 6 个）

### 3.1 Thinking Stream 系列（2 个）

**001-thinking-stream.cjs** — Reasoning stream 无条件发送

- **目的**：即使调用方没有 `onReasoningStream` 回调，也保持 reasoning stream 事件发送
- **影响范围**：`gateway-bundle.mjs`、`dist/` 下所有 `.js` 文件
- **风险**：与上游 reasoning-stream gating 语义有差异
- **移除条件**：OpenClaw 暴露 thinking stream 事件不再依赖回调门控，或 JustDo 消费上游事件格式
- **临时性**：是

**003-agent-announce-reasoning-stream.cjs** — Subagent announce reasoning stream 启用

- **目的**：Subagent 的 announce 轮（completion announce）也启用 reasoning stream。上游 agent-command 路径解析了 thinkLevel 但没有将 reasoningLevel 传入 embedded PI
- **影响范围**：`gateway-bundle.mjs`、`dist/`

### 3.2 Session 稳定性（1 个）

**002-session-write-lock-self-timeout.cjs** — 会话写锁自恢复

- **目的**：当 session write lock 超时且锁属于当前进程时，通过 in-process lock registry 自动释放恢复
- **影响范围**：`gateway-bundle.mjs`、`dist/`
- **风险**：改变了上游 lock failure 的行为
- **移除条件**：OpenClaw 原支持 self-owned stale lock 的自动恢复

### 3.3 Reasoning Content 兼容（1 个）

**004-openai-content-reasoning-tags.cjs** — OpenAI content reasoning 标签保留

- **目的**：当 OpenAI 兼容 provider 在 `delta.content` 中嵌入 `<think>...</think>` reasoning 内容时，将其作为 reasoning delta 保留而非静默丢弃
- **影响范围**：`gateway-bundle.mjs`、`dist/`
- **风险**：暴露了上游 reasoningTagTextPartitioner 原本可能过滤的内容
- **移除条件**：OpenClaw 的 OpenAI completions adapter 原生转发 reasoningTagTextPartitioner "thinking" 输出

### 3.4 Bundle 路径修复（2 个）

**005-subagent-registry-runtime-import.cjs** — Subagent registry 动态导入路径

- **目的**：esbuild bundle 后 `import.meta.url` 指向 runtime 根目录的 `gateway-bundle.mjs`，但 `subagent-registry.runtime.js` 在 `dist/` 下，需要修正动态 import 路径
- **影响范围**：仅 `gateway-bundle.mjs`
- **风险**：低，仅修改 bundle 文件的路径引用
- **移除条件**：OpenClaw 改用非 import.meta.url 方式加载，或上游 bundle 已内联处理

**006-provider-auth-worker-import.cjs** — Worker URL 路径修复

- **目的**：esbuild bundle 后 Worker 文件的 `import.meta.url` fallback 路径指向不存在的根级 `*.worker.mjs`，需要修正为 `dist/agents/` 下的路径。涉及 3 个 worker：`model-provider-auth.worker`、`compaction-planning.worker`、`code-mode.worker`
- **影响范围**：仅 `gateway-bundle.mjs`
- **风险**：低，仅修改 bundle fallback 路径

## 4. Patch 版本历史

### v2026.6.9（当前）

6 个 patches，覆盖 4 个关注领域：

| 领域 | 数量 | Patches |
|------|------|---------|
| Thinking Stream | 2 | `001`, `003` |
| Session 稳定性 | 1 | `002` |
| Reasoning Content | 1 | `004` |
| Bundle 路径 | 2 | `005`, `006` |

### v2026.4.11（历史参考）

v2026.4.11 时期有 14 个 patches，后精简为 7 个，覆盖 Gateway Entry、Cron、安全合规、Windows 兼容等类别。升级至 v2026.6.9 时，绝大多数 patch 已通过上游合并或打包方式替代而移除。

## 5. 运维指南

### 升级 OpenClaw 版本时的 Patch 处理

1. 在 `package.json` 中更新 `openclaw.version`
2. 创建 `scripts/patches/<new-version>/` 目录
3. 逐个验证旧的 patch 是否仍然需要：
   - 功能已上游合入 → 删除
   - Bundle/打包方式改变导致不再需要 → 删除
   - 仍然需要 → 适配到新版本，更新头注释
4. 更新本文档
5. 用 `OPENCLAW_FORCE_INSTALL=1` 测试完整安装+patch 流程

### 添加新 Patch

1. 在 `scripts/patches/<current-version>/` 下创建新 `.cjs` 文件，按序号命名
2. 包含必需的元数据头注释
3. 导出 `applyPatch(runtimeDir, options)` 函数
4. 运行 `npm run openclaw:runtime:host` 验证 patch 生效
5. 更新本文档的 patch 列表
