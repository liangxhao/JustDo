'use strict';

const { prepareInstallerAnimationAssets } = require('./installer-animation-assets.cjs');

function prepareInstallerAnimationScript(projectDir) {
  const assets = prepareInstallerAnimationAssets(projectDir);
  const { loopFirstFrame, lastFrame } = assets;
  if (
    !Number.isInteger(loopFirstFrame) ||
    !Number.isInteger(lastFrame) ||
    loopFirstFrame < 1 ||
    lastFrame < loopFirstFrame ||
    lastFrame >= 65536
  ) {
    throw new Error('Invalid installer animation frame ranges.');
  }
  const directory = assets.directory.replaceAll('$', '$$');
  const completeFrame = (lastFrame << 16) | lastFrame;
  return [
    `!define INSTALLER_ANIMATION_DIR "${directory}"`,
    `!define INSTALLER_ANIMATION_LOOP_FIRST ${loopFirstFrame}`,
    `!define INSTALLER_ANIMATION_LAST_FRAME ${lastFrame}`,
    `!define INSTALLER_ANIMATION_COMPLETE_FRAME ${completeFrame}`,
    '',
  ].join('\n');
}

module.exports = { prepareInstallerAnimationScript };
