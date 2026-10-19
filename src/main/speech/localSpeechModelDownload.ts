import { createHash } from 'crypto';
import fs from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as delay } from 'timers/promises';

import { t } from '../core/i18n';

const DOWNLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_ATTEMPTS = 3;

class DownloadTransportError extends Error {}

interface ModelDownloadOptions {
  url: string;
  archivePath: string;
  compressedBytes: number;
  sha256: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  onProgress: (percent: number) => void;
}

/** Keep each range below intranet proxies' large-response limits. */
export async function downloadLocalSpeechModel(options: ModelDownloadOptions): Promise<void> {
  let received = 0;
  let hash = createHash('sha256');
  let lastPercent = -1;
  while (received < options.compressedBytes) {
    const start = received;
    const end = Math.min(start + DOWNLOAD_CHUNK_BYTES, options.compressedBytes) - 1;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        try {
          response = await options.fetch(options.url, {
            redirect: 'follow',
            cache: 'no-store',
            headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
          });
        } catch (error) {
          throw new DownloadTransportError(error instanceof Error ? error.message : String(error));
        }
        if (![200, 206].includes(response.status) || !response.body) {
          throw new Error(`Model download failed with HTTP ${response.status}.`);
        }
        const partial = response.status === 206;
        // Servers without Range support may send the full file on the first request.
        // Never append a full response to a previously downloaded range.
        if (!partial && start !== 0) {
          throw new Error(t('localSpeechModelRangeIgnored'));
        }
        if (
          partial &&
          response.headers.get('content-range') !==
            `bytes ${start}-${end}/${options.compressedBytes}`
        ) {
          throw new Error(t('localSpeechModelRangeInvalid'));
        }
        const expectedBytes = partial ? end - start + 1 : options.compressedBytes;
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null && Number(contentLength) !== expectedBytes) {
          throw new Error('Downloaded model has an unexpected size.');
        }

        let chunkBytes = 0;
        const chunkHash = hash.copy();
        const progress = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            chunkBytes += chunk.length;
            if (chunkBytes > expectedBytes) {
              callback(new Error('Downloaded model exceeds the expected size.'));
              return;
            }
            chunkHash.update(chunk);
            const percent = Math.floor(((start + chunkBytes) / options.compressedBytes) * 100);
            if (percent > lastPercent) {
              lastPercent = percent;
              options.onProgress(percent);
            }
            callback(null, chunk);
          },
        });
        const reader = response.body.getReader();
        const body = Readable.from(
          (async function* () {
            try {
              while (true) {
                let result: ReadableStreamReadResult<Uint8Array>;
                try {
                  result = await reader.read();
                } catch (error) {
                  throw new DownloadTransportError(
                    error instanceof Error ? error.message : String(error),
                  );
                }
                if (result.done) break;
                yield result.value;
              }
            } finally {
              await reader.cancel().catch((): void => {});
              reader.releaseLock();
            }
          })(),
        );
        await pipeline(
          body,
          progress,
          fs.createWriteStream(options.archivePath, { flags: start === 0 ? 'w' : 'r+', start }),
        );
        if (chunkBytes !== expectedBytes) {
          throw new DownloadTransportError('Downloaded model has an unexpected size.');
        }
        hash = chunkHash;
        received = start + chunkBytes;
        break;
      } catch (error) {
        if (!(error instanceof DownloadTransportError) || attempt >= DOWNLOAD_ATTEMPTS - 1) {
          throw error;
        }
        // Only committed ranges contribute to the final hash and file. A retry
        // replaces the interrupted range instead of replaying the entire model.
        if (fs.existsSync(options.archivePath)) {
          await fs.promises.truncate(options.archivePath, start);
        }
        await delay(250 * 2 ** attempt);
      } finally {
        if (response?.body && !response.body.locked) {
          await response.body.cancel().catch((): void => {});
        }
      }
    }
  }
  if (hash.digest('hex') !== options.sha256) {
    throw new Error('Downloaded model failed integrity verification.');
  }
}
