# GucciAI 数据存储与 SQLite 设计

## 1. 概述

GucciAI 所有数据存储在本地 SQLite 数据库，文件名为 `gucciai.sqlite`，位于用户数据目录。采用 better-sqlite3 作为 SQLite 库，支持高性能同步操作。

### 1.1 数据库位置

| 平台 | 数据目录 |
|------|----------|
| macOS | `~/Library/Application Support/GucciAI/` |
| Windows | `%APPDATA%\GucciAI\` |
| Linux | `~/.config/GucciAI/` |

### 1.2 数据库特性

- **单文件存储**：便于备份和迁移
- **同步操作**：better-sqlite3 提供高性能同步 API
- **WAL 模式**：启用 Write-Ahead Logging 提高并发性能
- **完整 UTF-8**：支持中文等 Unicode 字符

## 2. 数据表结构

### 2.1 kv 表（键值存储）

应用级配置存储：

```sql
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT               -- JSON 格式存储
);

-- 示例数据
INSERT INTO kv (key, value) VALUES 
  ('appConfig', '{"language":"zh","theme":"dark"}'),
  ('auth_tokens', '{"accessToken":"xxx","refreshToken":"yyy"}'),
  ('skillsConfig', '{"skills":[{"id":"web-search","enabled":true}]}');
```

### 2.2 cowork_config 表

Cowork 系统配置：

```sql
CREATE TABLE cowork_config (
  working_directory TEXT,
  system_prompt TEXT,
  execution_mode TEXT,        -- 'auto' | 'local'
  agent_engine TEXT,          -- 'openclaw' | 'yd_cowork'
  model_provider TEXT,
  model_name TEXT,
  api_key TEXT,               -- 加密存储
  api_format TEXT,            -- 'anthropic' | 'openai'
  coding_plan_enabled INTEGER,
  updated_at INTEGER
);

-- 单行配置
INSERT INTO cowork_config VALUES (
  '/Users/username/work',
  'You are a helpful assistant...',
  'auto',
  'openclaw',
  'anthropic',
  'claude-sonnet-4-6',
  NULL,                       -- API key 由 Provider 配置管理
  'anthropic',
  0,
  1712851200000
);
```

### 2.3 cowork_sessions 表

会话元数据：

```sql
CREATE TABLE cowork_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  working_directory TEXT,
  status TEXT,                 -- 'idle' | 'running' | 'completed' | 'error' | 'stopped'
  created_at INTEGER,
  updated_at INTEGER,
  message_count INTEGER DEFAULT 0
);

-- 索引
CREATE INDEX idx_sessions_created ON cowork_sessions(created_at DESC);
CREATE INDEX idx_sessions_status ON cowork_sessions(status);
```

### 2.4 cowork_messages 表

会话消息历史：

```sql
CREATE TABLE cowork_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT,                   -- 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  content TEXT,
  thinking_content TEXT,       -- 思考/推理内容（模型 thinking 流，可选）
  metadata TEXT,               -- JSON: { isStreaming, isThinking, toolName, toolInput, ... }
  timestamp INTEGER,
  sequence INTEGER,            -- 消息顺序号

  FOREIGN KEY (session_id) REFERENCES cowork_sessions(id)
);

-- 索引
CREATE INDEX idx_messages_session ON cowork_messages(session_id, sequence);
CREATE INDEX idx_messages_type ON cowork_messages(type);
```

> **thinking_content 字段**：存储模型的思考/推理内容。详见 [thinking-stream-implementation.md](../features/thinking-stream-implementation.md)。

### 2.X cowork_subagents 表

子 Agent 追踪（UI 缓存，非运行时权威）：

```sql
CREATE TABLE cowork_subagents (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  child_session_key TEXT,
  label TEXT,
  status TEXT,
  created_at INTEGER,
  FOREIGN KEY (parent_session_id) REFERENCES cowork_sessions(id)
);

CREATE INDEX idx_cowork_subagents_parent_session ON cowork_subagents(parent_session_id);
```

### 2.Y session_groups 表

会话分组：

```sql
CREATE TABLE session_groups (
  id TEXT PRIMARY KEY,
  name TEXT,
  sort_order INTEGER,
  created_at INTEGER
);
```

### 2.6 agents 表

自定义 Agent 配置：

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  system_prompt TEXT,
  skills TEXT,                 -- JSON: ["web-search", "docx", ...]
  bindings TEXT,               -- JSON: [{platform, conversationId}, ...]
  created_at INTEGER,
  updated_at INTEGER
);
```

### 2.7 mcp_servers 表

MCP 服务器配置：

```sql
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT,
  command TEXT,
  args TEXT,                   -- JSON: ["--port", "8080"]
  env TEXT,                    -- JSON: {"KEY": "value"}
  enabled INTEGER DEFAULT 1,
  created_at INTEGER
);
```

### 2.8 im_config 表

IM 网关配置（规划中）：

```sql
CREATE TABLE im_config (
  key TEXT PRIMARY KEY,        -- 配置键
  value TEXT                   -- JSON 配置
);
```

### 2.9 im_session_mappings 表

IM 会话与 Cowork 会话映射（规划中）：

```sql
CREATE TABLE im_session_mappings (
  platform TEXT,               -- 平台标识
  conversation_id TEXT,        -- IM 会话 ID
  session_id TEXT,             -- Cowork session ID
  agent_id TEXT,               -- 绑定的 Agent ID
  created_at INTEGER,

  PRIMARY KEY (platform, conversation_id),
  FOREIGN KEY (session_id) REFERENCES cowork_sessions(id)
);
```

### 2.10 scheduled_task_meta 表

定时任务元数据：

```sql
CREATE TABLE scheduled_task_meta (
  task_id TEXT PRIMARY KEY,
  origin TEXT,                 -- 'conversation' | 'gui' | 'migration'
  origin_session_id TEXT,
  origin_message_id TEXT,
  agent_id TEXT,
  im_delivery TEXT,            -- JSON: {platform, conversationId}
  created_at INTEGER,
  updated_at INTEGER
);
```

## 3. SQLiteStore 实现

### 3.1 核心类

**文件**：`src/main/sqliteStore.ts`

```typescript
class SQLiteStore {
  private db: Database;
  private dbPath: string;
  
  // 初始化
  init(): void {
    this.dbPath = path.join(app.getPath('userData'), 'gucciai.sqlite');
    this.db = new Database(this.dbPath);
    
    // 启用 WAL 模式
    this.db.pragma('journal_mode = WAL');
    
    // 创建表
    this.createTables();
    
    // 迁移
    this.runMigrations();
  }
  
  // 创建表
  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      
      CREATE TABLE IF NOT EXISTS cowork_config (
        working_directory TEXT,
        system_prompt TEXT,
        execution_mode TEXT,
        agent_engine TEXT,
        model_provider TEXT,
        model_name TEXT,
        api_key TEXT,
        api_format TEXT,
        coding_plan_enabled INTEGER,
        updated_at INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        working_directory TEXT,
        status TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        message_count INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        content TEXT,
        thinking_content TEXT,   -- 思考内容字段
        metadata TEXT,
        timestamp INTEGER,
        sequence INTEGER
      );
      
      -- 其他表...
    `);
    
    // 创建索引
    this.createIndexes();
  }
  
  // KV 操作
  get(key: string): unknown | null {
    const row = this.db.get<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      [key]
    );
    return row ? JSON.parse(row.value) : null;
  }
  
  set(key: string, value: unknown): void {
    this.db.run(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
      [key, JSON.stringify(value)]
    );
  }
  
  delete(key: string): void {
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
  }
  
  // 保存数据库
  saveDb(): void {
    // WAL 模式自动持久化，此方法用于显式保存
  }
  
  // 关闭连接
  close(): void {
    this.db.close();
  }
}
```

### 3.2 WAL 模式

启用 Write-Ahead Logging 提高性能：

```typescript
// 启用 WAL 模式
this.db.pragma('journal_mode = WAL');

// 设置 busy timeout（等待锁释放）
this.db.pragma('busy_timeout = 5000');

// 设置 synchronous 模式
this.db.pragma('synchronous = NORMAL');
```

WAL 模式优势：
- 读写不互斥
- 更好的并发性能
- 更少的数据损坏风险

## 4. CoworkStore 实现

### 4.1 核心类

**文件**：`src/main/coworkStore.ts`

```typescript
class CoworkStore {
  private db: Database;
  
  constructor(db: Database) {
    this.db = db;
  }
  
  // 配置管理
  getConfig(): CoworkConfig {
    const row = this.db.get<CoworkConfigRow>(
      'SELECT * FROM cowork_config LIMIT 1'
    );
    
    if (!row) {
      return DEFAULT_COWORK_CONFIG;
    }
    
    return {
      workingDirectory: row.working_directory,
      systemPrompt: row.system_prompt,
      executionMode: row.execution_mode || 'auto',
      agentEngine: row.agent_engine || 'openclaw',
      // ...
    };
  }
  
  setConfig(config: CoworkConfig): void {
    this.db.run(`
      UPDATE cowork_config SET
        working_directory = ?,
        system_prompt = ?,
        execution_mode = ?,
        agent_engine = ?,
        updated_at = ?
    `, [
      config.workingDirectory,
      config.systemPrompt,
      config.executionMode,
      config.agentEngine,
      Date.now(),
    ]);
    
    // 如果没有行，插入
    if (this.db.changes === 0) {
      this.db.run(`
        INSERT INTO cowork_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [/* ... */]);
    }
  }
  
  // 会话管理
  createSession(sessionId: string, meta: SessionMeta): void {
    this.db.run(`
      INSERT INTO cowork_sessions (id, title, working_directory, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [sessionId, meta.title, meta.workingDirectory, meta.status, Date.now(), Date.now()]);
  }
  
  getSession(sessionId: string): Session | null {
    return this.db.get<Session>(
      'SELECT * FROM cowork_sessions WHERE id = ?',
      [sessionId]
    );
  }
  
  listSessions(): Session[] {
    return this.db.all<Session[]>(
      'SELECT * FROM cowork_sessions ORDER BY created_at DESC'
    );
  }
  
  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    this.db.run(`
      UPDATE cowork_sessions SET status = ?, updated_at = ? WHERE id = ?
    `, [status, Date.now(), sessionId]);
  }
  
  deleteSession(sessionId: string): void {
    // 删除消息
    this.db.run('DELETE FROM cowork_messages WHERE session_id = ?', [sessionId]);
    
    // 删除会话
    this.db.run('DELETE FROM cowork_sessions WHERE id = ?', [sessionId]);
    
    // 删除 IM 映射
    this.db.run('DELETE FROM im_session_mappings WHERE session_id = ?', [sessionId]);
  }
  
  // 消息管理
  addMessage(sessionId: string, message: CoworkMessage): void {
    const sequence = this.getNextSequence(sessionId);
    
    this.db.run(`
      INSERT INTO cowork_messages (id, session_id, type, content, metadata, timestamp, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      message.id,
      sessionId,
      message.type,
      message.content,
      JSON.stringify(message.metadata || {}),
      message.timestamp || Date.now(),
      sequence,
    ]);
    
    // 更新消息计数
    this.updateMessageCount(sessionId);
  }
  
  getSessionMessages(sessionId: string): CoworkMessage[] {
    return this.db.all<CoworkMessage[]>(
      'SELECT * FROM cowork_messages WHERE session_id = ? ORDER BY sequence',
      [sessionId]
    ).map(row => ({
      ...row,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }
  
  updateMessageContent(sessionId: string, messageId: string, content: string): void {
    this.db.run(`
      UPDATE cowork_messages SET content = ? WHERE id = ?
    `, [content, messageId]);
  }
  
  // 消息替换（对账使用）
  replaceConversationMessages(
    sessionId: string,
    authoritative: Array<{ role: 'user' | 'assistant'; text: string }>
  ): void {
    // 1. 删除现有 user/assistant 消息
    this.db.run(`
      DELETE FROM cowork_messages 
      WHERE session_id = ? AND type IN ('user', 'assistant')
    `, [sessionId]);
    
    // 2. 获取最大 sequence
    let nextSeq = this.getMaxSequence(sessionId) + 1;
    
    // 3. 按顺序重新插入
    for (const entry of authoritative) {
      this.db.run(`
        INSERT INTO cowork_messages (id, session_id, type, content, metadata, timestamp, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        uuid(),
        sessionId,
        entry.role,
        entry.text,
        JSON.stringify({ isStreaming: false, isFinal: true }),
        Date.now(),
        nextSeq++,
      ]);
    }
    
    // 4. 更新消息计数
    this.updateMessageCount(sessionId);
  }
  
  // 辅助方法
  private getNextSequence(sessionId: string): number {
    const max = this.getMaxSequence(sessionId);
    return max + 1;
  }
  
  private getMaxSequence(sessionId: string): number {
    const row = this.db.get<{ max: number }>(
      'SELECT MAX(sequence) as max FROM cowork_messages WHERE session_id = ?',
      [sessionId]
    );
    return row?.max || 0;
  }
  
  private updateMessageCount(sessionId: string): void {
    const count = this.db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM cowork_messages WHERE session_id = ?',
      [sessionId]
    );
    
    this.db.run(`
      UPDATE cowork_sessions SET message_count = ?, updated_at = ? WHERE id = ?
    `, [count?.count || 0, Date.now(), sessionId]);
  }
}
```

## 5. IMStore 实现

**文件**：`src/main/im/imStore.ts`

参见 [06-im-integration.md](06-im-integration.md) 中的 IMStore 部分。

## 6. 数据迁移

### 6.1 迁移框架

```typescript
interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: (db) => {
      // 创建初始表
    },
  },
  {
    version: 2,
    name: 'add_coding_plan',
    up: (db) => {
      db.run('ALTER TABLE cowork_config ADD COLUMN coding_plan_enabled INTEGER DEFAULT 0');
    },
  },
  {
    version: 3,
    name: 'add_agent_engine',
    up: (db) => {
      db.run('ALTER TABLE cowork_config ADD COLUMN agent_engine TEXT DEFAULT "openclaw"');
    },
  },
  {
    version: 4,
    name: 'im_multi_instance',
    up: (db) => {
      // IM 多实例迁移
      migrateIMConfig(db);
    },
  },
  {
    version: 5,
    name: 'add_thinking_content',
    up: (db) => {
      db.run('ALTER TABLE cowork_messages ADD COLUMN thinking_content TEXT');
    },
  },
];

function runMigrations(db: Database): void {
  // 获取当前版本
  const row = db.get<{ value: string }>(
    'SELECT value FROM kv WHERE key = "db_version"'
  );
  const currentVersion = row ? parseInt(row.value) : 0;
  
  // 运行未执行的迁移
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      migration.up(db);
      
      // 更新版本
      db.run(
        'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
        ['db_version', migration.version.toString()]
      );
    }
  }
}
```

## 7. 数据备份与恢复

### 7.1 自动备份

```typescript
function autoBackup(dbPath: string): void {
  const backupPath = `${dbPath}.backup`;
  
  // 复制数据库文件
  fs.copyFileSync(dbPath, backupPath);
  
  // 保留最近 7 天的备份
  const backupDir = path.join(app.getPath('userData'), 'backups');
  
  // 清理旧备份
  const files = fs.readdirSync(backupDir);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  
  for (const file of files) {
    const stat = fs.statSync(path.join(backupDir, file));
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(path.join(backupDir, file));
    }
  }
}
```

### 7.2 数据导出

```typescript
function exportData(db: Database): ExportedData {
  return {
    kv: db.all('SELECT * FROM kv'),
    coworkConfig: db.get('SELECT * FROM cowork_config'),
    coworkSessions: db.all('SELECT * FROM cowork_sessions'),
    coworkMessages: db.all('SELECT * FROM cowork_messages'),
    agents: db.all('SELECT * FROM agents'),
    mcpServers: db.all('SELECT * FROM mcp_servers'),
    exportedAt: Date.now(),
    version: '2026.4',
  };
}
```

### 7.3 数据导入

```typescript
function importData(db: Database, data: ExportedData): void {
  // 清空现有数据
  db.exec(`
    DELETE FROM kv;
    DELETE FROM cowork_config;
    DELETE FROM cowork_sessions;
    DELETE FROM cowork_messages;
    DELETE FROM agents;
    DELETE FROM mcp_servers;
  `);
  
  // 导入数据
  for (const row of data.kv) {
    db.run('INSERT INTO kv (key, value) VALUES (?, ?)', [row.key, row.value]);
  }
  
  // ... 其他表
}
```

## 8. 性能优化

### 8.1 索引策略

| 表 | 索引 | 用途 |
|------|------|------|
| cowork_sessions | `created_at DESC` | 按时间排序会话列表 |
| cowork_sessions | `status` | 按状态过滤会话 |
| cowork_messages | `session_id, sequence` | 查询会话消息 |
| cowork_messages | `type` | 按类型过滤消息 |
| im_session_mappings | `platform, conversation_id` | IM 映射查询 |

### 8.2 批量操作

```typescript
// 批量插入消息
function batchInsertMessages(sessionId: string, messages: CoworkMessage[]): void {
  const stmt = this.db.prepare(`
    INSERT INTO cowork_messages (id, session_id, type, content, metadata, timestamp, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  this.db.transaction(() => {
    for (const msg of messages) {
      stmt.run(msg.id, sessionId, msg.type, msg.content, JSON.stringify(msg.metadata), msg.timestamp, msg.sequence);
    }
  })();
}
```

### 8.3 连接池

better-sqlite3 是同步库，无需连接池。但应避免频繁打开/关闭连接：

```typescript
// 单例模式
let dbInstance: Database | null = null;

function getDb(): Database {
  if (!dbInstance) {
    dbInstance = new Database(dbPath);
  }
  return dbInstance;
}
```

## 9. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/main/sqliteStore.ts` | SQLite 数据库管理 |
| `src/main/coworkStore.ts` | Cowork 数据 CRUD |
| `src/main/im/imStore.ts` | IM 数据 CRUD |
| `src/main/scheduledTask/modelMapper.ts` | 定时任务数据映射 |
| `src/main/scheduledTask/migrate.ts` | 定时任务迁移 |
| `tests/*.test.mjs` | 数据层测试 |
