import path from 'node:path';
import { normalizePath, transformWithOxc } from 'vite';

/** Generate nested Hook signatures that Vite otherwise skips in non-JSX .ts files. */
/** @returns {import('vite').Plugin} */
export function reactHooksRefreshPlugin(projectRoot) {
  const rendererRoot = normalizePath(path.join(projectRoot, 'src/renderer')) + '/';
  const extensionsRoot = normalizePath(path.join(projectRoot, 'plugins/extensions')) + '/';
  let runtimeUrl = '/@react-refresh';
  return {
    name: 'react-hooks-refresh',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      runtimeUrl = `${config.base}@react-refresh`;
    },
    applyToEnvironment(environment) {
      return (
        environment.config.consumer === 'client' &&
        !environment.config.isProduction &&
        environment.config.server.hmr !== false
      );
    },
    async transform(code, id) {
      const filename = normalizePath(id.split('?')[0]);
      if (!filename.endsWith('.ts') || filename.endsWith('.d.ts')) return;
      const isBrowserSource =
        filename.startsWith(rendererRoot) ||
        (filename.startsWith(extensionsRoot) && filename.includes('/browser/'));
      if (!isBrowserSource || !/\buse[A-Z0-9]\w*\s*\(/u.test(code)) return;
      // Plain .ts modules also skip React's refresh wrapper. Bind signatures
      // directly to its runtime, leaving HMR propagation to their consumers.
      let signatureName = '__createHookSignature';
      while (code.includes(signatureName)) signatureName += '_';
      const result = await transformWithOxc(code, filename, {
        jsx: { runtime: 'automatic', refresh: { refreshSig: signatureName } },
        sourcemap: true,
      });
      if (!result.code.includes(`${signatureName}(`)) return;
      return {
        ...result,
        code:
          `import { createSignatureFunctionForTransform as ${signatureName} } from ${JSON.stringify(runtimeUrl)};\n` +
          result.code,
        map: result.map && { ...result.map, mappings: ';' + result.map.mappings },
      };
    },
  };
}
