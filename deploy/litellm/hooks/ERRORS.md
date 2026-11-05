# 校验与授权错误码

请求头、JWT 和受管 Team 校验共用以下结构：

```json
{"error":{"type":"auth_error","message":"Authentication failed: JWT has expired","code":"JWT-1005","request_id":"<server-generated-id>"}}
```

HTTP 状态与业务错误码分开。`X-Request-ID` 响应头与正文 ID 一致，由服务端生成，
不接受客户端指定。请求头错误使用统一提示 `Request validation failed`；
JWT/Team 使用固定的明确原因。不返回令牌、Cookie、实际 claims 值或底层异常内容。

## 请求头：模糊提示

| 错误码 | HTTP | 内部原因 | 开发检查项 |
| --- | --- | --- | --- |
| REQ-1042 | 400 | account_missing / account_duplicate / account_invalid | X-User-Account 唯一，9–12 位 ASCII 字母数字，首位字母，末尾 6 位数字 |
| REQ-2071 | 400 | cookie_missing / cookie_duplicate / cookie_invalid | X-Cookie 唯一、非空、最多 16 KiB、Cookie 键值对语法合法 |

`type` 为 `invalid_request_error`。账号先于 Cookie 校验，只返回首个失败类别；
同一字段的不同失败原因共用对外错误码。Cookie 格式合法不代表会话有效。

## JWT 与 Team：明确原因

`type` 为 `auth_error`。401 应修正或更新凭证；403 由管理员检查用户、分组和权限；
503 表示认证服务或配置异常，不应通过重新输入用户凭证解决。JWT 失败不回退旧 Key。

| 错误码 | HTTP | 对外说明 |
| --- | --- | --- |
| JWT-1001 | 401 | Authentication failed: JWT or required identity headers are missing or malformed |
| JWT-1002 | 401 | Authentication failed: conflicting JWT credentials |
| JWT-1003 | 401 | Authentication failed: JWT algorithm is not allowed or kid is missing |
| JWT-1004 | 401 | Authentication failed: JWT signature is invalid |
| JWT-1005 | 401 | Authentication failed: JWT has expired |
| JWT-1006 | 401 | Authentication failed: JWT is not yet valid or was issued in the future |
| JWT-1007 | 401 | Authentication failed: JWT issuer does not match |
| JWT-1008 | 401 | Authentication failed: JWT audience does not match |
| JWT-1009 | 401 | Authentication failed: required JWT claims (sub, jti, iss, aud, iat, exp) are missing or invalid |
| JWT-1010 | 401 | Authentication failed: JWT iat and exp must be integer timestamps |
| JWT-1011 | 401 | Authentication failed: JWT lifetime exceeds the configured maximum |
| JWT-1012 | 401 | Authentication failed: account header does not match JWT subject |
| JWT-1013 | 401 | Authentication failed: JWT validation failed; token format or claims are invalid |
| JWT-1014 | 401 | Authentication failed: JWT signing key is not available |
| JWT-1501 | 503 | JWT authentication is temporarily unavailable; contact the administrator |
| JWT-1502 | 503 | JWT signing-key service is temporarily unavailable; retry later |
| JWT-1503 | 503 | JWT authorization service is temporarily unavailable; retry later |
| AUTH-2001 | 403 | Authorization failed: user is not provisioned in LiteLLM |
| AUTH-2002 | 403 | Authorization failed: user must belong to exactly one active managed Team |
| AUTH-2003 | 403 | Authorization failed: active managed Team membership was not found |
| AUTH-2004 | 403 | Authorization failed: active managed Team must have an explicit model list |
| AUTH-2005 | 403 | Authorization failed: Team is blocked |
| AUTH-2006 | 403 | Default Team is unavailable |
| AUTH-2007 | 403 | Default Team roster is invalid |
| AUTH-2008 | 403 | Default member budget is invalid or unavailable |
| AUTH-2009 | 403 | Default member models are invalid |
| AUTH-2501 | 503 | Authorization failed: automatic enrollment unavailable |
| AUTH-2502 | 503 | Authorization failed: Team lookup unavailable |
| AUTH-2503 | 503 | Authorization failed: Team member policy lookup unavailable |

`AUTH-2003` 表示 Team 成员名单中缺少该账号；个人策略读取或缓存同步失败返回 `AUTH-2503`。

## 排障与范围

统一日志名为 `litellm.validation`，仅记录 `code`、内部 `reason` 和 `request_id`。
按请求 ID 关联响应和日志；JWT 内部 reason 对应 `jwt_auth/errors.py` 枚举名的小写形式。
自定义诊断不记录账号、Cookie、JWT、完整请求头、URL 或正文，不输出底层异常堆栈。
活动上报中的 JWT 错误也使用同一响应，保留同一个请求 ID。

请求头校验对 WebSocket 使用 1008，ASGI close reason 为 `错误码:请求ID`。
握手前拒绝可能被服务器转为不含 reason 的 HTTP 403，此时查服务端日志。

本表覆盖自定义校验 Hook。LiteLLM 原生 Key、模型预算/限流和上游模型错误保留原协议，
不重写其状态码、重试语义或流式响应。错误码发布后保持含义稳定。
隐藏细节只减少信息暴露，不能防止伪造请求头；真实授权仍依赖 JWT/Key 和 Team。
