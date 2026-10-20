import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parse } from 'acorn';

import type { AppPluginManifest } from '../../../../packages/app-plugin-sdk/contracts';

type SyntaxNode = Record<string, unknown> & { type: string };
export interface AppModuleGraphs {
  browser: ReadonlySet<string>;
  presentation: ReadonlySet<string>;
}
/** Approved artifact modules may only import indexed code or native Node builtins in Main. */
export const verifyAppModuleGraph = (
  manifest: AppPluginManifest,
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
): AppModuleGraphs => {
  const parsed = new Map<string, { imports: string[]; requires: string[]; resources: string[] }>();
  for (const [name, source] of sources) {
    if (source.length > 8 * 1024 * 1024) throw new Error('App module is too large');
    const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const imports: string[] = [];
    const requires: string[] = [];
    const resources: string[] = [];
    const literal = (node: unknown): string => {
      const value = node as SyntaxNode | undefined;
      if (value?.type !== 'Literal' || typeof value.value !== 'string')
        throw new Error('Computed app module loading is not supported');
      return value.value;
    };
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const item = node as SyntaxNode;
      if (
        [
          'ImportDeclaration',
          'ExportAllDeclaration',
          'ExportNamedDeclaration',
          'ImportExpression',
        ].includes(item.type) &&
        item.source
      )
        imports.push(literal(item.source));
      if (['CallExpression', 'NewExpression'].includes(item.type)) {
        const callee = item.callee as SyntaxNode | undefined;
        if (
          callee?.type === 'Identifier' &&
          ['require', '__require'].includes(String(callee.name))
        ) {
          requires.push(literal((item.arguments as unknown[])[0]));
        }
        // Workers can be mounted through URL rather than import(). Keep their
        // indexed code graph even when the same pure chunk is also used in Main.
        const args = item.arguments as SyntaxNode[];
        const base = args[1];
        const baseObject = base?.object as SyntaxNode | undefined;
        if (
          item.type === 'NewExpression' &&
          callee?.type === 'Identifier' &&
          callee.name === 'URL' &&
          base?.type === 'MemberExpression' &&
          (base.property as SyntaxNode)?.name === 'url' &&
          baseObject?.type === 'MetaProperty' &&
          (baseObject.meta as SyntaxNode)?.name === 'import' &&
          (baseObject.property as SyntaxNode)?.name === 'meta' &&
          args[0]?.type === 'Literal' &&
          typeof args[0].value === 'string' &&
          /^\.\.?\//u.test(args[0].value)
        )
          resources.push(args[0].value);
        const name =
          callee?.type === 'Identifier'
            ? callee.name
            : callee?.type === 'MemberExpression'
              ? ((callee.property as SyntaxNode)?.name ?? (callee.property as SyntaxNode)?.value)
              : undefined;
        if (
          [
            'createRequire',
            'eval',
            'Function',
            'getBuiltinModule',
            'binding',
            '_load',
            'runInThisContext',
            'runInNewContext',
          ].includes(String(name))
        )
          throw new Error('Dynamic app code loading is not supported');
      }
      for (const [key, child] of Object.entries(item))
        if (!['start', 'end', 'loc', 'raw'].includes(key)) visit(child);
    };
    visit(syntax);
    parsed.set(name, { imports, requires, resources });
  }
  const covered = new Set<string>();
  const visited = new Set<string>();
  const browser = new Set<string>();
  const presentation = new Set<string>();
  const visitGraph = (entry: string, kind: 'main' | 'browser' | 'presentation'): void => {
    const main = kind === 'main';
    const key = `${kind}:${entry}`;
    if (visited.has(key)) return;
    visited.add(key);
    const module = parsed.get(entry);
    if (!module) throw new Error('App module dependency is not indexed');
    if (kind === 'browser' && entry === manifest.entries.main)
      throw new Error('Browser module referenced Main entry');
    if (kind === 'presentation') {
      if (
        [manifest.entries.main, manifest.entries.browser].includes(entry) ||
        sources.get(entry)?.includes('app-plugin.browser-runtime.v1')
      )
        throw new Error('History presentation imported a business entry or browser runtime');
      presentation.add(entry);
    } else if (kind === 'browser') browser.add(entry);
    covered.add(entry);
    const references: Array<{ specifier: string; resource: boolean }> = [
      ...[...module.imports, ...module.requires].map(specifier => ({ specifier, resource: false })),
      ...module.resources.map(specifier => ({ specifier, resource: true })),
    ];
    for (const { specifier, resource } of references) {
      if (main && isBuiltin(specifier)) {
        if (
          ['module', 'vm', 'worker_threads', 'child_process'].includes(
            specifier.replace(/^node:/u, ''),
          )
        )
          throw new Error('Dynamic app module loaders are unsupported');
        continue;
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../'))
        throw new Error('Undeclared app external dependency');
      if (/[\\%?#]/u.test(specifier)) throw new Error('Invalid app module specifier');
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(entry), specifier));
      if (relative.startsWith('../') || !files.has(relative))
        throw new Error('App module dependency escaped its artifact');
      if (sources.has(relative)) visitGraph(relative, kind);
      else if (!resource) throw new Error('App module dependency is not indexed');
    }
  };
  visitGraph(manifest.entries.main, 'main');
  visitGraph(manifest.entries.browser, 'browser');
  if (manifest.entries.presentation) visitGraph(manifest.entries.presentation, 'presentation');
  // Workers and separately mounted browser modules have the browser capability boundary.
  for (const entry of sources.keys()) if (!covered.has(entry)) visitGraph(entry, 'browser');
  return { browser, presentation };
};
