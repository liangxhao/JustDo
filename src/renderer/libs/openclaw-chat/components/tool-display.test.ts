import { describe, expect, test } from 'vitest';

import { resolveToolDisplay } from './tool-display';

describe('resolveToolDisplay', () => {
  test('uses OpenClaw canonical titles', () => {
    expect(resolveToolDisplay('sessions_spawn')).toEqual({ title: 'Sub-agent' });
    expect(resolveToolDisplay('exec')).toEqual({ title: 'Exec' });
    expect(resolveToolDisplay('gateway_process')).toEqual({ title: 'Background Shell' });
  });

  test('uses OpenClaw fallback title formatting for unknown tools', () => {
    expect(resolveToolDisplay('custom_tool')).toEqual({ title: 'Custom Tool' });
    expect(resolveToolDisplay('API')).toEqual({ title: 'API' });
    expect(resolveToolDisplay('')).toEqual({ title: 'Tool' });
  });
});
