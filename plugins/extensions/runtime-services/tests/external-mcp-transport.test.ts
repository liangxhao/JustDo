import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it, vi } from 'vitest';

import { connectExternalMcpServer, type ExternalMcpConnection } from '../external-mcp/transport';

vi.mock('openclaw/plugin-sdk/process-runtime', () => ({
  isPidDefinitelyDead(pid: number) {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  },
  signalProcessTree(pid: number, _signal: string, options: { onComplete: () => void }) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
    options.onComplete();
  },
}));

const roots: string[] = [];
const connections: ExternalMcpConnection[] = [];
afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map(connection => connection.close()));
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
const serverPath = fileURLToPath(new URL('./fixtures/external-mcp-server.cjs', import.meta.url));

it('refuses macOS session MCP before starting any subprocess', async () => {
  const start = vi.spyOn(StdioClientTransport.prototype, 'start');
  try {
    await expect(
      connectExternalMcpServer(
        { name: 'fixture', command: process.execPath, args: [serverPath], env: [] },
        os.tmpdir(),
        new AbortController().signal,
        'darwin',
      ),
    ).rejects.toThrow('process-tree cleanup cannot be confirmed');
    expect(start).not.toHaveBeenCalled();
  } finally {
    start.mockRestore();
  }
});

async function fixture(sharedOutputSchemas = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-stdio-'));
  roots.push(cwd);
  const receipt = path.join(cwd, 'calls.txt');
  const connection = await connectExternalMcpServer(
    {
      name: 'fixture',
      command: process.execPath,
      args: [serverPath, receipt],
      env: [
        { name: 'EXTERNAL_MCP_FIXTURE', value: 'isolated' },
        { name: 'EXTERNAL_MCP_FIXTURE_OUTPUT_SCHEMAS', value: String(sharedOutputSchemas) },
      ],
    },
    cwd,
    new AbortController().signal,
  );
  connections.push(connection);
  return { cwd, receipt, connection };
}

it('discovers and calls a real stdio process with its session cwd and minimal environment', async () => {
  vi.stubEnv('OPENCLAW_GATEWAY_TOKEN', 'synthetic-host-only');
  const { cwd, receipt, connection } = await fixture();
  expect(connection.tools.map(tool => tool.name)).toEqual(['echo']);
  const result = await connection.invoke('echo', { value: 'hello' }, new AbortController().signal);
  expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
  expect(result.structuredContent).toMatchObject({ cwd, custom: 'isolated', leakedToken: false });
  expect(fs.readFileSync(receipt, 'utf8')).toBe('call\n');
  await connection.close();
  expect(() =>
    process.kill(Number((result.structuredContent as { pid: number }).pid), 0),
  ).toThrow();
});

it('validates independent output schemas with the same $id and local references over stdio', async () => {
  const { receipt, connection } = await fixture(true);
  expect(connection.tools.map(tool => tool.name)).toEqual(['text', 'number']);
  const signal = new AbortController().signal;
  const text = await connection.invoke('text', { value: 'hello' }, signal);
  const number = await connection.invoke('number', { value: 42 }, signal);
  expect(text.structuredContent).toEqual({ value: 'hello' });
  expect(number.structuredContent).toEqual({ value: 42 });
  expect(fs.readFileSync(receipt, 'utf8')).toBe('call\ncall\n');
});

it('retires uncertain calls after cancellation without replay or accepting subsequent input', async () => {
  const { receipt, connection } = await fixture();
  const controller = new AbortController();
  const running = connection.invoke('echo', { value: 'wait' }, controller.signal);
  // The receipt observes admission before cancellation; no timing guess decides it.
  for (let i = 0; i < 100 && !fs.existsSync(receipt); i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  expect(fs.existsSync(receipt)).toBe(true);
  controller.abort();
  await expect(running).rejects.toThrow('outcome may be unknown');
  await expect(
    connection.invoke('echo', { value: 'again' }, new AbortController().signal),
  ).rejects.toThrow('unavailable');
  expect(fs.readFileSync(receipt, 'utf8')).toBe('call\n');
});
