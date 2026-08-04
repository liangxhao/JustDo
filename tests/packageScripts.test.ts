import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

test('relies on the npm predist:win lifecycle without invoking it twice', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  expect(packageJson.scripts['predist:win']).toBe('npm run openclaw:runtime:win-x64');
  expect(packageJson.scripts['dist:win']).not.toContain('npm run predist:win');
});
