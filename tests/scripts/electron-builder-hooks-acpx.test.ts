import { describe, expect, test } from 'vitest';

const { verifyAcpxArtifactEntryPaths } = require('../../scripts/packaging/electron-builder-hooks.cjs') as {
  verifyAcpxArtifactEntryPaths: (
    entryPaths: Set<string>,
    prefix: string,
    installTarget: { targetId: string; os: string; cpu: string },
    buildHint: string,
  ) => void;
};

const installTarget = { targetId: 'win-x64', os: 'win32', cpu: 'x64' };
const acpxPrefix = 'cfmind/dist/extensions/acpx/';
const completeEntries = new Set([
  `${acpxPrefix}index.js`,
  `${acpxPrefix}package.json`,
  `${acpxPrefix}openclaw.plugin.json`,
  `${acpxPrefix}.justdo-extension-assembly.json`,
  `${acpxPrefix}THIRD_PARTY_NOTICES.md`,
  `${acpxPrefix}node_modules/acpx/dist/runtime.js`,
  `${acpxPrefix}node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`,
  `${acpxPrefix}node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
  `${acpxPrefix}node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`,
  `${acpxPrefix}node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`,
]);

describe('packaged ACPX artifact verification', () => {
  test('accepts a complete target-specific ACPX payload', () => {
    expect(() =>
      verifyAcpxArtifactEntryPaths(completeEntries, 'cfmind/', installTarget, 'test'),
    ).not.toThrow();
  });

  test('fails closed when legal metadata or a native adapter is missing', () => {
    const incompleteEntries = new Set(completeEntries);
    incompleteEntries.delete(`${acpxPrefix}THIRD_PARTY_NOTICES.md`);
    incompleteEntries.delete(
      `${acpxPrefix}node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`,
    );

    expect(() =>
      verifyAcpxArtifactEntryPaths(incompleteEntries, 'cfmind/', installTarget, 'test'),
    ).toThrow(/THIRD_PARTY_NOTICES\.md.*Codex|Codex.*THIRD_PARTY_NOTICES\.md/iu);
  });
});
