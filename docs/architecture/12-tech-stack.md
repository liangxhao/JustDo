# GucciAI 技术栈与依赖说明

## 1. 概述

GucciAI 基于 Electron + React 技术栈，采用 TypeScript 开发，使用 Vite 构建。核心 Agent 引擎为 OpenClaw，数据存储使用 SQLite。

## 2. 核心技术栈

### 2.1 框架层

| 技术 | 版本 | 用途 |
|------|------|------|
| **Electron** | 41.2.0 | 跨平台桌面应用框架 |
| **React** | 18.2.0 | UI 组件框架 |
| **TypeScript** | 5.7.3 | 类型安全的 JavaScript |
| **Vite** | 5.1.4 | 前端构建工具 |
| **Redux Toolkit** | 2.2.1 | 状态管理 |
| **Tailwind CSS** | 3.4.1 | 样式框架 |

### 2.2 Agent 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **OpenClaw** | v2026.6.9 | 主要 Agent 引擎 |
| **@anthropic-ai/claude-agent-sdk** | 0.2.12 | 内置 Agent SDK（弃用但保留） |
| **@modelcontextprotocol/sdk** | 1.27.1 | MCP 协议 SDK |

### 2.3 数据层

| 技术 | 版本 | 用途 |
|------|------|------|
| **better-sqlite3** | 12.8.0 | SQLite 数据库 |

### 2.4 UI 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **@headlessui/react** | 1.7.18 | 无样式 UI 组件 |
| **@heroicons/react** | 2.1.1 | SVG 图标库 |
| **react-markdown** | 10.0.0 | Markdown 渲染 |
| **remark-gfm** | 4.0.1 | GitHub Flavored Markdown |
| **remark-math** | 6.0.0 | 数学公式支持 |
| **rehype-katex** | 7.0.1 | LaTeX 渲染 |
| **mermaid** | 10.9.5 | 流程图渲染 |
| **dompurify** | 3.3.1 | HTML/SVG 净化 |

### 2.5 IM 层

> IM 平台 SDK 将在集成后添加。

### 2.6 其他工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **electron-log** | 5.4.3 | 日志管理 |
| **cron-parser** | 5.5.0 | Cron 表达式解析 |
| **cronstrue** | 3.14.0 | Cron 表达式人类可读化 |
| **uuid** | 11.1.0 | UUID 生成 |
| **zod** | 4.3.6 | Schema 验证 |
| **cheerio** | 1.2.0 | HTML 解析 |
| **qrcode.react** | 4.2.0 | QR 码生成 |

## 3. 开发依赖

### 3.1 构建工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **electron-builder** | 24.12.0 | 打包分发 |
| **esbuild** | 0.21.5 | 快速打包 |
| **vite-plugin-electron** | 0.28.0 | Electron + Vite 集成 |

### 3.2 测试工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **vitest** | 4.1.0 | 单元测试 |
| **@types/better-sqlite3** | 7.6.13 | SQLite 类型定义 |

### 3.3 代码质量

| 技术 | 版本 | 用途 |
|------|------|------|
| **eslint** | 9.39.4 | 代码检查 |
| **prettier** | 3.8.1 | 代码格式化 |
| **husky** | 9.1.7 | Git hooks |
| **lint-staged** | 16.4.0 | 暂存区检查 |
| **@commitlint/cli** | 20.5.0 | 提交消息检查 |

## 4. TypeScript 配置

### 4.1 主配置（Renderer）

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/renderer/*"]
    }
  },
  "include": ["src/renderer/**/*", "src/shared/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 4.2 Electron 配置（Main）

```json
// electron-tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "CommonJS",
    "lib": ["ES2020"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "outDir": "dist-electron",
    "rootDir": "src/main"
  },
  "include": ["src/main/**/*", "src/shared/**/*"],
  "exclude": ["node_modules"]
}
```

## 5. Vite 配置

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/main.ts',
        onstart: (options) => {
          // 启动 Electron
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
      {
        entry: 'src/main/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
  server: {
    port: 5175,
  },
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
```

## 6. electron-builder 配置

```json
// electron-builder.json
{
  "appId": "com.gucciai.app",
  "productName": "GucciAI",
  "directories": {
    "output": "release"
  },
  "files": [
    "dist/**/*",
    "dist-electron/**/*",
    "package.json"
  ],
  "extraResources": [
    {
      "from": "resources/python-win",
      "to": "python-win",
      "filter": ["**/*"]
    },
    {
      "from": "release/openclaw-runtime-current.asar",
      "to": "cfmind.asar"
    }
  ],
  "mac": {
    "category": "public.app-category.productivity",
    "icon": "public/icon.icns",
    "target": ["dmg"]
  },
  "win": {
    "icon": "public/icon.ico",
    "target": ["nsis"]
  },
  "linux": {
    "icon": "public/icon.png",
    "target": ["AppImage", "deb"]
  }
}
```

## 7. NPM Scripts

### 7.1 开发命令

```bash
# 开发模式（Vite + Electron hot reload）
npm run electron:dev

# 开发模式（含 OpenClaw 引擎）
npm run electron:dev:openclaw

# 仅启动 Vite
npm run dev

# TypeScript 编译（仅 Electron）
npm run compile:electron
```

### 7.2 构建命令

```bash
# 生产构建
npm run build

# ESLint 检查
npm run lint

# Prettier 格式化
npm run format

# 运行测试
npm test
```

### 7.3 打包命令

```bash
# macOS
npm run dist:mac          # .dmg
npm run dist:mac:x64      # Intel
npm run dist:mac:arm64    # Apple Silicon
npm run dist:mac:universal # 双架构

# Windows
npm run dist:win          # .exe NSIS

# Linux
npm run dist:linux        # .AppImage + .deb
```

### 7.4 OpenClaw 命令

```bash
# 确保 OpenClaw 版本
npm run openclaw:ensure

# 应用 patches
npm run openclaw:patch

# 安装 plugins
npm run openclaw:plugins

# 同步本地扩展
npm run openclaw:extensions:local

# 打包 gateway
npm run openclaw:bundle

# 预编译扩展
npm run openclaw:precompile

# 清理 runtime
npm run openclaw:prune

# 构建 runtime（各平台）
npm run openclaw:runtime:host     # 当前平台
npm run openclaw:runtime:mac-arm64
npm run openclaw:runtime:win-x64
npm run openclaw:runtime:linux-x64
```

### 7.5 Skills 命令

```bash
# 构建 web-search skill
npm run build:skill:web-search

# 构建 tech-news skill
npm run build:skill:tech-news

# 构建 email skill
npm run build:skill:email

# 构建所有 skills
npm run build:skills
```

## 8. 环境变量

### 8.1 OpenClaw 相关

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCLAW_FORCE_INSTALL` | 强制重新安装预构建运行时 | — |

### 8.2 IM Secrets

> IM 平台相关环境变量将在集成后定义。

### 8.3 Python Runtime（Windows 打包）

| 变量 | 说明 |
|------|------|
| `GUCCIAI_PORTABLE_PYTHON_ARCHIVE` | 本地预构建 Python runtime 路径 |
| `GUCCIAI_PORTABLE_PYTHON_URL` | Python runtime 下载 URL |
| `GUCCIAI_WINDOWS_EMBED_PYTHON_VERSION` | Windows Python 版本 |

## 9. 版本管理

### 9.1 应用版本

在 `package.json` 中声明：

```json
{
  "version": "2026.4.12"
}
```

### 9.2 OpenClaw 版本

在 `package.json` 中声明：

```json
{
  "openclaw": {
    "version": "v2026.6.9",
    "repo": "https://github.com/openclaw/openclaw.git",
    "plugins": []
  }
}
```

### 9.3 Node.js 版本要求

```json
{
  "engines": {
    "node": ">=24 <25"
  }
}
```

## 10. 目录结构

```
GucciAI/
├── package.json              # 依赖和脚本定义
├── package-lock.json         # 依赖锁定
├── tsconfig.json             # Renderer TypeScript 配置
├── electron-tsconfig.json    # Main TypeScript 配置
├── vite.config.ts            # Vite 构建配置
├── electron-builder.json     # 打包配置
│
├── public/                   # 静态资源
│   ├── logo.png
│   ├── icon.icns             # macOS 图标
│   ├── icon.ico              # Windows 图标
│   └── icon.png              # Linux 图标
│
├── src/
│   ├── main/                 # Electron 主进程
│   ├── renderer/             # React UI
│   ├── shared/               # 共享代码
│   ├── scheduledTask/        # 定时任务
│   └── common/               # 公共代码
│
├── resources/skills/                   # Skills 定义
│   ├── skills.config.json
│   ├── web-search/
│   ├── docx/
│   ├── xlsx/
│   ├── pptx/
│   └── ...
│
├── scripts/                  # 构建脚本
│   ├── setup-python-runtime.js
│   └── ...
│
├── openclaw-extensions/      # OpenClaw 本地扩展
│   ├── mcp-bridge/
│   ├── ask-user-question/
│   └── ...
│
├── tests/                    # 测试文件
│   ├── openclawConfigSync.test.mjs
│   └── ...
│
├── docs/                     # 设计文档
│   ├── README.md
│   ├── 01-overview.md
│   └── ...
│
├── release/                  # 打包输出
│
├── dist/                     # Vite 构建输出
│
├── dist-electron/            # Electron 编译输出
│
└── resources/                # 打包资源
    └── python-win/           # Windows Python runtime
```

## 11. 依赖更新策略

### 11.1 安全更新

定期检查安全漏洞：

```bash
npm audit
npm audit fix
```

### 11.2 OpenClaw 更新

更新 OpenClaw 版本：

1. 修改 `package.json` 中的 `openclaw.version`
2. 运行 `npm run electron:dev:openclaw`
3. 自动 checkout 新版本并构建
4. 提交 `package.json` 更新

### 11.3 主要依赖升级

遵循以下原则：
- Electron：跟随最新稳定版
- React：跟随最新稳定版
- TypeScript：跟随最新稳定版
- Node.js：锁定 24.x（engines 定义）

## 12. 关键依赖说明

### 12.1 better-sqlite3

同步 API 的 SQLite 库，高性能：

```typescript
import Database from 'better-sqlite3';

const db = new Database('gucciai.sqlite');
db.pragma('journal_mode = WAL'); // WAL 模式

// 同步操作
const row = db.get('SELECT * FROM kv WHERE key = ?', ['appConfig']);
```

### 12.2 react-markdown + remark-gfm

完整 Markdown 渲染支持：

```typescript
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

<ReactMarkdown
  remarkPlugins={[remarkGfm, remarkMath]}
  rehypePlugins={[rehypeKatex]}
>
  {content}
</ReactMarkdown>
```

### 12.3 electron-log

主进程日志管理，自动写入日志文件：

```typescript
import log from 'electron-log';

// 日志文件位置
// macOS: ~/Library/Logs/GucciAI/
// Windows: %USERPROFILE%\AppData\Roaming\GucciAI\logs\
// Linux: ~/.config/GucciAI/logs/

log.info('Session started');
log.error('Failed to start engine:', error);
```

### 12.4 uuid

唯一 ID 生成：

```typescript
import { v4 as uuidv4 } from 'uuid';

const sessionId = uuidv4();
// 'abc123-def456-...'
```