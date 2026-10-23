import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLanguage, type LanguageType, setLanguage, t } from '../../core/i18n';
import { prepareExtensionForInstall } from './extensionConversion';

vi.mock('../../../shared/productMetadata', () => ({ PRODUCT_NAME: 'ExampleProduct' }));

describe('prepareExtensionForInstall', () => {
  let pluginDirectory: string;
  let previousLanguage: LanguageType;

  beforeEach(() => {
    previousLanguage = getLanguage();
    pluginDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-format-中文 空格-'));
  });

  afterEach(() => {
    setLanguage(previousLanguage);
    fs.rmSync(pluginDirectory, { recursive: true, force: true });
  });

  it.each(['{"id":"native","configSchema":{}}', '{invalid json'])(
    'preserves the native source and leaves manifest validation to OpenClaw: %s',
    async manifest => {
      fs.writeFileSync(path.join(pluginDirectory, 'openclaw.plugin.json'), manifest);
      fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), 'export default () => {};');
      const input = { pluginDirectory, sourcePath: `${pluginDirectory}.tgz` };
      await expect(prepareExtensionForInstall(input)).resolves.toBe(input);
      expect(fs.readFileSync(path.join(pluginDirectory, 'openclaw.plugin.json'), 'utf8')).toBe(
        manifest,
      );
    },
  );

  it.each([
    {
      language: 'zh' as const,
      prefix: '该扩展不满足 ExampleProduct 的扩展格式。',
      compiledEntry: '已编译运行入口',
    },
    {
      language: 'en' as const,
      prefix: "This extension does not meet ExampleProduct's extension format requirements.",
      compiledEntry: 'compiled runtime entry',
    },
  ])(
    'explains the required package format using product metadata in $language',
    async ({ language, prefix, compiledEntry }) => {
      setLanguage(language);
      const input = { pluginDirectory, sourcePath: `${pluginDirectory}.zip` };
      const attempt = prepareExtensionForInstall(input);
      await expect(attempt).rejects.toThrow(prefix);
      await expect(attempt).rejects.toThrow('openclaw.plugin.json');
      await expect(attempt).rejects.toThrow(compiledEntry);
      expect(fs.readdirSync(pluginDirectory)).toEqual([]);
    },
  );

  it.each(['.claude-plugin', '.codex-plugin', '.cursor-plugin', 'unknown'])(
    'rejects non-native %s packages without changing files',
    async marker => {
      fs.mkdirSync(path.join(pluginDirectory, marker));
      await expect(
        prepareExtensionForInstall({ pluginDirectory, sourcePath: pluginDirectory }),
      ).rejects.toThrow(t('extensionConversionNotImplemented'));
      expect(fs.readdirSync(pluginDirectory)).toEqual([marker]);
    },
  );
});
