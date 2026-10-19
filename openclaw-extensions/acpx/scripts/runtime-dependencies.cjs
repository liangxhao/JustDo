'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT_PACKAGE_NAME = String.raw`@(?:openai/codex-(?:win32|darwin|linux)-(?:x64|arm64)|anthropic-ai/claude-agent-sdk-(?:(?:win32|darwin)-(?:x64|arm64)|linux-(?:x64|arm64)(?:-musl)?))`;
const AGENT_PACKAGE_ROOT_PATTERN = new RegExp(String.raw`(?:^|/node_modules/)${AGENT_PACKAGE_NAME}$`, 'u');
const AGENT_PACKAGE_ENTRY_PATTERN = new RegExp(String.raw`(?:^|/node_modules/)${AGENT_PACKAGE_NAME}(?:/|$)`, 'u');

// ACP adapters are transport dependencies. Third-party agent executables are
// installed and maintained by the user, never distributed with this plugin.
function verifyExternalAgentPackages(entries) {
  const forbidden = entries.filter(entry =>
    AGENT_PACKAGE_ENTRY_PATTERN.test(entry.replaceAll('\\', '/').replace(/^\.\//u, '')),
  );
  if (forbidden.length > 0) {
    throw new Error('ACPX must not bundle third-party agent binaries: ' + forbidden.join(', '));
  }
}

function removeExternalAgentPackages(extensionDir) {
  const modulesDir = path.resolve(extensionDir, 'node_modules');
  if (!fs.existsSync(modulesDir)) return;
  if (fs.lstatSync(modulesDir).isSymbolicLink()) {
    throw new Error('Refusing to prune linked ACPX dependency directory: ' + modulesDir);
  }
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name);
      const relative = path.relative(modulesDir, target);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('Invalid ACPX dependency path');
      }
      if ((entry.isDirectory() || entry.isSymbolicLink()) &&
        AGENT_PACKAGE_ROOT_PATTERN.test(relative.replaceAll('\\', '/'))) {
        if (entry.isSymbolicLink()) fs.unlinkSync(target);
        else fs.rmSync(target, { recursive: true, force: true });
        continue;
      }
      // Normal npm .bin links point to files. Never descend through directory
      // links into another installation while examining nested packages.
      if (entry.isSymbolicLink()) {
        if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
          throw new Error('Refusing to prune linked ACPX dependency directory: ' + target);
        }
        continue;
      }
      if (entry.isDirectory()) visit(target);
    }
  }
  visit(modulesDir);
}

module.exports = { removeExternalAgentPackages, verifyExternalAgentPackages };
