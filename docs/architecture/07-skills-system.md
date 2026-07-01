# JustDo Skills 技能系统设计

## 1. 概述

Skills 是 JustDo 的扩展机制，每个 Skill 定义了一组特定场景下的工具和能力。JustDo 内置 17 个 Skill（由 OpenClaw Gateway 管理），覆盖文档生成、数据分析、网络自动化、图表生成等场景。

### 1.1 核心设计原则

| 原则 | 说明 |
|------|------|
| **Gateway 管理** | Skills 完全由 OpenClaw Gateway 管理，JustDo 不维护本地 Skill 运行时状态 |
| **构建时部署** | Skills 在 JustDo 构建时复制到 OpenClaw Runtime 内置目录，非运行时加载 |
| **RPC 操作** | UI 通过 Gateway RPC (`skills.*`) 进行安装、搜索、配置等操作 |
| **17 个内置 Skill** | 固定在构建时部署，不额外增加 |

### 1.2 17 个内置 Skill 列表

| Skill ID | 说明 | 默认启用 |
|----------|------|----------|
| `agent-browser` | 浏览器自动化 | false |
| `algorithmic-art` | 算法艺术生成 | true |
| `data-analysis` | 数据分析 | true |
| `diagram-generator` | 图表生成（Mermaid / PlantUML） | true |
| `docx` | Word 文档生成 | true |
| `healthcheck` | 系统健康检查 | true |
| `mcp-builder` | MCP Server 构建 | true |
| `multi-search-engine` | 多引擎网络搜索 | true |
| `node-connect` | Node.js 连接工具 | true |
| `ontology` | 知识本体管理 | true |
| `pdf` | PDF 处理与生成 | true |
| `playwright` | 浏览器自动化（Playwright） | true |
| `pptx` | PowerPoint 演示文稿生成 | true |
| `self-improvement` | 自我改进 | true |
| `skill-creator` | 自定义 Skill 创建 | true |
| `taskflow` | 任务流管理 | true |
| `theme-factory` | 主题工厂 | true |
| `weather` | 天气查询 | true |
| `xlsx` | Excel 表格生成 | true |

> 共 19 个 Skill 被配置，其中 18 个默认启用，`agent-browser` 默认禁用。

---

## 2. Skill 目录结构

### 2.1 构建时源目录

```
resources/skills/
├── agent-browser/           # 浏览器自动化
│   ├── SKILL.md             # Skill 定义
│   ├── IMPLEMENTATION.md    # 实现细节
│   ├── TEST.md              # 测试指南
│   ├── README.md            # 用户文档
│   ├── package.json         # 依赖
│   └── ...
├── docx/                    # Word 文档生成
│   ├── SKILL.md
│   └── ...
├── multi-search-engine/     # 多引擎搜索
│   ├── SKILL.md
│   └── ...
└── ...                      # 其余 Skill
```

### 2.2 构建目标目录

```
vendor/openclaw-runtime/{platform}-{arch}/
├── gateway.asar             # OpenClaw Gateway
├── skills/                  # 构建时复制的 Skills
│   ├── agent-browser/
│   ├── algorithmic-art/
│   ├── data-analysis/
│   ├── ...
│   └── xlsx/
└── ...
```

---

## 3. Skill 定义文档 (SKILL.md)

每个 Skill 必须包含 `SKILL.md` 文件，定义 Skill 的元信息、工具列表、使用示例。该格式由 OpenClaw Gateway 定义和解析。

```markdown
# Skill Name

## Description

简要描述 Skill 的用途和场景。

## Tools

### tool_name_1

Description: 工具用途描述
Input: 输入参数说明
Output: 输出结果说明
Security: 安全风险等级（low/medium/high）

### tool_name_2

...

## Examples

### Example 1: 基本用法

User: 用户输入示例
Agent: Agent 响应示例

## Dependencies

- package-name: 版本
- external-service: 外部服务依赖

## Security Notes

使用此 Skill 时的安全注意事项。
```

### SKILL.md 元数据格式

```yaml
name: skill-name
description: Skill description
version: 1.0.0
author: JustDo
```

---

## 4. Skill 类型分类

| 类型 | 说明 | 示例 |
|------|------|------|
| **文档生成** | Office 文档生成 | docx, xlsx, pptx, pdf |
| **图表可视化** | 图表和可视化生成 | diagram-generator, algorithmic-art |
| **网络工具** | 网络搜索和自动化 | multi-search-engine, playwright, agent-browser |
| **数据分析** | 数据处理和分析 | data-analysis |
| **系统工具** | 本地系统操作 | healthcheck |
| **知识管理** | 知识组织和本體 | ontology |
| **扩展管理** | Skill 和 MCP 扩展 | skill-creator, mcp-builder |
| **工作流** | 任务和工作流管理 | taskflow |
| **实用工具** | 其他实用功能 | weather, node-connect, theme-factory, self-improvement |

---

## 5. 构建时处理

Skills 在 JustDo 构建时处理，直接写入 OpenClaw Runtime 内置目录。

### 5.1 配置文件

**文件**: `resources/builtin-skills.json`

```json
{
  "version": 1,
  "description": "JustDo built-in skills configuration for OpenClaw runtime",
  "skills": [
    { "id": "agent-browser", "enabled": false },
    { "id": "algorithmic-art", "enabled": true },
    { "id": "data-analysis", "enabled": true },
    { "id": "diagram-generator", "enabled": true },
    { "id": "docx", "enabled": true },
    { "id": "healthcheck", "enabled": true },
    { "id": "mcp-builder", "enabled": true },
    { "id": "multi-search-engine", "enabled": true },
    { "id": "node-connect", "enabled": true },
    { "id": "ontology", "enabled": true },
    { "id": "pdf", "enabled": true },
    { "id": "playwright", "enabled": true },
    { "id": "pptx", "enabled": true },
    { "id": "self-improvement", "enabled": true },
    { "id": "skill-creator", "enabled": true },
    { "id": "taskflow", "enabled": true },
    { "id": "theme-factory", "enabled": true },
    { "id": "weather", "enabled": true },
    { "id": "xlsx", "enabled": true }
  ],
  "disableOpenClawDefaults": true
}
```

| 字段 | 说明 |
|------|------|
| `version` | 配置版本 |
| `skills` | 要复制的 Skills 列表 |
| `skills[].id` | Skill ID（对应 `resources/skills/` 目录下的子目录名） |
| `skills[].enabled` | 是否复制该 Skill |
| `disableOpenClawDefaults` | 是否删除 OpenClaw Runtime 默认 Skills |

### 5.2 构建流程

```
┌─────────────────────────────────────────────────────────────┐
│                    JustDo 项目                              │
│                                                             │
│  ┌─────────────────┐  ┌─────────────────────────────────┐  │
│  │ resources/      │  │ resources/skills/                │  │
│  │ builtin-skills. │  │ (19 个内置 Skill 源目录)        │  │
│  │ json            │  │                                 │  │
│  └─────────────────┘  └─────────────────────────────────┘  │
│           │                          │                      │
│           │  ┌───────────────────────────────────────────┐ │
│           │  │ scripts/install-openclaw-runtime.cjs     │ │
│           │  │ (via patch-openclaw-runtime.cjs)         │ │
│           └───────────────────────────────────────────────┘ │
│                              │                              │
└──────────────────────────────│──────────────────────────────┘
                               │ 构建时处理 [4/7b]
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   OpenClaw Runtime                           │
│                                                             │
│  vendor/openclaw-runtime/{platform}-{arch}/                 │
│  ├── gateway.asar                                           │
│  ├── skills/                                                │
│  │   ├── docx/          (从 resources/skills/ 复制)        │
│  │   ├── xlsx/                                              │
│  │   ├── multi-search-engine/                               │
│  │   └── ...                                                │
│  └─────────────────────────────────────────────────────────┘
```

**构建步骤**:

1. 加载 `resources/builtin-skills.json` 配置
2. 若 `disableOpenClawDefaults=true`: 删除 Runtime 的 `skills/` 目录所有内容
3. 从 JustDo `resources/skills/` 复制配置中 `enabled: true` 的 Skills 到 Runtime 的 `skills/`
4. `disableOpenClawDefaults=false` 时: 仅补充复制，不删除默认 Skills

### 5.3 运行时行为

- Skills 已在 OpenClaw Runtime 内置目录中
- OpenClaw Gateway 在启动时自动发现内置 Skills
- `openclaw.json` 无需 `skills.load.extraDirs` 配置

---

## 6. Skill 管理器 (Gateway RPC)

### 6.1 SkillRpcHandler

**文件**: `src/main/libs/agentEngine/rpc/skillRpc.ts`

JustDo 不再使用本地文件系统管理 Skills。所有 Skill 操作（安装、启用/禁用、搜索、详情）通过 Gateway RPC 完成：

```typescript
class SkillRpcHandler {
  constructor(private readonly callbacks: SkillRpcCallbacks) {}

  // 获取当前 Skills 状态（含启用状态、版本等）
  async getSkillsStatus(agentId?: string): Promise<GatewaySkillStatus>

  // 从 ClawHub 安装第三方 Skill
  async installSkill(params: SkillInstallParams): Promise<SkillRpcResult>

  // 更新 Skill 配置（启用/禁用、设置）
  async updateSkillConfig(params: SkillUpdateParams): Promise<SkillRpcResult>

  // 搜索 ClawHub 上的 Skills
  async searchClawHubSkills(query?: string, limit?: number): Promise<ClawHubSearchResult[]>

  // 获取 ClawHub Skill 详情
  async getClawHubSkillDetail(slug: string): Promise<ClawHubDetail | null>

  // 会话标题生成
  async generateTitle(userIntent: string | null, timeoutMs?: number): Promise<string>

  // 会话模型更新
  async patchSessionModel(sessionId: string, model: string, agentId?: string): Promise<{ ok: boolean; error?: string }>
}
```

### 6.2 Gateway RPC 方法映射

| SkillRpcHandler 方法 | Gateway RPC | 说明 |
|----------------------|------------|------|
| `getSkillsStatus()` | `skills.status` | 获取所有 Skill 状态信息 |
| `installSkill()` | `skills.install` | 从 ClawHub 安装新 Skill |
| `updateSkillConfig()` | `skills.update` | 更新 Skill 配置 |
| `searchClawHubSkills()` | `skills.search` | 搜索 ClawHub Skill 市场 |
| `getClawHubSkillDetail()` | `skills.detail` | 获取单个 Skill 详情 |

### 6.3 类型定义

```typescript
// Skill 从 Gateway 获取的运行时状态
interface GatewaySkillStatus {
  skills: GatewaySkillEntry[];
}

interface GatewaySkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  version?: string;
  author?: string;
}

// 安装参数
interface SkillInstallParams {
  url?: string;
  source?: 'clawhub' | 'file' | 'git';
  slug?: string;
}

// 更新参数
interface SkillUpdateParams {
  skillKey: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

// 操作结果
interface SkillRpcResult {
  ok: boolean;
  error?: string;
}

// ClawHub 搜索结果
interface ClawHubSearchResult {
  slug: string;
  name: string;
  description: string;
  author: string;
  downloads: number;
  rating: number;
}

interface ClawHubDetail {
  slug: string;
  name: string;
  description: string;
  author: string;
  version: string;
  readme: string;
  tools: string[];
}
```

---

## 7. Skills UI

使用 React 组件进行 Skill 管理的 UI 展示和交互：

| 组件 | 文件 | 职责 |
|------|------|------|
| `SkillsButton` | `src/renderer/components/skills/SkillsButton.tsx` | 触发 Skills 管理弹窗的按钮 |
| `SkillsManager` | `src/renderer/components/skills/SkillsManager.tsx` | Skills 管理主面板（启用/禁用、配置） |
| `SkillsPopover` | `src/renderer/components/skills/SkillsPopover.tsx` | Skills 快速操作弹出面板 |
| `SkillsView` | `src/renderer/components/skills/SkillsView.tsx` | Skill 详情展示视图 |
| `ActiveSkillBadge` | `src/renderer/components/skills/ActiveSkillBadge.tsx` | 当前活跃 Skill 标记 |

UI 交互流程：

1. 用户通过 `SkillsButton` 或 `SkillsPopover` 打开技能管理
2. UI 通过 IPC 调用 `skillRpcHandler.getSkillsStatus()` 获取当前 Skills 状态
3. 用户启用/禁用 Skill → `skillRpcHandler.updateSkillConfig()` → Gateway RPC `skills.update`
4. 用户安装新 Skill → `skillRpcHandler.installSkill()` → Gateway RPC `skills.install`

---

## 8. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/main/libs/agentEngine/rpc/skillRpc.ts` | Skill RPC 处理（Gateway 通信） |
| `src/main/libs/agentEngine/types.ts` | Skill 相关类型定义 |
| `resources/builtin-skills.json` | 构建时 Skills 配置清单 |
| `resources/skills/*/SKILL.md` | Skill 定义文档 |
| `scripts/install-openclaw-runtime.cjs` | 构建脚本（Skills 部署步骤） |
| `src/renderer/components/skills/SkillsButton.tsx` | Skills 触发按钮 |
| `src/renderer/components/skills/SkillsManager.tsx` | Skills 管理面板 |
| `src/renderer/components/skills/SkillsPopover.tsx` | Skills 弹出面板 |
| `src/renderer/components/skills/SkillsView.tsx` | Skill 详情视图 |
| `src/renderer/components/skills/ActiveSkillBadge.tsx` | 活跃 Skill 标记 |

---

## 9. 运行时要点

- **无本地 SkillManager 类**: 不再使用独立的 `SkillManager` 类管理 Skill 文件系统。所有操作通过 Gateway RPC
- **无 skills.config.json**: 不再使用 `resources/skills/skills.config.json`。配置通过 Gateway 内置机制管理
- **无独立构建脚本**: Skill 代码在 OpenClaw Runtime 中已预构建，无需 JustDo 单独构建
- **Gateway 权威**: Skill 启用状态由 Gateway 维护，JustDo UI 仅做展示和交互
