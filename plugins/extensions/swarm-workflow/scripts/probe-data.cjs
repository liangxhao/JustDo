'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Simulate host preparation only for the isolated native smoke/probe state. */
function prepareWorkflowProbeData(stateDirectory) {
  if (!path.isAbsolute(stateDirectory) || path.parse(stateDirectory).root === stateDirectory)
    throw new Error('An isolated absolute state directory is required');
  const directory = path.join(stateDirectory, 'plugin-data', 'swarm-workflow');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.owner.json'), JSON.stringify({
    schemaVersion: 1, pluginId: 'swarm-workflow', dataId: randomUUID(), retention: 'retain',
  }), { flag: 'wx' });
  return directory;
}

module.exports = { prepareWorkflowProbeData };
