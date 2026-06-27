const GATEWAY_TOOL_FAILURE_NOTICE_PATTERN = /^⚠️\s*🛠️[\s\S]*\sfailed$/i;

export const isGatewayToolFailureNotice = (text: string): boolean =>
  GATEWAY_TOOL_FAILURE_NOTICE_PATTERN.test(text.trim());
