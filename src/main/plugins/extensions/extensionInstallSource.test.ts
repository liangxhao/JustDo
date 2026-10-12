import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedDirectoryOperationCoordinator } from '../../core/filesystem/managedDirectoryOperations';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { prepareExtensionInstallSource } from './extensionInstallSource';
import {
  __openClawExtensionImportTestUtils,
  OpenClawExtensionImportService,
} from './openclawExtensionImportService';

describe.skipIf(process.platform !== 'win32')('Windows extension import source', () => {
  let root: string;
  let source: string;
  let host: string;
  let hostLink: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-source-test-'));
    source = path.join(root, '中文 package');
    host = path.join(root, 'runtime');
    hostLink = path.join(source, 'node_modules', 'openclaw');
    fs.mkdirSync(path.dirname(hostLink), { recursive: true });
    fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, 'keep.txt'), 'host');
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'demo',
        peerDependencies: { openclaw: '*' },
        openclaw: { extensions: ['./index.js'] },
      }),
    );
    fs.writeFileSync(path.join(source, 'openclaw.plugin.json'), '{"id":"demo"}');
    fs.writeFileSync(path.join(source, 'index.js'), 'export default {};');
    fs.symlinkSync(host, hostLink, 'junction');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('omits only the current declared host junction and leaves source and host intact', async () => {
    const prepared = await prepareExtensionInstallSource(source, host);
    try {
      expect(prepared.directory).not.toBe(source);
      expect(fs.readFileSync(path.join(prepared.directory, 'index.js'), 'utf8')).toBe(
        'export default {};',
      );
      expect(fs.existsSync(path.join(prepared.directory, 'node_modules', 'openclaw'))).toBe(false);
      // The unpatched native copier no longer encounters a symlink in this input.
      const installed = path.join(root, 'installed');
      await fsp.cp(prepared.directory, installed, { recursive: true, verbatimSymlinks: true });
      expect(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).toContain(
        'peerDependencies',
      );
    } finally {
      await prepared.cleanup();
    }
    expect(fs.existsSync(prepared.directory)).toBe(false);
    expect(fs.realpathSync(hostLink)).toBe(fs.realpathSync(host));
    expect(fs.readFileSync(path.join(host, 'keep.txt'), 'utf8')).toBe('host');
  });

  it.each([
    'unknown-junction',
    'hardlink',
    'undeclared',
    'other-host',
    'bundle',
    'node-modules-link',
  ])('leaves %s to the native installer without normalizing it', async kind => {
    if (kind === 'unknown-junction') fs.symlinkSync(host, path.join(source, 'unknown'), 'junction');
    if (kind === 'hardlink')
      fs.linkSync(path.join(host, 'keep.txt'), path.join(source, 'linked.txt'));
    if (kind === 'undeclared')
      fs.writeFileSync(
        path.join(source, 'package.json'),
        '{"openclaw":{"extensions":["./index.js"]}}',
      );
    if (kind === 'bundle')
      fs.writeFileSync(path.join(source, 'package.json'), '{"peerDependencies":{"openclaw":"*"}}');
    if (kind === 'other-host') {
      fs.unlinkSync(hostLink);
      fs.symlinkSync(root, hostLink, 'junction');
    }
    if (kind === 'node-modules-link') {
      fs.renameSync(path.dirname(hostLink), path.join(root, 'modules'));
      fs.symlinkSync(path.join(root, 'modules'), path.dirname(hostLink), 'junction');
    }
    const prepared = await prepareExtensionInstallSource(source, host);
    expect(prepared.directory).toBe(source);
    await prepared.cleanup();
    expect(fs.existsSync(source)).toBe(true);
  });

  it.each(['file-replaced', 'late-entry', 'copy-failure'])(
    'rejects %s during preparation and removes its partial copy',
    async kind => {
      const mkdtemp = vi.spyOn(fsp, 'mkdtemp');
      const originalOpen = fsp.open.bind(fsp);
      let triggered = false;
      vi.spyOn(fsp, 'open').mockImplementation(async (file, flags, mode) => {
        if (!triggered && file === path.join(source, 'index.js')) {
          triggered = true;
          if (kind === 'file-replaced') {
            fs.unlinkSync(file);
            fs.linkSync(path.join(host, 'keep.txt'), file);
          } else if (kind === 'late-entry') {
            fs.writeFileSync(path.join(source, 'late.js'), 'new');
          } else throw Object.assign(new Error('No space'), { code: 'ENOSPC' });
        }
        return originalOpen(file, flags, mode);
      });
      await expect(prepareExtensionInstallSource(source, host)).rejects.toThrow();
      const temporary = await mkdtemp.mock.results[0].value;
      expect(fs.existsSync(temporary)).toBe(false);
      expect(fs.readFileSync(path.join(host, 'keep.txt'), 'utf8')).toBe('host');
    },
  );

  it.skipIf(!fs.existsSync(path.resolve('vendor/openclaw-runtime/current/dist')))(
    'keeps native review tokens stable across disposable sources and cleans confirmed success',
    async () => {
      const runtimeRoot = fs.realpathSync(path.resolve('vendor/openclaw-runtime/current'));
      fs.unlinkSync(hostLink);
      fs.symlinkSync(runtimeRoot, hostLink, 'junction');
      fs.writeFileSync(
        path.join(source, 'openclaw.plugin.json'),
        JSON.stringify({
          id: 'demo',
          configSchema: { type: 'object', properties: {} },
        }),
      );
      const stateDir = path.join(root, 'state');
      fs.mkdirSync(stateDir);
      const configPath = path.join(stateDir, 'openclaw.json');
      fs.writeFileSync(configPath, '{"plugins":{}}');
      const reviewedPaths: string[] = [];
      const installedPaths: string[] = [];
      const runCommand: typeof __openClawExtensionImportTestUtils.runCommand = async (
        exe,
        args,
        options,
      ) => {
        if (args[0] === '--input-type=module') {
          reviewedPaths.push(options.env.JUSTDO_PLUGIN_REVIEW_DIRECTORY!);
          return __openClawExtensionImportTestUtils.runCommand(exe, args, options);
        }
        installedPaths.push(args[3]);
        expect(args[3]).toBe(reviewedPaths.at(-1));
        expect(fs.existsSync(path.join(args[3], 'node_modules', 'openclaw'))).toBe(false);
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({
            getStatus: () => ({ phase: 'ready' }),
            getBaseDir: () => stateDir,
            getConfigPath: () => configPath,
            buildCliEnvironment: async () => ({
              runtimeRoot,
              openclawEntry: path.join(runtimeRoot, 'openclaw.mjs'),
              env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
            }),
          }) as unknown as OpenClawEngineManager,
        requestGateway: vi.fn(),
        runCommand,
        directoryOperations: new ManagedDirectoryOperationCoordinator({
          findLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
        }),
      });
      const first = await service.importPath(source);
      expect(first.error).toBeUndefined();
      expect(first.capabilityReview?.reviewToken).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.existsSync(reviewedPaths[0])).toBe(false);
      expect(installedPaths).toHaveLength(0);
      const second = await service.importPath(
        source,
        undefined,
        first.capabilityReview!.reviewToken,
      );
      expect(second).toMatchObject({ success: true, extensionId: 'demo' });
      expect(reviewedPaths).toHaveLength(2);
      expect(reviewedPaths[0]).not.toBe(reviewedPaths[1]);
      expect(installedPaths).toHaveLength(1);
      expect(fs.existsSync(installedPaths[0])).toBe(false);
      expect(fs.realpathSync(hostLink)).toBe(runtimeRoot);
    },
  );

  it.each(['timeout', 'failure', 'throw'])(
    'retains the temporary source after %s when the native outcome is uncertain',
    async outcome => {
      let retained: string | undefined;
      const stateDir = path.join(root, 'state');
      const runCommand = vi.fn(async (_exe: string, args: string[]) => {
        retained = args[3];
        if (outcome === 'throw') throw new Error('Connection closed');
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Unconfirmed native outcome',
          timedOut: outcome === 'timeout',
        };
      });
      const service = new OpenClawExtensionImportService({
        getOpenClawEngineManager: () =>
          ({
            getStatus: () => ({ phase: 'ready' }),
            getBaseDir: () => stateDir,
            buildCliEnvironment: async () => ({
              runtimeRoot: host,
              openclawEntry: path.join(host, 'openclaw.mjs'),
              env: { OPENCLAW_STATE_DIR: stateDir },
            }),
          }) as unknown as OpenClawEngineManager,
        runCommand,
        directoryOperations: new ManagedDirectoryOperationCoordinator({
          findLockingProcesses: vi.fn(async () => ({ available: true, processes: [] })),
        }),
      });
      try {
        const result = await service.importPath(source);
        expect(result.success).toBe(false);
        expect(retained).toBeDefined();
        expect(fs.existsSync(retained!)).toBe(true);
        expect(fs.existsSync(path.join(retained!, 'index.js'))).toBe(true);
        expect(runCommand).toHaveBeenCalledOnce();
        expect(fs.realpathSync(hostLink)).toBe(fs.realpathSync(host));
      } finally {
        // Only this test's captured, app-created one-shot source is removed.
        if (
          retained &&
          path.basename(retained) === 'package' &&
          path.basename(path.dirname(retained)).startsWith('extension-install-source-') &&
          path.dirname(path.dirname(retained)) === os.tmpdir()
        ) {
          await fsp.rm(path.dirname(retained), { recursive: true, force: true });
        }
      }
    },
  );
});
