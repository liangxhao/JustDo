import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import OpenCC from 'opencc-js/t2cn';

const execFileAsync = promisify(execFile);
const requireDependency = createRequire(import.meta.url);
const resolveDecoder = (): string => requireDependency('@ffmpeg-installer/ffmpeg').path;
const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' });
export const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 3600;
const SEGMENT_SECONDS = 30;
const SAMPLE_RATE = 16000;
const TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TEXT_CHARS = 100000;
const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.flac',
  '.webm',
  '.mp4',
  '.mov',
  '.mkv',
]);

export type TranscriptionConfig = {
  command: string;
  args: string[];
  modelId: string;
  language: string;
};
export type RunCommand = (command: string, args: string[], signal: AbortSignal) => Promise<string>;

const runCommand: RunCommand = async (command, args, signal) => {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      signal,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    signal.throwIfAborted();
    // Do not expose command arguments, stderr, or transcript previews in errors.
    throw new Error(
      'Local audio processing failed or timed out. Check the audio format and installed speech model.',
    );
  }
};

export function parseTranscript(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    if (line.startsWith('text=')) return line.slice(5).trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const result = JSON.parse(line);
        if (typeof result.text === 'string') return result.text.trim();
      } catch {
        /* Ignore diagnostic lines. */
      }
    }
  }
  return '';
}

export function readConfig(value: unknown): TranscriptionConfig | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Partial<TranscriptionConfig>;
  if (
    typeof config.command !== 'string' ||
    !path.isAbsolute(config.command) ||
    !Array.isArray(config.args) ||
    !config.args.every(arg => typeof arg === 'string') ||
    typeof config.modelId !== 'string' ||
    typeof config.language !== 'string'
  )
    return null;
  return config as TranscriptionConfig;
}

export async function transcribeFile(
  audioPath: string,
  config: TranscriptionConfig,
  options: {
    signal?: AbortSignal;
    run?: RunCommand;
    workspaceDir?: string;
    workspaceOnly?: boolean;
  } = {},
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  if (
    !path.isAbsolute(audioPath) ||
    audioPath.startsWith('\\\\') ||
    audioPath.startsWith('//') ||
    audioPath.includes('\0')
  ) {
    throw new Error('Provide an absolute local audio file path, not a URL or network share.');
  }
  if (!AUDIO_EXTENSIONS.has(path.extname(audioPath).toLowerCase())) {
    throw new Error(
      'Unsupported audio format. Use WAV, MP3, M4A, AAC, OGG, Opus, FLAC, WebM, MP4, MOV, or MKV.',
    );
  }
  const inputPath = await fs.realpath(audioPath);
  if (inputPath.startsWith('\\\\') || inputPath.startsWith('//'))
    throw new Error('Network audio paths are not supported.');
  if (options.workspaceOnly) {
    if (!options.workspaceDir) throw new Error('The audio workspace is unavailable.');
    const workspace = await fs.realpath(options.workspaceDir);
    const relative = path.relative(workspace, inputPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('The audio file is outside the permitted workspace.');
    }
  }
  const stat = await fs.stat(inputPath);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUDIO_BYTES) {
    throw new Error('Audio must be a non-empty local file no larger than 256 MiB.');
  }
  const run = options.run ?? runCommand;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-local-cli-'));
  try {
    // Work from our own copy; reject playlist demuxers and all network protocols.
    const localInput = path.join(tempDir, `input${path.extname(inputPath).toLowerCase()}`);
    await fs.copyFile(inputPath, localInput);
    if ((await fs.stat(localInput)).size > MAX_AUDIO_BYTES)
      throw new Error('Audio exceeds 256 MiB.');
    signal.throwIfAborted();
    await run(
      options.run ? 'ffmpeg' : resolveDecoder(),
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'wav,mp3,mov,aac,ogg,flac,matroska,webm',
        '-i',
        localInput,
        '-map',
        '0:a:0',
        '-vn',
        '-t',
        String(MAX_AUDIO_SECONDS + 1),
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        '-f',
        'segment',
        '-segment_time',
        String(SEGMENT_SECONDS),
        '-reset_timestamps',
        '1',
        path.join(tempDir, 'segment-%04d.wav'),
      ],
      signal,
    );
    const segments = (await fs.readdir(tempDir))
      .filter(name => /^segment-\d{4}\.wav$/.test(name))
      .sort();
    if (!segments.length) throw new Error('No audio stream was decoded.');
    // PCM payload plus small WAV headers: enforce the duration limit before ASR.
    const sizes = await Promise.all(segments.map(name => fs.stat(path.join(tempDir, name))));
    if (
      sizes.reduce((total, item) => total + Math.max(0, item.size - 78), 0) >
      MAX_AUDIO_SECONDS * SAMPLE_RATE * 2
    ) {
      throw new Error('Audio exceeds the one-hour transcription limit. Split the recording first.');
    }
    const results: Array<{ startSeconds: number; text: string }> = [];
    let characters = 0;
    for (const [index, segment] of segments.entries()) {
      signal.throwIfAborted();
      const stdout = await run(
        config.command,
        [...config.args, path.join(tempDir, segment)],
        signal,
      );
      let text = parseTranscript(stdout);
      if (config.language === 'zh') text = toSimplified(text);
      characters += text.length;
      if (characters > MAX_TEXT_CHARS)
        throw new Error('Transcript exceeds the output limit. Split the recording first.');
      if (text) results.push({ startSeconds: index * SEGMENT_SECONDS, text });
    }
    signal.throwIfAborted();
    if (!results.length) throw new Error('No speech was recognized.');
    return {
      text: results.map(item => item.text).join('\n'),
      segments: results,
      modelId: config.modelId,
      language: config.language,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
