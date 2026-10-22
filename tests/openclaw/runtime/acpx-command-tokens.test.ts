import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { expandBundledAgentCommandValue } from '../../../plugins/extensions/acpx/src/command-tokens';

describe('ACPX bundled Agent command tokens', () => {
  test('expands managed runtime paths without tokenizing spaces', () => {
    const pluginRoot = path.join('C:', 'Program Files', 'JustDo', 'extensions', 'acpx');
    const openClawRoot = path.join('C:', 'Program Files', 'JustDo', 'openclaw');
    const nodeExecutable = path.join(openClawRoot, 'node.exe');

    expect(
      expandBundledAgentCommandValue('${NODE_EXECUTABLE}', {
        nodeExecutable,
        pluginRoot,
        openClawRoot,
      }),
    ).toBe(nodeExecutable);
    expect(
      expandBundledAgentCommandValue('${ACPX_PLUGIN_ROOT}/adapters/example/index.mjs', {
        nodeExecutable,
        pluginRoot,
        openClawRoot,
      }),
    ).toBe(`${pluginRoot}/adapters/example/index.mjs`);
  });
});
