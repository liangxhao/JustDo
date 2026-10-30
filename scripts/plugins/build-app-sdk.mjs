import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSdkPackage } from '@app-plugin/build/sdk';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function buildAppSdk(destination = path.join(repo, 'build/app-plugin-sdk')) {
  return buildSdkPackage({
    source: path.join(repo, 'plugins/sdk/app-plugin-sdk'),
    destination,
    licenseFile: path.join(repo, 'LICENSE'),
  });
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  console.log(await buildAppSdk());
