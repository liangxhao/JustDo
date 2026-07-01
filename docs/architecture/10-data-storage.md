# JustDo 数据存储与 SQLite 设计

## 1. 概述

JustDo 使用本地 SQLite 数据库作为 **UI 缓存层**，文件名为 `justdo.sqlite`，位于用户数据目录。采用 better-sqlite3 作为 SQLite 库，支持高性能同步操作。

> **重要**：SQLite 是 UI 缓存，**不是**权威数据源。OpenClaw Gateway 的 `chat.history` 是消息历史的权威来源。`cowork_messages` 仅作为本地缓存存在，Gateway 是单⼀权责中心。

### 1.1 数据库定位

| 数据类别 | 权威来源 | 本地 SQLite 职责 |
|----------|----------|----------------|
| 会话消息历史 | Gateway `chat.history` API | UI 缓存，加速本地渲染 |
| 会话元数据 | JustDo 本地存储 | 会话列表、标题、状态 |
| 配置 | JustDo 本地存储 | 应用设置、Cowork 配置、API 凭据 |
| Agent 定义 | JustDo 本地存储 | 自定义 Agent 配置 |
| MCP 服务器 | JustDo 本地存储 | MCP 服务器配置 |
| 定时任务元数据 | JustDo 本地存储 | 任务来源和绑定信息 |
| 分组信息 | JustDo 本地存储 | 会话分组组织 |

### 1.2 数据库位置

| 平台 | 数据目录 |
|------|----------|
| macOS | `~/Library/Application Support/JustDo/` |
| Windows | `%APPDATA%\JustDo\` |
| Linux | `~/.config/JustDo/` |

### 1.3 数据库特性

- **单文件存储**：便于备份和迁移
- **同步操作**：better-sqlite3 提供高性能同步 API
- **WAL 模式**：启用 Write-Ahead Logging 提高并发性能
- **完整 UTF-8**：支持中文等 Unicode 字符

## 2. 数据表结构

### 2.1 kv 表（键值存储）

应用级配置存储，通用键值对：

```sql
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,          -- JSON 格式存储
  updated_at INTEGER NOT NULL
);

-- 示例数据
INSERT INTO kv (key, value, updated_at) VALUES 
  ('appConfig', '{"language":"zh","theme":"dark"}', 1712851200000),
  ('auth_tokens', '{"accessToken":"xxx","refreshToken":"yyy"}', 1712851200000),
  ('skillsConfig', '{"skills":[{"id":"web-search","enabled":true}]}', 1712851200000);
```

### 2.2 cowork_config 表

Cowork 系统配置（键值对形式）：

```sql
CREATE TABLE cowork_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,          -- JSON 格式
  updated_at INTEGER NOT NULL
);

-- 示例数据
INSERT INTO cowork_config (key, value, updated_at) VALUES
  ('workingDirectory', '"/Users/username/work"', 1712851200000),
  ('systemPrompt', '"You are a helpful assistant..."', 1712851200000),
  ('executionMode', '"auto"', 1712851200000),
  ('agentEngine', '"openclaw"', 1712851200000),
  ('modelProvider', '"anthropic"', 1712851200000),
  ('modelName', '"claude-sonnet-4-6"', 1712851200000);
```

> **注意**：`api_key` 字段不在 cowork_config 中管理。API 密钥由 Provider 配置独立管理，通过 OpenClaw Gateway 的 provider 配置系统处理。

### 2.3 cowork_sessions 表

会话元数据：

```sql
CREATE TABLE cowork_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  claude_session_id TEXT,         -- OpenClaw Gateway session key
  status TEXT NOT NULL DEFAULT 'idle',  -- 'idle' | 'running' | 'completed' | 'error' | 'stopped'
  pinned INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,               -- working directory
  execution_mode TEXT,             -- 'auto' | 'local'
  agent_id TEXT NOT NULL DEFAULT 'main',
  active_skill_ids TEXT,           -- JSON array of active skill IDs
  group_id TEXT REFERENCES session_groups(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 索引
CREATE INDEX idx_sessions_created ON cowork_sessions(created_at DESC);
CREATE INDEX idx_sessions_status ON cowork_sessions(status);
```

### 2.4 cowork_messages 表

会话消息历史（UI 缓存，**非权威来源**）：

```sql
CREATE TABLE cowork_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,              -- 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  content TEXT NOT NULL,
  thinking_content TEXT,           -- 思考/推理内容（模型 thinking 流，可选）
  metadata TEXT,                   -- JSON: { isStreaming, isThinking, toolName, toolInput, ... }
  model_name TEXT,                 -- AI model used for this message
  usage TEXT,                      -- JSON: token usage data
  created_at INTEGER NOT NULL,
  sequence INTEGER,                -- 消息顺序号

  FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
);

-- 索引
CREATE INDEX idx_cowork_messages_session_id ON cowork_messages(session_id);
```

> **权威来源说明**：消息历史的权威数据源是 Gateway 的 `chat.history` RPC 调用。`cowork_messages` 表作为本地缓存存在，用于快速 UI 渲染。当 Gateway 返回更新后的历史时，本地缓存会被替换。

### 2.5 session_groups 表

会话分组组织：

```sql
CREATE TABLE session_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

### 2.6 agents 表

自定义 Agent 配置：

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  identity TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  skill_ids TEXT NOT NULL DEFAULT '[]',  -- JSON: ["web-search", "docx", ...]
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'custom',  -- 'custom' | 'preset'
  preset_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 2.7 mcp_servers 表

MCP 服务器配置：

```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  transport_type TEXT NOT NULL DEFAULT 'stdio',
  config_json TEXT NOT NULL DEFAULT '{}',  -- JSON: command, args, env
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 2.8 scheduled_task_meta 表

定时任务元数据（本地持久化 OpenClaw cron 任务的自定义元数据）：

```sql
CREATE TABLE scheduled_task_meta (
  task_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,              -- JSON: TaskOrigin { type: 'conversation' | 'gui' | 'migration', sessionId, messageId }
  binding TEXT NOT NULL              -- JSON: ExecutionBinding { agentId, imDelivery? }
);
```

> OpenClaw Gateway 的 `cron.*` API 不支持自定义字段，因此将任务来源和绑定信息本地持久化在此表中。

## 3. 文件级记忆系统

除 SQLite 外，JustDo 通过 OpenClaw Gateway 管理一组文件级持久记忆文件，存储在 `~/.openclaw/` 目录中：

| 文件 | 用途 |
|------|------|
| `MEMORY.md` | 持久化事实与偏好 |
| `USER.md` | 用户档案 |
| `SOUL.md` | Agent 个性与行为准则 |
| `memory/YYYY-MM-DD.md` | 每日笔记 |

记忆文件由 Gateway 自动管理，JustDo 不直接写入这些文件。

## 4. SQLiteStore 实现

### 4.1 核心类

**文件**：`src/main/data/sqliteStore.ts`

```typescript
class SqliteStore {
  private db: Database;
  private dbPath: string;
  
  static create(userDataPath?: string): SqliteStore {
    // 初始化路径
    const dbPath = path.join(basePath, 'justdo.sqlite');
    const db = new Database(dbPath);
    
    // 启用 WAL 模式
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -8000'); // 8 MB
    db.pragma('wal_autocheckpoint = 1000');
    
    // 创建表和迁移
    store.initializeTables(basePath);
    return store;
  }
  
  // KV 操作
  get<T>(key: string): T | undefined { /* ... */ }
  set<T>(key: string, value: T): void { /* ... */ }
  delete(key: string): void { /* ... */ }
  
  // 变更监听
  onDidChange<T>(key: string, callback): () => void { /* ... */ }
  
  close(): void { /* ... */ }
}
```

### 4.2 WAL 模式

启用 Write-Ahead Logging 提高性能：

```typescript
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8000');    // 8 MB 缓存
db.pragma('wal_autocheckpoint = 1000'); // 每 ~4 MB WAL 写入后 checkpoint
```

WAL 模式优势：
- 读写不互斥
- 更好的并发性能
- 更少的数据损坏风险

### 4.3 CoworkStore

**文件**：`src/main/coworkStore.ts`

CoworkStore 封装会话和消息的 CRUD 操作。消息缓存操作包括替换会话消息（从 Gateway 对账）：

```typescript
class CoworkStore {
  private db: Database;
  
  // 配置管理（通过 kv 表）
  getConfig(): CoworkConfig { /* ... */ }
  setConfig(config: CoworkConfig): void { /* ... */ }
  
  // 会话管理
  createSession(sessionId, meta): void { /* ... */ }
  getSession(sessionId): Session | null { /* ... */ }
  listSessions(): Session[] { /* ... */ }
  updateSessionStatus(sessionId, status): void { /* ... */ }
  deleteSession(sessionId): void { /* ... */ }
  
  // 消息管理（UI 缓存）
  addMessage(sessionId, message): void { /* ... */ }
  getSessionMessages(sessionId): CoworkMessage[] { /* ... */ }
  replaceConversationMessages(sessionId, authoritative): void { /* ... */ }
}
```

## 5. 数据迁移

### 5.1 迁移策略

迁移在 `sqliteStore.ts` 的 `initializeTables` 中处理：

```typescript
// 检查列是否存在后添加
const columns = this.db.pragma('table_info(cowork_sessions)');
const colNames = columns.map(c => c.name);

if (!colNames.includes('execution_mode')) {
  this.db.exec('ALTER TABLE cowork_sessions ADD COLUMN execution_mode TEXT;');
}
// ... 其他迁移
```

迁移版本（历史变更，当前均为幂等操作）：

| 变更 | 说明 |
|------|------|
| execution_mode 列 | 从 'container' 迁移到 'local' |
| pinned 列 | 会话置顶功能 |
| sequence 列 | 消息顺序号 |
| thinking_content 列 | 思考内容存储 |
| model_name 列 | 消息对应的 AI 模型 |
| usage 列 | token 用量统计 |
| agent_id 列 | 会话绑定的 Agent |
| group_id 列 | 会话分组外键 |

### 5.2 旧数据迁移

首次启动时，如果 `kv` 表为空，尝试从 legacy `config.json`（electron-store 格式）导入数据。

## 6. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/main/sqliteStore.ts` | SQLite 数据库管理（建表、迁移、KV 操作） |
| `src/main/coworkStore.ts` | Cowork 会话和消息 CRUD |
| `src/scheduledTask/metaStore.ts` | 定时任务元数据持久化 |
| `src/main/scheduledTask/migrate.ts` | 定时任务迁移 |

## 7. 版本信息

- **Last Updated**: 2026-07-01
- **JustDo Version**: v2026.7.1
- **OpenClaw Gateway**: v2026.6.9
