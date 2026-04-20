# GucciAI 纯前端架构设计

## 1. 设计目标

GucciAI 作为 **OpenClaw Gateway 的纯前端**，不注入任何自己的上下文内容。所有 AI 推理、上下文管理、历史存储由 OpenClaw Gateway 处理，GucciAI 仅负责：

- 用户界面（UI）
- 配置管理（API keys、provider、model）
- OpenClaw Gateway 进程管理
- Skill 同步（从 GucciAI resources/skills 目录到 OpenClaw state 目录）

### 设计动机

1. **简化架构**：避免 GucciAI 和 OpenClaw 之间的上下文冲突
2. **统一管理**：历史、上下文由 OpenClaw Gateway 统一管理
3. **原生兼容**：OpenClaw 原生 channel sessions（Telegram、Discord 等）与桌面 UI 共享同一套上下文
4. **降低维护成本**：减少 GucciAI 的 prompt/policy 管理逻辑

## 2. 架构概述

```
┌─────────────────────────────────────────────────────────────┐
│                     GucciAI (前端)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   React UI  │  │ Config Sync │  │   Skill Manager     │ │
│  │  (renderer) │  │ (API/model) │  │ (sync to OpenClaw)  │ │
│  └─────────────┘  └─────────────┘  ┌─────────────────────┘ │
│                                          │                  │
└──────────────────────────────────────────│──────────────────┘
                                           │ sync skills
                                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  AI Engine  │  │  History    │  │    Skills System    │ │
│  │ (inference) │  │ (storage)   │  │  (~/.openclaw/skills│ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│  ┌─────────────┐  ┌─────────────┐                           │
│  │ Sessions    │  │ Channels    │                           │
│  │ (state)     │  │(Telegram/etc│                           │
│  └─────────────┘  └─────────────┘                           │
└─────────────────────────────────────────────────────────────┘
```

## 3. 移除的注入点

### 3.1 消息级注入

**移除前**：`buildOutboundPrompt` 会注入：
- `[GucciAI system instructions]` 包装
- `## Local Time Context` 时间上下文
- `[Context bridge from previous GucciAI conversation]` 历史迁移

**移除后**：纯透传用户原始消息

```typescript
// openclawRuntimeAdapter.ts
private async buildOutboundPrompt(
  _sessionId: string,
  prompt: string,
  _systemPrompt?: string,
  _agentId?: string,
): Promise<string> {
  // 纯透传：直接返回用户消息，不注入任何 GucciAI 上下文
  return prompt.trim();
}
```

### 3.2 AGENTS.md 注入

**移除前**：`syncAgentsMd` 会注入：
- `## System Prompt` 用户配置的 system prompt
- `## Web Search` 禁用 web_search 的 policy
- `## Command Execution & User Interaction Policy` 删除确认 policy
- `## Memory Policy` 强制 write tool 的 policy
- Scheduled Task prompt

**移除后**：只移除已存在的 GucciAI managed section，不写入任何内容

```typescript
// openclawConfigSync.ts
private syncAgentsMd(workspaceDir: string, _coworkConfig: CoworkConfig): string | undefined {
  const MARKER = '<!-- GucciAI managed: do not edit below this line -->';
  // 只移除已存在的 managed section，不注入任何内容
  // ...
}
```

### 3.3 Per-Agent Workspace 注入

**移除前**：`syncPerAgentWorkspaces` 会为每个 agent 写入：
- `SOUL.md` (system prompt)
- `IDENTITY.md` (identity)
- `AGENTS.md` (managed policies)
- `MEMORY.md` (memory directory)

**移除后**：空实现，让 OpenClaw 自己管理 agent workspace

### 3.4 Skills 配置注入

**移除前**：`openclaw.json` 中的 `skills.entries` 和 `skills.load.extraDirs` 指向 GucciAI userData/resources/skills

**移除后**：`skills.load.extraDirs` 指向 OpenClaw state 目录 (~/.openclaw/skills/)

## 4. 保留的配置同步

以下配置仍然同步到 OpenClaw（无 prompt 注入）：

| 配置项 | 说明 |
|--------|------|
| Provider API keys | 环境变量形式存储 |
| Default model | 默认模型配置 |
| Workspace path | 工作目录配置 |
| Sandbox mode | sandbox 配置 |
| Browser enabled | browser 工具配置 |
| Plugins entries | MCP bridge 等插件 |

## 5. Skill 管理架构

### 5.1 构建时处理

Skills 在 GucciAI 构建时处理，直接写入 OpenClaw runtime 内置目录：

```
GucciAI 项目
├── resources/builtin-skills.json   # 配置文件
├── skills/                          # GucciAI 内置 Skills
│   ├── create-plan/
│   ├── docx/
│   ├── web-search/
│   └── ...
└── scripts/build-openclaw-runtime.sh  # 构建脚本

         ↓ 构建时处理

OpenClaw Runtime
├── gateway.asar
├── skills/
│   ├── create-plan/    (from GucciAI)
│   ├── docx/           (from GucciAI)
│   └── ...
```

### 5.2 配置文件

`resources/builtin-skills.json`:

```json
{
  "version": 1,
  "description": "GucciAI built-in skills configuration",
  "skills": [
    { "id": "create-plan", "enabled": true },
    { "id": "docx", "enabled": true },
    { "id": "web-search", "enabled": true }
  ],
  "disableOpenClawDefaults": true
}
```

| 字段 | 说明 |
|------|------|
| `skills.id` | Skill ID（对应 `skills/` 目录下的子目录） |
| `skills.enabled` | 是否复制该 Skill |
| `disableOpenClawDefaults` | 是否删除 OpenClaw 默认 Skills |

### 5.3 构建脚本处理

在 `scripts/build-openclaw-runtime.sh` 中：

1. 加载 `resources/builtin-skills.json` 配置
2. 若 `disableOpenClawDefaults=true`：删除 runtime 的 `skills/` 目录所有内容
3. 从 GucciAI `skills/` 复制配置中指定的 Skills 到 runtime 的 `skills/`

### 5.4 运行时

运行时无需额外配置：
- Skills 已在 OpenClaw runtime 内置目录中
- OpenClaw Gateway 自动发现内置 Skills
- `openclaw.json` 无需 `skills.load.extraDirs`

## 6. 历史管理

GucciAI 不存储历史，历史完全由 OpenClaw Gateway 管理：

- Session 历史通过 Gateway API (`chat.history`) 实时获取
- UI 显示的历史来自 Gateway，而非本地存储
- Context Bridge 功能已移除（不再迁移 GucciAI 本地历史到 Gateway）

## 7. 文件变更清单

| 文件 | 变更 |
|------|------|
| `openclawRuntimeAdapter.ts` | `buildOutboundPrompt` 简化为纯透传，删除注入方法 |
| `openclawLocalTimeContextPrompt.ts` | 删除整个文件 |
| `main.ts` | `mergeCoworkSystemPrompt` 简化为纯透传 |
| `openclawConfigSync.ts` | `syncAgentsMd` 只移除 managed section，删除 policy 常量，`syncPerAgentWorkspaces` 空实现，`skills.load.extraDirs` 指向 state 目录 |
| `skillManager.ts` | 新增 `loadBuiltinSkillsConfig()`、`syncBuiltinSkillsToOpenClaw()` |
| `resources/builtin-skills.json` | 新建配置文件 |

## 8. 验证方法

### 消息透传验证

在 GucciAI 中发送消息，通过 Gateway log 确认：
- 消息内容是纯用户输入
- 不包含 `[GucciAI system instructions]` 或时间上下文

### AGENTS.md 验证

检查 OpenClaw workspace 的 AGENTS.md：
- 不包含 GucciAI managed section
- 不包含 Web Search/Exec/Memory Policy

### 配置同步验证

检查 `openclaw.json`：
- providers/model 配置正常同步
- `skills.load.extraDirs` 指向 ~/.openclaw/skills/
- `skills.entries` 不存在

### Skill 管理验证

检查 ~/.openclaw/skills/ 目录：
- 只包含配置文件中指定的 skills
- OpenClaw 默认 skills 按配置处理