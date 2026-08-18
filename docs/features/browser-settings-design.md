# 浏览器设置设计

> 本文是设计与前置条件记录，不代表 JustDo 已经交付 extension 配对、状态管理或对应 IPC。
> 文中列出的 `src/...` 文件名是拟议实现位置。当前捆绑 OpenClaw `v2026.7.1-2`
> 已包含 upstream extension driver、relay、CLI 与配置能力，但 JustDo 的产品集成和发布流程
> 尚未完成。

## 1. 目标与版本前提

在“设置”中增加独立的“浏览器”选项卡，让用户选择 OpenClaw 浏览器运行方式，
重点解决：

1. 复用用户日常 Chrome 的登录态、Cookie、企业 SSO、扩展和网络代理。
2. 用户离开电脑后，定时任务仍能使用已登录的 Chrome。
3. 面向小白用户，正常流程不能要求输入命令、端口、路径或配对字符串。

本文最初核对了旧 runtime 与 upstream 新方案；升级后又按当前捆绑产物复核：

- 历史基线 OpenClaw `v2026.6.11` 删除了 Chrome Extension driver，只包含 managed
  browser、Chrome MCP existing-session 和 CDP。
- OpenClaw 官网当前跟随 `main` / `2026.7.x`。提交
  `d6801f23d4`（2026-07-06）重新实现了
  `driver: "extension"`，最早包含在 `v2026.7.1-beta.3`。
- JustDo 当前捆绑 OpenClaw `v2026.7.1-2`，其 npm 产物包含 browser extension driver、
  loopback relay、extension CLI 和相关配置 schema；打包 prune policy 也保留 `browser`
  extension。
- 官网的 Chrome Extension 是当前新方案，不是应当废弃的旧方案。

参考：

- 历史设计比对使用 `../openclaw` 的 `v2026.6.11` 和当时的 `origin/main`
- 当前 runtime 基准为 npm `openclaw@2026.7.1-2`
- [Browser control API](https://docs.openclaw.ai/tools/browser-control)
- [Chrome Extension](https://docs.openclaw.ai/tools/chrome-extension)

runtime 前置已经满足，但第三种模式仍不能仅靠增加一个 UI 选项上线。进入产品开发前必须完成
packaged runtime 的 driver/relay/CLI/doctor 验证、配对与凭据生命周期、状态 IPC、发布渠道和
fail-closed 测试。该能力应复用 upstream browser extension，不做 JustDo 私有 runtime patch。

## 2. 三种产品模式

| 产品模式               | OpenClaw Profile | Driver             | 登录态                    | 是否需要人在场        |
| ---------------------- | ---------------- | ------------------ | ------------------------- | --------------------- |
| 内置浏览器             | `openclaw`       | `openclaw`         | OpenClaw 独立 Profile     | 否                    |
| 用户浏览器（有人值守） | `user`           | `existing-session` | 整个当前 Chrome Profile   | 首次连接时确认        |
| 用户浏览器（无人值守） | `chrome`         | `extension`        | 用户 Chrome，仅共享标签组 | 首次安装/配对后不需要 |

设置页当前提供前两种模式供用户选择：默认使用 `openclaw` 隔离浏览器；只有用户主动选择
“允许连接你的浏览器”后，才将默认 Profile 切换为 `user` 并显示 Chrome 授权引导。模式保存到
`app_config.browserMode`，切换后通过配置同步服务安全应用，使后续会话使用新的默认 Profile。

### 2.1 内置浏览器

OpenClaw 启动隔离 Chromium Profile。隔离性好，但不会复用日常浏览器登录态，
并且 OpenClaw 默认给 managed Chrome 增加 `--no-proxy-server`。

### 2.2 用户浏览器（有人值守）

通过 Chrome DevTools MCP 自动连接日常 Chrome 会话：

- 复用整个当前 Profile 的标签页、Cookie、代理、VPN、企业证书和扩展。
- 需要 Chrome 144 或更高版本。在 `chrome://inspect/#remote-debugging` 开启
  Remote Debugging，并在首次连接时批准 Chrome 的 Allow 对话框。
- 不使用 `--remote-debugging-port`。Chrome 136 起会忽略针对默认用户数据目录的
  调试端口参数；显式 CDP 只能配合独立的 `--user-data-dir`，不能复用日常 Profile。
- OpenClaw 启动 Chrome MCP `existing-session` 子进程并传入 `--autoConnect`。

设置页提供“浏览器”选项卡，并通过主进程只读检测 Chrome 的准备状态：

- 检查 Chrome 是否安装以及 `Local State` 中的 Remote Debugging 用户开关。
- 读取默认用户目录的 `DevToolsActivePort`，并验证对应 loopback 端口是否监听。
- 文件存在但端口未监听时显示“需要完全重启 Chrome”，不把残留文件误判为可连接。
- 端口存在时解析监听进程；无人监听时明确说明它只是 Chrome 遗留记录，其他进程占用时
  显示进程名和 PID，并且不把该端口误判为可用的 Chrome 调试端点。
- 可复制 `chrome://inspect/#remote-debugging` 并聚焦 Chrome；由于 Chrome 可能丢弃外部
  进程传入的 `chrome://` URL，用户需要在地址栏粘贴后回车。端口就绪后可重启 Gateway
  并通过“测试连接”直接请求 `browser.request /tabs` 触发授权。
- Windows 下 Chrome MCP 直接使用上游 stdio transport；运行时补丁会将其 `npx` 调用
  映射到 JustDo 管理的 Electron Node 与 `npx-cli.js`，并从握手开始捕获 stderr。
- Chrome 自动连接成功但尚未建立初始页面上下文时，上游 `list_pages` 会返回
  `No page selected`；运行时会创建一个同 Profile 的空白页建立上下文，再返回标签页列表。
- 设置页不会写 Chrome 配置、删除端口文件或使用 `--remote-debugging-port=9222` 启动 Chrome。

### 2.3 用户浏览器（无人值守）

通过 OpenClaw MV3 Chrome Extension 的 `chrome.debugger` API：

- 不出现阻塞式远程调试 Allow 对话框。
- Extension relay 只监听 loopback，并使用主机本地 token 双向认证。
- Agent 只能访问 OpenClaw 标签组中的标签页，不是整个浏览器。
- 用户把标签页移出该组、再次点击扩展按钮或关闭调试提示后可立即撤销。
- Agent 新建的标签页自动进入 OpenClaw 标签组。
- 新标签页仍使用当前用户 Chrome Profile 的 Cookie、代理、VPN、证书和登录态。

这才是本产品中“用户浏览器（无人值守）”的正确技术映射。

## 3. 小白用户约束与现实边界

上游文档的默认安装流程包括：

1. 获取 unpacked extension 路径。
2. 打开 `chrome://extensions`。
3. 开启 Developer mode。
4. 选择 Load unpacked。
5. 获取 pairing string。
6. 打开扩展 popup 并粘贴配对信息。

这个流程不能直接交给 JustDo 用户。

另外，普通 Chrome 不允许桌面应用静默安装任意扩展：

- Chrome Web Store 安装需要用户确认扩展权限。
- Windows/macOS external install 仍会显示启用确认。
- 真正零交互 force-install 只适用于企业管理员策略。

因此“一键”应定义为：

- 用户只完成一次清晰的浏览器安全确认。
- JustDo 自动完成 extension 路径发现、relay 启动、token 生成、配对和健康检查。
- 用户不接触 Developer mode、文件夹、命令、端口或 pairing string。

如果连 Chrome 自己要求的安装/启用确认也不允许，则普通消费版 Chrome 无法满足；
只能使用企业策略预装，或退回 JustDo/OpenClaw 专用浏览器 Profile。

## 4. 推荐的分发与配对方案

### 4.1 企业环境：首选

将 JustDo Chrome Extension 发布到 Chrome Web Store，并为企业管理员提供
force-install policy 模板：

- IT 管理员一次部署。
- 最终用户无需安装操作。
- JustDo 启动后自动发现扩展并完成本机配对。
- 企业可用 allowlist 控制允许安装和升级的扩展 ID。

这是最符合“用户零配置”的方式。

### 4.2 普通用户：一次 Chrome 确认

需要先把扩展发布到 Chrome Web Store。JustDo 设置页的
“安装并启用”按钮负责：

1. 启动本地 extension relay。
2. 创建或读取主机本地 pairing secret。
3. 打开扩展商店安装页。
4. 等待扩展安装并连接。
5. 自动完成配对，不要求复制字符串。
6. 检测到 Connected 后自动切换默认 Profile 为 `chrome`。

Chrome Web Store 的权限确认不能由 JustDo 代点。页面应把这一步解释成
“Chrome 正在确认你允许 JustDo 控制共享标签页”，而不是技术设置。

### 4.3 自动配对机制

上游 popup 要求手工粘贴 pairing string，不符合产品约束。JustDo 需要选择一种
受控的自动配对机制：

#### 方案 A：Native Messaging，推荐

- JustDo 安装器注册固定 Native Messaging Host。
- Extension 首次运行向 Host 请求当前 Gateway endpoint 和一次性 pairing
  material。
- Main 校验 extension ID、浏览器和请求 nonce。
- Extension 完成 relay 握手后，Main 立即使一次性 material 失效。
- 长期 token 继续由 Extension 和 OpenClaw 按上游模型保管。

优点是跨页面、无固定 HTTP 端口、身份边界清晰。缺点是 Windows/macOS/Linux
都要处理 Native Messaging manifest 和安装器注册。

#### 方案 B：loopback onboarding page

- JustDo 启动短生命周期 loopback HTTP 页面。
- Extension 只允许从固定 loopback origin 接收一次性配对请求。
- 完成后立即关闭 onboarding server。

实现较轻，但 origin、端口固定、CSRF、重放和本地恶意进程抢配对的防护更复杂。

不要：

- 把长期 pairing secret 写进安装 URL 查询参数。
- 把 token 烘焙进通用 extension 包。
- 让 Renderer 读取 Gateway token。
- 在日志中打印 pairing string。

## 5. 设置页设计

在侧边栏中放在“通用”和“模型”之间，并新增独立
`BrowserSettingsTab.tsx`。

### 5.1 模式卡片

#### 内置浏览器

- 标签：默认、隔离。
- 说明：独立浏览器，不读取日常 Chrome 数据。
- 配置：显示窗口/无头、浏览器程序、网络。

#### 用户浏览器（有人值守）

- 标签：临时连接。
- 说明：复用整个 Chrome Profile；连接时需要本人在电脑前点击允许。
- 状态：Chrome 版本、远程调试状态、等待确认、已连接。
- 网络只读说明：使用用户 Chrome 自身网络设置。

#### 用户浏览器（无人值守）

- 标签：推荐用于定时任务。
- 说明：安装扩展后复用 Chrome 登录态；只控制 OpenClaw 标签组。
- 主按钮状态机：
  - 未安装：`安装并启用`
  - 等待 Chrome：`请在 Chrome 中确认安装`
  - 配对中：`正在安全连接`
  - 已连接：`已启用`
  - 断开：`重新连接`
- 用户不看到 token、端口、路径或 Profile 名。
- 网络只读说明：使用用户 Chrome 自身代理、VPN、证书和企业策略。

### 5.2 共享范围

无人值守模式必须把“标签组即授权边界”讲清楚：

- `仅共享 OpenClaw 标签组中的网页`
- `新任务打开的网页会自动进入该组`
- `将网页移出该组即可立即停止访问`

首次启用完成后，可自动打开一个普通欢迎页并放入 OpenClaw 标签组，用于确认
连接。不能自动把用户已有标签页批量加入共享组。

### 5.3 状态与诊断

页面显示：

- Extension：未安装 / 已安装。
- Relay：未启动 / 正在连接 / Connected。
- Profile：`chrome · extension`。
- 共享标签页数量。
- Gateway：已生效 / 等待重启 / 等待当前任务结束后重启。
- 操作：
  - 测试连接。
  - 打开共享测试页。
  - 暂停/恢复。
  - 解除配对。

连接测试只能读取 status 和 tabs，不读取页面正文、不截图。

## 6. JustDo 配置模型

在 `src/shared/browser.ts` 定义产品语义：

```ts
export const BrowserMode = {
  MANAGED: 'managed',
  USER_ATTENDED: 'user-attended',
  USER_UNATTENDED: 'user-unattended',
} as const;

export type BrowserSettings = {
  mode: (typeof BrowserMode)[keyof typeof BrowserMode];
  managed: {
    executablePath: string;
    headless: boolean;
    proxyMode: 'direct' | 'follow-app';
  };
  attended: {
    userDataDir: string;
  };
  unattended: {
    enabled: boolean;
  };
};
```

默认：

```ts
{
  mode: 'managed',
  managed: {
    executablePath: '',
    headless: false,
    proxyMode: 'direct',
  },
  attended: {
    userDataDir: '',
  },
  unattended: {
    enabled: false,
  },
}
```

作为 `AppConfig.browser` 存入现有 `app_config`。Pairing secret、Gateway device
token 和 relay credential 不进入 `app_config` 或 Renderer。

## 7. OpenClaw 配置映射

### 7.1 内置浏览器

```json5
{
  browser: {
    enabled: true,
    defaultProfile: 'openclaw',
  },
}
```

### 7.2 用户浏览器（有人值守）

```json5
{
  browser: {
    enabled: true,
    defaultProfile: 'user',
    profiles: {
      user: {
        driver: 'existing-session',
        attachOnly: true,
        color: '#00AA00',
      },
    },
  },
}
```

### 7.3 用户浏览器（无人值守）

```json5
{
  browser: {
    enabled: true,
    defaultProfile: 'chrome',
    profiles: {
      chrome: {
        driver: 'extension',
        color: '#FF4500',
      },
    },
  },
}
```

`buildManagedOpenClawConnectivityConfig()` 目前固定覆盖整个 `browser` 节点。
实施时新增纯函数：

```ts
buildManagedOpenClawBrowserConfig(browserSettings, proxySettings);
```

并由 `OpenClawConfigSync` 读取 JustDo 语义配置。Browser config 变化要求 Gateway
restart；有活动任务时复用现有延迟重启机制。

## 8. Main、IPC 与 Preload

新增：

```text
src/shared/openclaw/browser.ts
src/main/openclaw/browser/openclawBrowserService.ts
src/main/openclaw/browser/browserExtensionOnboardingService.ts
src/main/ipc/openclaw/browser.ts
src/renderer/features/settings/components/BrowserSettingsTab.tsx
```

窄 IPC：

```ts
const OpenClawBrowserIpc = {
  GetStatus: 'openclaw:browser:getStatus',
  TestConnection: 'openclaw:browser:testConnection',
  BeginExtensionSetup: 'openclaw:browser:beginExtensionSetup',
  CancelExtensionSetup: 'openclaw:browser:cancelExtensionSetup',
  UnpairExtension: 'openclaw:browser:unpairExtension',
} as const;
```

Main 通过 Gateway `browser.request` 或对应 extension status API 获取状态。
Renderer 不直接调用 relay，不读取 Gateway/extension credential。

状态归一化：

```ts
type BrowserConnectionStatus = {
  mode: 'managed' | 'user-attended' | 'user-unattended';
  state:
    | 'not-installed'
    | 'waiting-for-browser-confirmation'
    | 'pairing'
    | 'connected'
    | 'disconnected'
    | 'error';
  profile: 'openclaw' | 'user' | 'chrome';
  driver: 'openclaw' | 'existing-session' | 'extension';
  sharedTabCount?: number;
  message?: string;
};
```

## 9. 无人值守行为

完成一次安装和配对后：

- Gateway/JustDo 重启：relay 自动恢复，Extension 使用已保存身份重连。
- Chrome 重启：Extension 自动恢复连接。
- Agent 打开新页面：自动进入 OpenClaw 标签组，不需要用户点击。
- 已有网页：只有用户曾加入 OpenClaw 标签组后才可访问。
- 用户移出标签：立即撤销。
- Chrome 显示可关闭的调试 banner，但它不是阻塞式确认。

定时任务启动前必须检查：

1. Extension connected。
2. Gateway browser service ready。
3. `chrome` Profile 可用。

检查失败时任务应明确失败并提示“打开 Chrome”或“重新连接”，不能静默回退到
内置 Profile，避免在错误账号或未登录环境下执行。

## 10. 安全要求

- Relay 只绑定 loopback。
- Relay 两侧认证并校验 `chrome-extension://<expected-id>` origin。
- Pairing material 高熵、短生命周期、单次使用。
- 解除配对时旋转或删除 host-local secret。
- 不记录 pairing string、Gateway token、Cookie、页面内容和完整 WebSocket URL。
- Extension ID 必须固定并纳入 allowlist。
- 只控制 OpenClaw 标签组，不能在 JustDo 中提供“共享全部已有标签页”开关。
- 安装/升级包必须签名并来自可信发布渠道。
- Extension 与 Gateway 版本不兼容时 fail closed。

## 11. 实施顺序

### Phase 0：Runtime 前置

1. 以当前捆绑 `openclaw@2026.7.1-2` 为唯一 runtime 基准。
2. 已完成版本升级及 `browser` extension 的打包保留；仍需补齐 packaged-runtime 契约验证。
3. 在 Electron 内嵌 Node 下验证 `driver=extension`、extension CLI、relay、doctor 和
   `browser.request`，失败时保持产品入口关闭。

### Phase 1：设置与手工上游流程

1. 增加三种模式及配置同步。
2. 先接通上游 unpacked extension 手工流程，仅供开发验证。
3. 完成 status、test、Gateway restart 和定时任务 fail-closed。

此阶段不能面向小白用户正式发布。

### Phase 2：可发布的一次确认流程

1. 发布签名 Chrome Web Store Extension。
2. 实现 Native Messaging 自动配对。
3. 设置页提供“安装并启用”状态机。
4. 增加企业 force-install policy 模板。
5. 完成 Chrome/Edge、重启、升级、断线和凭据旋转验证。

## 12. 测试清单

- 三种模式生成正确 OpenClaw Profile。
- `v2026.7.1-2` packaged runtime 的 extension driver、relay、CLI 与 schema 契约可验证；
  在 JustDo 集成未完成或验证失败时不显示伪成功。
- Extension 未安装、等待确认、配对、连接、断开的状态转换。
- Pairing token 不进入 Renderer、日志、URL query 或 `app_config`。
- Extension 只能控制 OpenClaw 标签组。
- Agent 新建标签自动进入组。
- 移出标签、关闭 banner、解除配对立即撤销控制。
- Gateway/Chrome/JustDo 分别重启后自动恢复。
- 定时任务在 extension 离线时 fail closed。
- 企业系统代理、PAC、VPN、私有 CA 下使用用户 Chrome 网络栈。
- 中英文 i18n 完整。

## 13. 需要同步的文档

实现时同步更新：

- `docs/architecture/02-architecture.md`
- `docs/architecture/05-agent-engine.md`
- `docs/architecture/07-plugin-system.md`
- `docs/architecture/10-data-storage.md`
- `docs/architecture/11-security-model.md`
- `docs/patches/openclaw-patch-guide.md`（若升级或回移 runtime）
