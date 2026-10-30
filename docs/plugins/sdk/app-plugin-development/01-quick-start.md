# 01 快速入门：Hello Panel

本章构建一个只读插件：原生入口用于建立插件身份，Main 返回插件 ID / 版本，Browser 在扩展卡片上提供一个设置面板。示例不创建会话、不执行模型任务、不访问用户文件、不新增数据库表。

完整源码位于 [examples/hello-panel/](examples/hello-panel)。新建插件时复制这个目录，按 [02](02-package-and-manifests.md) 同步修改三份清单中的身份、版本和入口，再按实际需要增加命令和视图。界面、文案和业务代码留在插件自己的目录，通过公开 SDK 使用宿主能力。

软件通过桌面界面运行和管理插件，不提供命令行运行入口。本指南的 npm、Node 和构建工具命令只用于开发环境里的依赖准备、类型检查与打包，不是让使用者通过命令行启动或操作软件。

## 1. 准备开发环境

使用仓库 `.nvmrc` 指定的 Node 24，具体最低版本以根 `package.json.engines` 为准，按仓库锁文件安装依赖。插件使用兼容的 SDK v1 和 React 18；Browser 运行时复用宿主 React 单例。

在仓库根目录运行：

```powershell
nvm use 24
npm install
```

已有完整依赖时不必重复安装。首次准备应用和原生运行时请阅读[开发与排障](../../../development.md)；以下单插件构建不需要启动用户 Gateway。

## 2. 认识示例文件

```text
hello-panel/
  package.json              # 源码入口和包元数据
  openclaw.plugin.json      # 原生 Extension 身份与配置 schema
  app.plugin.json           # 应用入口、命令、插槽声明
  LICENSE                   # 源码示例的许可证，构建时随包交付
  index.ts                  # 只负责原生注册
  host/
    app.ts                  # Main 命令 info.read
  app/browser/
    index.tsx               # Browser 注册、双语文案、只读面板
```

三个 JSON 文件不是同一份配置的不同写法，分工见[下一章](02-package-and-manifests.md)。`app.plugin.json.entries` 是输出文件名；`package.json.app` 是源码文件名。

Main 的关键部分是：

```ts
export function register(host: AppMainHost): AppMainRegistration {
  return {
    commands: [
      {
        id: 'info.read',
        invoke: () => {
          host.assertActive();
          return { id: host.manifest.id, version: host.manifest.version };
        },
      },
    ],
  };
}
```

Browser 注册 `plugin.settings` 视图，并通过 `host.invoke('info.read')` 请求 Main。每次挂载用 `host.resources.child()` 托管读取结果，组件卸载或插件关闭后，迟到结果不会写回已失效界面。完整实现还包含共享 Modal、Portal、双语文案和返回值检查，见[示例界面](examples/hello-panel/app/browser/index.tsx)。

## 3. 构建完整插件包

仍在仓库根目录运行：

```powershell
node plugins/sdk/app-plugin-build/cli.mjs check --source docs/plugins/sdk/app-plugin-development/examples/hello-panel
node plugins/sdk/app-plugin-build/cli.mjs build --source docs/plugins/sdk/app-plugin-development/examples/hello-panel --out build/plugin-examples/hello-panel
```

也可以把源码放到其他目录，但须先按 [05](05-build-test-and-install.md) 在该项目安装示例声明的 SDK、构建器、React 和类型依赖。路径有空格或中文时加引号：

```powershell
node plugins/sdk/app-plugin-build/cli.mjs check --source "C:\my-plugins\hello-panel"
node plugins/sdk/app-plugin-build/cli.mjs build --source "C:\my-plugins\hello-panel" --out build/plugin-examples/hello-panel
```

这里直接调用公共构建工具的 CLI 源码入口，使用仓库已安装的工具链和 SDK。它输出 Native / Main / Browser / CSS、许可证及校验清单，不把应用 `src` 打进插件。Hello Panel 的 Native 入口不导入 OpenClaw 类型；有原生 SDK import 的插件还需为 `check` 提供匹配的 `--sdk-root`，见 [05](05-build-test-and-install.md)。

将源码复制到仓库之外后，必须在独立项目安装其 `package.json` 声明的 SDK、构建器、React 和类型依赖，才能改用已安装的 `app-plugin-build check/build` 命令。准备和分发这些包的方法也见 05；不能依赖某台机器碰巧存在的宿主 `node_modules`。

命令结束会输出插件 ID 和产物 hash。目录形状为：

```text
build/plugin-examples/hello-panel/
  hello-panel/<hash>/               # 供应用宿主加载的应用产物
  packages/hello-panel/<hash>/      # 完整可安装包，选择这一层
    package.json
    openclaw.plugin.json
    index.js
    LICENSE
    THIRD_PARTY_NOTICES.json
    app/
      app.artifact.json
      native.binding.json
      main.mjs
      browser.mjs
      browser.css
```

独立单包构建不会更新仓库的 `build/app-plugins/catalog.json`，也不会把示例自动安装进应用。`check` 检查实际 Native/Main/Browser 入口的严格类型；`build` 另行验证依赖边界并生成产物，不能只凭 esbuild 成功省略 `check`。

## 4. 在应用中安装并观察

当前产品默认内置交付；以下步骤仅适用于产品已经开放本地安装的开发/发行环境。没有导入入口时，不要直接改运行时目录来绕过管理；仓库捆绑流程见 [05](05-build-test-and-install.md)。

1. 进入「插件 → 扩展」的本地导入流程，选择 `build/plugin-examples/hello-panel/packages/hello-panel/<hash>` 完整目录。
2. 用户主动安装即授权本次确切代码：Main 接受原生能力声明，并在原生安装确认后核对身份、绑定及逐文件 hash，再登记 Main/UI 代码信任。无需提供 review token 或另行人工批准应用产物；失败或结果未知时先核对回执，不重试安装。
3. 安装或替换包时，宿主确认旧 Gateway 退出后在后台启动新 Gateway，软件保持打开。如需启用插件，在扩展管理中显式打开；普通启用、关闭不重启 Gateway。外部包不能通过 `defaultEnabled` 自行取得启用权限。
4. 原生加载且应用部分被准入后，卡片出现插件提供的设置按钮。点击可看到示例面板、插件 ID 和版本。
5. 关闭插件，确认设置入口和已打开面板同时撤回；再次启用后可以重新打开，旧面板不会自行复活。

若按钮没有出现，先按 [05 的排查顺序](05-build-test-and-install.md#排查接入失败)核对，不要手工修改审批文件、产物 hash 或生成的 `index.js`。

## 5. 做第一次修改

修改示例的两种语言文案，或增加一个只读 Main 命令。增加命令要同时修改 `app.plugin.json.commands`、Main 注册和 Browser 调用；增加 UI 入口要同步声明 `slots`。

修改实际内容后重建会生成新的 hash。通过受管流程安装新完整包并校验、登记新 hash，等待后台 Gateway 重新加载后再检查新行为，整个过程不要求重启软件。只修改插件时通常不需要重建应用；如果修改的是 SDK 或宿主实现，则需要相应的应用构建和验证。

不要直接编辑上一次输出目录。构建后的原生字节、`native.binding.json`、应用清单和文件 hash 是一个整体，拆开更新会被宿主拒绝。

下一步阅读 [02 目录、清单与边界](02-package-and-manifests.md)，再选择 Native/Main 或 Browser 章节。
