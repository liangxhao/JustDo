import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

const {
  syncNativeExtensionOverlay,
} = require('../../scripts/openclaw/sync-native-extension-overlay.cjs');

test('composes both native entry paths without altering baseline bytes and rejects an altered baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-overlay-'));
  onTestFinished(() => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Invalid fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'native');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(targetDir);
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify({ version: '2026.9.8', openclaw: { extensions: ['./index.js'] } }),
  );
  fs.writeFileSync(
    path.join(targetDir, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'openai', capabilityCatalogEntry: './capability-catalog.js' }),
  );
  const entries = Object.fromEntries(
    ['index', 'capability-catalog'].map(name => {
      const bytes = `export default { identity: '${name}' };\n`;
      fs.writeFileSync(path.join(targetDir, `${name}.js`), bytes);
      fs.writeFileSync(
        path.join(sourceDir, `${name}.ts`),
        `import native from './native-${name}.mjs'; export default {...native, composed: true};`,
      );
      return [`${name}.js`, createHash('sha256').update(bytes).digest('hex')];
    }),
  );
  fs.writeFileSync(
    path.join(sourceDir, 'native-source.json'),
    JSON.stringify({ id: 'openai', version: '2026.9.8', entries }),
  );
  syncNativeExtensionOverlay(sourceDir, targetDir);
  const outputs = ['index', 'capability-catalog'].map(name =>
    fs.readFileSync(path.join(targetDir, `${name}.js`)),
  );
  syncNativeExtensionOverlay(sourceDir, targetDir);
  for (const [index, name] of ['index', 'capability-catalog'].entries()) {
    expect(fs.readFileSync(path.join(targetDir, `${name}.js`))).toEqual(outputs[index]);
    expect(fs.readFileSync(path.join(targetDir, `native-${name}.mjs`), 'utf8')).toBe(
      `export default { identity: '${name}' };\n`,
    );
  }
  fs.appendFileSync(path.join(targetDir, 'native-index.mjs'), '/* changed */');
  expect(() => syncNativeExtensionOverlay(sourceDir, targetDir)).toThrow(/locked pristine source/);
  expect(fs.readFileSync(path.join(targetDir, 'index.js'))).toEqual(outputs[0]);
});
