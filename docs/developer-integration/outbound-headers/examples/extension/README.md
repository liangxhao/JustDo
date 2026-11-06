# Extension 文件放置示例

把本目录中的 `outbound-header-policy.json` 复制到现有 OpenClaw Extension 的根目录：

```text
your-extension/
├─ openclaw.plugin.json
├─ package.json
├─ ...原有 Extension 文件
├─ outbound-header-policy.json
└─ USER_SETUP.md                  # 可选的用户配置说明
```

不要把 `user_info.json` 或任何真实凭据放进 Extension。随包交付填写完整的
[用户配置说明](USER_SETUP.md)，让用户在自己的应用数据目录维护对应字段，
不要求用户阅读仓库上级目录或源码。

该文件不是 Hook，也不会修改用户的手工 `config.json`。Extension 安装并启用后，应用会在内存中
合并规则；Extension 被禁用或卸载后，规则自动移除。

`USER_SETUP.md` 是可以复制到真实 Extension 中的说明模板。它不参与运行时配置，仅用于告诉用户
需要在本机提供哪些 Header 值。发布前用实际产品目录和文件名替换路径占位符，保留同账号已有登录字段，
不要原样分发尚未填写的模板。
