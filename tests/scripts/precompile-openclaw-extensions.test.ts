import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { precompileOpenClawExtensions } =
  require('../../scripts/openclaw/precompile-openclaw-extensions.cjs') as {
    precompileOpenClawExtensions: (
      runtimeRoot: string,
      options: { required: boolean },
    ) => Promise<{
      compiled: number;
      errors: number;
    }>;
  };

test('keeps CUA native SDK and image loaders external when precompiling its TypeScript entry', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-cua-compile-'));
  const pluginRoot = path.join(runtimeRoot, 'dist', 'extensions', 'cua-computer');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        type: 'module',
        openclaw: { extensions: ['./index.ts'] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'index.ts'),
      [
        "import { registerComputerUseProvider } from 'openclaw/plugin-sdk/computer-use';",
        "import { CuaDriver } from '@trycua/cua-driver';",
        "import * as rastermill from 'rastermill';",
        'export default { registerComputerUseProvider, CuaDriver, rastermill };',
      ].join('\n'),
    );

    const result = await precompileOpenClawExtensions(runtimeRoot, { required: true });

    expect(result).toMatchObject({ compiled: 1, errors: 0 });
    const compiled = fs.readFileSync(path.join(pluginRoot, 'index.js'), 'utf8');
    expect(compiled).toContain('from "openclaw/plugin-sdk/computer-use"');
    expect(compiled).toContain('from "@trycua/cua-driver"');
    expect(compiled).toContain('from "rastermill"');
    expect(
      JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')),
    ).toMatchObject({ openclaw: { extensions: ['./index.js'] } });
  } finally {
    log.mockRestore();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
