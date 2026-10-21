import fs from 'node:fs';
import path from 'node:path';

import { buildSync } from 'esbuild';

/** Ship the regular theme tokens and the same resolver before any module loads. */
export function buildStartupAppearance(rendererRoot) {
  const result = buildSync({
    entryPoints: [path.join(rendererRoot, 'theme/startupAppearance.ts')],
    tsconfig: path.resolve(rendererRoot, '../../tsconfig.json'),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
  });
  return {
    script: result.outputFiles[0].text.replaceAll('</script', '<\\/script'),
    styles: fs.readFileSync(path.join(rendererRoot, 'theme/css/themes.css'), 'utf8'),
  };
}
