import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';

const {
  removeExternalAgentPackages,
  verifyExternalAgentPackages,
} = require('../scripts/runtime-dependencies.cjs');

test('removes third-party agent binaries while retaining adapters and runtime dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpx-dependencies-'));
  const agents = ['@openai/codex-win32-x64', '@anthropic-ai/claude-agent-sdk-win32-x64'];
  const retained = [
    '@agentclientprotocol/codex-acp',
    '@anthropic-ai/claude-agent-sdk',
    '@openclaw/fs-safe-win32-x64-msvc',
  ];
  try {
    for (const name of [...agents, ...retained]) {
      const dir = path.join(root, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'payload'), 'fixture');
    }
    expect(() => verifyExternalAgentPackages(agents)).toThrow(/must not bundle/u);
    removeExternalAgentPackages(root);
    removeExternalAgentPackages(root);
    for (const name of agents)
      expect(fs.existsSync(path.join(root, 'node_modules', name))).toBe(false);
    for (const name of retained)
      expect(fs.existsSync(path.join(root, 'node_modules', name, 'payload'))).toBe(true);
    expect(() => verifyExternalAgentPackages(retained)).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains similarly named source files and packages outside complete platform-package boundaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpx-package-boundaries-'));
  const files = [
    '@openai/codex-schema.js',
    '@openai/codex-win32-x64.js',
    '@anthropic-ai/claude-agent-sdk-schema.js',
    'parent/node_modules/@openai/codex-schema.js',
    'parent/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64.js',
    'parent/assets/@openai/codex-win32-x64/payload',
    '@openai/codex-linux-x64-extra/payload',
  ];
  try {
    for (const file of files) {
      const target = path.join(root, 'node_modules', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'keep');
    }
    expect(() => verifyExternalAgentPackages(files)).not.toThrow();
    removeExternalAgentPackages(root);
    for (const file of files) {
      expect(fs.readFileSync(path.join(root, 'node_modules', file), 'utf8'), file).toBe('keep');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes and rejects agent platform packages at every nested npm boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpx-nested-dependencies-'));
  const agents = [
    '@openai/codex-win32-x64',
    'parent/node_modules/@openai/codex-linux-arm64',
    '@scope/parent/node_modules/child/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64',
  ];
  const retained = [
    'parent/node_modules/@openai/codex',
    '@scope/parent/node_modules/@anthropic-ai/claude-agent-sdk',
    'parent/node_modules/@openclaw/fs-safe-win32-x64-msvc',
  ];
  try {
    for (const name of [...agents, ...retained]) {
      const directory = path.join(root, 'node_modules', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'payload'), 'fixture');
    }
    for (const name of agents) {
      expect(() => verifyExternalAgentPackages([name + '/payload'])).toThrow(/must not bundle/u);
      expect(() => verifyExternalAgentPackages([name.replaceAll('/', '\\') + '\\payload'])).toThrow(
        /must not bundle/u,
      );
    }
    removeExternalAgentPackages(root);
    for (const name of agents)
      expect(fs.existsSync(path.join(root, 'node_modules', name))).toBe(false);
    for (const name of retained)
      expect(fs.existsSync(path.join(root, 'node_modules', name, 'payload'))).toBe(true);
    expect(() => verifyExternalAgentPackages(retained)).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('never follows dependency directory links while pruning nested packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpx-linked-dependencies-'));
  const extension = path.join(root, 'extension');
  const outside = path.join(root, 'outside');
  const linkedScope = path.join(extension, 'node_modules', '@linked');
  fs.mkdirSync(path.join(outside, 'node_modules', '@openai', 'codex-win32-x64'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(outside, 'node_modules', '@openai', 'codex-win32-x64', 'payload'),
    'keep',
  );
  fs.mkdirSync(path.dirname(linkedScope), { recursive: true });
  fs.symlinkSync(outside, linkedScope, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    expect(() => removeExternalAgentPackages(extension)).toThrow(/Refusing to prune linked/u);
    expect(
      fs.readFileSync(
        path.join(outside, 'node_modules', '@openai', 'codex-win32-x64', 'payload'),
        'utf8',
      ),
    ).toBe('keep');
  } finally {
    fs.unlinkSync(linkedScope);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
