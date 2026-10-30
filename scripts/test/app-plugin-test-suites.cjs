'use strict';

const fs = require('node:fs');
const path = require('node:path');

function discoverAppPluginTestSuites(projectRoot) {
  const sourceRoot = path.join(projectRoot, 'plugins/extensions');
  if (!fs.existsSync(sourceRoot)) return [];
  return fs.readdirSync(sourceRoot, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory()) return [];
    const pluginRoot = path.join(sourceRoot, entry.name);
    const packageFile = path.join(pluginRoot, 'package.json');
    if (!fs.existsSync(packageFile)) return [];
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (!pkg.app) return [];
    const config = path.join(pluginRoot, 'vitest.config.ts');
    if (!pkg.scripts?.test || !fs.existsSync(config))
      throw new Error(`App plugin must declare its independent test suite: ${entry.name}`);
    return [{ root: pluginRoot, config }];
  });
}

module.exports = { discoverAppPluginTestSuites };
