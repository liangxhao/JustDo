import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/extension-shared', () => ({ formatPluginConfigIssue: String }));
vi.mock('openclaw/plugin-sdk/string-coerce-runtime', () => ({
  normalizeLowercaseStringOrEmpty: (value: string) => value.trim().toLowerCase(),
}));
vi.mock('openclaw/plugin-sdk/state-paths', () => ({ resolveStateDir: () => '/native-state' }));

import { resolveAcpxPluginConfig } from '../../../openclaw-extensions/acpx/src/config';

test('uses native state independently from the selected workspace and preserves explicit overrides', () => {
  const options = { rawConfig: {}, workspaceDir: '/project', stateDir: '/application-state' };
  expect(resolveAcpxPluginConfig(options)).toMatchObject({
    cwd: path.resolve('/project'),
    stateDir: path.resolve('/application-state/acpx'),
  });
  expect(resolveAcpxPluginConfig({ ...options, workspaceDir: '/another-project' }).stateDir).toBe(
    path.resolve('/application-state/acpx'),
  );
  expect(
    resolveAcpxPluginConfig({ ...options, rawConfig: { stateDir: '/explicit-state' } }).stateDir,
  ).toBe(path.resolve('/explicit-state'));
  expect(resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: '/project' }).stateDir).toBe(
    path.resolve('/native-state/acpx'),
  );
});

test('the service passes its native state owner into config resolution', () => {
  const source = fs.readFileSync(path.resolve('openclaw-extensions/acpx/src/service.ts'), 'utf8');
  expect(source).toMatch(
    /resolveAcpxPluginConfig\(\{\s*rawConfig: params\.pluginConfig,\s*workspaceDir: ctx\.workspaceDir,\s*stateDir: ctx\.stateDir,/,
  );
});
