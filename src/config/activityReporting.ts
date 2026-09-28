/** 活动上报配置；修改后重启开发进程或重新打包。 */
export const ACTIVITY_REPORTING_CONFIG: Readonly<{ enabled: boolean; endpointPath: string }> = Object.freeze({
  // false 禁用启动、每日心跳和失败重试；不影响 JWT 认证或模型请求。
  enabled: true,
  // 拼接到模型 URL 去掉末尾 /v1 后的地址；以 / 开头，保留部署路径前缀。
  endpointPath: '/customer/activity',
});
