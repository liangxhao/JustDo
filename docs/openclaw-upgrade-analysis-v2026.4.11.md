# OpenClaw 升级分析报告：v2026.3.2 → v2026.4.11

*生成时间: 2026-04-12 | 调研深度: 高 | 信息来源: GitHub Releases, Exa Search, 项目代码分析*

---

## Executive Summary

从 OpenClaw v2026.3.2 升级到 v2026.4.11 是一个**中等复杂度的升级**，涉及多个 Breaking Changes 和配置迁移。GucciAI 项目通过 patches 机制深度定制了 OpenClaw，这些 patches 需要在升级前重新验证和适配。

**核心风险点**：
1. **Gateway Entry Patch** - GucciAI 自定义的 gateway 启动入口可能需要重写
2. **Exec Approvals 默认行为变更** - v2026.4.1 起默认启用 sandbox，可能影响现有工具执行
3. **Config 路径迁移** - 多个配置路径从 core 迁移到 plugin-owned paths
4. **已知 Regression 修复** - v2026.4.2 的 channels 初始化问题在后续版本已修复

**推荐升级策略**：渐进式升级，先跳至 v2026.4.5（最后一个重大 breaking release），再升至 v2026.4.11。

---

## 1. GucciAI 中 OpenClaw 的集成方式

### 1.1 版本管理机制

版本通过 [package.json](package.json) 的 `openclaw.version` 字段控制：

```json
{
  "openclaw": {
    "version": "v2026.3.2",
    "repo": "https://github.com/openclaw/openclaw.git",
    "plugins": []
  }
}
```

关键脚本：
| 脚本 | 作用 |
|------|------|
| `scripts/ensure-openclaw-version.cjs` | 克隆/checkout 指定版本的 OpenClaw 源码 |
| `scripts/apply-openclaw-patches.cjs` | 应用版本特定的 patches |
| `scripts/run-build-openclaw-runtime.cjs` | 构建 OpenClaw runtime |
| `scripts/bundle-openclaw-gateway.cjs` | 使用 esbuild 打包 gateway 为单文件 |

### 1.2 构建流程链

```bash
npm run openclaw:runtime:win-x64
# 执行顺序：
# 1. openclaw:ensure     → checkout 指定版本
# 2. openclaw:patch      → 应用 patches
# 3. build runtime       → 编译 OpenClaw
# 4. sync runtime        → 复制到 vendor/openclaw-runtime/
# 5. openclaw:bundle     → 打包 gateway-bundle.mjs
# 6. openclaw:plugins    → 安装 plugins
# 7. openclaw:extensions:local → 同步本地扩展
# 8. openclaw:precompile → 预编译扩展
# 9. openclaw:prune      → 清理不需要的文件
```

### 1.3 现有 Patches 分析

位于 `scripts/patches/v2026.3.2/`，共 9 个 patch 文件：

| Patch | 目的 | 升级风险 |
|-------|------|---------|
| `openclaw-gateway-entry.patch` | 添加专用 gateway entry，跳过 CLI overhead，优化 Electron utilityProcess 启动速度 (80-100s → 15-20s) | **高** - 需要验证 `GatewayRunOpts` 和 `runGatewayCommand` API 是否变化 |
| `openclaw-cron-current-time-suffix.patch` | 修复 cron heartbeat 时间处理逻辑 | **中** - heartbeat-runner.ts 代码可能有变化 |
| `openclaw-cron-delivery-inference.patch` | Cron delivery 推断逻辑 | **中** |
| `openclaw-cron-isolated-session-key.patch` | Cron isolated session key 处理 | **中** |
| `openclaw-cron-owner-fallback.patch` | Cron owner fallback 逻辑 | **中** |
| `openclaw-cron-reminder-prompt.patch` | Cron reminder prompt | **中** |
| `openclaw-cron-skip-missed-cron-jobs.patch` | 跳过遗漏的 cron jobs | **中** |
| `openclaw-cron-tool-owner-only.patch` | Cron tool owner only 约束 | **中** |
| `openclaw-wecom-exec-deny.patch` | Wecom exec deny 处理 | **低** |

---

## 2. 版本差异与 Breaking Changes

### 2.1 主要版本里程碑

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| v2026.3.2 | 2026-03-03 | Secrets/SecretRef 扩展, PDF tool, Plugin HTTP registration API 变更 |
| v2026.3.22 | 2026-03-23 | Plugin SDK overhaul, security hardening, GPT-5.4 |
| v2026.3.28 | 2026-03-28 | xAI x_search, MiniMax, plugins/hooks breaking |
| v2026.4.1 | 2026-04-01 | `/tasks` 命令, SearXNG provider, exec approvals 变更 |
| v2026.4.2 | 2026-04-02 | **Breaking**: x_search/web_fetch config 迁移, Task Flow 恢复 |
| v2026.4.5 | 2026-04-06 | **Breaking**: legacy config aliases 移除, video_generate/music_generate tools |
| v2026.4.9 | 2026-04-09 | Memory/dreaming 改进, **Breaking**: config aliases 移除 |
| v2026.4.10 | 2026-04-11 | Codex provider, Active Memory plugin |
| v2026.4.11 | 2026-04-12 | Dreaming/memory-wiki, Control UI webchat 改进, plugin setup descriptors |

### 2.2 关键 Breaking Changes 详细分析

#### 2.2.1 v2026.4.5 - Legacy Config Aliases 移除

**影响**: 移除以下旧配置路径别名：
- `talk.voiceId` / `talk.apiKey` → 使用 `plugins.entries.*`
- `agents.*.sandbox.perSession` → 使用 canonical paths
- `browser.ssrfPolicy.allowPrivateNetwork`
- `hooks.internal.handlers`
- channel/group/room `allow` toggles → 使用 `enabled`

**迁移**: 
- 使用 `openclaw doctor --fix` 自动迁移
- 加载时保持兼容性（load-time compatibility）

**对 GucciAI 影响**: 低 - GucciAI 通过 `openclawConfigSync.ts` 生成配置，需验证生成的配置是否使用旧路径。

#### 2.2.2 v2026.4.2 - Plugin-Owned Config Paths

**影响**: 
- `tools.web.x_search.*` → `plugins.entries.xai.config.xSearch.*`
- `tools.web.fetch.firecrawl.*` → `plugins.entries.firecrawl.config.webFetch.*`

**对 GucciAI 影响**: 低 - GucciAI 未使用 x_search 或 firecrawl。

#### 2.2.3 v2026.4.1/v2026.3.31 - Exec Approvals 变更

**影响**: 
- Sandbox 默认启用 (`agents.defaults.sandbox.mode = "all"`)
- `exec-approvals.json` 安全默认变更
- `security: "none"` 不再有效 → fallback 到 `deny`
- 所有 existing setups 的 exec 可能被阻断

**解决方案**: 
```json
// ~/.openclaw/exec-approvals.json
{
  "defaults": { "ask": "off", "security": "full" }
}
```
或在 openclaw.json:
```json
"tools": {
  "exec": {
    "security": "full",
    "ask": "off"
  }
}
```

**对 GucciAI 影响**: **高** - 需要在 `openclawConfigSync.ts` 中添加 exec approvals 配置。

#### 2.2.4 v2026.3.2 - Plugin HTTP Registration API (当前版本已应用)

**影响**: `api.registerHttpHandler(...)` 移除 → 使用 `api.registerHttpRoute({ path, auth, match, handler })`

**对 GucciAI 影响**: 已处理 - GucciAI 的 mcp-bridge 扩展已使用新的 API。

---

## 3. 已知 Regression 与修复状态

### 3.1 v2026.4.2 - Channels 初始化失败

**Issue**: [#60400](https://github.com/openclaw/openclaw/issues/60400)
- 升级后所有 channels 无法初始化
- Channels table 为空
- **状态**: Open，但在后续版本中已修复

### 3.2 v2026.4.1/v2026.3.31 - Exec 完全失效

**Issue**: [#59006](https://github.com/openclaw/openclaw/issues/59006)
- exec approvals 静默重置
- sandbox 自动启用
- **状态**: 通过配置 workaround 解决

### 3.3 v2026.3.28+ - OAuth Token 认证问题

**Issue**: [#60279](https://github.com/openclaw/openclaw/issues/60279)
- Anthropic OAuth tokens 使用错误的 header (Bearer vs x-api-key)
- **状态**: Closed (已修复)

### 3.4 v2026.3.22 - Matrix Plugin API Version Mismatch

**Issue**: [#52899](https://github.com/openclaw/openclaw/issues/52899)
- Plugin API version 报告不正确
- **状态**: Closed (已修复)

---

## 4. 升级方案

### 4.1 推荐升级路径

**方案 A：渐进式升级（推荐）**
```
v2026.3.2 → v2026.4.5 → v2026.4.11
```
优点：分阶段验证 breaking changes，降低风险

**方案 B：直接升级**
```
v2026.3.2 → v2026.4.11
```
风险较高，但节省时间

### 4.2 升级步骤

#### Phase 1: 准备工作

1. **备份现有配置和 patches**
   ```bash
   cp -r scripts/patches/v2026.3.2 scripts/patches/v2026.3.2.backup
   cp -r vendor/openclaw-runtime/win-x64 vendor/openclaw-runtime/win-x64.backup
   ```

2. **更新 package.json 版本**
   ```json
   {
     "openclaw": {
       "version": "v2026.4.11",
       "repo": "https://github.com/openclaw/openclaw.git",
       "plugins": []
     }
   }
   ```

3. **创建新 patches 目录**
   ```bash
   mkdir -p scripts/patches/v2026.4.11
   ```

#### Phase 2: Checkout 新版本

```bash
# 设置环境变量跳过自动 checkout
export OPENCLAW_SKIP_ENSURE=1

# 手动 fetch 和 checkout
cd ../openclaw
git fetch --tags origin
git checkout v2026.4.11
```

#### Phase 3: 验证并迁移 Patches

对每个 patch 执行：

1. **检查目标文件是否存在**
   ```bash
   # 示例：gateway-entry patch
   ls -la src/cli/gateway-cli/run.ts
   ls -la tsdown.config.ts
   ```

2. **检查 API 是否变化**
   - `GatewayRunOpts` type 定义
   - `runGatewayCommand` 函数签名
   - heartbeat-runner.ts 结构

3. **手动测试 patch 应用**
   ```bash
   git apply --check scripts/patches/v2026.3.2/openclaw-gateway-entry.patch
   ```

4. **根据失败信息更新 patch**

#### Phase 4: 高风险 Patch 适配指南

**gateway-entry.patch 适配**：

核心变更：
- 新增 `src/gateway-entry.ts` 文件
- 导出 `GatewayRunOpts` 和 `runGatewayCommand`

验证步骤：
```typescript
// 1. 检查 run.ts 中的 type 和 function 是否存在
// 2. 检查 tsdown.config.ts 是否需要添加 gateway-entry 编译入口
// 3. 验证 gateway-entry.ts 的导入路径是否正确
```

如果 API 变化：
```diff
// 可能需要调整的部分：
- import { normalizeEnv } from "./infra/env.js";
+ // 检查导入路径是否变化

- async function runGatewayCommand(opts: GatewayRunOpts) {
+ // 检查函数签名是否变化
```

**cron patches 适配**：

验证文件：
- `src/infra/heartbeat-runner.ts`
- 检查 `runHeartbeatOnce` 函数签名
- 检查 `appendCronStyleCurrentTimeLine` 函数位置

#### Phase 5: 构建和测试

```bash
# 构建 runtime
npm run openclaw:runtime:win-x64

# 测试 gateway 启动
node vendor/openclaw-runtime/current/gateway-bundle.mjs --help

# 测试完整应用
npm run electron:dev:openclaw
```

#### Phase 6: 配置迁移

更新 `openclawConfigSync.ts` 添加 exec approvals 默认：

```typescript
// 在生成的配置中添加：
const execApprovalsConfig = {
  defaults: {
    ask: 'off',
    security: 'full',
  },
};
```

---

## 5. 新版本主要新特性

### 5.1 功能增强

| 特性 | 版本 | 描述 |
|------|------|------|
| Active Memory Plugin | v2026.4.10 | 自动记忆子代理，无需手动 "remember this" |
| Codex Provider | v2026.4.10 | `codex/gpt-*` 使用 Codex-managed auth |
| video_generate tool | v2026.4.5 | 内置视频生成工具 |
| music_generate tool | v2026.4.5 | 内置音乐生成工具 |
| `/tasks` 命令 | v2026.4.1 | Chat-native 后台任务面板 |
| SearXNG Provider | v2026.4.1 | 自托管 web search |
| Task Flow | v2026.4.2 | 后台编排持久化 |
| Dreaming/memory-wiki | v2026.4.11 | ChatGPT import, Memory Palace |
| Plugin Setup Descriptors | v2026.4.11 | 插件安装流程描述 |

### 5.2 Provider 更新

- GPT-5.4 / GPT-5.4-pro (v2026.3.13+)
- Claude Opus 4.6 / Sonnet 4.6
- Gemini 2.5 Pro
- Qwen, Fireworks AI, StepFun providers (v2026.4.5)
- MiniMax TTS/Search integrations

---

## 6. 关键行动清单

### 6.1 已完成 ✅

- [x] 1. 备份现有 patches 和 runtime
- [x] 2. 更新 package.json 版本号 → `v2026.4.11`
- [x] 3. 创建 `scripts/patches/v2026.4.11/` 目录
- [x] 4. 验证 gateway-entry.patch 与新版本兼容性 → 已适配为 3 个独立 patches
- [x] 5. 验证所有 cron patches → 已适配为 6 个 patches（3 个跳过）

### 6.2 待完成

- [ ] 6. 构建并测试新 runtime
- [ ] 7. 测试完整的 electron:dev:openclaw 流程

### 6.3 可选优化

- [ ] 考虑使用 Active Memory Plugin
- [ ] 评估 Codex provider 是否适合工作流
- [ ] 测试 video_generate / music_generate 工具

---

## 7. 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| gateway-entry patch 不兼容 | 高 | 手动比对 API，逐行更新 patch |
| exec approvals 阻断工具执行 | 高 | 在配置生成中添加 defaults |
| cron patches 失效 | 中 | 验证 heartbeat-runner.ts 结构 |
| 新 regression | 低 | 在 v2026.4.11 已修复大部分已知问题 |
| 构建失败 | 中 | 回退至备份版本 |

---

## 8. Sources

1. [OpenClaw v2026.4.11 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.11)
2. [OpenClaw v2026.4.5 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.5)
3. [OpenClaw v2026.3.2 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.3.2)
4. [Issue #60400 - Channels init failure](https://github.com/openclaw/openclaw/issues/60400)
5. [Issue #59006 - Exec broken](https://github.com/openclaw/openclaw/issues/59006)
6. [Issue #60279 - OAuth token auth](https://github.com/openclaw/openclaw/issues/60279)
7. [OpenClaw Updates - openclaw.com.au](https://openclaw.com.au/updates)
8. [OpenClaw Releases - openclaw-hub.com](https://openclaw-hub.com/releases/)
9. [ClawCloud - 2026.3.2 Breaking Changes Checklist](https://www.clawcloud.sh/guides/openclaw-3-2-breaking-changes)

---

## Methodology

调研方法：
- GitHub Releases 搜索：15+ 版本详情
- Exa Web Search：8 次搜索，获取 changelog、issue、migration guides
- 项目代码分析：package.json、scripts、patches、adapter 代码
- 总计分析源：20+ 个

Sub-questions investigated:
1. OpenClaw v2026.3.2 → v2026.4.11 之间有哪些 breaking changes？
2. GucciAI 如何集成和管理 OpenClaw 版本？
3. 现有 patches 在新版本中是否兼容？
4. 已知的 regression 和修复状态？
5. 升级需要哪些具体步骤？