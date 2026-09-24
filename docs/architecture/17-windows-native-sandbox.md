# Windows 原生任务沙盒：准入、配置与失效边界

Windows 可选命令沙盒使用官方 mxc 后端及短生命周期 ProcessContainer。它限制 Gateway 发起的命令与文件工具，不限制整个 Main、模型网络请求或应用内浏览器；它也不替代 Electron Renderer sandbox。

## 1. 用户选择如何变成执行策略

默认 executionMode=local，旧 container/auto 归一化到 local。选择 sandbox 之前，WindowsSandboxService 检查平台、插件、固定二进制、broker 与真实隔离进程；失败不降级到 host exec。

```mermaid
flowchart LR
  UI[安全设置] --> IPC[WindowsSandbox IPC]
  IPC --> Probe[二进制 / broker / 真实探针]
  Probe --> Config[受管配置同步]
  Config --> Gateway[Gateway]
  Gateway --> MXC[mxc 插件]
  MXC --> PC[短生命周期 ProcessContainer]
  PC --> Result[原生命令 / 文件结果]
```

本机模式显式关闭 mxc，不要求所有 Windows 机器具有可用 ProcessContainer。状态获取、初始化、修复和打开诊断是不同操作，查询状态本身不应默默提权修复系统。

## 2. 就绪状态的含义

共享状态包括 unsupported_platform、plugin_missing、broker_unavailable、host_preparation_recommended、ready、check_failed，并附 supported/helperAvailable/initialized/ready 等字段。

插件目录存在只通过第一层检查。服务验证 wxc-exec 和 wxc-host-prep 的 SHA-256，再实际运行无网络 ProcessContainer；成功探针按执行器 hash 缓存。更换二进制不能复用旧成功结果。

系统盘准备通过沙盒内执行目录枚举判断，不解析本地化 icacls 字符串。缺少相关 ACE 可以是建议准备而不是完全不可用；UI 应区别“可运行但枚举受限”和“无法创建隔离进程”。

## 3. 文件与网络能力

工作区可读写，物化 Skill 与必要系统路径只读，未授权宿主路径不可见。命令结束销毁容器，不创建长期本地沙盒账号。取消、超时和子进程清理必须作用到原生隔离执行，不能只关闭等待 Promise。

默认 network=none。用户显式允许联网后使用 default 和 internetClient capability；当前没有域名白名单。开启网络不改变文件系统授权，也不等于允许访问所有宿主文件。

MXC SDK 的请求 envelope 仍可能进入原生进程 argv，具备宿主进程检查权限的同用户可能观察。长期密钥不应作为沙盒命令/env 参数；不能把 AppContainer 描述成对宿主管理员保密的边界。

## 4. 原生配置投影

sandbox 模式生成 agents.defaults.sandbox 的 mode=all、backend=mxc、scope=session、workspaceAccess=rw，tools.exec.host=sandbox 与 fs.workspaceOnly=true，并启用 mxc 的 processcontainer containment。

这些是全局后端选择与基础策略；会话 mode/root 仍按每次准入核对。单个会话失败不能悄悄切到 local 或全局 full。手动修改生成后的 JSON 也不是产品设置的长期权威。

OpenClaw 的 Docker 风格 Skill 物化默认可能形成“可写工作区内嵌只读目录”，ProcessContainer 无法安全表达该重叠。当前版本补丁为 mxc 使用工作区外物化路径并授只读，Docker/SSH 语义不受改写。

## 5. 显式系统准备

用户可在设置页触发带 UAC 的 wxc-host-prep prepare-system-drive。提权前和提权后的 helper 都重新验证固定 hash 与 Microsoft Authenticode，防止安装文件被替换后执行。

系统准备不是每轮工具执行的隐式前置，更不能为普通状态查询弹提权。拒绝 UAC、helper 缺失或签名验证失败应返回明确错误，保留 local 模式的选择。

## 6. 构建和升级责任

Windows runtime 携带 @openclaw/mxc-sandbox@2026.9.2 与锁定 SDK 0.7.0。需检查插件 ID、backend 注册、执行器、host-prep、launcher、目标架构 node-pty 和第三方许可证。二进制清单在 shared/security/mxcNativeBinaries.json。

运行时从 pristine 包构建并应用当前 skill path 补丁；不能在历史补丁产物上补字符串。macOS/Linux 不携带或启用 mxc，文档和 UI 不应显示跨平台通用沙盒承诺。

## 7. 验证矩阵与排障

| 场景                                        | 预期                        |
| ------------------------------------------- | --------------------------- |
| workspace 内读写                            | 按 session 权限正常执行     |
| workspace 外路径                            | 拒绝，不回退 host           |
| bundled/managed/project Skill 副本          | 只读可用，来源路径正确      |
| read/write/edit/apply_patch/stat 等文件工具 | 走有效后端，不漏回宿主      |
| network=none                                | 连接失败，子进程继承隔离    |
| 取消/超时                                   | 原生进程结束，无残留执行    |
| broker/插件/二进制损坏                      | fail closed，可诊断         |
| 中文、空格和自定义安装路径                  | 正确解析，不依赖 shell 拼接 |

先看 WindowsSandboxService 的具体 status 和 diagnostics，再查原生 backend 注册与 Gateway 日志。服务测试可验证策略分支，真实隔离验收需在目标 Windows/架构上运行，不能用 mock 探针替代。
