import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';

const tar = require('tar');
const { extractDrawioSource } = require('../scripts/prepare.cjs');
const upstream = require('../upstream.json');
const sourceName = `drawio-${upstream.commit}`;
const webapp = `${sourceName}/src/main/webapp`;
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function entry(name: string, content = '', type = 'File', linkpath?: string) {
  const body = Buffer.from(content);
  const header = new tar.Header({
    path: name,
    type,
    size: body.length,
    mode: type === 'Directory' ? 0o755 : 0o644,
    linkpath,
  });
  header.encode();
  return Buffer.concat([header.block, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function fixture(entries: Buffer[]) {
  const buildRoot = path.resolve(__dirname, '../../../../build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(buildRoot, 'diagram-extraction-'));
  directories.push(directory);
  const staging = path.join(directory, '图表 暂存');
  const archive = path.join(directory, '图表 源码.tar.gz');
  fs.mkdirSync(staging);
  fs.writeFileSync(archive, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  return { directory, archive, staging };
}

it('extracts the pinned editor subtree and license in Chinese paths without system tar', () => {
  const { directory, archive, staging } = fixture([
    entry(`${webapp}/`, '', 'Directory'),
    entry(`${webapp}/index.html`, '<html>offline</html>'),
    entry(`${webapp}/img/lib/mscae/Offer.svg`, '<svg>Offer</svg>'),
    entry(`${sourceName}/LICENSE`, 'Apache-2.0'),
    entry(`${sourceName}/LICENSE.extra`, 'exclude'),
    entry(`${webapp}-extra/other.txt`, 'exclude'),
    entry(`${sourceName}/src/main/java/server.java`, 'exclude'),
  ]);
  vi.stubEnv('PATH', directory);

  extractDrawioSource(archive, staging);

  expect(fs.readFileSync(path.join(staging, webapp, 'img/lib/mscae/Offer.svg'), 'utf8')).toBe(
    '<svg>Offer</svg>',
  );
  expect(fs.readFileSync(path.join(staging, webapp, 'index.html'), 'utf8')).toBe(
    '<html>offline</html>',
  );
  expect(fs.readFileSync(path.join(staging, sourceName, 'LICENSE'), 'utf8')).toBe('Apache-2.0');
  expect(fs.readdirSync(path.join(staging, sourceName)).sort()).toEqual(['LICENSE', 'src']);
  expect(fs.readdirSync(path.join(staging, sourceName, 'src/main'))).toEqual(['webapp']);
});

it('rejects archive links before creating them and retains the extraction cause', () => {
  const { archive, staging } = fixture([
    entry(`${webapp}/linked.svg`, '', 'SymbolicLink', '../../outside.svg'),
  ]);

  expect(() => extractDrawioSource(archive, staging)).toThrow(
    /Could not extract draw.io source archive: Unsupported.*SymbolicLink/,
  );
  expect(fs.existsSync(path.join(staging, webapp, 'linked.svg'))).toBe(false);
});

it('fails strictly on traversal entries without writing outside the editor subtree', () => {
  const { archive, staging } = fixture([entry(`${webapp}/../outside.txt`, 'outside')]);

  expect(() => extractDrawioSource(archive, staging)).toThrow(
    /Could not extract draw.io source archive:.*\.\./,
  );
  expect(fs.existsSync(path.join(staging, sourceName, 'src/main/outside.txt'))).toBe(false);
});
