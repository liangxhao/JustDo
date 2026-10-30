#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildAppPlugin, buildAppPlugins } from './build.mjs';
import { typecheckAppPlugin, typecheckAppPlugins } from './typecheck.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    'source-root': { type: 'string' },
    out: { type: 'string' },
    'sdk-root': { type: 'string' },
  },
});
const [command = 'build'] = positionals;
if (
  positionals.length > 1 ||
  !['build', 'check'].includes(command) ||
  (values.source && values['source-root'])
)
  throw new Error(
    'Usage: app-plugin-build build|check [--source <plugin> | --source-root <extensions>] [--out <output>] [--sdk-root <public-sdk>]',
  );
const options = {
  sourceRoot: values['source-root'],
  destination: values.out,
  openclawSdkRoot: values['sdk-root'],
};
const result =
  command === 'build'
    ? values.source
      ? [await buildAppPlugin(values.source, values.out ?? 'build/app-plugins')]
      : await buildAppPlugins(options)
    : values.source
      ? [await typecheckAppPlugin(values.source, options)]
      : await typecheckAppPlugins(options);
console.log(JSON.stringify(result.map(({ id, hash }) => ({ id, ...(hash ? { hash } : {}) }))));
