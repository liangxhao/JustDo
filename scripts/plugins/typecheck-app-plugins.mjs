import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typecheckAppPlugins } from '@app-plugin/build/typecheck';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await typecheckAppPlugins({
  sourceRoot: path.join(repo, 'plugins/extensions'),
  openclawSdkRoot:
    process.env.OPENCLAW_SDK_ROOT ??
    path.join(repo, 'vendor/openclaw-runtime/current/dist/plugin-sdk'),
});
console.log('Independent app plugin types passed.');
