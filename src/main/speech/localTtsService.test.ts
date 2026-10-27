import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import { buildManagedLocalTtsConfig } from '../openclaw/config/speech/localTtsConfig';
import { synthesizeLocalSpeech } from './localTtsService';

vi.mock('../openclaw/config/speech/localTtsConfig', () => ({
  buildManagedLocalTtsConfig: vi.fn(),
}));
const settings = { ...defaultLocalSpeechSettings, outputEnabled: true };
let fixture: string | undefined;
afterEach(async () => {
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  fixture = undefined;
  vi.restoreAllMocks();
});

async function configure(script: string) {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-test-'));
  const scriptPath = path.join(fixture, 'runner.cjs');
  await fs.writeFile(scriptPath, script);
  vi.mocked(buildManagedLocalTtsConfig).mockReturnValue({
    providers: {
      'tts-local-cli': {
        command: process.execPath,
        args: [scriptPath, '{{OutputPath}}', '{{Text}}'],
      },
    },
  });
}

it('passes text literally without a shell and removes generated files after reading WAV', async () => {
  await configure(`const fs = require('node:fs');
    const b = Buffer.alloc(44); b.write('RIFF'); b.write('WAVE', 8);
    fs.writeFileSync(process.argv[2], b);
    fs.writeFileSync(__dirname + '/args.json', JSON.stringify(process.argv.slice(2)));`);
  const text = '--flag=hello & $(echo secret) "中文"';
  const result = await synthesizeLocalSpeech(text, settings);
  expect(result.mimeType).toBe('audio/wav');
  expect(Buffer.from(result.audioBase64, 'base64').length).toBe(44);
  const [outputPath, received] = JSON.parse(
    await fs.readFile(path.join(fixture!, 'args.json'), 'utf8'),
  );
  expect(received).toBe(` ${text}`);
  await expect(fs.stat(path.dirname(outputPath))).rejects.toThrow();
});

it('cleans up on CLI failure and does not disclose its text or stderr', async () => {
  await configure(`require('node:fs').writeFileSync(__dirname + '/output.txt', process.argv[2]);
    console.error('private text'); process.exit(1);`);
  await expect(synthesizeLocalSpeech('private text', settings)).rejects.toThrow(
    'Local speech synthesis failed.',
  );
  const outputPath = await fs.readFile(path.join(fixture!, 'output.txt'), 'utf8');
  await expect(fs.stat(path.dirname(outputPath))).rejects.toThrow();
});

it('rejects missing local assets without invoking a command', async () => {
  vi.mocked(buildManagedLocalTtsConfig).mockReturnValue(null);
  await expect(synthesizeLocalSpeech('hello', settings)).rejects.toThrow('unavailable');
});

it('rejects invalid generated audio', async () => {
  await configure(`require('node:fs').writeFileSync(process.argv[2], Buffer.alloc(44));`);
  await expect(synthesizeLocalSpeech('hello', settings)).rejects.toThrow(
    'Local speech synthesis failed.',
  );
});

it('allows a new request while a discarded earlier synthesis is still completing', async () => {
  await configure(`const fs = require('node:fs');
    setTimeout(() => {
      const b = Buffer.alloc(44); b.write('RIFF'); b.write('WAVE', 8);
      fs.writeFileSync(process.argv[2], b);
    }, process.argv[3] === 'old' ? 100 : 0);`);
  const earlier = synthesizeLocalSpeech('old', settings);
  const current = synthesizeLocalSpeech('new', settings);
  const results = await Promise.all([earlier, current]);
  expect(results.every(result => result.mimeType === 'audio/wav')).toBe(true);
});

it('aborts the preview process and waits for exit before removing temporary output', async () => {
  await configure(`const fs = require('node:fs');
    fs.writeFileSync(__dirname + '/ready.json', JSON.stringify({ pid: process.pid, output: process.argv[2] }));
    setTimeout(() => {
      const b = Buffer.alloc(44); b.write('RIFF'); b.write('WAVE', 8);
      fs.writeFileSync(process.argv[2], b);
    }, 10000);`);
  const controller = new AbortController();
  const running = synthesizeLocalSpeech('preview text', settings, { signal: controller.signal });
  const rejected = expect(running).rejects.toThrow('Local speech synthesis failed.');
  let child: { pid: number; output: string } | undefined;
  await vi.waitFor(async () => {
    child = JSON.parse(await fs.readFile(path.join(fixture!, 'ready.json'), 'utf8'));
  });
  controller.abort();
  await rejected;
  await expect(fs.stat(path.dirname(child!.output))).rejects.toThrow();
  expect(() => process.kill(child!.pid, 0)).toThrow();
});
