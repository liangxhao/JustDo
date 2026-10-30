'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

if (!process.env.APP_PLUGIN_HOST_ROOT?.trim())
  throw new Error('Set APP_PLUGIN_HOST_ROOT to the host repository for this explicit integration probe.');
const hostRoot = fs.realpathSync(path.resolve(process.env.APP_PLUGIN_HOST_ROOT));
if (!fs.statSync(path.join(hostRoot, 'package.json')).isFile())
  throw new Error('APP_PLUGIN_HOST_ROOT must identify the host repository.');
const pluginRoot = fs.realpathSync(path.resolve(__dirname, '..'));
const hostRequire = createRequire(path.join(hostRoot, 'package.json'));

module.exports = { hostRoot, pluginRoot, hostRequire };
