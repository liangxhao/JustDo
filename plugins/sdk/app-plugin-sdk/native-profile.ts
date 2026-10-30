/** Cold app companions support one native ESM business module on the host SDK baseline.
 * This verifies a supported module format, not a sandbox for trusted JavaScript.
 */
export const APP_NATIVE_PROFILE = 'single-file-v1';
type SyntaxNode = Record<string, unknown> & { type: string };
export function verifyAppNativeModule(
  source: string,
  parse: (source: string, options: { ecmaVersion: 'latest'; sourceType: 'module' }) => unknown,
  isBuiltin: (specifier: string) => boolean,
): void {
  if (source.length > 8 * 1024 * 1024) throw new Error('App native module is too large');
  const forbiddenBuiltins = new Set(['module', 'vm', 'worker_threads', 'child_process']);
  const specifier = (node: unknown): void => {
    const item = node as SyntaxNode | undefined;
    if (item?.type !== 'Literal' || typeof item.value !== 'string')
      throw new Error('Computed native module loading is unsupported');
    const name = item.value;
    if (/^openclaw\/plugin-sdk\/[a-z][a-z0-9-]*$/u.test(name)) return;
    if (isBuiltin(name) && !forbiddenBuiltins.has(name.replace(/^node:/u, ''))) return;
    throw new Error('App native modules must bundle business dependencies into one ESM entry');
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
      specifier(item.source);
    if (['CallExpression', 'NewExpression'].includes(item.type)) {
      const callee = item.callee as SyntaxNode | undefined;
      const name =
        callee?.type === 'Identifier'
          ? callee.name
          : callee?.type === 'MemberExpression'
            ? ((callee.property as SyntaxNode)?.name ?? (callee.property as SyntaxNode)?.value)
            : undefined;
      if (
        [
          'require',
          '__require',
          'createRequire',
          'eval',
          'Function',
          'getBuiltinModule',
          'binding',
          '_load',
          'runInThisContext',
          'runInNewContext',
        ].includes(String(name))
      ) {
        throw new Error('Dynamic native business code loading is unsupported');
      }
    }
    for (const [key, child] of Object.entries(item))
      if (!['start', 'end', 'loc', 'raw'].includes(key)) visit(child);
  };
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
}
