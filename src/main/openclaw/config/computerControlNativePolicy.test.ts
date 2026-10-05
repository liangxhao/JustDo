import { describe, expect, test, vi } from 'vitest';

import { evaluateComputerControlNativePolicy } from './computerControlNativePolicy';

describe('native computer policy projection', () => {
  test('sends only global admission fields and returns the native decision', async () => {
    const run = vi.fn().mockResolvedValue('JUSTDO_COMPUTER_POLICY=false');
    expect(
      await evaluateComputerControlNativePolicy(
        'runtime',
        {
          profile: 'coding',
          allow: ['read'],
          deny: ['Computer'],
          web: { search: { apiKey: 'test-only-secret' } },
          sandbox: { tools: { deny: ['computer'] } },
          byProvider: { private: { deny: ['computer'] } },
        },
        run,
      ),
    ).toBe(false);
    expect(run).toHaveBeenCalledWith(
      'runtime',
      JSON.stringify({ allow: ['read'], deny: ['Computer'], profile: 'coding' }),
    );
    run.mockResolvedValue('JUSTDO_COMPUTER_POLICY=true');
    expect(await evaluateComputerControlNativePolicy('runtime', {}, run)).toBe(true);
  });

  test('fails closed for missing runtimes, malformed output, and runner failures', async () => {
    const run = vi.fn().mockResolvedValue('true');
    await expect(evaluateComputerControlNativePolicy(null, {}, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(evaluateComputerControlNativePolicy('runtime', {}, run)).rejects.toThrow();
    run.mockRejectedValue(new Error('native unavailable'));
    await expect(evaluateComputerControlNativePolicy('runtime', {}, run)).rejects.toThrow();
  });

  test('rejects oversized policies before spawning', async () => {
    const run = vi.fn();
    await expect(
      evaluateComputerControlNativePolicy('runtime', { deny: ['x'.repeat(65_536)] }, run),
    ).rejects.toThrow('Computer policy too large');
    expect(run).not.toHaveBeenCalled();
  });
});
