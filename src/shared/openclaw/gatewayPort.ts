export const MIN_OPENCLAW_GATEWAY_PORT = 1024;
export const MAX_OPENCLAW_GATEWAY_PORT = 65535;
export const EPHEMERAL_PORT_RANGE_START = 49152;

export const GatewayPortValidationCode = {
  Required: 'required',
  Integer: 'integer',
  Privileged: 'privileged',
  OutOfRange: 'out_of_range',
} as const;

export const GatewayPortSetErrorCode = {
  Invalid: 'invalid',
  Unavailable: 'unavailable',
  Busy: 'busy',
  SaveFailed: 'save_failed',
} as const;

export type GatewayPortSetErrorCode =
  (typeof GatewayPortSetErrorCode)[keyof typeof GatewayPortSetErrorCode];

export type GatewayPortValidationCode =
  (typeof GatewayPortValidationCode)[keyof typeof GatewayPortValidationCode];

export type GatewayPortInputValidation =
  | { valid: true; port: number; usesEphemeralRange: boolean }
  | { valid: false; code: GatewayPortValidationCode };

export const validateGatewayPortNumber = (port: unknown): GatewayPortInputValidation => {
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    return { valid: false, code: GatewayPortValidationCode.Integer };
  }
  if (port < 1 || port > MAX_OPENCLAW_GATEWAY_PORT) {
    return { valid: false, code: GatewayPortValidationCode.OutOfRange };
  }
  if (port < MIN_OPENCLAW_GATEWAY_PORT) {
    return { valid: false, code: GatewayPortValidationCode.Privileged };
  }
  return {
    valid: true,
    port,
    usesEphemeralRange: port >= EPHEMERAL_PORT_RANGE_START,
  };
};

export const parseGatewayPortInput = (input: string): GatewayPortInputValidation => {
  const normalized = input.trim();
  if (!normalized) {
    return { valid: false, code: GatewayPortValidationCode.Required };
  }
  if (!/^\d+$/.test(normalized)) {
    return { valid: false, code: GatewayPortValidationCode.Integer };
  }
  return validateGatewayPortNumber(Number(normalized));
};
