import path from 'node:path';

import ts from 'typescript';
import { expect, test } from 'vitest';

test('Core process types remain valid without either optional business plugin source tree', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const removed = ['agent-team', 'swarm-workflow'].map(id =>
    path.join(root, 'plugins/extensions', id).replaceAll('\\', '/').toLowerCase(),
  );
  const unavailable = (filename: string) => {
    const absolute = path.resolve(filename).replaceAll('\\', '/').toLowerCase();
    return removed.some(directory => absolute === directory || absolute.startsWith(directory + '/'));
  };
  for (const configName of ['electron-tsconfig.json', 'tsconfig.json']) {
    const filename = path.join(root, configName);
    const source = ts.readConfigFile(filename, ts.sys.readFile);
    expect(source.error).toBeUndefined();
    const config = ts.parseJsonConfigFileContent(source.config, ts.sys, root, { noEmit: true }, filename);
    const host = ts.createCompilerHost(config.options);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const directoryExists = host.directoryExists!.bind(host);
    host.fileExists = file => !unavailable(file) && fileExists(file);
    host.directoryExists = directory => !unavailable(directory) && directoryExists(directory);
    host.getSourceFile = (file, ...args) => unavailable(file) ? undefined : getSourceFile(file, ...args);
    const program = ts.createProgram(config.fileNames.filter(file => !unavailable(file)), config.options, host);
    const errors = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
    expect(ts.formatDiagnostics(errors, {
      getCanonicalFileName: file => file,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    })).toBe('');
    expect(program.getSourceFiles().some(file => unavailable(file.fileName))).toBe(false);
  }
}, 30_000);
