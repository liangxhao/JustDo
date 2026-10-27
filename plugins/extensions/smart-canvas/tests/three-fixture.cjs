'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// npm development dependency only; never installed as a widget asset.
const THREE_FIXTURE = Object.freeze({
  version: require('../package.json').devDependencies.three,
});

/** Read installed ESM modules for controlled local HTTPS test fixtures. */
function readThreeModules() {
  const packageRoot = path.resolve(path.dirname(require.resolve('three')), '..');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version,
    THREE_FIXTURE.version,
  );
  const modules = new Map();
  const selected = [
    'build/three.module.js',
    'build/three.core.js',
    'examples/jsm/controls/OrbitControls.js',
  ];
  for (const name of selected)
    modules.set(
      `/npm/three@${THREE_FIXTURE.version}/${name}`,
      fs.readFileSync(path.join(packageRoot, name)),
    );
  return { modules, version: THREE_FIXTURE.version };
}

module.exports = { THREE_FIXTURE, readThreeModules };
