import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import plugin from '../../../../plugins/extensions/stt-local-cli/index';
import {
  parseTranscript,
  readConfig,
  type RunCommand,
  transcribeFile,
} from '../../../../plugins/extensions/stt-local-cli/transcribe';

const roots: string[] = [];
const config = {
  command: path.resolve('sherpa-onnx-offline.exe'),
  args: ['--num-threads=2'],
  modelId: 'sensevoice',
  language: 'zh',
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-test-'));
  roots.push(root);
  const input = path.join(root, '录音 with spaces.wav');
  await fs.writeFile(input, 'audio');
  return { root, input };
}
function fakeRun(text = 'text=語音轉寫'): RunCommand {
  return vi.fn(async (_command, args, signal) => {
    signal.throwIfAborted();
    if (args.includes('-f')) {
      const pattern = args.at(-1)!;
      await fs.writeFile(pattern.replace('%04d', '0000'), Buffer.alloc(32078));
      await fs.writeFile(pattern.replace('%04d', '0001'), Buffer.alloc(32078));
      return '';
    }
    return text;
  });
}

describe('local STT tool', () => {
  it('transcribes all segments, simplifies Chinese and removes temporary files', async () => {
    const { root, input } = await fixture();
    const run = fakeRun();
    const result = await transcribeFile(input, config, {
      workspaceDir: root,
      workspaceOnly: true,
      run,
    });
    expect(result.text).toBe('语音转写\n语音转写');
    expect(result.segments.map(item => item.startSeconds)).toEqual([0, 30]);
    const calls = vi.mocked(run).mock.calls;
    expect(calls[0][1]).toContain('file,pipe');
    expect(calls[1][0]).toBe(config.command);
    const temporary = path.dirname(calls[1][1].at(-1)!);
    await expect(fs.stat(temporary)).rejects.toThrow();
    expect(await fs.readFile(input, 'utf8')).toBe('audio');
  });
  it('rejects URLs, unsupported formats and files outside the workspace before execution', async () => {
    const { input } = await fixture();
    const { root } = await fixture();
    const run = fakeRun();
    await expect(transcribeFile('https://example.org/a.wav', config, { run })).rejects.toThrow(
      'absolute local',
    );
    await expect(transcribeFile(path.resolve('playlist.m3u8'), config, { run })).rejects.toThrow(
      'Unsupported',
    );
    await expect(
      transcribeFile(input, config, { workspaceOnly: true, workspaceDir: root, run }),
    ).rejects.toThrow('outside');
    expect(run).not.toHaveBeenCalled();
  });
  it('cancels between segments without returning partial success and cleans up', async () => {
    const { input } = await fixture();
    const controller = new AbortController();
    const base = fakeRun();
    const run = vi.fn<RunCommand>(async (command, args, signal) => {
      const result = await base(command, args, signal);
      if (!args.includes('-f')) controller.abort();
      return result;
    });
    await expect(
      transcribeFile(input, config, { run, signal: controller.signal }),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(2);
    await expect(fs.stat(path.dirname(run.mock.calls[1][1].at(-1)!))).rejects.toThrow();
  });
  it('does not return a successful transcript for silence', async () => {
    const { input } = await fixture();
    await expect(transcribeFile(input, config, { run: fakeRun('text=') })).rejects.toThrow(
      'No speech',
    );
  });
  it('registers only when configured and never exposes a host tool to sandboxed sessions', () => {
    const registerTool = vi.fn();
    plugin.register({ pluginConfig: {}, registerTool } as never);
    expect(registerTool).not.toHaveBeenCalled();
    plugin.register({ pluginConfig: config, registerTool, config: {} } as never);
    expect(registerTool.mock.calls[0][0]({ sandboxed: true })).toBeNull();
    expect(registerTool.mock.calls[0][0]({ sandboxed: false }).name).toBe('transcribe_audio');
    expect(readConfig({ command: 'relative.exe', args: [] })).toBeNull();
  });
  it('fails overlong audio before ASR and cleans failed decode output', async () => {
    const { input } = await fixture();
    let outputDir = '';
    const oversized = vi.fn<RunCommand>(async (_command, args) => {
      outputDir = path.dirname(args.at(-1)!);
      const segment = path.join(outputDir, 'segment-0000.wav');
      const handle = await fs.open(segment, 'w');
      await handle.truncate(3601 * 16000 * 2 + 78);
      await handle.close();
      return '';
    });
    await expect(transcribeFile(input, config, { run: oversized })).rejects.toThrow('one-hour');
    expect(oversized).toHaveBeenCalledOnce();
    await expect(fs.stat(outputDir)).rejects.toThrow();
    const failed = vi.fn<RunCommand>(async (_command, args) => {
      outputDir = path.dirname(args.at(-1)!);
      throw new Error('decode failed');
    });
    await expect(transcribeFile(input, config, { run: failed })).rejects.toThrow('decode failed');
    await expect(fs.stat(outputDir)).rejects.toThrow();
  });

  it('parses structured Sherpa output without exposing diagnostics', () => {
    expect(parseTranscript('diagnostic\n{"text":"hello"}')).toBe('hello');
    expect(parseTranscript('log\n{"text":""}')).toBe('');
  });
});
