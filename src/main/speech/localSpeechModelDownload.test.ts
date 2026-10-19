import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLanguage, setLanguage } from '../core/i18n';
import { downloadLocalSpeechModel } from './localSpeechModelDownload';

const RANGE_BYTES = 16 * 1024 * 1024;
const temporaryRoots: string[] = [];
let previousLanguage = getLanguage();

beforeEach(() => {
  previousLanguage = getLanguage();
  setLanguage('en');
});

const createOptions = (body: Buffer) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-model-download-'));
  temporaryRoots.push(root);
  return {
    url: 'https://models.example.test/model.tar.zst',
    archivePath: path.join(root, 'model.download'),
    compressedBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    onProgress: vi.fn(),
  };
};

const partialResponse = (body: Buffer, start: number, total: number) =>
  new Response(body, {
    status: 206,
    headers: {
      'content-range': `bytes ${start}-${start + body.length - 1}/${total}`,
      'content-length': String(body.length),
    },
  });

afterEach(() => {
  setLanguage(previousLanguage);
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('downloadLocalSpeechModel', () => {
  it('streams a model larger than 128 MiB through bounded ranges with a whole-file hash', async () => {
    const options = createOptions(Buffer.alloc(0));
    const total = 129 * 1024 * 1024 + 13;
    const expectedHash = createHash('sha256');
    // Different bytes per range detect duplicated, missing or reordered segments.
    for (let start = 0; start < total; start += RANGE_BYTES) {
      expectedHash.update(Buffer.alloc(Math.min(RANGE_BYTES, total - start), start / RANGE_BYTES));
    }
    const fetchModel = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')!;
      const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(from);
      const end = Number(to);
      expect(end - start + 1).toBeLessThanOrEqual(RANGE_BYTES);
      const block = Buffer.alloc(64 * 1024, start / RANGE_BYTES);
      let remaining = end - start + 1;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (remaining === 0) return controller.close();
            const chunk = block.subarray(0, Math.min(block.length, remaining));
            remaining -= chunk.length;
            controller.enqueue(chunk);
          },
        }),
        {
          status: 206,
          headers: {
            'content-range': `bytes ${start}-${end}/${total}`,
            'content-length': String(end - start + 1),
          },
        },
      );
    });
    const sha256 = expectedHash.digest('hex');

    await downloadLocalSpeechModel({
      ...options,
      compressedBytes: total,
      sha256,
      fetch: fetchModel,
    });

    expect(fetchModel).toHaveBeenCalledTimes(9);
    expect(fs.statSync(options.archivePath).size).toBe(total);
    const actualHash = createHash('sha256');
    for await (const chunk of fs.createReadStream(options.archivePath)) actualHash.update(chunk);
    expect(actualHash.digest('hex')).toBe(sha256);
    expect(options.onProgress).toHaveBeenLastCalledWith(100);
  });

  it('retries only the interrupted range and discards its partial bytes and hash', async () => {
    const body = Buffer.alloc(RANGE_BYTES + 17, 7);
    const options = createOptions(body);
    let reads = 0;
    const fetchModel = vi
      .fn()
      .mockResolvedValueOnce(partialResponse(body.subarray(0, RANGE_BYTES), 0, body.length))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (reads++ === 0) controller.enqueue(Buffer.alloc(8, 99));
              else controller.error(new Error('net::ERR_HTTP2_PROTOCOL_ERROR'));
            },
          }),
          {
            status: 206,
            headers: { 'content-range': `bytes ${RANGE_BYTES}-${body.length - 1}/${body.length}` },
          },
        ),
      )
      .mockResolvedValueOnce(partialResponse(body.subarray(RANGE_BYTES), RANGE_BYTES, body.length));

    await downloadLocalSpeechModel({ ...options, fetch: fetchModel });

    expect(fetchModel).toHaveBeenCalledTimes(3);
    expect(fetchModel.mock.calls[1][1].headers.Range).toBe(
      `bytes=${RANGE_BYTES}-${body.length - 1}`,
    );
    expect(fetchModel.mock.calls[2][1].headers.Range).toBe(
      `bytes=${RANGE_BYTES}-${body.length - 1}`,
    );
    expect(fs.statSync(options.archivePath).size).toBe(body.length);
    expect(createHash('sha256').update(fs.readFileSync(options.archivePath)).digest('hex')).toBe(
      options.sha256,
    );
    const progress = options.onProgress.mock.calls.map(([percent]) => percent);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('limits transport retries and preserves the last network error', async () => {
    const options = createOptions(Buffer.from('model'));
    const fetchModel = vi.fn().mockRejectedValue(new Error('net::ERR_HTTP2_PROTOCOL_ERROR'));

    await expect(downloadLocalSpeechModel({ ...options, fetch: fetchModel })).rejects.toThrow(
      'net::ERR_HTTP2_PROTOCOL_ERROR',
    );

    expect(fetchModel).toHaveBeenCalledTimes(3);
  });

  it('accepts a full response when the server does not support ranges', async () => {
    const body = Buffer.from('model');
    const options = createOptions(body);
    const fetchModel = vi.fn().mockResolvedValue(new Response(body));

    await downloadLocalSpeechModel({ ...options, fetch: fetchModel });

    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(options.archivePath)).toEqual(body);
  });

  it('rejects a full response after an already committed range', async () => {
    const body = Buffer.alloc(RANGE_BYTES + 1);
    const options = createOptions(body);
    const cancel = vi.fn();
    const fetchModel = vi
      .fn()
      .mockResolvedValueOnce(partialResponse(body.subarray(0, RANGE_BYTES), 0, body.length))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));

    await expect(downloadLocalSpeechModel({ ...options, fetch: fetchModel })).rejects.toThrow(
      'ignored the requested download range',
    );

    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect(fs.statSync(options.archivePath).size).toBe(RANGE_BYTES);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    {
      status: 206,
      headers: { 'content-range': 'bytes 1-5/6' },
      error: 'unexpected download range',
    },
    {
      status: 206,
      headers: { 'content-range': 'bytes 0-4/9' },
      error: 'unexpected download range',
    },
    { status: 206, headers: {}, error: 'unexpected download range' },
    { status: 200, headers: { 'content-length': '4' }, error: 'unexpected size' },
    { status: 404, headers: {}, error: 'HTTP 404' },
  ])('rejects invalid response metadata without retrying: $error ($status)', async response => {
    const options = createOptions(Buffer.from('model'));
    const cancel = vi.fn();
    const fetchModel = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: response.status,
        headers: response.headers as HeadersInit,
      }),
    );

    await expect(downloadLocalSpeechModel({ ...options, fetch: fetchModel })).rejects.toThrow(
      response.error,
    );

    expect(fetchModel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fs.existsSync(options.archivePath)).toBe(false);
  });

  it('rejects corrupted model bytes without retrying', async () => {
    const options = createOptions(Buffer.from('model'));
    const fetchModel = vi.fn().mockResolvedValue(new Response(Buffer.from('wrong')));

    await expect(downloadLocalSpeechModel({ ...options, fetch: fetchModel })).rejects.toThrow(
      'integrity verification',
    );

    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it('retries a truncated range and never marks it complete', async () => {
    const body = Buffer.from('model');
    const options = createOptions(body);
    const fetchModel = vi.fn(
      async () =>
        new Response(body.subarray(0, 2), {
          status: 206,
          headers: { 'content-range': 'bytes 0-4/5' },
        }),
    );

    await expect(downloadLocalSpeechModel({ ...options, fetch: fetchModel })).rejects.toThrow(
      'unexpected size',
    );

    expect(fetchModel).toHaveBeenCalledTimes(3);
    expect(options.onProgress).not.toHaveBeenCalledWith(100);
  });

  it('does not retry disk write errors', async () => {
    const body = Buffer.from('model');
    const options = createOptions(body);
    fs.mkdirSync(options.archivePath);
    const fetchModel = vi.fn(async () => new Response(body));

    await expect(downloadLocalSpeechModel({ ...options, fetch: fetchModel })).rejects.toThrow();

    expect(fetchModel).toHaveBeenCalledTimes(1);
  });
});
