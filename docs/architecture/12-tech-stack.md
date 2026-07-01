# JustDo 技术栈与依赖说明

## 1. 概述

JustDo 基于 Electron + React 技术栈，采用 TypeScript 开发，使用 Vite 构建。核心 Agent 引擎为 OpenClaw Gateway（以预构建 npm 包方式分发），数据存储使用 SQLite（UI 缓存层），消息渲染采用 Lit 自定义元素。

## 2. 核心技术栈

### 2.1 框架层

| 技术 | 版本 | 用途 |
|------|------|------|
| **Electron** | ^41.2.0 | 跨平台桌面应用框架 |
| **React** | ^18.2.0 | UI 组件框架（状态管理、设置、布局） |
| **React DOM** | ^18.2.0 | React DOM 渲染器 |
| **TypeScript** | ^5.7.3 | 类型安全的 JavaScript |
| **Vite** | ^5.1.4 | 前端构建工具 |
| **Redux Toolkit** | ^2.2.1 | 状态管理 |
| **Tailwind CSS** | ^3.4.1 | 样式框架 |

### 2.2 Agent 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **OpenClaw Gateway** | v2026.6.9 | 单一 Agent 引擎（预构建 npm 包） |
| **@modelcontextprotocol/sdk** | ^1.27.1 | MCP 协议 SDK |

> **注意**：`@anthropic-ai/claude-agent-sdk` 已弃用并移除。JustDo 仅使用 OpenClaw Gateway 作为唯一 Agent 引擎，不维护任何双引擎架构。

### 2.3 数据层

| 技术 | 版本 | 用途 |
|------|------|------|
| **better-sqlite3** | ^12.8.0 | SQLite 数据库（UI 缓存） |

### 2.4 UI 层

| 技术 | 版本 | 用途 |
|------|------|------|
| **@dnd-kit/core** | ^6.3.1 | 拖放功能 |
| **@heroicons/react** | ^2.1.1 | SVG 图标库 |
| **@monaco-editor/react** | ^4.7.0 | Monaco 代码编辑器 |
| **highlight.js** | ^11.11.1 | 代码语法高亮 |
| **katex** | ^0.16.21 | LaTeX 数学公式渲染 |
| **lit** | ^3.3.3 | Lit 自定义元素（`<justdo-chat>` 消息渲染） |
| **markdown-it** | ^14.2.0 | Markdown 解析 |
| **markdown-it-task-lists** | ^2.1.1 | 任务列表扩展 |
| **mermaid** | ^10.9.5 | 流程图渲染 |
| **react-markdown** | ^10.0.0 | React Markdown 渲染 |
| **react-syntax-highlighter** | ^15.6.1 | 代码块语法高亮 |
| **rehype-katex** | ^7.0.1 | KaTeX React 集成 |
| **remark-gfm** | ^4.0.1 | GitHub Flavored Markdown |
| **remark-math** | ^6.0.0 | 数学公式支持 |
| **dompurify** | ^3.3.1 | HTML/SVG 净化 |

### 2.5 聊天渲染层

消息渲染采用 Lit 自定义元素 `<justdo-chat>`，与 OpenClaw webchat 一致的渲染管线：

| 组件 | 路径 | 用途 |
|------|------|------|
| `<justdo-chat>` Lit Element | `src/renderer/libs/openclaw-chat/components/justdo-chat.ts` | 消息列表渲染 |
| GatewayClient | `src/renderer/libs/openclaw-chat/gateway/client.ts` | Gateway WebSocket 连接 |
| ChatController | `src/renderer/libs/openclaw-chat/gateway/chat-controller.ts` | 聊天状态与事件管理 |
| buildChatItems | `src/renderer/libs/openclaw-chat/pipeline/build-chat-items.ts` | 消息管线处理 |
| grouped-render | `src/renderer/libs/openclaw-chat/components/grouped-render.ts` | 消息组分段渲染 |
| tool-display | `src/renderer/libs/openclaw-chat/components/tool-display.ts` | 工具调用显示 |

### 2.6 其他工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **electron-log** | ^5.4.3 | 日志管理 |
| **cronstrue** | ^3.14.0 | Cron 表达式人类可读化 |
| **js-yaml** | ^4.1.1 | YAML 解析 |
| **uuid** | ^11.1.0 | UUID 生成 |

### 2.7 主题系统

JustDo 内置 14 套完整主题，位于 `src/renderer/theme/themes/`：

| 主题 | 说明 |
|------|------|
| `classic-light` / `classic-dark` | 经典浅色/深色 |
| `cyber` | 赛博风格 |
| `dawn` | 黎明 |
| `daylight` | 日光 |
| `emerald` | 翡翠绿 |
| `midnight` | 午夜深色 |
| `mocha` | 摩卡咖啡 |
| `nord` | 北欧极简 |
| `ocean` | 海洋蓝 |
| `paper` | 纸张质感 |
| `rose` | 玫瑰粉 |
| `sakura` | 樱花 |
| `sunset` | 日落 |

主题引擎在 `src/renderer/theme/engine/`，通过 CSS 自定义属性和 Tailwind 配置实现。

## 3. 开发依赖

### 3.1 构建工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **electron-builder** | ^24.12.0 | 打包分发 |
| **esbuild** | ^0.21.5 | 快速打包 |
| **vite-plugin-electron** | ^0.28.0 | Electron + Vite 集成 |

### 3.2 测试工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **vitest** | ^4.1.0 | 单元测试 |
| **@types/better-sqlite3** | ^7.6.13 | SQLite 类型定义 |

### 3.3 代码质量

| 技术 | 版本 | 用途 |
|------|------|------|
| **eslint** | ^9.39.4 | 代码检查 |
| **prettier** | ^3.8.1 | 代码格式化 |
| **husky** | ^9.1.7 | Git hooks |
| **lint-staged** | ^16.4.0 | 暂存区检查 |
| **@commitlint/cli** | ^20.5.0 | 提交消息检查 |

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
        onstart: (options) => { /* 启动 Electron */ },
        vite: { build: { outDir: 'dist-electron' } },
      },
      {
        entry: 'src/main/preload.ts',
        vite: { build: { outDir: 'dist-electron' } },
      },
    ]),
    renderer(),
  ],
  server: { port: 5175 },
  build: { outDir: 'dist' },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/renderer') },
  },
});
```

## 6. electron-builder 配置

```json
// electron-builder.json
{
  "appId": "com.justdo.app",
  "productName": "JustDo",
  "directories": { "output": "release" },
  "files": ["dist/**/*", "dist-electron/**/*", "package.json"],
  "extraResources": [
    {
      "from": "release/openclaw-runtime-current.asar",
      "to": "cfmind.asar"
    }
  ],
  "mac": {
    "category": "public.app-category.productivity",
    "target": ["dmg"]
  },
  "win": { "target": ["nsis"] },
  "linux": { "target": ["AppImage", "deb"] }
}
```

> **注意**：`resources/python-win` 已不再打包在 electron-builder 配置中。Windows Python 运行时通过 `setup:python-runtime` 脚本动态处理。

## 7. NPM Scripts

### 7.1 开发命令

```bash
# 开发模式（Vite + Electron hot reload）
npm run electron:dev

# 开发模式（含 OpenClaw 运行时）
npm run electron:dev:openclaw

# 仅启动 Vite dev server
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
npm run dist:mac              # Apple Silicon (arm64)
npm run dist:mac:x64          # Intel
npm run dist:mac:arm64        # Apple Silicon
npm run dist:mac:universal    # 双架构

# Windows
npm run dist:win              # .exe NSIS

# Linux
npm run dist:linux            # .AppImage + .deb
```

### 7.4 OpenClaw 运行时管理

```bash
# 构建运行时（各平台）
npm run openclaw:runtime:host           # 当前平台
npm run openclaw:runtime:mac-arm64
npm run openclaw:runtime:mac-x64
npm run openclaw:runtime:win-x64
npm run openclaw:runtime:win-arm64
npm run openclaw:runtime:linux-x64
npm run openclaw:runtime:linux-arm64

# 运行时辅助
npm run openclaw:plugins                # 安装 plugins
npm run openclaw:extensions:local       # 同步本地扩展
npm run openclaw:bundle                 # 打包 gateway
npm run openclaw:precompile             # 预编译扩展
npm run openclaw:prune                  # 清理运行时
```

> **注意**：`openclaw:ensure`、`openclaw:patch` 脚本已移除。Runtime 以预构建 npm 包形式下载，无需本地构建操作。Skills 由 OpenClaw Gateway 管理，本地不执行构建。

## 8. 环境变量

### 8.1 OpenClaw 相关

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENCLAW_FORCE_INSTALL` | 强制重新安装预构建运行时 | — |

## 9. 版本管理

### 9.1 应用版本

在 `package.json` 中声明：

```json
{
  "version": "2026.7.1"
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

OpenClaw 运行时以预构建 npm 包方式分发，通过平台特定脚本下载（`openclaw:runtime:*`）。

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
JustDo/
├── package.json              # 依赖和脚本定义
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
│   │   ├── main.ts           # 入口
│   │   ├── preload.ts        # contextBridge 安全层
│   │   ├── coworkStore.ts    # Cowork 数据 CRUD
│   │   ├── core/             # 核心应用工具
│   │   ├── data/             # 数据层 (sqliteStore.ts)
│   │   ├── features/         # 功能管理
│   │   ├── ipcHandlers/      # IPC 处理模块
│   │   └── libs/             # 领域分组库 (agentEngine/cowork/infra/mcp/openclaw)
│   │
│   ├── renderer/             # React UI + Lit chat
│   │   ├── App.tsx           # 根组件
│   │   ├── theme/            # 主题系统
│   │   │   ├── engine/       # 主题引擎
│   │   │   ├── themes/       # 14 套主题定义
│   │   │   ├── tailwind/     # Tailwind 主题集成
│   │   │   └── tokens/       # 设计令牌
│   │   ├── components/       # UI 组件
│   │   │   ├── cowork/       # Cowork 相关组件
│   │   │   │   ├── JustDoChatWrapper.tsx   # React ↔ Lit 桥接
│   │   │   │   ├── CoworkView.tsx
│   │   │   │   ├── CoworkSessionList.tsx
│   │   │   │   └── ...
│   │   │   └── ...
│   │   ├── libs/
│   │   │   └── openclaw-chat/ # Lit 聊天渲染管线
│   │   │       ├── gateway/   # GatewayClient + ChatController
│   │   │       ├── components/# Lit 组件
│   │   │       ├── pipeline/  # 消息处理管线
│   │   │       ├── conversion/# 数据转换
│   │   │       └── shims/     # 兼容层
│   │   ├── store/             # Redux store
│   │   └── types/             # TypeScript 类型
│   │
│   ├── scheduledTask/         # 定时任务（cron 引擎、元数据）
│   └── shared/                # 共享常量和类型
│
├── resources/skills/          # 17 个内置技能定义（Gateway 管理）
│
├── scripts/                   # 构建和工具脚本
│   ├── install-openclaw-runtime.cjs
│   ├── openclaw-runtime-host.cjs
│   ├── setup-python-runtime.js
│   └── ...
│
├── openclaw-extensions/       # OpenClaw 本地扩展
│   ├── mcp-bridge/
│   └── ask-user-question/
│
├── tests/                     # 测试文件
│
└── docs/                      # 设计文档
```

## 11. 关键依赖说明

### 11.1 Lit + `<justdo-chat>`（消息渲染）

JustDo 使用 Lit 自定义元素 `<justdo-chat>` 渲染聊天消息，替代了原有的 React CoworkSessionDetail（3800+ 行）。Lit 元素直接通过 GatewayClient 连接 Gateway WebSocket，使用与 OpenClaw webchat 完全一致的渲染管线。

```typescript
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';

@customElement('justdo-chat')
export class JustDoChatElement extends LitElement {
  // 通过 ChatController 连接 Gateway
  set controller(ctrl: ChatController) { /* ... */ }
}
```

在 React 中通过 `JustDoChatWrapper.tsx` 嵌入。

### 11.2 better-sqlite3

同步 API 的 SQLite 库，高性能：

```typescript
import Database from 'better-sqlite3';

const db = new Database('justdo.sqlite');
db.pragma('journal_mode = WAL'); // WAL 模式
```

### 11.3 markdown-it + highlight.js + katex

Lit 聊天组件中的 Markdown 渲染链：

```typescript
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

const md = new MarkdownIt({
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(str, { language: lang }).value;
    }
    return '';
  }
});
```

### 11.4 electron-log

主进程日志管理，自动写入日志文件：

```typescript
import log from 'electron-log';
// macOS: ~/Library/Logs/JustDo/
// Windows: %USERPROFILE%\AppData\Roaming\JustDo\logs\
// Linux: ~/.config/JustDo/logs/
```

## 12. 版本信息

- **Last Updated**: 2026-07-01
- **JustDo Version**: v2026.7.1
- **OpenClaw Gateway**: v2026.6.9
- **Node.js**: >= 24 < 25
