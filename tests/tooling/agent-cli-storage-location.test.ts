import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { findCSharpCompiler } = require('../../scripts/external-agent/create-agent-cli-launcher.cjs');

describe.skipIf(process.platform !== 'win32' || !findCSharpCompiler())('native CLI storage locator', () => {
  let home: string;
  let probe: string;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-cli-'));
    probe = path.join(home, 'probe.exe');
    const harness = path.join(home, 'probe.cs');
    // Invoke the production resolver in a console harness without connecting to
    // a bridge, starting Electron or reading a real user's profile.
    fs.writeFileSync(harness, `using System; using System.Reflection; using System.Text;
internal static class StorageLocationProbe {
  public static int Main(string[] args) {
    try {
      Console.OutputEncoding = new UTF8Encoding(false);
      var method = typeof(AgentCliLauncher).GetMethod("ResolveUserData", BindingFlags.NonPublic | BindingFlags.Static);
      Console.Write((string)method.Invoke(null, new object[] { args[0], args.Length > 1 ? args[1] : null }));
      return 0;
    } catch (Exception error) { Console.Error.Write((error.InnerException ?? error).Message); return 1; }
  }
}`);
    execFileSync(findCSharpCompiler(), [
      '/nologo', '/target:exe', '/main:StorageLocationProbe', '/reference:System.Web.Extensions.dll',
      `/out:${probe}`, path.resolve('scripts/external-agent/agent-cli-launcher.cs'), harness,
    ], { windowsHide: true });
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  function json(file: string, value: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }

  function fixture() {
    const root = fs.mkdtempSync(path.join(home, 'profile-'));
    const bootstrap = path.join(root, 'bootstrap');
    const target = path.join(root, '新 数据');
    const profileId = randomUUID();
    const rootId = randomUUID();
    fs.mkdirSync(bootstrap);
    const location = { version: 1, profileId, revision: 1, activeRoot: target, activeRootId: rootId };
    json(path.join(bootstrap, 'storage-root.json'), { version: 1, profileId, rootId: randomUUID() });
    json(path.join(bootstrap, 'storage-location.json'), location);
    json(path.join(target, 'storage-root.json'), { version: 1, profileId, rootId });
    return { root, bootstrap, target, profileId, rootId, location };
  }

  const resolve = (bootstrap: string, override?: string) => execFileSync(probe,
    [bootstrap, ...(override === undefined ? [] : [override])], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });

  it('follows a verified current root for default and legacy bootstrap commands', () => {
    const f = fixture();
    expect(resolve(f.bootstrap)).toBe(f.target);
    expect(resolve(f.bootstrap, f.bootstrap)).toBe(f.target);
    expect(resolve(f.bootstrap, f.target)).toBe(f.target);
  });

  it('redirects a copied production command from a retained root of the same profile', () => {
    const f = fixture();
    const retained = path.join(f.root, 'retained');
    json(path.join(retained, 'storage-root.json'), { version: 1, profileId: f.profileId, rootId: randomUUID() });
    expect(resolve(f.bootstrap, retained)).toBe(f.target);
  });

  it('uses the current locator even if the bootstrap marker is missing', () => {
    const f = fixture();
    const retained = path.join(f.root, 'retained');
    json(path.join(retained, 'storage-root.json'), { version: 1, profileId: f.profileId, rootId: randomUUID() });
    fs.unlinkSync(path.join(f.bootstrap, 'storage-root.json'));

    expect(resolve(f.bootstrap, retained)).toBe(f.target);
  });

  it('refuses an explicit active root whose identity is missing', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.target, 'storage-root.json'));

    expect(() => resolve(f.bootstrap, f.target)).toThrow('identity does not match');
  });

  it('waits for Main to recover an interrupted first binding', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.bootstrap, 'storage-location.json'));
    fs.unlinkSync(path.join(f.bootstrap, 'storage-root.json'));
    json(path.join(f.bootstrap, 'storage-location.initializing.json'), { version: 1 });

    expect(() => resolve(f.bootstrap)).toThrow('location is unavailable');
  });

  it('leaves independent development and other profile commands isolated', () => {
    const f = fixture();
    const development = path.join(f.root, 'development');
    const independent = path.join(f.root, 'independent');
    json(path.join(independent, 'storage-root.json'), { version: 1, profileId: randomUUID(), rootId: randomUUID() });
    json(path.join(f.bootstrap, 'storage-relocation', 'active.json'), { stage: 'copying' });
    expect(resolve(f.bootstrap, development)).toBe(development);
    expect(resolve(f.bootstrap, independent)).toBe(independent);
  });

  it('refuses maintenance even when an old source bridge might still exist', () => {
    const f = fixture();
    json(path.join(f.bootstrap, 'storage-relocation', 'active.json'), { stage: 'copying' });
    expect(() => resolve(f.bootstrap)).toThrow('relocation is in progress');
  });

  it('keeps an explicitly independent marked profile isolated even when the production locator is corrupt', () => {
    const f = fixture();
    const independent = path.join(f.root, 'independent');
    const retained = path.join(f.root, 'retained');
    json(path.join(independent, 'storage-root.json'), { version: 1, profileId: randomUUID(), rootId: randomUUID() });
    json(path.join(retained, 'storage-root.json'), { version: 1, profileId: f.profileId, rootId: randomUUID() });
    fs.writeFileSync(path.join(f.bootstrap, 'storage-location.json'), '{broken');
    json(path.join(f.bootstrap, 'storage-relocation', 'active.json'), { stage: 'failed' });

    expect(resolve(f.bootstrap, independent)).toBe(independent);
    expect(resolve(f.bootstrap, path.join(f.root, 'unmarked-development'))).toBe(path.join(f.root, 'unmarked-development'));
    expect(() => resolve(f.bootstrap, retained)).toThrow();
  });

  it('refuses failed and unknown relocation stages rather than connecting to retained discovery metadata', () => {
    const f = fixture();
    json(path.join(f.bootstrap, 'storage-relocation', 'active.json'), { stage: 'failed' });
    expect(() => resolve(f.bootstrap)).toThrow('relocation is in progress');
    json(path.join(f.bootstrap, 'storage-relocation', 'active.json'), { stage: 'unrecognized-stage' });
    expect(() => resolve(f.bootstrap)).toThrow('relocation is in progress');
  });

  it('fails closed for mismatched root identity and malformed or missing locator', () => {
    const f = fixture();
    json(path.join(f.target, 'storage-root.json'), { version: 1, profileId: f.profileId, rootId: randomUUID() });
    expect(() => resolve(f.bootstrap)).toThrow('identity does not match');
    fs.writeFileSync(path.join(f.bootstrap, 'storage-location.json'), '{broken');
    expect(() => resolve(f.bootstrap)).toThrow();
    fs.rmSync(path.join(f.bootstrap, 'storage-location.json'));
    json(path.join(f.bootstrap, 'storage-relocation', 'active.json'), { stage: 'copying' });
    expect(() => resolve(f.bootstrap)).toThrow('location is unavailable');
  });

  it('keeps the original default for users who have never established a locator', () => {
    const bootstrap = path.join(home, `initial-${randomUUID()}`);
    fs.mkdirSync(bootstrap);
    expect(resolve(bootstrap)).toBe(bootstrap);
  });
});
