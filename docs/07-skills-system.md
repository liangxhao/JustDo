# GucciAI Skills 技能系统设计

## 1. 概述

Skills 是 GucciAI 的扩展机制，每个 Skill 定义了一组特定场景下的工具和能力。GucciAI 内置 29 个 Skill，覆盖文档生成、视频创作、数据分析、网络自动化等场景。

### 1.1 Skill 目录结构

```
SKILLs/
├── skills.config.json        # Skill 启用/禁用配置
│
├── web-search/               # 网络搜索
│   ├── SKILL.md              # Skill 定义文档
│   ├── IMPLEMENTATION.md     # 实现说明
│   ├── TEST.md               # 测试指南
│   ├── README.md             # 用户文档
│   ├── package.json          # Skill 依赖
│   └── scripts/              # 服务脚本
│
├── docx/                     # Word 文档生成
│   ├── SKILL.md
│   └── ...
│
├── xlsx/                     # Excel 表格生成
│   ├── SKILL.md
│   └── ...
│
├── pptx/                     # PowerPoint 生成
│   ├── SKILL.md
│   └── ...
│
├── remotion/                 # 视频生成
│   ├── SKILL.md
│   └── ...
│
├── playwright/               # 网络自动化
│   ├── SKILL.md
│   └── ...
│
└── ...                       # 更多 Skills
```

### 1.2 Skill 配置

```json
// SKILLs/skills.config.json
{
  "skills": [
    { "id": "web-search", "enabled": true },
    { "id": "docx", "enabled": true },
    { "id": "xlsx", "enabled": true },
    { "id": "pptx", "enabled": true },
    { "id": "pdf", "enabled": true },
    { "id": "remotion", "enabled": true },
    { "id": "seedance", "enabled": true },
    { "id": "seedream", "enabled": true },
    { "id": "playwright", "enabled": true },
    { "id": "canvas-design", "enabled": true },
    { "id": "frontend-design", "enabled": true },
    { "id": "develop-web-game", "enabled": true },
    { "id": "stock-analyzer", "enabled": true },
    { "id": "stock-announcements", "enabled": true },
    { "id": "stock-explorer", "enabled": true },
    { "id": "content-planner", "enabled": true },
    { "id": "article-writer", "enabled": true },
    { "id": "daily-trending", "enabled": true },
    { "id": "films-search", "enabled": true },
    { "id": "music-search", "enabled": true },
    { "id": "weather", "enabled": true },
    { "id": "local-tools", "enabled": true },
    { "id": "create-plan", "enabled": true },
    { "id": "youdaonote", "enabled": true },
    { "id": "skill-vetter", "enabled": true },
    { "id": "skill-creator", "enabled": true }
  ]
}
```

## 2. Skill 定义文档

### 2.1 SKILL.md 结构

每个 Skill 必须包含 `SKILL.md` 文件，定义 Skill 的元信息、工具列表、使用示例。

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

### Example 2: 高级用法

...

## Dependencies

- package-name: 版本
- external-service: 外部服务依赖

## Security Notes

使用此 Skill 时的安全注意事项。
```

### 2.2 Skill 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| **文档生成** | Office 文档生成 | docx, xlsx, pptx, pdf |
| **视频创作** | 视频和动画生成 | remotion, seedance |
| **图像设计** | 图像生成和设计 | seedream, canvas-design |
| **网络工具** | 网络搜索和自动化 | web-search, playwright |
| **金融分析** | 股票和金融数据 | stock-analyzer, stock-announcements |
| **内容创作** | 文章和内容生成 | article-writer, content-planner |
| **系统工具** | 本地系统操作 | local-tools |
| **扩展管理** | Skill 扩展 | skill-creator, skill-vetter |

## 3. 内置 Skills

### 3.1 文档生成

| Skill | 说明 | 输出格式 |
|-------|------|----------|
| `docx` | Word 文档生成 | .docx |
| `xlsx` | Excel 表格生成 | .xlsx |
| `pptx` | PowerPoint 演示文稿 | .pptx |
| `pdf` | PDF 处理和生成 | .pdf |

### 3.2 视频创作

| Skill | 说明 | 技术栈 |
|-------|------|----------|
| `remotion` | 程序化视频生成 | Remotion + React |
| `seedance` | AI 视频生成 | Seedance API |

### 3.3 图像设计

| Skill | 说明 | 技术栈 |
|-------|------|----------|
| `seedream` | AI 图像生成 | Seedream API |
| `canvas-design` | Canvas 绘图设计 | HTML Canvas |

### 3.4 网络工具

| Skill | 说明 | 技术栈 |
|-------|------|----------|
| `web-search` | 网络搜索 | 自建服务 + 搜索引擎 API |
| `playwright` | 网络自动化 | Playwright |
| `frontend-design` | 前端 UI 设计 | React + Tailwind |

### 3.5 金融分析

| Skill | 说明 | 数据源 |
|-------|------|----------|
| `stock-analyzer` | 股票深度分析 | A股数据 |
| `stock-announcements` | 股票公告检索 | 公告数据 |
| `stock-explorer` | 股票信息探索 | 基础数据 |

### 3.6 内容创作

| Skill | 说明 | 用途 |
|-------|------|------|
| `article-writer` | 文章写作 | 长文、博客 |
| `content-planner` | 内容规划 | 选题、排期 |
| `daily-trending` | 每日热点 | 热点聚合 |

### 3.7 系统工具

| Skill | 说明 | 安全级别 |
|-------|------|----------|
| `local-tools` | 本地系统工具 | medium-high |

### 3.8 扩展管理

| Skill | 说明 | 用途 |
|-------|------|------|
| `skill-creator` | Skill 创建 | 创建自定义 Skill |
| `skill-vetter` | Skill 安全审计 | 安装前检查 |

## 4. Skill 管理器

### 4.1 SkillManager

**文件**：`src/main/skillManager.ts`

```typescript
class SkillManager {
  private skillsDir: string;
  private config: SkillConfig;
  
  // 初始化
  init(): void {
    this.skillsDir = path.join(app.getPath('userData'), 'SKILLs');
    this.loadConfig();
    this.loadSkillDefinitions();
  }
  
  // 加载配置
  private loadConfig(): void {
    const configPath = path.join(this.skillsDir, 'skills.config.json');
    if (fs.existsSync(configPath)) {
      this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      this.config = { skills: DEFAULT_SKILLS };
    }
  }
  
  // 加载 Skill 定义
  private loadSkillDefinitions(): void {
    for (const skillEntry of this.config.skills) {
      if (skillEntry.enabled) {
        const skillPath = path.join(this.skillsDir, skillEntry.id);
        if (fs.existsSync(skillPath)) {
          this.loadSkill(skillEntry.id, skillPath);
        }
      }
    }
  }
  
  // 加载单个 Skill
  private loadSkill(id: string, skillPath: string): void {
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const definition = this.parseSkillMd(content);
      this.registerSkill(id, definition);
    }
  }
  
  // 解析 SKILL.md
  private parseSkillMd(content: string): SkillDefinition {
    // 解析 Markdown 结构
    // 提取 Description、Tools、Examples、Dependencies
    // 返回 SkillDefinition 对象
  }
  
  // 注册 Skill
  private registerSkill(id: string, definition: SkillDefinition): void {
    // 将 Skill 工具注册到 OpenClaw 或内置引擎
  }
  
  // 获取启用的 Skills
  getEnabledSkills(): string[] {
    return this.config.skills
      .filter(s => s.enabled)
      .map(s => s.id);
  }
  
  // 启用/禁用 Skill
  setSkillEnabled(id: string, enabled: boolean): void {
    const entry = this.config.skills.find(s => s.id === id);
    if (entry) {
      entry.enabled = enabled;
      this.saveConfig();
    }
  }
  
  // 保存配置
  private saveConfig(): void {
    const configPath = path.join(this.skillsDir, 'skills.config.json');
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
  }
}
```

### 4.2 SkillDefinition 类型

```typescript
interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  tools: ToolDefinition[];
  examples: SkillExample[];
  dependencies: SkillDependency[];
  securityNotes?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  securityLevel: 'low' | 'medium' | 'high';
  executePath?: string;      // 执行脚本路径
}

interface SkillExample {
  title: string;
  userInput: string;
  agentResponse: string;
}

interface SkillDependency {
  name: string;
  version?: string;
  type: 'npm' | 'python' | 'external';
}
```

## 5. Skill 安全

### 5.1 安全审计

**文件**：`src/main/libs/skillSecurity/`

```typescript
// skillSecurityScanner.ts
class SkillSecurityScanner {
  // 扫描 Skill 目录
  scan(skillPath: string): SecurityScanResult {
    const issues: SecurityIssue[] = [];
    
    // 1. 检查脚本内容
    issues.push(...this.scanScripts(skillPath));
    
    // 2. 检查依赖
    issues.push(...this.scanDependencies(skillPath));
    
    // 3. 检查网络请求
    issues.push(...this.scanNetworkAccess(skillPath));
    
    // 4. 检查文件访问
    issues.push(...this.scanFileAccess(skillPath));
    
    return {
      skillPath,
      issues,
      riskLevel: this.calculateRiskLevel(issues),
    };
  }
  
  // 检查脚本内容
  private scanScripts(skillPath: string): SecurityIssue[] {
    const issues: SecurityIssue[] = [];
    
    const scripts = glob.sync('**/*.{js,ts,py,sh}', { cwd: skillPath });
    
    for (const script of scripts) {
      const content = fs.readFileSync(path.join(skillPath, script), 'utf-8');
      
      // 检查危险模式
      if (this.containsDangerousPatterns(content)) {
        issues.push({
          type: 'dangerous_pattern',
          severity: 'high',
          file: script,
          description: '检测到危险代码模式',
        });
      }
      
      // 检查硬编码密钥
      if (this.containsHardcodedSecrets(content)) {
        issues.push({
          type: 'hardcoded_secret',
          severity: 'critical',
          file: script,
          description: '检测到硬编码密钥',
        });
      }
    }
    
    return issues;
  }
}
```

### 5.2 skill-vetter Skill

`skill-vetter` Skill 用于在安装第三方 Skill 前进行安全审计：

```markdown
# skill-vetter

## Description
第三方 Skill 安全审计工具，在安装前检查潜在风险。

## Tools

### vet_skill
Description: 审计 Skill 安全性
Input: skill_path - Skill 目录路径
Output: SecurityScanResult - 安全审计结果
Security: low

## Examples

### Example 1: 安装前审计

User: 我想安装这个第三方 Skill，帮我检查一下安全性
Agent: [调用 vet_skill] 审计结果：发现 2 个中等风险问题...

## Security Notes
此 Skill 本身是安全的，仅用于审计其他 Skill。
```

## 6. Skill 创建

### 6.1 skill-creator Skill

`skill-creator` 用于创建自定义 Skill：

```markdown
# skill-creator

## Description
创建自定义 Skill 的辅助工具。

## Tools

### create_skill
Description: 创建新的 Skill 结构
Input: 
  - name: Skill 名称
  - description: Skill 描述
  - tools: 工具列表
Output: Skill 目录结构

### add_tool
Description: 向现有 Skill 添加工具
Input:
  - skill_id: Skill ID
  - tool_name: 工具名称
  - tool_definition: 工具定义
Output: 更新后的 Skill

## Examples

### Example 1: 创建简单 Skill

User: 创建一个简单的 Skill 用于生成二维码
Agent: [调用 create_skill] 已创建 qrcode-generator Skill...
```

### 6.2 Skill 模板

```markdown
# {{skill_name}}

## Description

{{description}}

## Tools

### {{tool_name}}

Description: {{tool_description}}
Input: {{input_schema}}
Output: {{output_schema}}
Security: {{security_level}}

## Examples

### Example 1

User: {{user_input}}
Agent: {{agent_response}}

## Dependencies

- {{dependency_name}}: {{version}}

## Security Notes

{{security_notes}}
```

## 7. Skill 构建

### 7.1 构建脚本

部分 Skill 需要构建步骤：

```bash
# 构建 web-search Skill
npm run build:skill:web-search

# 构建所有 Skills
npm run build:skills
```

### 7.2 Skill package.json

部分 Skill 有独立依赖：

```json
// SKILLs/web-search/package.json
{
  "name": "web-search-skill",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "node-fetch": "^3.3.0"
  },
  "scripts": {
    "start": "node scripts/start-server.js"
  }
}
```

### 7.3 构建流程

```typescript
// scripts/build-skill-web-search.js
async function buildWebSearchSkill() {
  const skillDir = 'SKILLs/web-search';
  
  // 1. 安装依赖
  execSync('npm install', { cwd: skillDir });
  
  // 2. 编译 TypeScript
  execSync('npx tsc -p tsconfig.json', { cwd: skillDir });
  
  // 3. 清理临时文件
  fs.rmSync(path.join(skillDir, '.connection'), { force: true });
  fs.rmSync(path.join(skillDir, '.server.log'), { force: true });
  fs.rmSync(path.join(skillDir, '.server.pid'), { force: true });
}
```

## 8. Skill 与 OpenClaw 集成

### 8.1 工具注册

Skill 工具通过 OpenClaw 的 `managed.yaml` 或本地扩展注册：

```yaml
# managed.yaml
tools:
  builtin:
    - read_file
    - write_file
    - execute_command
    - web_search
    - ...
  extensions:
    - path: ./extensions/web-search
    - path: ./extensions/docx
```

### 8.2 本地扩展同步

**文件**：`scripts/sync-local-openclaw-extensions.cjs`

```javascript
// 同步本地 Skills 到 OpenClaw extensions
function syncLocalExtensions() {
  const skillsDir = 'SKILLs';
  const openclawExtensionsDir = '../openclaw/extensions';
  
  const enabledSkills = getEnabledSkills();
  
  for (const skill of enabledSkills) {
    const skillPath = path.join(skillsDir, skill);
    const extensionPath = path.join(openclawExtensionsDir, skill);
    
    // 复制 Skill 到 OpenClaw extensions
    fs.cpSync(skillPath, extensionPath, { recursive: true });
  }
}
```

## 9. Skills UI

### 9.1 Skills 设置面板

**文件**：`src/renderer/components/skills/SkillsSettings.tsx`

```typescript
function SkillsSettings() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  
  useEffect(() => {
    // 加载 Skills 配置
    window.electron.store.get('skillsConfig').then(config => {
      setSkills(config?.skills || DEFAULT_SKILLS);
    });
  }, []);
  
  const toggleSkill = (id: string, enabled: boolean) => {
    const updated = skills.map(s => 
      s.id === id ? { ...s, enabled } : s
    );
    setSkills(updated);
    window.electron.store.set('skillsConfig', { skills: updated });
  };
  
  return (
    <div className="skills-settings">
      {skills.map(skill => (
        <div key={skill.id} className="skill-entry">
          <span className="skill-name">{skill.id}</span>
          <Toggle
            checked={skill.enabled}
            onChange={(checked) => toggleSkill(skill.id, checked)}
          />
        </div>
      ))}
    </div>
  );
}
```

## 10. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/main/skillManager.ts` | Skill 管理器 |
| `src/main/libs/skillSecurity/skillSecurityScanner.ts` | 安全扫描 |
| `src/main/libs/skillSecurity/skillSecurityRules.ts` | 安全规则 |
| `src/main/libs/skillSecurity/skillSecurityTypes.ts` | 安全类型 |
| `SKILLs/skills.config.json` | Skill 配置 |
| `SKILLs/*/SKILL.md` | Skill 定义 |
| `scripts/build-skill-*.js` | Skill 构建脚本 |
| `src/renderer/components/skills/SkillsSettings.tsx` | Skills UI |