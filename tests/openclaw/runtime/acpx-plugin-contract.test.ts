import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
const extensionRoot = path.join(repositoryRoot, 'openclaw-extensions', 'acpx');

const readJson = (filePath: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;

describe('vendored ACPX plugin contract', () => {
  test('uses the same repository extension pipeline as other bundled extensions', () => {
    const packageJson = readJson(path.join(repositoryRoot, 'package.json'));
    const openclaw = packageJson.openclaw as { plugins?: Array<Record<string, unknown>> };

    expect(openclaw.plugins ?? []).not.toContainEqual(
      expect.objectContaining({ id: 'acpx' }),
    );
    expect(fs.existsSync(extensionRoot)).toBe(true);
  });

  test('locks compatible adapters and exposes the enterprise replacement seams', () => {
    const packageJson = readJson(path.join(extensionRoot, 'package.json'));
    const dependencies = packageJson.dependencies as Record<string, string>;
    const manifest = readJson(path.join(extensionRoot, 'openclaw.plugin.json'));
    const schema = manifest.configSchema as {
      properties: Record<string, unknown>;
    };

    expect(packageJson).toMatchObject({
      name: 'acpx-runtime',
      version: '2026.9.6-local.1',
      private: true,
    });
    expect(dependencies).toMatchObject({
      '@agentclientprotocol/claude-agent-acp': '0.76.0',
      '@agentclientprotocol/codex-acp': '1.11.0',
      acpx: '0.19.1',
    });
    expect(schema.properties).toHaveProperty('claudeExecutable');
    expect(schema.properties).toHaveProperty('agents');
    expect(schema.properties).toHaveProperty('diagnosticAgents');
    expect(schema.properties).toHaveProperty('startupProbe');
    expect(fs.existsSync(path.join(extensionRoot, 'package-lock.json'))).toBe(true);
  });

  test('fails closed when bundled adapters are missing instead of downloading at runtime', () => {
    const bridgeSource = fs.readFileSync(
      path.join(extensionRoot, 'src', 'codex-auth-bridge.ts'),
      'utf8',
    );

    expect(bridgeSource).not.toContain('npmCliPath');
    expect(bridgeSource).not.toContain('[npmCliPath, "exec", "--yes", "--package"');
    expect(bridgeSource).toContain('bundled ${params.displayName} ACP adapter is missing');
  });

  test('passes the original serialized argv into lease wrapper-root matching', () => {
    const reaperSource = fs.readFileSync(
      path.join(extensionRoot, 'src', 'process-reaper.ts'),
      'utf8',
    );

    expect(reaperSource).toContain('commandWrapperBelongsToRoot(command, params.wrapperRoot)');
    expect(reaperSource).not.toContain(
      'commandWrapperBelongsToRoot(normalized, params.wrapperRoot)',
    );
  });

  test('exposes a per-agent doctor through the lazy runtime and Gateway', () => {
    const entrySource = fs.readFileSync(path.join(extensionRoot, 'index.ts'), 'utf8');
    const runtimeSource = fs.readFileSync(path.join(extensionRoot, 'src', 'runtime.ts'), 'utf8');
    const proxySource = fs.readFileSync(
      path.join(extensionRoot, 'src', 'runtime-proxy.ts'),
      'utf8',
    );

    expect(entrySource).toContain("'acpx.agent.doctor'");
    expect(entrySource).toContain("{ scope: 'operator.read' }");
    expect(entrySource).toContain('doctorAgentIds.has(agentId)');
    expect(runtimeSource).toContain('async doctorAgent(agentName: string)');
    expect(runtimeSource).toContain('probeAgent: normalizedAgentName');
    expect(proxySource).toContain('doctorAgent(agentName)');
  });
});
