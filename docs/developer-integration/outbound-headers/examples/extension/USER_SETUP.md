# Example Service 用户配置

此 Extension 会自动声明以下请求头映射：

- `X-User-Account`
- `X-Access-Token`

Extension 不包含这些请求头的真实值。请在本机的 `user_info.json` 中增加：

```json
{
  "X-User-Account": "replace-with-user-account",
  "X-Access-Token": "replace-with-real-token"
}
```

Windows 文件路径格式：

```text
%APPDATA%\<productName>\<directoryName>\<userInfoFileName>
```

`productName` 来自 `package.json.productName`；目录名与用户信息文件名分别来自
`src/config/loginStorage.ts` 的 `LOGIN_STORAGE_CONFIG`。请按实际构建配置替换占位符。

如果文件中已有其他属性，请保留原有内容，只合并上述属性。修改完成后请完全退出并重新启动应用。
不要把包含真实值的 `user_info.json` 发给 Extension 开发者或提交到代码仓库。
