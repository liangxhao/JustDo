import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppInitializationActivity } from '../../shared/app/initialization';
import { StartupRoute } from '../../shared/app/startup/routing';
import { DEFAULT_WORKSPACE_DIRECTORY_NAME } from '../../shared/productMetadata';
import { AppInitialization } from '../startup/initialization/appInitialization';
import { CoworkStore, getDefaultWorkingDirectory } from './coworkStore';

// These tests exercise no database. Accidental native construction must fail.
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() {
      throw new Error('The workspace initializer must not open SQLite.');
    }
  },
}));

const main = ts.createSourceFile(
  'main.ts',
  fs.readFileSync(new URL('../main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const declarations: ts.VariableDeclaration[] = [];
const visit = (node: ts.Node) => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'defaultProjectDir'
  )
    declarations.push(node);
  ts.forEachChild(node, visit);
};
visit(main);
if (declarations.length !== 1) throw new Error('Main must have one default workspace initializer.');
const statement = declarations[0].parent.parent;
if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent))
  throw new Error('The workspace initializer must remain in the startup sequence.');
const statements = statement.parent.statements;
const index = statements.indexOf(statement);
const startupBlock = statements
  .slice(index, index + 4)
  .map(node => node.getText(main))
  .join('\n');
const javascript = ts.transpileModule(`async function prepare() { ${startupBlock} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Execute the actual Main block and actual optional-task owner, without Electron.
const prepare = (initialization: AppInitialization, filesystem: Pick<typeof fs, 'promises'> = fs) =>
  new Function(
    'getDefaultWorkingDirectory',
    'initialization',
    'fs',
    'AppInitializationActivity',
    'appShutdown',
    javascript + '\nreturn prepare();',
  )(getDefaultWorkingDirectory, initialization, filesystem, AppInitializationActivity, {
    isQuitting: () => false,
  }) as Promise<void>;

let root: string;
let home: string;
let initialization: AppInitialization;
const defaultPath = () => path.join(home, DEFAULT_WORKSPACE_DIRECTORY_NAME, 'project');
const config = (workingDirectory?: string) =>
  CoworkStore.prototype.getConfig.call({
    getAll: () => (workingDirectory ? [{ key: 'workingDirectory', value: workingDirectory }] : []),
  } as unknown as CoworkStore);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-default-'));
  home = path.join(root, 'home');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('JUSTDO_DEV_WORKSPACE_DIR', '');
  initialization = new AppInitialization(path.join(root, 'profile'), StartupRoute.Fresh, () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('workspace-default-'))
    throw new Error('Refusing to remove an unexpected fixture root.');
  fs.rmSync(root, { recursive: true, force: true });
});

describe('default workspace startup ownership', () => {
  it('prepares the same Chinese/spaced development default returned to homepage Apps', async () => {
    const workspace = path.join(root, '隔离 用户目录', 'project');
    vi.stubEnv('JUSTDO_DEV_WORKSPACE_DIR', workspace);
    expect(config().workingDirectory).toBe(workspace);

    await prepare(initialization);

    expect(fs.statSync(config().workingDirectory).isDirectory()).toBe(true);
    expect(fs.existsSync(defaultPath())).toBe(false);
    expect(initialization.getState().activity).toBe(AppInitializationActivity.Workspace);
  });

  it('preserves existing default project files across repeated startup', async () => {
    fs.mkdirSync(defaultPath(), { recursive: true });
    const existing = path.join(defaultPath(), 'existing.txt');
    fs.writeFileSync(existing, 'retained content');

    await prepare(initialization);
    await prepare(initialization);

    expect(config().workingDirectory).toBe(defaultPath());
    expect(fs.readFileSync(existing, 'utf8')).toBe('retained content');
    expect(fs.readdirSync(defaultPath())).toEqual(['existing.txt']);
  });

  it.each(['relative/project', ''])(
    'ignores an invalid or missing development override: %j',
    async value => {
      vi.stubEnv('JUSTDO_DEV_WORKSPACE_DIR', value);
      expect(getDefaultWorkingDirectory()).toBe(defaultPath());
      await prepare(initialization);
      expect(fs.statSync(defaultPath()).isDirectory()).toBe(true);
    },
  );

  it.each(['production', 'test'])(
    'ignores an absolute development override in %s',
    async environment => {
      const override = path.join(root, 'unselected', 'project');
      vi.stubEnv('NODE_ENV', environment);
      vi.stubEnv('JUSTDO_DEV_WORKSPACE_DIR', override);

      await prepare(initialization);

      expect(config().workingDirectory).toBe(defaultPath());
      expect(fs.statSync(defaultPath()).isDirectory()).toBe(true);
      expect(fs.existsSync(override)).toBe(false);
    },
  );

  it('retains a saved custom working directory without creating it during default preparation', async () => {
    const saved = path.join(root, 'custom-missing', 'project');
    expect(config(saved).workingDirectory).toBe(saved);
    await prepare(initialization);
    expect(config(saved).workingDirectory).toBe(saved);
    expect(fs.existsSync(saved)).toBe(false);
    expect(fs.statSync(defaultPath()).isDirectory()).toBe(true);
  });

  it('keeps a file collision intact and reports the existing optional-task failure', async () => {
    fs.mkdirSync(path.dirname(defaultPath()), { recursive: true });
    fs.writeFileSync(defaultPath(), 'not a directory');

    await prepare(initialization);

    expect(fs.readFileSync(defaultPath(), 'utf8')).toBe('not a directory');
    expect(console.error).toHaveBeenCalledWith(
      '[AppInitialization] Optional startup task failed; continuing:',
      'prepare default project directory',
      expect.any(Object),
      expect.any(Error),
    );
  });

  it('awaits the filesystem preparation before continuing toward Gateway and homepage readiness', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const mkdir = vi.fn(async (directory: string) => {
      await held;
      return fs.promises.mkdir(directory, { recursive: true });
    });
    let finished = false;
    const task = prepare(initialization, {
      promises: { mkdir } as unknown as typeof fs.promises,
    }).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(fs.existsSync(defaultPath())).toBe(false);
    release();
    await task;
    expect(fs.statSync(defaultPath()).isDirectory()).toBe(true);
    expect(finished).toBe(true);
    const source = statement.parent.getText(main);
    expect(source.indexOf(statement.getText(main))).toBeLessThan(
      source.indexOf('const status = await ensureOpenClawRunningForCowork()'),
    );
    const resolverImports = main.statements.filter(
      node =>
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          element => element.name.text === 'getDefaultWorkingDirectory',
        ),
    );
    expect(resolverImports).toHaveLength(1);
    expect((resolverImports[0] as ts.ImportDeclaration).moduleSpecifier.getText(main)).toBe(
      "'./data/coworkStore'",
    );
    expect(startupBlock).toContain('await initialization.runOptionalTask');
    expect(startupBlock).toContain('if (appShutdown.isQuitting()) return;');
  });
});
