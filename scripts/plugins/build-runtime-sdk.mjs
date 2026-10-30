import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSdkPackage } from '@app-plugin/build/sdk';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function buildRuntimeSdk(destination = path.join(repo, 'build/runtime-services-sdk')) {
  return buildSdkPackage({
    source: path.join(repo, 'plugins/extensions/runtime-services/sdk'),
    destination,
    licenseFile: path.join(repo, 'LICENSE'),
  });
}
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  console.log(await buildRuntimeSdk());
