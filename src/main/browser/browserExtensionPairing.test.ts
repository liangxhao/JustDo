import { describe, expect, it, vi } from 'vitest';

import {
  buildBrowserExtensionPairingCommandArgs,
  readAutomaticBrowserExtensionPairing,
  readBrowserExtensionPairing,
} from './browserExtensionPairing';

const cli = {
  openclawEntry: 'openclaw.mjs',
  runtimeRoot: 'runtime',
  port: 42871,
  token: 'unused',
  env: {},
};
const gateway = `ws://127.0.0.1:${cli.port}`;
const localPairing = `${gateway}/browser/extension?gateway=${encodeURIComponent(gateway)}#${'a'.repeat(64)}`;
const read = (pairingString: unknown = localPairing, remote: unknown = false) =>
  readBrowserExtensionPairing(
    async () => cli,
    'gateway',
    async () => JSON.stringify({ pairingString, relayPort: 42881, remote }),
  );

describe('native browser extension pairing', () => {
  it.each(['ready', 'starting', 'stopped', 'error'])(
    'does not issue pairing when readiness or policy verification fails: %s',
    async phase => {
      const buildEnvironment = vi.fn(async () => cli);
      const command = vi.fn(async () => 'unused');
      await expect(
        readAutomaticBrowserExtensionPairing(async () => ({ phase }), buildEnvironment, command),
      ).rejects.toThrow('pairing is unavailable');
      expect(buildEnvironment).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
    },
  );
  it('uses the native Gateway wake-up route for automatic pairing', async () => {
    expect(buildBrowserExtensionPairingCommandArgs(cli.openclawEntry, 'gateway')).toContain(
      '--local-gateway',
    );
    expect(buildBrowserExtensionPairingCommandArgs(cli.openclawEntry)).not.toContain(
      '--local-gateway',
    );
    expect(await read()).toEqual({ pairingString: localPairing, relayPort: 42881 });
  });

  it.each([
    localPairing.replace('127.0.0.1', 'remote.example'),
    localPairing.replace(':42871/browser', ':42872/browser'),
    localPairing.replace('/browser/extension', '/extension'),
    localPairing.replace(
      'gateway=' + encodeURIComponent(gateway),
      'gateway=' + encodeURIComponent('wss://remote.example'),
    ),
    localPairing.replace(
      'gateway=' + encodeURIComponent(gateway),
      'gateway=' + encodeURIComponent(gateway + '/proxy'),
    ),
    localPairing.replace(
      'gateway=' + encodeURIComponent(gateway),
      'gateway=' + encodeURIComponent('ws://user:password@127.0.0.1:42871'),
    ),
    localPairing.replace('a'.repeat(64), 'invalid'),
  ])('rejects a non-local, mismatched or invalid native target', async pairing => {
    await expect(read(pairing)).rejects.toThrow('invalid browser extension pairing result');
  });

  it.each([true, undefined])('rejects remote or unconfirmed topology: %s', async remote => {
    await expect(read(localPairing, remote === undefined ? null : remote)).rejects.toThrow(
      'invalid browser extension pairing result',
    );
  });

  it('retains direct relay validation for clipboard pairing', async () => {
    const pairingString = `ws://127.0.0.1:42881/extension#${'b'.repeat(64)}`;
    const command = vi.fn(async () => JSON.stringify({ pairingString, relayPort: 42881 }));
    expect(await readBrowserExtensionPairing(async () => cli, 'relay', command)).toEqual({
      pairingString,
      relayPort: 42881,
    });
  });
});
