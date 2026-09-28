export type BuiltinModelAuthConfig = Readonly<{
  tokenExchangeUrl: string;
  maxJwtLifetimeSeconds: number;
  developmentAuthMode: 'jwt' | 'api-key';
  developmentApiKey: string;
  developmentApiKeyFile?: string;
}>;

/** 部署方编辑此处，然后重启 Electron 开发进程。 */
export const BUILTIN_MODEL_AUTH_CONFIG: BuiltinModelAuthConfig = Object.freeze({
  // Jalor 完整换证地址，例如 https://login.example.com/api/litellm/mtoken2jwt。
  // 空地址禁用换证，不从模型地址推断。
  tokenExchangeUrl: '',
  // JWT 生命周期上限：30–10800 秒，须匹配签发端和 LiteLLM 策略。
  // 如果接口签发 10800 秒 JWT，请显式改为 10800。
  maxJwtLifetimeSeconds: 300,
  // 仅未打包 Electron 进程使用；打包版始终使用 JWT。
  developmentAuthMode: 'jwt',
  // 仅在 developmentAuthMode 为 api-key 且未打包时使用。提交代码前必须清空。
  developmentApiKey: '',
  // 仅开发模式读取；文件内容不参与打包。
  developmentApiKeyFile: '',
});
