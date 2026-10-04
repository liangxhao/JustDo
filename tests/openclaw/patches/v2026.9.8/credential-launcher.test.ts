import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

const {
  __testing: { HELPER, transform },
} = require('../../../../scripts/patches/v2026.9.8/031-windows-servicing-credential-launcher.cjs');
const sid = 's-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const command = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function checker(entries: Array<{ sid: string; canWrite: boolean }>, ok = true) {
  const inspectWindowsAcl = vi
    .fn()
    .mockResolvedValue({ ok, untrustedWorld: [], untrustedGroup: entries });
  return new Function(
    'process',
    'inspectWindowsAcl',
    HELPER.replace('await import("@openclaw/fs-safe/advanced")', '({ inspectWindowsAcl })').replace(
      'const { inspectWindowsAcl } = ({ inspectWindowsAcl });',
      '',
    ) + '\nreturn isJustDoWindowsServicingLauncher;',
  )(
    { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, getBuiltinModule: () => path.win32 },
    inspectWindowsAcl,
  );
}
describe('Windows servicing credential launcher boundary', () => {
  test('admits only the OS service writer on the managed launcher', async () => {
    const check = checker([{ sid, canWrite: true }]);
    await expect(
      check(
        command,
        { label: 'secrets.providers.justdo_login.command' },
        { source: 'windows-acl', ownerSid: sid },
      ),
    ).resolves.toBe(true);
  });
  test.each([
    ['different provider', command, 'secrets.providers.custom.command', sid, sid, true],
    [
      'different executable',
      'C:\\Users\\test\\powershell.exe',
      'secrets.providers.justdo_login.command',
      sid,
      sid,
      true,
    ],
    ['different owner', command, 'secrets.providers.justdo_login.command', 'other', sid, true],
    ['other writable group', command, 'secrets.providers.justdo_login.command', sid, 'other', true],
    ['unverified ACL', command, 'secrets.providers.justdo_login.command', sid, sid, false],
  ])('rejects %s', async (_name, file, label, owner, writer, ok) => {
    await expect(
      checker([{ sid: writer as string, canWrite: true }], ok as boolean)(
        file,
        { label },
        { source: 'windows-acl', ownerSid: owner },
      ),
    ).resolves.toBe(false);
  });
  test('retains all native guards and rejects historical patch markers', () => {
    const source =
      'async function assertSecureExecCommandPath(params) { const perms = await inspectPathPermissions(commandPath); if (perms.worldWritable || perms.groupWritable) throw Error("denied"); return commandPath; }';
    const patched = transform(source, 'fixture.mjs');
    expect(transform(patched, 'fixture.mjs')).toBe(patched);
    expect(patched).toContain(
      '(perms.worldWritable || perms.groupWritable) && !await isJustDoWindowsServicingLauncher',
    );
    expect(() => transform(patched.replaceAll('V2026_9_8', 'V2026_9_2'), 'fixture.mjs')).toThrow();
  });
  test('verifies the bundled helper with renamed locals and preserves every security guard', () => {
    const source = 'async function assertSecureExecCommandPath(params) { const perms = await inspectPathPermissions(commandPath); if (perms.worldWritable || perms.groupWritable) throw Error("denied"); return commandPath; }';
    const patched = transform(source, 'fixture.mjs');
    const bundled = patched
      .replace(/\bentry\b/g, 'entry2')
      .replace(/entry2 =>/g, '(entry2) =>')
      .replace(/\bpermissions\b/g, 'permissions2')
      .replace(/\bserviceSid\b/g, 'serviceSid2')
      .replace(/\bpaths\b/g, 'paths2')
      .replace(/\bexpected\b/g, 'expected2')
      .replace(/\bacl\b(?!")/g, 'acl2')
      .replace('const { inspectWindowsAcl } = await import("@openclaw/fs-safe/advanced");',
        'const { inspectWindowsAcl: inspectWindowsAcl2 } = await Promise.resolve().then(() => (init_advanced(), advanced_exports));')
      .replace('await inspectWindowsAcl(commandPath)', 'await inspectWindowsAcl2(commandPath)');
    expect(transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    for (const [before, after] of [
      ['permissions2.ownerSid !== serviceSid2', 'permissions2.ownerSid === serviceSid2'],
      ['entry2.sid === serviceSid2', 'entry2.sid !== serviceSid2'],
      ['!acl2.untrustedWorld', 'acl2.untrustedWorld'],
      ['acl2.ok &&', 'true &&'],
      ['secrets.providers.justdo_login.command', 'secrets.providers.other.command'],
    ]) {
      expect(() => transform(bundled.replace(before, after), 'gateway-bundle.mjs')).toThrow('Incomplete servicing ACL patch');
    }
  });

});
