import { isBuiltin } from 'node:module';
import path from 'node:path';

import { verifyAppNativeModule } from '@app-plugin/sdk/native-profile';
import { parse } from 'acorn';
import { build } from 'esbuild';
import { expect, test } from 'vitest';

test('bundles the public Runtime Services native clients into the supported companion native profile', async () => {
  const result = await build({
    stdin: {
      contents: `
        export { createRuntimeServicesClient } from '@runtime-services/sdk/native-client';
        export { managedSubagent } from '@runtime-services/sdk/execution';
      `,
      resolveDir: path.resolve('.'),
      sourcefile: 'native-client-profile.mjs',
      loader: 'js',
    },
    tsconfigRaw: {},
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['openclaw/plugin-sdk/*'],
    write: false,
  });
  expect(() => verifyAppNativeModule(result.outputFiles[0].text, parse, isBuiltin)).not.toThrow();
});
