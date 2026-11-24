'use strict';

const { workerData, parentPort } = require('node:worker_threads');
const {
  inspectConfiguredPluginPath,
  inspectOpenClawExtensionDirectory,
} = require('../../../plugins/extensions/openclawExtensionInventory.cjs');

parentPort.postMessage({
  workspace: new Map(workerData.workspace.map(directory =>
    [directory, inspectOpenClawExtensionDirectory(directory)],
  )),
  configured: new Map(workerData.configured.map(pluginPath =>
    [pluginPath, inspectConfiguredPluginPath(pluginPath)],
  )),
});
