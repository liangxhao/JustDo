import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  restrictCredentialDirectory,
  restrictCredentialFile,
} from '../openclaw/config/models/providerSecretFile';
import { AppServerSettingsStore } from './appServerSettingsStore';

vi.mock('../openclaw/config/models/providerSecretFile', () => ({
  restrictCredentialDirectory: vi.fn(),
  restrictCredentialFile: vi.fn(),
}));

describe('persistent app-server connection settings', () => {
  let directory: string;
  let settingsDirectory: string;
  let file: string;

  beforeEach(() => {
    vi.mocked(restrictCredentialDirectory).mockReset();
    vi.mocked(restrictCredentialFile).mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-server-settings-'));
    settingsDirectory = path.join(directory, 'app-server');
    file = path.join(settingsDirectory, 'connection.json');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('protects credentials before writing and persists ports and tokens across reopened stores', () => {
    vi.mocked(restrictCredentialFile).mockImplementation(temporary => {
      expect(fs.readFileSync(temporary, 'utf8')).toBe('');
    });
    const store = new AppServerSettingsStore(directory);
    const initial = store.get();
    expect(initial).toEqual({ port: 0, token: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(restrictCredentialDirectory).toHaveBeenCalledWith(settingsDirectory);
    expect(new AppServerSettingsStore(directory).get()).toEqual(initial);

    const configured = store.setPort(13042);
    expect(configured).toEqual({ port: 13042, token: initial.token });
    expect(new AppServerSettingsStore(directory).get()).toEqual(configured);
    const rotated = store.regenerateToken();
    expect(rotated.port).toBe(13042);
    expect(rotated.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(rotated.token).not.toBe(initial.token);
    expect(new AppServerSettingsStore(directory).get()).toEqual(rotated);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(rotated);
    expect(fs.readdirSync(settingsDirectory)).toEqual(['connection.json']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(settingsDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('returns independent snapshots for reads and both settings updates', () => {
    const store = new AppServerSettingsStore(directory);
    const first = store.get();
    const token = first.token;
    first.token = 'changed';
    first.port = 100;
    expect(store.get()).toEqual({ port: 0, token });
    const configured = store.setPort(65535);
    configured.port = 1;
    expect(store.get()).toEqual({ port: 65535, token });
    const rotated = store.regenerateToken();
    const rotatedToken = rotated.token;
    rotated.token = 'changed';
    expect(store.get()).toEqual({ port: 65535, token: rotatedToken });
    expect(store.setPort(0)).toEqual({ port: 0, token: rotatedToken });
  });

  it('rejects invalid port input before creating or changing settings', () => {
    const store = new AppServerSettingsStore(directory);
    for (const port of [-1, 65536, 1.5, Number.NaN, '13042', null]) {
      expect(() => store.setPort(port as number)).toThrow('Invalid application connection port.');
    }
    expect(fs.existsSync(settingsDirectory)).toBe(false);
    const initial = store.get();
    expect(() => store.setPort(-1)).toThrow('Invalid application connection port.');
    expect(store.get()).toEqual(initial);
    expect(new AppServerSettingsStore(directory).get()).toEqual(initial);
  });

  it.each([
    '{"token":"private-fixture"',
    JSON.stringify({ port: 65536, token: 'a'.repeat(64) }),
    JSON.stringify({ port: 0, token: 'A'.repeat(64) }),
  ])('preserves invalid settings without replacing credentials', content => {
    fs.mkdirSync(settingsDirectory);
    fs.writeFileSync(file, content);
    const store = new AppServerSettingsStore(directory);
    for (const operation of [() => store.get(), () => store.setPort(13042), () => store.regenerateToken()]) {
      expect(operation).toThrow('Application connection settings are unavailable.');
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(fs.readdirSync(settingsDirectory)).toEqual(['connection.json']);
    expect(restrictCredentialFile).not.toHaveBeenCalled();
  });

  it('does not treat read permission failures as missing settings', () => {
    const initial = new AppServerSettingsStore(directory).get();
    const read = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (target === file) throw Object.assign(new Error('private-fixture'), { code: 'EACCES' });
      return Reflect.apply(read, fs, [target, ...args]);
    }) as typeof fs.readFileSync);
    expect(() => new AppServerSettingsStore(directory).get())
      .toThrow('Application connection settings are unavailable.');
    expect(JSON.parse(read(file, 'utf8'))).toEqual(initial);
  });

  it('does not write a token before credential permissions are secured', () => {
    vi.mocked(restrictCredentialFile).mockImplementation(temporary => {
      expect(fs.readFileSync(temporary, 'utf8')).toBe('');
      throw new Error('private-fixture ACL unavailable');
    });
    const store = new AppServerSettingsStore(directory);
    expect(() => store.get()).toThrow('Unable to save application connection settings.');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(settingsDirectory)).toEqual([]);
    vi.mocked(restrictCredentialFile).mockReset();
    expect(store.get().token).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each(['flush', 'replace'] as const)('keeps the previous file and cache when %s fails', failure => {
    const store = new AppServerSettingsStore(directory);
    const initial = store.get();
    const content = fs.readFileSync(file, 'utf8');
    const fail = () => { throw new Error(`private-fixture ${initial.token}`); };
    if (failure === 'flush') vi.spyOn(fs, 'fsyncSync').mockImplementation(fail);
    else vi.spyOn(fs, 'renameSync').mockImplementation(fail);

    expect(() => store.setPort(13042)).toThrow('Unable to save application connection settings.');
    expect(() => store.regenerateToken()).toThrow('Unable to save application connection settings.');
    expect(store.get()).toEqual(initial);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(new AppServerSettingsStore(directory).get()).toEqual(initial);
    expect(fs.readdirSync(settingsDirectory)).toEqual(['connection.json']);
  });
});
