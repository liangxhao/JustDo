import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isAppServerPort } from '../../../shared/integrations/appServerIntegration';
import {
  restrictCredentialDirectory,
  restrictCredentialFile,
} from '../../openclaw/config/models/providerSecretFile';

export interface AppServerSettings {
  port: number;
  token: string;
}

const MAX_SETTINGS_BYTES = 4096;
const unavailable = (): Error => new Error('Application connection settings are unavailable.');
const writeFailed = (): Error => new Error('Unable to save application connection settings.');
const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

const isSettings = (value: unknown): value is AppServerSettings => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return (
    isAppServerPort(settings.port) &&
    typeof settings.token === 'string' &&
    /^[0-9a-f]{64}$/u.test(settings.token)
  );
};

/** Main owns persistent connection credentials, outside the generic Renderer KV bridge. */
export class AppServerSettingsStore {
  private readonly directory: string;
  private readonly file: string;
  private settings?: AppServerSettings;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'app-server');
    this.file = path.join(this.directory, 'connection.json');
  }

  get(): AppServerSettings {
    if (this.settings) return { ...this.settings };
    let stored: unknown;
    try {
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw unavailable();
      const file = fs.lstatSync(this.file);
      if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_SETTINGS_BYTES) throw unavailable();
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (!isMissing(error)) throw unavailable();
      const initial = { port: 0, token: randomBytes(32).toString('hex') };
      this.persist(initial);
      this.settings = initial;
      return { ...initial };
    }
    if (!isSettings(stored)) throw unavailable();
    this.settings = { port: stored.port, token: stored.token };
    return { ...this.settings };
  }

  setPort(port: number): AppServerSettings {
    if (!isAppServerPort(port)) throw new Error('Invalid application connection port.');
    const current = this.get();
    if (current.port === port) return current;
    return this.commit({ ...current, port });
  }

  regenerateToken(): AppServerSettings {
    return this.commit({ ...this.get(), token: randomBytes(32).toString('hex') });
  }

  private commit(settings: AppServerSettings): AppServerSettings {
    this.persist(settings);
    this.settings = { ...settings };
    return { ...settings };
  }

  private persist(settings: AppServerSettings): void {
    const temporary = path.join(this.directory, `connection.tmp-${randomUUID()}`);
    let descriptor: number | undefined;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = fs.lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw writeFailed();
      restrictCredentialDirectory(this.directory);
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      // Protect the empty file before any credential reaches disk, including Windows ACLs.
      restrictCredentialFile(temporary);
      fs.writeFileSync(descriptor, `${JSON.stringify(settings)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.file);
    } catch {
      throw writeFailed();
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the safe storage error. */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* The committed file was renamed, or cleanup failed. */ }
    }
  }
}
