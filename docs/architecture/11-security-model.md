# JustDo 安全模型与权限控制

**版本**: v2026.6.25

## 1. 安全架构

JustDo 采用多层安全防护，确保用户数据和系统安全。

### 1.1 安全层次

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层安全                                 │
│                                                             │
│  - API Key 环境变量管理                                       │
│  - 安全配置存储 (Electron safeStorage)                        │
│  - Gateway 配置同步安全                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    进程层安全                                 │
│                                                             │
│  - Context Isolation 启用                                    │
│  - Node Integration 禁用                                     │
│  - Sandbox 启用                                               │
│  - Preload 安全桥接                                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    权限控制层                                 │
│                                                             │
│  - 工具调用审批                                               │
│  - 工作目录边界                                               │
│  - 风险等级评估                                               │
│  - 单次/会话级授权                                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    内容安全层                                 │
│                                                             │
│  - DOMPurify 净化 (HTML/SVG)                                 │
│  - Mermaid Strict Mode                                       │
│  - 隔离 iframe 渲染                                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    网络安全层                                 │
│                                                             │
│  - CORS 限制                                                  │
│  - HTTPS 强制                                                 │
│  - Gateway 通信本地回环                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 进程安全

### 2.1 BrowserWindow 配置

```typescript
const mainWindow = new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),

    // Context Isolation: 启用
    // Renderer 无法直接访问 Node.js API
    contextIsolation: true,

    // Node Integration: 禁用
    // Renderer 无法使用 require()
    nodeIntegration: false,

    // Sandbox: 启用
    // Renderer 运行在 Chromium 沙箱
    sandbox: true,

    // Web Security: 启用
    webSecurity: true,

    // 禁用远程模块
    enableRemoteModule: false,
  }
});
```

### 2.2 Preload 安全桥接

```typescript
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// 仅暴露必要的 API，不暴露 ipcRenderer 本身
contextBridge.exposeInMainWorld('electron', {
  cowork: {
    startSession: (params) => ipcRenderer.invoke('cowork:startSession', params),
    // 其他方法...
  },
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  },
  // ... 其他命名空间

  // 不暴露：
  // - ipcRenderer.send
  // - ipcRenderer.sendSync
  // - require
  // - process
});
```

### 2.3 IPC 类型验证

所有 IPC 调用进行参数验证：

```typescript
// main.ts - IPC handler
ipcMain.handle('cowork:startSession', (event, params) => {
  if (!params || typeof params !== 'object') {
    throw new Error('Invalid params');
  }

  if (!params.prompt || typeof params.prompt !== 'string') {
    throw new Error('Invalid prompt');
  }

  if (params.workingDirectory) {
    if (!isAbsolutePath(params.workingDirectory)) {
      throw new Error('Working directory must be absolute path');
    }
  }

  return handleStartSession(params);
});
```

---

## 3. 权限控制

### 3.1 工具分类

| 级别 | 工具类型 | 示例 | 授权方式 |
|------|----------|------|----------|
| `low` | 信息读取 | read_file, list_directory | 可设置会话级授权 |
| `medium` | 文件修改 | write_file, create_directory | 必须单次授权 |
| `high` | 系统操作 | execute_command, network_request | 必须单次授权，显示警告 |
| `critical` | 危险操作 | delete_recursive, install_package | 必须单次授权，双重确认 |

### 3.2 权限请求流程

```
Agent → Engine Router: 调用工具 write_file
Engine Router → Main Process: 发起权限请求
Main Process → Renderer: permissionRequest event
Renderer → User: 显示权限 Modal
User → Renderer: 点击"允许"或"拒绝"
Renderer → Main Process: respondToPermission
Main Process → Engine Router: 权限响应

  允许 → Engine Router → Agent: 执行工具
  拒绝 → Engine Router → Agent: 工具被拒绝
```

### 3.3 权限请求结构

```typescript
interface PermissionRequest {
  sessionId: string;
  permissionId: string;         // 请求 ID
  toolName: string;             // 工具名称
  toolInput: Record<string, unknown>; // 工具输入
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  description: string;          // 工具用途描述
  warnings?: string[];          // 风险警告
}

interface PermissionResponse {
  sessionId: string;
  permissionId: string;
  approved: boolean;
  scope: 'single' | 'session';  // 单次或会话级
}
```

### 3.4 风险评估

```typescript
function assessRiskLevel(toolName: string, toolInput: Record<string, unknown>): RiskLevel {
  const toolRiskMap: Record<string, RiskLevel> = {
    'read_file': 'low',
    'list_directory': 'low',
    'write_file': 'medium',
    'create_directory': 'medium',
    'execute_command': 'high',
    'web_search': 'medium',
    'network_request': 'high',
    'delete_file': 'high',
    'delete_directory': 'critical',
  };

  let level = toolRiskMap[toolName] || 'medium';

  // 根据输入动态调整风险级别
  if (toolName === 'execute_command' && isDangerousCommand(toolInput.command)) {
    level = 'critical';
  }

  if (toolName === 'write_file' && isSystemPath(toolInput.file_path)) {
    level = 'critical';
  }

  return level;
}

function isDangerousCommand(command: string): boolean {
  const dangerousPatterns = [
    /rm\s+-rf/,
    /sudo/,
    /chmod\s+777/,
    /mkfs/,
    /dd\s+if=/,
    />\s*\/dev\/sd/,
    /curl\s+.*\|\s*bash/,
    /wget\s+.*\|\s*sh/,
  ];
  return dangerousPatterns.some(p => p.test(command));
}
```

### 3.5 工作目录边界

所有文件操作限制在工作目录内：

```typescript
function isWithinWorkingDirectory(filePath: string, workingDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedWorkingDir = path.resolve(workingDir);
  return resolvedPath.startsWith(resolvedWorkingDir);
}

function validateFilePath(toolInput: Record<string, unknown>, workingDir: string): void {
  const filePath = toolInput.file_path || toolInput.path;
  if (filePath && !isWithinWorkingDirectory(filePath, workingDir)) {
    throw new Error(`路径 ${filePath} 超出工作目录 ${workingDir}`);
  }
}
```

### 3.6 权限 Modal UI

**文件**: `src/renderer/components/cowork/CoworkPermissionModal.tsx`

显示工具调用请求，根据风险等级显示不同 UI，支持单次/会话级授权。

---

## 4. 内容安全

### 4.1 DOMPurify 净化

SVG 和用户输入 HTML 使用 DOMPurify 净化：

```typescript
import DOMPurify from 'dompurify';

// 净化 SVG
const cleanSvg = DOMPurify.sanitize(svgContent, {
  USE_PROFILES: { svg: true },
  FORBID_TAGS: ['script', 'iframe'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick'],
});

// 净化 HTML
const cleanHtml = DOMPurify.sanitize(htmlContent, {
  ALLOWED_TAGS: ['p', 'div', 'span', 'a', 'img', 'h1', 'h2', 'h3', 'ul', 'li'],
  ALLOWED_ATTR: ['href', 'src', 'class', 'id'],
});
```

### 4.2 Mermaid Strict Mode

Mermaid 图表使用严格安全模式：

```typescript
mermaid.initialize({
  securityLevel: 'strict',  // 禁止点击事件和脚本
  startOnLoad: false,
});
```

### 4.3 iframe 隔离

用户生成内容在隔离 iframe 中渲染：

```html
<iframe
  srcDoc={htmlContent}
  sandbox="allow-scripts"
  <!-- 不包含: allow-same-origin, allow-forms, allow-popups -->
/>
```

---

## 5. Secrets 管理

### 5.1 环境变量注入

API Keys 和 Secrets 通过环境变量注入，不硬编码：

```typescript
// Gateway 环境变量
const gatewayEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  // ... 其他 Provider API Keys
};

// 启动 Gateway
spawn(gatewayPath, [], { env: { ...process.env, ...gatewayEnv } });
```

### 5.2 安全凭证存储

敏感配置使用 Electron `safeStorage` 加密：

```typescript
// API Key 加密存储
function encryptApiKey(key: string): string {
  return safeStorage.encryptString(key).toString('base64');
}

function decryptApiKey(encrypted: string): string {
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}
```

### 5.3 配置文件安全

OpenClaw 配置不包含明文 Secrets：

```yaml
# managed.yaml - Secrets 通过环境变量引用
channels:
  dingtalk:
    accounts:
      acc1:
        clientId: xxx
        clientSecretEnv: JUSTDO_DINGTALK_CLIENT_SECRET  # 环境变量名
```

---

## 6. 网络安全

### 6.1 HTTPS 强制

所有外部 API 调用使用 HTTPS：

```typescript
function validateApiUrl(url: string): void {
  if (!url.startsWith('https://')) {
    throw new Error('API URL 必须使用 HTTPS');
  }
}
```

### 6.2 Gateway 通信安全

JustDo 与 OpenClaw Gateway 之间的通信通过本地 IPC 或 localhost HTTP 进行，不暴露到外部网络。

### 6.3 Rate Limiting

API 调用实施速率限制：

```typescript
class RateLimiter {
  private requests: Map<string, number[]> = new Map();

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now();
    const requests = this.requests.get(key) || [];
    const validRequests = requests.filter(t => t > now - windowMs);

    if (validRequests.length >= maxRequests) {
      return false; // 超过限制
    }

    validRequests.push(now);
    this.requests.set(key, validRequests);
    return true;
  }
}
```

---

## 7. 日志安全

### 8.1 敏感信息过滤

```typescript
function sanitizeLogMessage(message: string): string {
  message = message.replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=REDACTED');
  message = message.replace(/secret[=:]\s*\S+/gi, 'secret=REDACTED');
  message = message.replace(/token[=:]\s*\S+/gi, 'token=REDACTED');
  message = message.replace(/password[=:]\s*\S+/gi, 'password=REDACTED');
  return message;
}
```

### 8.2 错误信息脱敏

用户可见的错误信息不包含敏感细节：

```typescript
function sanitizeErrorMessage(error: Error): string {
  let message = error.message.replace(/\/Users\/\w+/g, '/Users/xxx');
  message = message.replace(/C:\\Users\\\w+/g, 'C:\\Users\\xxx');
  message = message.replace(/https:\/\/[^\s]+/g, 'https://api.example.com');
  return message;
}
```

---

## 8. 安全清单

### 9.1 提交前检查

- [ ] 无硬编码密钥（API keys, passwords, tokens）
- [ ] 所有用户输入已验证
- [ ] SQL 注入防护（使用参数化查询）
- [ ] XSS 防护（HTML/SVG 已净化）
- [ ] CSRF 保护启用
- [ ] 认证/授权已验证
- [ ] 所有端点启用 Rate Limiting
- [ ] 错误信息不泄露敏感数据

### 9.2 代码审查重点

- 文件路径操作：检查工作目录边界
- 网络请求：检查 HTTPS 和域名限制
- 子进程执行：检查命令危险度
- 用户输入：检查净化和验证
- Secrets 存储：检查加密和环境变量

---

## 9. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/main/main.ts` | BrowserWindow 安全配置 |
| `src/main/preload.ts` | Preload 安全桥接 |
| `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` | 权限请求处理 |
| `src/main/libs/commandSafety.ts` | 危险命令检测 |
| `src/renderer/components/cowork/CoworkPermissionModal.tsx` | 权限请求 UI |
