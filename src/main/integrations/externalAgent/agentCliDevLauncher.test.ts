import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import vm from 'vm';

import { getAgentCliCommandName } from '../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  resolveDevelopmentAgentCliExecutable,
  resolvePackagedAgentCliExecutable,
} from './agentCliDevLauncher';

function developmentScript(
  root: string,
  env: Record<string, string>,
  productName: string = PRODUCT_NAME,
) {
  const createLauncher = vi.fn();
  const scriptModule = {
    exports: {} as { prepareDevelopmentLauncher: (userData?: string) => string },
  };
  const modules: Record<string, unknown> = {
    path,
    crypto: { createHash },
    '../../package.json': { productName },
    '../../src/shared/integrations/agentCli.ts': { getAgentCliCommandName },
    './create-agent-cli-launcher.cjs': { createAgentCliLauncher: createLauncher },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.resolve('scripts/external-agent/prepare-development-launcher.cjs'),
      'utf8',
    ),
    {
      require: (name: string) => {
        if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
        return modules[name];
      },
      module: scriptModule,
      process: { platform: 'win32', env },
      __dirname: path.join(root, 'scripts', 'external-agent'),
    },
  );
  return { prepare: scriptModule.exports.prepareDevelopmentLauncher, createLauncher };
}

describe('Agent CLI development launcher location', () => {
  it('builds inside the checkout and agrees with Main for paths containing spaces and Chinese', () => {
    const root = path.resolve('工程 预览');
    const userData = path.resolve('用户 数据');
    const script = developmentScript(root, {});

    const executable = script.prepare(userData);

    expect(executable).toBe(resolveDevelopmentAgentCliExecutable(root, userData));
    expect(path.relative(root, executable).split(path.sep).slice(0, 3)).toEqual([
      '.agent-tasks',
      'external-agent',
      'development',
    ]);
    expect(script.createLauncher).toHaveBeenCalledWith(executable, { userDataPath: userData });
  });

  it('keeps normal and isolated bridge profiles in separate checkout launchers', () => {
    const root = path.resolve('checkout');
    const appData = path.resolve('roaming');
    const isolatedData = path.join(root, '.work', 'profile');
    const normal = developmentScript(root, { APPDATA: appData });
    const isolated = developmentScript(root, { JUSTDO_DEV_USER_DATA_DIR: isolatedData });

    const normalExecutable = normal.prepare();
    const isolatedExecutable = isolated.prepare();

    expect(normalExecutable).toBe(
      resolveDevelopmentAgentCliExecutable(root, path.join(appData, PRODUCT_NAME)),
    );
    expect(isolatedExecutable).toBe(resolveDevelopmentAgentCliExecutable(root, isolatedData));
    expect(isolatedExecutable).not.toBe(normalExecutable);
    expect(isolated.createLauncher).toHaveBeenCalledWith(isolatedExecutable, {
      userDataPath: isolatedData,
    });
  });

  it('keeps the packaged launcher alongside the installed executable', () => {
    const installation = path.resolve('安装 目录');
    expect(resolvePackagedAgentCliExecutable(path.join(installation, `${PRODUCT_NAME}.exe`))).toBe(
      path.join(installation, `${PRODUCT_NAME.toLowerCase()}-cli.exe`),
    );
  });

  it('uses a changed productName consistently for development and installed launchers', async () => {
    const root = path.resolve('工程 预览');
    const appData = path.resolve('用户 数据');
    const productName = 'Acme';
    const script = developmentScript(root, { APPDATA: appData }, productName);
    vi.resetModules();
    vi.doMock('../../../shared/productMetadata', () => ({ PRODUCT_NAME: productName }));
    try {
      const renamed = await import('./agentCliDevLauncher');
      const executable = script.prepare();
      const userData = path.join(appData, productName);

      expect(executable).toBe(renamed.resolveDevelopmentAgentCliExecutable(root, userData));
      expect(path.basename(executable)).toBe('acme-cli.exe');
      expect(script.createLauncher).toHaveBeenCalledWith(executable, { userDataPath: userData });
      expect(renamed.resolvePackagedAgentCliExecutable(path.join(root, 'Acme.exe'))).toBe(
        path.join(root, 'acme-cli.exe'),
      );
    } finally {
      vi.doUnmock('../../../shared/productMetadata');
      vi.resetModules();
    }
  });
});
