import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_PROVIDER_ID, type LocalTtsSpeakResult } from '../../shared/speech/localTts';
import { buildManagedLocalTtsConfig } from '../openclaw/config/speech/localTtsConfig';

const runFile = promisify(execFile);
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export async function synthesizeLocalSpeech(
  text: string,
  settings: LocalSpeechSettings,
  options: { signal?: AbortSignal } = {},
): Promise<LocalTtsSpeakResult> {
  options.signal?.throwIfAborted();
  const config = buildManagedLocalTtsConfig(undefined, settings);
  if (!config) throw new Error('Local speech synthesis is unavailable.');
  const provider = (
    config.providers as Record<
      string,
      {
        command: string;
        args: string[];
      }
    >
  )[LOCAL_TTS_PROVIDER_ID];
  let directory: string | undefined;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'justdo-tts-'));
    const outputPath = path.join(directory, 'speech.wav');
    // Sherpa parses leading dashes as CLI flags even in the text position.
    const spokenText = text.startsWith('-') ? ` ${text}` : text;
    const args = provider.args.map(arg =>
      arg === '{{Text}}' ? spokenText : arg.replace('{{OutputPath}}', outputPath),
    );
    options.signal?.throwIfAborted();
    const execution = runFile(provider.command, args, {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      signal: options.signal,
    });
    // Abort can reject before the child closes; clean its files only after it has stopped.
    const closed = new Promise<void>(resolve => execution.child.once('close', () => resolve()));
    try {
      await execution;
    } finally {
      await closed;
    }
    options.signal?.throwIfAborted();
    const stat = await fs.stat(outputPath);
    if (!stat.isFile() || stat.size < 44 || stat.size > MAX_AUDIO_BYTES) {
      throw new Error('Invalid speech output.');
    }
    const audio = await fs.readFile(outputPath, { signal: options.signal });
    if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Invalid speech output.');
    }
    return {
      audioBase64: audio.toString('base64'),
      provider: LOCAL_TTS_PROVIDER_ID,
      outputFormat: 'wav',
      mimeType: 'audio/wav',
      fileExtension: '.wav',
    };
  } catch {
    // CLI errors contain the argument list, including the user's text.
    throw new Error('Local speech synthesis failed.');
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}
