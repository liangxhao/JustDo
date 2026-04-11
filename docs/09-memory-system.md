# GucciAI 持久化记忆系统设计

## 1. 概述

GucciAI 的记忆系统基于 OpenClaw，将信息持久化为文件存储在工作目录中。Agent 能够在会话之间记住用户的偏好和上下文。

### 1.1 设计原则

1. **文件记忆** —— 信息存储为 Markdown 文件，而非数据库
2. **显式写入** —— 通过 Agent 的 `write` 工具写入，而非后台提取
3. **自动加载** —— 会话启动时自动读取记忆文件作为上下文
4. **用户可控** —— GUI 支持手动编辑 MEMORY.md

### 1.2 记忆文件结构

| 文件 | 用途 | 加载时机 |
|------|------|----------|
| `MEMORY.md` | 持久事实、偏好、决策 | 每次会话开始 |
| `memory/YYYY-MM-DD.md` | 每日笔记 | 今天和昨天的文件 |
| `USER.md` | 用户画像 | 每次会话开始 |
| `SOUL.md` | Agent 人格和行为原则 | 每次会话开始 |

### 1.3 记忆写入方式

| 方式 | 说明 | 示例 |
|------|------|------|
| **显式指令** | 用户明确要求记住 | "记住我偏好英文回复" |
| **Agent 自发** | Agent 发现重要信息并写入 | 发现 API 密钥失效，记录备用方案 |
| **GUI 编辑** | 用户在设置面板手动编辑 | 添加新的偏好条目 |

## 2. 记忆文件格式

### 2.1 MEMORY.md 格式

```markdown
---
name: MEMORY
description: Durable facts and preferences loaded at session start
type: memory
---

# Memory

## User Preferences

- **Language**: User prefers English responses
- **Code Style**: 2-space indentation, single quotes
- **Framework**: React + TypeScript preferred

## Key Decisions

- 2026-03-15: Adopted OpenClaw as primary agent engine

## Environment Notes

- Working directory: /Users/username/projects/gucciai
- Python runtime: Bundled 3.11
- Node version: 24.x required

## API Configuration

- Default provider: Anthropic Claude
- Coding plan enabled for: Zhipu, Qwen, Volcengine, Moonshot

## Important Facts

- User is a software engineer specializing in frontend
- Weekly release schedule: every Thursday
```

### 2.2 USER.md 格式

```markdown
---
name: USER
description: User profile with long-term information
type: user
---

# User Profile

## Identity

- **Name**: John Doe
- **Occupation**: Senior Software Engineer
- **Company**: Tech Startup Inc.
- **Location**: San Francisco, CA

## Professional Background

- 10+ years in web development
- Expertise: React, TypeScript, Node.js
- Interest: AI-assisted coding

## Communication Style

- Prefers concise, technical responses
- Appreciates code examples over explanations
- Likes bullet-point summaries

## Work Habits

- Works 9 AM - 6 PM PST
- Uses VS Code as primary editor
- Git commits follow conventional commits spec
```

### 2.3 SOUL.md 格式

```markdown
---
name: SOUL
description: Agent personality and behavioral principles
type: soul
---

# Agent Soul

## Identity

- **Name**: GucciAI Assistant
- **Role**: Personal productivity assistant

## Behavioral Principles

1. **Proactive**: Anticipate user needs before explicit requests
2. **Precise**: Provide accurate, actionable information
3. **Secure**: Never expose secrets or bypass safety checks
4. **Transparent**: Explain what you're doing before acting
5. **Patient**: Handle retries gracefully, don't give up easily

## Communication Style

- Use clear, concise language
- Prefer code examples over long explanations
- Ask clarifying questions when ambiguous
- Provide progress updates during long operations

## Tool Usage

- Always request permission before file operations
- Explain tool purpose before execution
- Provide fallback options when tools fail

## Memory Behavior

- Write to MEMORY.md when instructed to "remember"
- Update USER.md when learning new user facts
- Keep daily notes for recent context
```

### 2.4 每日笔记格式

```markdown
---
name: 2026-04-11
description: Daily notes for context preservation
type: daily
---

# Daily Notes - 2026-04-11

## Morning Session

- Worked on refactoring authentication module
- Added JWT token refresh mechanism
- Fixed bug in token expiration check

## Afternoon Session

- Reviewed PR #42 for API changes
- Approved after security review
- Noted: API versioning strategy needs documentation

## Tasks Completed

1. Authentication refactor PR merged
2. Security review for API changes
3. Updated CHANGELOG.md

## Pending Items

- API versioning documentation
- Performance test for new auth flow
```

## 3. 记忆加载机制

### 3.1 会话启动加载

每次 Cowork 会话启动时，OpenClaw 自动读取记忆文件：

```typescript
// 会话启动流程
function initializeSession(sessionKey: string, workingDir: string): void {
  const memoryContext = loadMemoryContext(workingDir);
  
  // 将记忆注入到 prompt context
  const systemPrompt = buildSystemPrompt(memoryContext);
  
  // 发送给 Agent
  gatewayClient.chat.send({
    sessionKey,
    systemPrompt,
    // ...
  });
}

// 加载记忆上下文
function loadMemoryContext(workingDir: string): MemoryContext {
  const context: MemoryContext = {
    soul: readFile(path.join(workingDir, 'SOUL.md')),
    user: readFile(path.join(workingDir, 'USER.md')),
    memory: readFile(path.join(workingDir, 'MEMORY.md')),
    todayNote: readFile(getDailyNotePath(workingDir, new Date())),
    yesterdayNote: readFile(getDailyNotePath(workingDir, yesterday())),
  };
  
  return context;
}

// 构建系统 prompt
function buildSystemPrompt(context: MemoryContext): string {
  return `
# Agent Identity

${context.soul}

# User Profile

${context.user}

# Memory

${context.memory}

# Recent Context

## Today (${formatDate(new Date())})

${context.todayNote}

## Yesterday

${context.yesterdayNote}
`;
}
```

### 3.2 加载顺序

记忆文件按以下顺序加载和注入：

1. `SOUL.md` —— Agent 人格（最先，定义行为）
2. `USER.md` —— 用户画像（其次，定义用户）
3. `MEMORY.md` —— 持久记忆（核心事实）
4. `memory/YYYY-MM-DD.md`（今天） —— 今日笔记
5. `memory/YYYY-MM-DD.md`（昨天） —— 昨日笔记

## 4. 记忆写入机制

### 4.1 write 工具

Agent 通过 `write` 工具写入记忆文件：

```typescript
interface WriteInput {
  file_path: string;       // 文件路径
  content: string;         // 文件内容
}

// 执行写入
async function executeWrite(input: WriteInput): Promise<void> {
  // 1. 检查路径是否在工作目录内
  if (!isWithinWorkingDirectory(input.file_path, workingDir)) {
    throw new Error('路径超出工作目录范围');
  }
  
  // 2. 写入文件
  fs.writeFileSync(input.file_path, input.content, 'utf-8');
  
  // 3. 记录日志
  console.log(`[Memory] Written to ${input.file_path}`);
}
```

### 4.2 写入触发场景

**场景 1：用户显式要求**

```
User: "记住我偏好英文回复，以后都用英文"
Agent: [调用 write 工具] 已将偏好写入 MEMORY.md
```

**场景 2：Agent 发现重要信息**

```
Agent 在执行任务过程中发现：
- 用户的项目使用特定框架版本
- API 有特殊限制
- 用户习惯使用特定命令

Agent: [自发调用 write 工具] 将发现写入 MEMORY.md
```

**场景 3：定时提醒创建**

```
User: "提醒我每天早上 9 点开会"
Agent: [调用 cron.add] 创建定时任务
Agent: [调用 write 工具] 将提醒配置写入 MEMORY.md 以备查阅
```

### 4.3 写入规范

Agent 写入记忆时遵循以下规范：

1. **Markdown 格式** —— 使用标准 Markdown 结构
2. **分类清晰** —— 使用标题和列表组织内容
3. **时间标记** —— 记录写入时间
4. **来源标注** —— 说明信息来源

```markdown
## New Preference

- **Framework**: User prefers Vue over React (2026-04-11, from conversation)

## Environment Note

- Node version: 24.x required (2026-04-11, detected from package.json)
```

## 5. GUI 记忆管理

### 5.1 设置面板

**文件**：`src/renderer/components/Settings.tsx`

用户可在设置面板查看和编辑 MEMORY.md：

```typescript
function MemoryEditor() {
  const [memory, setMemory] = useState('');
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    loadMemory();
  }, []);
  
  const loadMemory = async () => {
    const workingDir = coworkConfig.workingDirectory;
    const memoryPath = path.join(workingDir, 'MEMORY.md');
    
    try {
      const content = await window.electron.fs.readFile(memoryPath);
      setMemory(content);
    } catch (e) {
      // 文件不存在，使用默认模板
      setMemory(DEFAULT_MEMORY_TEMPLATE);
    }
    setLoading(false);
  };
  
  const saveMemory = async () => {
    const workingDir = coworkConfig.workingDirectory;
    const memoryPath = path.join(workingDir, 'MEMORY.md');
    
    await window.electron.fs.writeFile(memoryPath, memory);
    
    showToast('记忆已保存');
  };
  
  const addEntry = (category: string, entry: string) => {
    const newSection = `
## ${category}

- ${entry} (${new Date().toISOString().split('T')[0]}, added via GUI)
`;
    setMemory(memory + newSection);
  };
  
  return (
    <div className="memory-editor">
      <textarea
        value={memory}
        onChange={(e) => setMemory(e.target.value)}
        rows={20}
      />
      
      <div className="actions">
        <button onClick={saveMemory}>保存</button>
        <button onClick={loadMemory}>重新加载</button>
      </div>
      
      <div className="quick-add">
        <select onChange={(e) => setSelectedCategory(e.target.value)}>
          <option value="Preferences">偏好</option>
          <option value="Environment">环境</option>
          <option value="Decisions">决策</option>
        </select>
        
        <input
          placeholder="添加条目"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
        />
        
        <button onClick={() => addEntry(selectedCategory, newEntry)}>
          添加
        </button>
      </div>
    </div>
  );
}
```

### 5.2 搜索功能

```typescript
function MemorySearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemorySearchResult[]>([]);
  
  const search = async () => {
    const workingDir = coworkConfig.workingDirectory;
    
    // 搜索 MEMORY.md 和 daily notes
    const memoryFiles = [
      'MEMORY.md',
      ...getDailyNotePaths(workingDir, 7), // 最近 7 天
    ];
    
    const results: MemorySearchResult[] = [];
    
    for (const file of memoryFiles) {
      const content = await window.electron.fs.readFile(file);
      const matches = findMatches(content, query);
      
      results.push({
        file,
        matches,
      });
    }
    
    setResults(results);
  };
  
  return (
    <div className="memory-search">
      <input
        placeholder="搜索记忆"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      
      <button onClick={search}>搜索</button>
      
      <div className="results">
        {results.map(r => (
          <div key={r.file}>
            <h4>{r.file}</h4>
            {r.matches.map(m => (
              <p key={m.line}>{m.text}</p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
```

## 6. 旧版记忆提取（已弃用）

### 6.1 CoworkMemoryExtractor

**文件**：`src/main/libs/coworkMemoryExtractor.ts`

此组件用于旧版内置引擎，已弃用，OpenClaw 不使用后台提取：

```typescript
// @deprecated - OpenClaw 使用显式 write 工具
class CoworkMemoryExtractor {
  // 从对话中提取记忆候选
  extractCandidates(messages: CoworkMessage[]): MemoryCandidate[] {
    // 检测记忆触发模式
    const patterns = [
      '记住', 'remember', '以后', 'from now on',
      '我偏好', 'I prefer', '请用',
    ];
    
    // 返回候选列表
    // ...
  }
}
```

### 6.2 CoworkMemoryJudge

**文件**：`src/main/libs/coworkMemoryJudge.ts`

用于旧版引擎的记忆评分，已弃用：

```typescript
// @deprecated - OpenClaw 使用显式 write 工具
class CoworkMemoryJudge {
  // 评分记忆候选
  scoreCandidates(candidates: MemoryCandidate[]): ScoredCandidate[] {
    // 使用 LLM 评估记忆是否值得持久化
    // ...
  }
}
```

## 7. 记忆迁移

### 7.1 版本升级迁移

当 OpenClaw 版本升级时，记忆文件需要迁移：

```typescript
// 迁移记忆文件
function migrateMemoryFiles(oldWorkingDir: string, newWorkingDir: string): void {
  const memoryFiles = [
    'MEMORY.md',
    'USER.md',
    'SOUL.md',
    'memory/',  // 整个目录
  ];
  
  for (const file of memoryFiles) {
    const oldPath = path.join(oldWorkingDir, file);
    const newPath = path.join(newWorkingDir, file);
    
    if (fs.existsSync(oldPath)) {
      fs.cpSync(oldPath, newPath, { recursive: true });
    }
  }
}
```

## 8. 记忆容量管理

### 8.1 文件大小限制

记忆文件应保持在合理大小：

| 文件 | 建议 size |
|------|----------|
| `MEMORY.md` | < 10 KB |
| `USER.md` | < 5 KB |
| `SOUL.md` | < 5 KB |
| 每日笔记 | < 2 KB |

### 8.2 每日笔记清理

旧笔记定期清理：

```typescript
// 清理超过 30 天的每日笔记
function cleanupDailyNotes(workingDir: string, retentionDays: number = 30): void {
  const memoryDir = path.join(workingDir, 'memory');
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  
  const files = fs.readdirSync(memoryDir);
  
  for (const file of files) {
    const dateStr = file.replace('.md', '');
    const fileDate = new Date(dateStr);
    
    if (fileDate < cutoffDate) {
      fs.unlinkSync(path.join(memoryDir, file));
    }
  }
}
```

### 8.3 记忆压缩

当 MEMORY.md 过大时，Agent 可自发压缩：

```markdown
# Compressed Memory

## Key Preferences (summarized)

- Language: English
- Framework: React + TypeScript
- Style: 2-space indent

## Active Decisions

- Brand: GucciAI (2026-04-01)
- Engine: OpenClaw (2026-03-15)

## Deprecated entries removed

- Old API configurations (superseded)
- Temporary notes from 2026-02 (expired)
```

## 9. 关键文件清单

| 文件 | 职责 |
|------|------|
| `{workingDir}/MEMORY.md` | 持久记忆文件 |
| `{workingDir}/USER.md` | 用户画像文件 |
| `{workingDir}/SOUL.md` | Agent 人格文件 |
| `{workingDir}/memory/YYYY-MM-DD.md` | 每日笔记 |
| `src/main/libs/coworkMemoryExtractor.ts` | 旧版提取器（弃用） |
| `src/main/libs/coworkMemoryJudge.ts` | 旧版评分器（弃用） |
| `src/renderer/components/Settings.tsx` | GUI 记忆编辑 |