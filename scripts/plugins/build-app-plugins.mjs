import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAppPlugin as buildPlugin, buildAppPlugins as buildPlugins } from '@app-plugin/build';
import { buildAppSdk } from './build-app-sdk.mjs';

export { browserSdk } from '@app-plugin/build';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const withHostBoundary = options => ({
  licenseFile: path.join(repo, 'LICENSE'),
  ...options,
  forbiddenSourceRoots: [...(options.forbiddenSourceRoots ?? []), path.join(repo, 'src')],
});
export function buildAppPlugin(source, destination, options = {}) {
  return buildPlugin(source, destination, withHostBoundary(options));
}
export async function buildAppPlugins(options = {}) {
  await buildAppSdk();
  return buildPlugins(
    withHostBoundary({
      sourceRoot: path.join(repo, 'plugins/extensions'),
      destination: path.join(repo, 'build/app-plugins'),
      ...options,
    }),
  );
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = process.argv[2]
    ? [
        await buildAppPlugin(
          process.argv[2],
          process.argv[3] ?? path.join(repo, 'build/app-plugins'),
        ),
      ]
    : await buildAppPlugins();
  console.log(JSON.stringify(result.map(({ id, hash }) => ({ id, hash }))));
}
