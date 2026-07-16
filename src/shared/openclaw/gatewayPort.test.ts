import { describe, expect, it } from 'vitest';

import {
  GatewayPortValidationCode,
  parseGatewayPortInput,
  validateGatewayPortNumber,
} from './gatewayPort';

describe('gateway port validation', () => {
  it.each([
    ['', GatewayPortValidationCode.Required],
    ['12.5', GatewayPortValidationCode.Integer],
    ['123abc', GatewayPortValidationCode.Integer],
    ['0', GatewayPortValidationCode.OutOfRange],
    ['65536', GatewayPortValidationCode.OutOfRange],
    ['80', GatewayPortValidationCode.Privileged],
  ])('rejects %j with %s', (input, code) => {
    expect(parseGatewayPortInput(input)).toEqual({ valid: false, code });
  });

  it('accepts a normal user port', () => {
    expect(parseGatewayPortInput('42871')).toEqual({
      valid: true,
      port: 42871,
      usesEphemeralRange: false,
    });
  });

  it('marks dynamic ports as higher-conflict-risk', () => {
    expect(parseGatewayPortInput('49152')).toEqual({
      valid: true,
      port: 49152,
      usesEphemeralRange: true,
    });
  });

  it('rejects non-number IPC payloads', () => {
    expect(validateGatewayPortNumber('42871')).toEqual({
      valid: false,
      code: GatewayPortValidationCode.Integer,
    });
  });
});
