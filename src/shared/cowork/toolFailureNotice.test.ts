import { expect, test } from 'vitest';

import { isGatewayToolFailureNotice } from './toolFailureNotice';

test('recognizes OpenClaw synthetic tool failure notices', () => {
  expect(
    isGatewayToolFailureNotice(
      '⚠️ 🛠️ `Get-ChildItem -Path "~\\justdo\\project\\memory" -ErrorAction SilentlyContinue | Select-Object Name` failed',
    ),
  ).toBe(true);
});

test('does not classify regular session errors as tool failure notices', () => {
  expect(isGatewayToolFailureNotice('OpenClaw gateway client disconnected')).toBe(false);
});
