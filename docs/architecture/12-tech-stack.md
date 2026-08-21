# 技术栈

本文档记录当前 `package.json` 和构建配置中的技术栈。

## Runtime

| 项               | 当前值          |
| ---------------- | --------------- |
| Node.js          | `>=24.15.0 <25` |
| Electron         | `^42.6.0`       |
| OpenClaw Gateway | `v2026.7.1-2`   |
| Package manager  | npm             |
| Dev server port  | `43127`         |

## Frontend

| 技术                                         | 用途                           |
| -------------------------------------------- | ------------------------------ |
| React 18                                     | 应用 shell 和 feature UI       |
| React DOM                                    | DOM 渲染                       |
| Redux Toolkit                                | Renderer 状态                  |
| React Redux                                  | Store binding                  |
| Lit                                          | `<justdo-chat>` 自定义元素     |
| Tailwind CSS                                 | 样式工具                       |
| Monaco Editor                                | 编辑器能力                     |
| markdown-it / KaTeX / Mermaid / highlight.js | Markdown、公式、图表、代码高亮 |
| DOMPurify                                    | HTML sanitizer                 |

## Main Process

| 技术                                | 用途                   |
| ----------------------------------- | ---------------------- |
| better-sqlite3                      | 本地 SQLite            |
| electron-log                        | 日志                   |
| @modelcontextprotocol/sdk           | MCP                    |
| http-mitm-proxy / proxy-agent       | 代理相关               |
| js-yaml                             | 配置解析               |
| tar / yazl / extract-zip / 7zip-bin | runtime 和资源打包处理 |

## Build Tooling

| 工具                 | 用途                      |
| -------------------- | ------------------------- |
| TypeScript 5.7       | 类型检查                  |
| Vite 8               | Renderer build/dev server |
| vite-plugin-electron | Main/preload build        |
| electron-builder 26  | 桌面打包                  |
| ESLint 9             | lint                      |
| Prettier 3           | format                    |
| Vitest 4             | tests                     |
| Husky + commitlint   | commit hook               |

## Scripts

常用开发脚本：

```bash
npm run dev
npm run electron:dev
npm run electron:dev:openclaw
npm run lint
npm run build
npm run compile:electron
npm test
```

常用打包脚本：

```bash
npm run pack
npm run dist
npm run dist:win
npm run dist:mac
npm run dist:linux
```

OpenClaw runtime 脚本：

```bash
npm run openclaw:runtime:host
npm run openclaw:runtime:win-x64
npm run openclaw:runtime:mac-arm64
npm run openclaw:runtime:linux-x64
```

## CI

`.github/workflows/ci.yml` 当前包含：

- changed-files
- lint changed TypeScript files
- build renderer with `npm run build`
- build main with `npm run compile:electron`
- build skills stage when skills change
- test with `npm test`

注意：文档应跟随实际 package scripts 更新。新增或删除 CI 调用的 npm script 时，需要同时检查 `package.json` 与 workflow。

## TypeScript 配置分层

项目有多个 TypeScript 配置，分别服务不同 runtime：

| 配置                     | 作用                                        |
| ------------------------ | ------------------------------------------- |
| `tsconfig.json`          | Renderer/Vite 侧严格类型检查，ESNext module |
| `electron-tsconfig.json` | Main/preload 编译，CommonJS 目标            |
| `tsconfig.node.json`     | Vite/config 侧 Node 类型                    |
| `vitest.config.ts`       | Vitest alias 和 test environment            |

分层原因是 Main process、Renderer 和 build tooling 的 module system 不一致。Shared code 必须同时适配 Main 和 Renderer，因此不能依赖某一侧专有 API。

## Vite / Electron Build

`vite.config.ts` 同时配置 renderer、main、preload：

- Renderer 输出到 `dist/`。
- Main 和 preload 输出到 `dist-electron/`。
- Dev server 端口来自 `package.json.devServer.port`。
- `@` alias 指向 `src/renderer`。
- `@shared` alias 指向 `src/shared`。
- Mermaid 使用 core build，避免动态导入问题。

Main bundle 需要 external 部分 native/Electron/runtime 依赖，例如：

- `electron`
- `better-sqlite3`
- OpenClaw/Lark 相关包
- Discord/native optional 包

## Electron Builder

`electron-builder.json` 定义平台资源和过滤规则：

| 平台    | 输出         | 资源策略                                                                                 |
| ------- | ------------ | ---------------------------------------------------------------------------------------- |
| macOS   | DMG          | `vendor/openclaw-runtime/current` 作为 extraResources，内置 skills 随 runtime 提供       |
| Windows | NSIS         | 使用 `build-tar/win-resources.tar` 和 unpack script，内置 skills 仅保留 runtime 内的一份 |
| Linux   | AppImage/deb | runtime 作为 extraResources，内置 skills 随 runtime 提供                                 |

生产构建关闭 source map 并启用压缩。打包过滤会排除 README、license、tests、map、d.ts
以及 `compile:electron` 产生但运行时不使用的 `dist-electron/src`。新增 runtime 必需资产时要确认
不会被过滤误删。Renderer 和已打入 main bundle 的依赖属于构建依赖，不应再次进入生产
`node_modules`；生产依赖只保留 Electron 外置模块和离线运行时工具。
OpenClaw 的构建目录仍保留 `gateway.asar` 供准备和校验阶段使用，但分发包不再携带它：
Gateway 使用 `gateway-bundle.mjs`，CLI/client 回退使用已展开的 `openclaw.mjs` 和 `dist/`。
每次 `beforePack` 都会按照 `resources/builtin-skills.json` 将 `resources/skills` 全量同步到
runtime；Windows 升级安装会整目录替换 `cfmind`，避免旧版默认 skills 或已删除文件残留。

Windows 的 CPython 3.12 x64 runtime 由 `scripts/setup-python-runtime.js` 准备。除解释器和 pip
外，构建会按照 `resources/python-requirements.txt` 将精确锁定且带 wheel 哈希的 `requests`、
`PyYAML`、`openpyxl`、`pypdf`、`beautifulsoup4` 及其传递依赖安装到独立的
`Lib/bundled-site-packages`。用户后续通过 pip 安装的包保存在用户数据目录的
`runtimes/python-user`，并通过
`sitecustomize` 排在内置包之前，允许显式覆盖内置版本。Windows 主机构建完成后会导入五个顶层包；
安装、哈希或导入检查失败会终止打包。
嵌入式发行版保留 `python312._pth` 以固定基础搜索路径，因此 CPython 本身不会处理
`PYTHONPATH`；`sitecustomize` 会显式读取该变量并将其中的目录置于 `sys.path` 前部，供 skill
脚本加载自身或共享 Python 模块。路径按 Windows 的 `;` 分隔，重复项会被移除，空项按当前目录处理。
安装后 Python 解释器仅保存在应用安装目录的 `resources/python-win`，运行时直接使用该目录；启动时会
将用户自行安装的包保存在用户数据目录的 `runtimes/python-user`，并删除旧版本曾复制到
`runtimes/python-win` 的冗余解释器。旧完整环境中的 `Lib/site-packages` 不迁移；之后通过 pip 安装的
用户包会在应用升级时保留，且不会形成第二套 Python。

Windows NSIS 使用 `electron-updater` 从 Generic HTTPS 静态目录更新。feed 固化在
`scripts/windows-update-config.cjs`，打包过程不访问更新服务器，也不依赖环境变量；安装包
进入可访问该地址的内网后自动启用更新。当前内网分发未配置 Authenticode 证书，因此
`app-update.yml` 不写 publisher，下载的更新安装包不执行发布者签名匹配。
`afterAllArtifactBuild` 根据最终 EXE 和
`docs/releases/<package-version>.md` 重建 `latest.yml`，写入规范化版本、实际文件名、
SHA-512、大小、发布时间和更新说明。部署时先上传 EXE 和 blockmap，最后原子
替换短缓存或不缓存的 `latest.yml`。CI 会复算 manifest 的文件大小与 SHA-512 并检查
blockmap、feed 配置和构建标记后才上传产物。

## Native Modules

`better-sqlite3` 是 native dependency。相关脚本：

- `postinstall`: `electron-builder install-app-deps` + rebuild。
- `pretest`: `npm rebuild better-sqlite3`。
- `compile:electron`: 编译 main/preload。
- `rebuild:electron-native`: Electron ABI rebuild。

新增 native dependency 时要同步：

- `vite.config.ts` external。
- `electron-builder.json` asarUnpack 或资源策略。
- CI 安装/测试流程。

## Runtime Asset Pipeline

OpenClaw runtime 脚本大致分层：

```text
install-openclaw-runtime.cjs
  -> sync-openclaw-runtime-current.cjs
  -> bundle-openclaw-gateway.cjs
  -> ensure-openclaw-plugins.cjs
  -> sync-openclaw-runtime-resources.cjs
  -> precompile-openclaw-extensions.cjs
  -> prune-openclaw-runtime.cjs
```

平台脚本把 runtime 准备到 `vendor/openclaw-runtime/current` 或对应平台目录，再由 electron-builder 打包。

## Dependency Guidelines

新增依赖前判断：

- 是否只在 renderer 使用？避免进入 main bundle。
- 是否只在 main 使用？加入 external/asar 策略。
- 是否含 native module？确认 Electron ABI rebuild。
- 是否会增大安装包？确认是否可按需加载。
- 是否涉及安全面？检查 CSP、sanitize、权限和日志。

## Upgrade Checklist

升级核心版本时同步：

- `package.json`
- 根 README
- `docs/README.md`
- `docs/architecture/12-tech-stack.md`
- runtime patch 目录和 patch guide
- CI workflow 中 Node/npm/script 引用
