import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis');
const makensis = path.join(cacheRoot, 'nsis-3.0.4.1', 'makensis.exe');
const plugins = path.join(cacheRoot, 'nsis-resources-3.4.1', 'plugins', 'x86-unicode');
const templates = path.join(repoRoot, 'node_modules/app-builder-lib/templates/nsis');

describe('Windows NSIS template compilation', () => {
  it.runIf(process.platform === 'win32' && existsSync(makensis) && existsSync(plugins))(
    'compiles both real templates with all languages and warnings as errors',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-nsis-compile-'));
      try {
        const {
          NsisScriptGenerator,
        } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator');
        const {
          LangConfigurator,
          createAddLangsMacro,
          addCustomMessageFileInclude,
        } = require('app-builder-lib/out/targets/nsis/nsisLang');
        const generator = new NsisScriptGenerator();
        const languages = new LangConfigurator({});
        let index = 0;
        const packager = { getTempFile: async () => path.join(root, `messages-${index++}.nsh`) };
        generator.addIncludeDir(path.join(templates, 'include'));
        generator.addPluginDir('x86-unicode', plugins);
        generator.include(path.join(templates, 'include', 'StdUtils.nsh'));
        generator.flags([
          'updated',
          'force-run',
          'keep-shortcuts',
          'no-desktop-shortcut',
          'delete-app-data',
          'allusers',
          'currentuser',
        ]);
        createAddLangsMacro(generator, languages);
        await addCustomMessageFileInclude('messages.yml', packager, generator, languages);
        await addCustomMessageFileInclude('assistedMessages.yml', packager, generator, languages);
        const definitions: Record<string, string> = {
          APP_ID: 'com.justdo.compile.test',
          APP_DESCRIPTION: 'Compile smoke fixture',
          APP_GUID: 'justdo-compile-test',
          UNINSTALL_APP_KEY: 'justdo-compile-test',
          PRODUCT_NAME: 'JustDo',
          PRODUCT_FILENAME: 'JustDo',
          APP_FILENAME: 'JustDo',
          APP_PACKAGE_NAME: 'justdo',
          APP_INSTALLER_STORE_FILE: 'justdo-updater\\installer.exe',
          VERSION: '2026.8.27',
          PROJECT_DIR: repoRoot,
          SHORTCUT_NAME: 'JustDo',
          UNINSTALL_DISPLAY_NAME: 'JustDo',
          UNINSTALLER_OUT_FILE: path.join(root, 'uninstall.exe'),
        };
        writeFileSync(path.join(root, 'uninstall.exe'), 'compile-only fixture');
        writeFileSync(path.join(root, 'app.7z'), 'compile-only fixture');
        for (const buildUninstaller of [true, false]) {
          const source = [
            'Unicode true',
            `OutFile "${path.join(root, 'compile.exe')}"`,
            ...Object.entries(definitions).map(([key, value]) => `!define ${key} "${value}"`),
            ...(buildUninstaller ? ['!define BUILD_UNINSTALLER'] : []),
            `!define APP_64 "${path.join(root, 'app.7z')}"`,
            '!define COMPRESSION_METHOD 7z',
            '!define INSTALL_MODE_PER_ALL_USERS_REQUIRED',
            '!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION',
            '!define allowToChangeInstallationDirectory',
            generator.build(),
            `!include "${path.join(repoRoot, 'scripts/packaging/nsis-installer.nsh')}"`,
            readFileSync(path.join(templates, 'installer.nsi'), 'utf8'),
          ].join('\n');
          const result = spawnSync(makensis, ['/WX', '/INPUTCHARSET', 'UTF8', '-'], {
            input: source,
            encoding: 'utf8',
            cwd: templates,
            timeout: 30_000,
            windowsHide: true,
          });
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
          expect(existsSync(path.join(root, 'compile.exe'))).toBe(true);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
