'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Test input only. Neither this archive nor Three is an installed widget asset.
const THREE_FIXTURE = Object.freeze({
  version: '0.186.1',
  archive: 'three-0.186.1.tgz',
  integrity:
    'sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==',
});

/** Read verified real ESM modules into memory without preparing runtime assets. */
function readThreeModules(repoRoot = path.resolve(__dirname, '../../../..'), archivePath) {
  const archive = fs.readFileSync(
    path.resolve(archivePath ?? path.join(repoRoot, 'cache/widget-kit', THREE_FIXTURE.archive)),
  );
  assert.equal(
    `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    THREE_FIXTURE.integrity,
  );
  const modules = new Map();
  const selected = [
    'build/three.module.js',
    'build/three.core.js',
    'examples/jsm/controls/OrbitControls.js',
  ];
  require('tar')
    .t({
      sync: true,
      onentry(entry) {
        const name = entry.path.replace(/^package\//, '');
        if (!selected.includes(name)) return;
        assert.equal(entry.type, 'File');
        const parts = [];
        entry.on('data', chunk => parts.push(chunk));
        entry.on('end', () =>
          modules.set(`/npm/three@${THREE_FIXTURE.version}/${name}`, Buffer.concat(parts)),
        );
      },
    })
    .end(archive);
  assert.equal(modules.size, selected.length);
  return { modules, version: THREE_FIXTURE.version };
}

module.exports = { THREE_FIXTURE, readThreeModules };
