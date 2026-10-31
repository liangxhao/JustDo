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

// Read RT_MANIFEST from the emitted PE, rather than matching the NSIS source:
// an omitted manifest makes Windows stretch the entire supposedly scaled UI.
function embeddedManifest(filename: string): string {
  const pe = readFileSync(filename);
  const nt = pe.readUInt32LE(0x3c);
  const optional = nt + 24;
  const directories = optional + (pe.readUInt16LE(optional) === 0x10b ? 96 : 112);
  const sections = optional + pe.readUInt16LE(nt + 20);
  const offsetOf = (rva: number): number => {
    for (let index = 0; index < pe.readUInt16LE(nt + 6); index++) {
      const section = sections + index * 40;
      const start = pe.readUInt32LE(section + 12);
      const size = Math.max(pe.readUInt32LE(section + 8), pe.readUInt32LE(section + 16));
      if (rva >= start && rva < start + size) return pe.readUInt32LE(section + 20) + rva - start;
    }
    throw new Error(`PE resource RVA is outside its sections: ${rva}`);
  };
  const resources = offsetOf(pe.readUInt32LE(directories + 16));
  const descend = (relative: number, type?: number): number => {
    const directory = resources + relative;
    const count = pe.readUInt16LE(directory + 12) + pe.readUInt16LE(directory + 14);
    for (let index = 0; index < count; index++) {
      const entry = directory + 16 + index * 8;
      if (type === undefined || pe.readUInt32LE(entry) === type) return pe.readUInt32LE(entry + 4);
    }
    throw new Error('Compiled NSIS executable has no manifest resource.');
  };
  const type = descend(0, 24);
  const name = descend(type & 0x7fffffff);
  const data = descend(name & 0x7fffffff);
  expect(type & 0x80000000).not.toBe(0);
  expect(name & 0x80000000).not.toBe(0);
  expect(data & 0x80000000).toBe(0);
  const entry = resources + data;
  const start = offsetOf(pe.readUInt32LE(entry));
  return pe.subarray(start, start + pe.readUInt32LE(entry + 4)).toString('utf8');
}

describe('Windows NSIS template compilation', () => {
  it.runIf(process.platform === 'win32' && existsSync(makensis) && existsSync(plugins))(
    'compiles both real templates with all languages and warnings as errors',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-nsis-compile-'));
      require('app-builder-lib');
      const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
      const originalHeader = NsisTarget.prototype.computeCommonInstallerScriptHeader;
      const originalScript = NsisTarget.prototype.computeFinalScript;
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
        NsisTarget.prototype.computeCommonInstallerScriptHeader = async () => [
          generator.build(),
          `!include "${path.join(repoRoot, 'scripts/packaging/nsis-installer.nsh')}"`,
          '',
        ].join('\n');
        NsisTarget.prototype.computeFinalScript = async (source: string) => source;
        require('../../scripts/packaging/windows-installer-script.cjs').configureWindowsInstallerScript(repoRoot);
        const target = { packager: { projectDir: repoRoot }, isPortable: false };
        // Both real builder passes prepend sharedHeader before finalScript.
        // Animation definitions must precede the custom include in the header.
        const sharedHeader = await NsisTarget.prototype.computeCommonInstallerScriptHeader.call(target);
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
            sharedHeader + await NsisTarget.prototype.computeFinalScript.call(target, 'upstream', !buildUninstaller, new Map()),
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
          expect(embeddedManifest(path.join(root, 'compile.exe'))).toMatch(
            /<dpiAware\b[^>]*>true<\/dpiAware>/,
          );
        }
      } finally {
        NsisTarget.prototype.computeCommonInstallerScriptHeader = originalHeader;
        NsisTarget.prototype.computeFinalScript = originalScript;
        rmSync(root, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
