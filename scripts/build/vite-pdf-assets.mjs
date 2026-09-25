import fs from 'node:fs';
import path from 'node:path';

/** @returns {import('vite').Plugin} */
export function pdfAssetsPlugin(dependencyRoot) {
  return {
    name: 'pdfjs-support-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const asset = request.url?.split('?')[0] ?? '';
        if (!/^\/(cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9_.-]+$/u.test(asset)) return next();
        const source = path.join(dependencyRoot, 'pdfjs-dist', asset);
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) return next();
        response.setHeader(
          'Content-Type',
          asset.endsWith('.wasm')
            ? 'application/wasm'
            : asset.endsWith('.js')
              ? 'text/javascript'
              : 'application/octet-stream',
        );
        fs.createReadStream(source).pipe(response);
      });
    },
    generateBundle() {
      for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        const sourceDirectory = path.join(dependencyRoot, 'pdfjs-dist', directory);
        for (const filename of fs.readdirSync(sourceDirectory)) {
          const source = path.join(sourceDirectory, filename);
          if (fs.statSync(source).isFile()) {
            this.emitFile({
              type: 'asset',
              fileName: `pdfjs/${directory}/${filename}`,
              source: fs.readFileSync(source),
            });
          }
        }
      }
    },
  };
}
