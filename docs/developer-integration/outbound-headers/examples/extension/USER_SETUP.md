# Example Service 用户配置

> 发布方：复制此模板后，填写下方配置路径中的产品目录、子目录和文件名，再随 Extension 分发。
> 最终用户应获得本发行版的完整路径，不需要访问应用源码；发布前删除本提示。

此 Extension 会自动配置以下请求头。

- `X-User-Account` 取本机的同名字段。
- `X-Service-Token` 取本机的 `X-Access-Token` 字段。
- `X-Client-Mode` 使用随包提供的固定值 `desktop`。

请在本机的 `user_info.json` 中配置账号和访问令牌字段。

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

如果文件中已有其他属性，请保留原有内容，包括 mtoken、登录资料和其他请求头，只合并当前账号需要的上述属性。
不要把整个示例覆盖到现有文件，也不要把账号字段换成另一账号。
没有文件时可按发行方要求创建请求头配置；仅凭这些字段不代表应用账号或模型服务已登录。
修改完成后请完全退出并重新启动应用。
不要把包含真实值的 `user_info.json` 发给 Extension 开发者或提交到代码仓库。
