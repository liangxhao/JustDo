# OpenClaw v2026.9.6 验收记录

以下为升级当时的验证快照，该应用构建未发布；本次整理未重新执行验证。

## 打包与验证边界

- Node engine 下限为 24.16；开发 Node 24.21 与 Electron 42.7.0 内置 Node 24.18 均满足要求。
- 新增 node-host launcher 的相对路径按原始 dist 入口解析；Windows SQLite 快照检查需要 Koffi，运行时裁剪必须保留其加载器与原生模块。
- 补丁写入产物证明前检查 Gateway 与两个 worker 的 JavaScript 语法，失败回滚；专门测试覆盖打包去注释、变量改名、worker 内重复导入及语法失败。
- Windows x64 验证包含从锁定包重建、8 个本地扩展预编译、Gateway 独立临时状态启动和原生 RPC 握手。模型推理、真实账户调用及 macOS/Linux 安装包需在相应环境另行验收。

完成 `npm run openclaw:runtime:host` 后可运行 `node tests/openclaw/runtime/gateway-smoke.cjs`，或传入目标运行时目录。脚本为 HOME、状态、配置和工作区创建独立临时目录，仅调用健康、会话创建和进度读取 RPC，不发起模型请求；测试日志保留在输出的临时目录。

本次最终验证：`npm run lint`、`npm run build`、24 项 runtime patch proof 均通过；`npm test` 为 548 个文件 / 5,332 项通过，42 项条件跳过。正式 Windows x64 产物使用 Electron 内置 Node 启动成功，协议 4、475 个注册方法、会话创建与进度读取通过。一次并发验证出现技能 CLI 30 秒超时，单独复核及完整重跑均通过。
