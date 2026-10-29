import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

interface PreparedAssets {
  directory: string;
  fingerprint: string;
  cacheHit: boolean;
  frameRate: number;
  introFrames: number;
  loopFirstFrame: number;
  lastFrame: number;
  scales: Array<{ percent: number; width: number; height: number; aviPath: string; bitmapPath: string }>;
}

const {
  ANIMATION_CONTRACT,
  createBitmap,
  decodeLogoPng,
  encodeRle8Frame,
  prepareInstallerAnimationAssets,
  renderInstallerFrame,
} = require('../../scripts/packaging/installer-animation-assets.cjs') as {
  ANIMATION_CONTRACT: { scales: Array<{ percent: number; width: number; height: number }> };
  createBitmap: (width: number, height: number, pixels: Buffer) => Buffer;
  decodeLogoPng: (bytes: Buffer) => { width: number; height: number; rgb: Buffer };
  encodeRle8Frame: (pixels: Buffer, width: number, height: number) => Buffer;
  prepareInstallerAnimationAssets: (projectDir: string) => PreparedAssets;
  renderInstallerFrame: (logo: { width: number; height: number; rgb: Buffer }, scale: { width: number; height: number }, frame: number) => Buffer;
};

const sourceLogo = path.resolve(__dirname, '../../resources/icons/png/128x128.png');
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'installer-animation-assets-'));

afterAll(() => {
  const absolute = path.resolve(temporaryRoot);
  expect(path.dirname(absolute)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(absolute)).toMatch(/^installer-animation-assets-/);
  rmSync(absolute, { recursive: true, force: true });
});

function pngChunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  content.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function testPng(colorType = 6): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255, 7, 8, 9, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function fixture(name: string): string {
  const root = path.join(temporaryRoot, name);
  const logo = path.join(root, 'resources', 'icons', 'png', '128x128.png');
  mkdirSync(path.dirname(logo), { recursive: true });
  copyFileSync(sourceLogo, logo);
  return root;
}

interface RiffChunk { type: string; at: number; data: number; size: number; children: RiffChunk[] }

function riffChunks(bytes: Buffer, start = 12, end = bytes.length): RiffChunk[] {
  const result: RiffChunk[] = [];
  for (let at = start; at < end;) {
    expect(at + 8).toBeLessThanOrEqual(end);
    const type = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const next = at + 8 + size + (size & 1);
    expect(next).toBeLessThanOrEqual(end);
    result.push({ type, at, data: at + 8, size, children: type === 'LIST' ? riffChunks(bytes, at + 12, at + 8 + size) : [] });
    at = next;
  }
  return result;
}

function flatten(chunks: RiffChunk[]): RiffChunk[] {
  return chunks.flatMap(chunk => [chunk, ...flatten(chunk.children)]);
}

function decodeRle(bytes: Buffer, width: number, height: number): Buffer {
  const result = Buffer.alloc(width * height, 255);
  let x = 0;
  let y = height - 1;
  let ended = false;
  for (let offset = 0; offset < bytes.length;) {
    const count = bytes[offset++];
    const value = bytes[offset++];
    if (count) {
      expect(x + count).toBeLessThanOrEqual(width);
      result.fill(value, y * width + x, y * width + x + count);
      x += count;
    } else if (value === 0) {
      expect(x).toBe(width);
      x = 0;
      y -= 1;
    } else if (value === 1) {
      ended = true;
      expect(offset).toBe(bytes.length);
      break;
    } else if (value === 2) {
      throw new Error('The installer never emits delta frames.');
    } else {
      expect(x + value).toBeLessThanOrEqual(width);
      bytes.copy(result, y * width + x, offset, offset + value);
      x += value;
      offset += value + (value & 1);
    }
  }
  expect(ended).toBe(true);
  expect(y).toBe(-1);
  return result;
}

function readBitmap(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(bytes.toString('ascii', 0, 2)).toBe('BM');
  expect(bytes.readUInt32LE(2)).toBe(bytes.length);
  expect(bytes.readUInt16LE(28)).toBe(8);
  expect(bytes.readUInt32LE(30)).toBe(0);
  const width = bytes.readInt32LE(18);
  const height = bytes.readInt32LE(22);
  const stride = (width + 3) & ~3;
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    const start = bytes.readUInt32LE(10) + (height - y - 1) * stride;
    bytes.copy(pixels, y * width, start, start + width);
  }
  return { width, height, pixels };
}

describe('native installer animation assets', () => {
  it('reads the owned RGBA logo and composites transparent pixels on the white mark surface', () => {
    const original = decodeLogoPng(readFileSync(sourceLogo));
    expect([original.width, original.height]).toEqual([128, 128]);
    expect(original.rgb.length).toBe(128 * 128 * 3);
    expect(Math.min(...original.rgb)).toBe(0);
    expect(Math.max(...original.rgb)).toBe(255);
    expect([...decodeLogoPng(testPng()).rgb]).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it('rejects incompatible or damaged PNG inputs instead of silently changing the asset contract', () => {
    expect(() => decodeLogoPng(testPng(2))).toThrow('8-bit RGBA');
    const damaged = testPng();
    damaged[damaged.length - 1] ^= 1;
    expect(() => decodeLogoPng(damaged)).toThrow('checksum');
    expect(() => decodeLogoPng(damaged.subarray(0, 35))).toThrow('truncated');
  });

  it('encodes literal, odd-length, repeated and long pixel runs as independently decodable RLE8 rows', () => {
    const pixels = Buffer.concat([
      Buffer.from(Array.from({ length: 270 }, (_, n) => n % 80)),
      Buffer.alloc(270, 63),
      Buffer.from([...Array.from({ length: 267 }, (_, n) => n % 2), 9, 10, 11]),
    ]);
    expect(decodeRle(encodeRle8Frame(pixels, 270, 3), 270, 3)).toEqual(pixels);
  });

  it('keeps the larger mark inside high-DPI crop bounds and tapers the colored glow to an exact matte', () => {
    const logo = decodeLogoPng(readFileSync(sourceLogo));
    for (const scale of ANIMATION_CONTRACT.scales) {
      const visibleHeight = 128 * scale.percent / 100;
      const cropTop = (scale.height - visibleHeight) / 2;
      for (const number of [0, 36, 84, 180]) {
        const pixels = renderInstallerFrame(logo, scale, number);
        const bitmap = createBitmap(scale.width, scale.height, pixels);
        const color = (index: number) => {
          const at = 54 + index * 4;
          return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
        };
        const background = pixels[0];
        expect(color(background)).toEqual([251, 251, 253]);
        for (let x = 0; x < scale.width; x += 1) {
          expect(pixels[x]).toBe(background);
          expect(pixels[(scale.height - 1) * scale.width + x]).toBe(background);
        }
        for (let y = 0; y < scale.height; y += 1) {
          expect(pixels[y * scale.width]).toBe(background);
          expect(pixels[(y + 1) * scale.width - 1]).toBe(background);
        }
        const markRows = [];
        for (let y = 0; y < scale.height; y += 1) {
          if (pixels.subarray(y * scale.width, (y + 1) * scale.width).some(index => color(index).every(channel => channel < 80))) markRows.push(y);
        }
        expect(markRows[0]).toBeGreaterThanOrEqual(cropTop);
        expect(markRows.at(-1)).toBeLessThan(scale.height - cropTop);
        expect(markRows.at(-1)! - markRows[0]).toBeGreaterThan(96 * scale.percent / 100);
        if (number !== 0) {
          const left = color(pixels[Math.round(scale.height / 2) * scale.width + Math.round(scale.width * .14)]);
          const right = color(pixels[Math.round(scale.height / 2) * scale.width + Math.round(scale.width * .86)]);
          expect(left[2]).toBeGreaterThan(left[0] + 3);
          expect(left[1]).toBeGreaterThan(left[0]);
          expect(right[2]).toBeGreaterThan(right[1] + 3);
          expect(right[0]).toBeGreaterThan(right[1]);
        }
      }
    }
  });

  it('publishes deterministic silent AVI clips and BMP fallbacks, reuses verified inputs, and repairs corrupted output', () => {
    const root = fixture('with spaces 安装');
    const prepared = prepareInstallerAnimationAssets(root);
    expect(prepared.cacheHit).toBe(false);
    expect(prepared.frameRate).toBe(24);
    expect(prepared.loopFirstFrame).toBe(36);
    expect(prepared.lastFrame).toBe(227);
    expect(prepared.scales.map(scale => [scale.percent, scale.width, scale.height])).toEqual([
      [100, 224, 180], [150, 336, 270], [200, 448, 360],
    ]);
    const hashes = new Map<string, string>();
    for (const scale of prepared.scales) {
      const avi = readFileSync(scale.aviPath);
      hashes.set(path.basename(scale.aviPath), createHash('sha256').update(avi).digest('hex'));
      expect(avi.toString('ascii', 0, 4)).toBe('RIFF');
      expect(avi.readUInt32LE(4)).toBe(avi.length - 8);
      expect(avi.toString('ascii', 8, 12)).toBe('AVI ');
      const chunks = riffChunks(avi);
      const all = flatten(chunks);
      const main = all.find(chunk => chunk.type === 'avih')!;
      const stream = all.find(chunk => chunk.type === 'strh')!;
      const format = all.find(chunk => chunk.type === 'strf')!;
      const movie = chunks.find(chunk => chunk.type === 'LIST' && avi.toString('ascii', chunk.data, chunk.data + 4) === 'movi')!;
      const index = all.find(chunk => chunk.type === 'idx1')!;
      expect(avi.readUInt32LE(main.data + 16)).toBe(228);
      expect(avi.readUInt32LE(main.data + 24)).toBe(1);
      expect(avi.toString('ascii', stream.data, stream.data + 8)).toBe('vidsMRLE');
      expect(avi.readUInt32LE(stream.data + 20)).toBe(1);
      expect(avi.readUInt32LE(stream.data + 24)).toBe(24);
      expect(avi.readUInt32LE(stream.data + 32)).toBe(228);
      expect(avi.readUInt32LE(format.data + 16)).toBe(1);
      expect(avi.readUInt16LE(format.data + 14)).toBe(8);
      expect(avi.readUInt32LE(format.data + 32)).toBe(256);
      expect(movie.children).toHaveLength(228);
      expect(index.size).toBe(228 * 16);
      for (let number = 0; number < movie.children.length; number += 1) {
        const frame = movie.children[number];
        expect(frame.type).toBe('00dc');
        expect(avi.readUInt32LE(index.data + number * 16 + 8) + movie.data).toBe(frame.at);
        expect(avi.readUInt32LE(index.data + number * 16 + 12)).toBe(frame.size);
      }
      const decodeFrame = (number: number) => {
        const frame = movie.children[number];
        return decodeRle(avi.subarray(frame.data, frame.data + frame.size), scale.width, scale.height);
      };
      const entranceEnd = decodeFrame(35);
      const loopStart = decodeFrame(36);
      expect(entranceEnd).toEqual(loopStart);
      expect(decodeFrame(0)).not.toEqual(loopStart);
      expect(decodeFrame(84)).not.toEqual(loopStart);
      const fallback = readBitmap(readFileSync(scale.bitmapPath));
      expect([fallback.width, fallback.height]).toEqual([scale.width, scale.height]);
      expect(fallback.pixels).toEqual(loopStart);
      const background = format.data + 40 + loopStart[0] * 4;
      expect([...avi.subarray(background, background + 4)]).toEqual([253, 251, 251, 0]);
      // The full-field pastel gradient adds color transitions; complete RLE
      // key frames must still save at least 60% over raw indexed pixels.
      expect(avi.length).toBeLessThan(scale.width * scale.height * 228 * .4);
    }
    const manifest = path.join(prepared.directory, 'manifest.json');
    const before = statSync(manifest).mtimeMs;
    const cached = prepareInstallerAnimationAssets(root);
    expect(cached.directory).toBe(prepared.directory);
    expect(cached.cacheHit).toBe(true);
    expect(statSync(manifest).mtimeMs).toBe(before);
    const broken = prepared.scales[0].aviPath;
    writeFileSync(broken, 'damaged prepared animation');
    const repaired = prepareInstallerAnimationAssets(root);
    expect(repaired.fingerprint).toBe(prepared.fingerprint);
    expect(repaired.cacheHit).toBe(false);
    for (const scale of repaired.scales) {
      expect(createHash('sha256').update(readFileSync(scale.aviPath)).digest('hex')).toBe(hashes.get(path.basename(scale.aviPath)));
    }
    expect(readdirSync(path.join(root, 'build', 'installer')).some(name => name.startsWith('.animation-staging-'))).toBe(false);
    expect(readdirSync(path.join(root, 'build', 'installer')).some(name => name.startsWith('.animation-invalid-'))).toBe(true);
    expect(lstatSync(repaired.directory).isDirectory()).toBe(true);
  }, 40_000);

  it('binds the cache to source bytes and never publishes a prepared set after invalid source input', () => {
    const root = fixture('source contract');
    const logoPath = path.join(root, 'resources', 'icons', 'png', '128x128.png');
    const original = prepareInstallerAnimationAssets(root);
    writeFileSync(logoPath, testPng());
    const prepared = prepareInstallerAnimationAssets(root);
    expect(prepared.fingerprint).not.toBe(original.fingerprint);
    writeFileSync(logoPath, testPng(2));
    expect(() => prepareInstallerAnimationAssets(root)).toThrow('8-bit RGBA');
    expect(existsSync(path.join(prepared.directory, 'manifest.json'))).toBe(true);
    expect(readdirSync(path.join(root, 'build', 'installer')).filter(name => /^[a-f0-9]{64}$/.test(name)).sort()).toEqual([original.fingerprint, prepared.fingerprint].sort());
  }, 30_000);
});
