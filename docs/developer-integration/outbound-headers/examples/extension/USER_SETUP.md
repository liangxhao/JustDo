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

Windows 默认文件位置：

```text
%APPDATA%\JustDo\huawei\user_info.json
```

如果文件中已有其他属性，请保留原有内容，只合并上述属性。修改完成后请完全退出并重新启动应用。
不要把包含真实值的 `user_info.json` 发给 Extension 开发者或提交到代码仓库。
