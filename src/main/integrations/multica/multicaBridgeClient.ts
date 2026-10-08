import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  decodeMulticaBridgeLines,
  encodeMulticaBridgeMessage,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  MULTICA_MAX_REQUEST_BYTES,
  type MulticaBridgeMetadata,
  type MulticaBridgeRequest,
  type MulticaBridgeResponse,
  sanitizeMulticaBridgeEnvironment,
} from './multicaBridgeProtocol';

const CONNECT_TIMEOUT_MS = 5_000;

const isBridgeMetadata = (value: unknown): value is MulticaBridgeMetadata => {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<MulticaBridgeMetadata>;
  return (
    metadata.version === MULTICA_BRIDGE_PROTOCOL_VERSION &&
    typeof metadata.endpoint === 'string' &&
    metadata.endpoint.length > 0 &&
    typeof metadata.token === 'string' &&
    metadata.token.length > 0 &&
    typeof metadata.pid === 'number' &&
    Number.isSafeInteger(metadata.pid) &&
    metadata.pid > 0
  );
};

const isBridgeResponse = (value: unknown): value is MulticaBridgeResponse => {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<MulticaBridgeResponse>;
  if (response.type === 'stdout' || response.type === 'stderr') {
    return typeof response.data === 'string';
  }
  if (response.type === 'exit') {
    return typeof response.code === 'number' && Number.isInteger(response.code);
  }
  return response.type === 'error' && typeof response.message === 'string';
};

const writeOutput = (stream: NodeJS.WriteStream, value: string | Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(value, error => (error ? reject(error) : resolve()));
  });

export async function runMulticaBridgeClient(
  userDataPath: string,
  argv: string[],
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<number> {
  const metadataPath = path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE);
  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    await writeOutput(
      process.stderr,
      `${PRODUCT_NAME} is not running. Start ${PRODUCT_NAME} and keep it open or in the tray.\n`,
    );
    return 69;
  }
  if (!isBridgeMetadata(parsedMetadata)) {
    await writeOutput(process.stderr, `Restart ${PRODUCT_NAME} to refresh its Multica bridge.\n`);
    return 70;
  }
  const metadata = parsedMetadata;
  return new Promise(resolve => {
    const socket = net.createConnection(metadata.endpoint);
    let buffer = '';
    const streaming = argv[0] === 'app-server';
    const inputDecoder = new StringDecoder('utf8');
    const input = (chunk: Buffer): void => {
      if (
        !socket.write(
          encodeMulticaBridgeMessage({ type: 'stdin', data: inputDecoder.write(chunk) }),
        )
      )
        process.stdin.pause();
    };
    const eof = (): void => {
      socket.write(encodeMulticaBridgeMessage({ type: 'eof' }));
    };
    socket.on('drain', () => {
      if (streaming && !finished) process.stdin.resume();
    });
    const decoder = new StringDecoder('utf8');
    let finished = false;
    let responseRejected = false;
    let pendingWrites = 0;
    let requestedCode: number | null = null;
    const finish = (): void => {
      if (finished || requestedCode === null || pendingWrites > 0) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.off('data', input);
      process.stdin.off('end', eof);
      if (streaming) process.stdin.pause();
      socket.destroy();
      resolve(requestedCode);
    };
    const requestFinish = (code: number): void => {
      requestedCode ??= code;
      finish();
    };
    const relay = (stream: NodeJS.WriteStream, data: string): void => {
      pendingWrites += 1;
      const writable = stream.write(Buffer.from(data, 'base64'), () => {
        pendingWrites -= 1;
        if (!finished && pendingWrites === 0) socket.resume();
        finish();
      });
      if (!writable) socket.pause();
    };
    const timer = setTimeout(() => {
      pendingWrites += 1;
      process.stderr.write(`Timed out connecting to ${PRODUCT_NAME}.\n`, () => {
        pendingWrites -= 1;
        requestFinish(69);
      });
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      const request: MulticaBridgeRequest = {
        type: 'request',
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        requestId: crypto.randomUUID(),
        token: metadata.token,
        argv,
        cwd: process.cwd(),
        env: sanitizeMulticaBridgeEnvironment(process.env),
      };
      socket.write(encodeMulticaBridgeMessage(request));
      if (streaming) {
        process.stdin.on('data', input);
        process.stdin.once('end', eof);
        process.stdin.resume();
      }
    });
    socket.on('data', chunk => {
      if (responseRejected) return;
      if (Buffer.byteLength(buffer) + chunk.length > MULTICA_MAX_REQUEST_BYTES) {
        responseRejected = true;
        pendingWrites += 1;
        process.stderr.write(`${PRODUCT_NAME} returned an oversized bridge response.\n`, () => {
          pendingWrites -= 1;
          requestFinish(70);
        });
        return;
      }
      buffer += decoder.write(chunk);
      try {
        const decoded = decodeMulticaBridgeLines(buffer);
        buffer = decoded.remainder;
        for (const raw of decoded.messages) {
          if (!isBridgeResponse(raw)) throw new Error('Invalid bridge response.');
          const response = raw;
          if (response.type === 'stdout') relay(process.stdout, response.data);
          else if (response.type === 'stderr') relay(process.stderr, response.data);
          else if (response.type === 'exit') requestFinish(response.code);
          else if (response.type === 'error') {
            pendingWrites += 1;
            process.stderr.write(`${response.message}\n`, () => {
              pendingWrites -= 1;
              requestFinish(70);
            });
          }
        }
      } catch {
        pendingWrites += 1;
        process.stderr.write(`${PRODUCT_NAME} returned an invalid bridge response.\n`, () => {
          pendingWrites -= 1;
          requestFinish(70);
        });
      }
    });
    socket.once('error', () => {
      pendingWrites += 1;
      process.stderr.write(`${PRODUCT_NAME} is not running.\n`, () => {
        pendingWrites -= 1;
        requestFinish(69);
      });
    });
    socket.once('close', () =>
      requestFinish(requestedCode ?? (streaming && process.stdin.readableEnded ? 0 : 70)),
    );
  });
}
