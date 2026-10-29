'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ANIMATION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  frameRate: 24,
  introFrames: 36,
  loopFirstFrame: 36,
  loopFrames: 192,
  lastFrame: 227,
  background: Object.freeze([251, 251, 253]),
  scales: Object.freeze([
    Object.freeze({ percent: 100, width: 224, height: 180 }),
    Object.freeze({ percent: 150, width: 336, height: 270 }),
    Object.freeze({ percent: 200, width: 448, height: 360 }),
  ]),
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const BACKGROUND_INDEX = 80;
const PALETTE = Array.from({ length: 256 }, (_, index) => {
  if (index < 64) {
    const gray = Math.round((index * 255) / 63);
    return [gray, gray, gray];
  }
  if (index < 80) {
    const step = index - 64;
    return [Math.round(166 + step * 5), Math.round(192 + step * 4), Math.round(225 + step * 2)];
  }
  if (index === BACKGROUND_INDEX) return [...ANIMATION_CONTRACT.background];
  // These two ramps retain subtle ambient color instead of quantizing every
  // almost-white pixel into the same coarse gray/blue bucket.
  if (index < 145) {
    const amount = (index - 80) / 64;
    return [Math.round(251 - amount * 31), Math.round(251 - amount * 18), 253];
  }
  if (index < 209) {
    const amount = (index - 144) / 64;
    return [Math.round(251 - amount * 13), Math.round(251 - amount * 25), 253];
  }
  if (index < 241) {
    const amount = (index - 209) / 31;
    return [
      Math.round(255 - amount * 29),
      Math.round(255 - amount * 24),
      Math.round(255 - amount * 8),
    ];
  }
  return [255, 255, 255];
});
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
let colorLookup;
let pastelLookup;

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decodeLogoPng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Installer logo must be a PNG image.');
  }
  let width;
  let height;
  let ended = false;
  const compressed = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Installer logo has a truncated PNG chunk.');
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Installer logo has a truncated PNG chunk.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      throw new Error(`Installer logo PNG checksum failed: ${type}.`);
    }
    if (type === 'IHDR') {
      if (width !== undefined || offset !== 8 || length !== 13)
        throw new Error('Installer logo has an invalid PNG header.');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!width || !height || width > 2048 || height > 2048)
        throw new Error('Installer logo dimensions are unsupported.');
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Installer logo requires non-interlaced, 8-bit RGBA PNG input.');
      }
    } else if (type === 'IDAT') {
      if (width === undefined) throw new Error('Installer logo PNG is missing its header.');
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length)
        throw new Error('Installer logo has an invalid PNG ending.');
      ended = true;
      break;
    } else if (type[0] === type[0].toUpperCase()) {
      throw new Error(`Installer logo PNG has an unsupported critical chunk: ${type}.`);
    }
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error('Installer logo PNG is incomplete.');
  const rowBytes = width * 4;
  const inflated = zlib.inflateSync(Buffer.concat(compressed), {
    maxOutputLength: (rowBytes + 1) * height,
  });
  if (inflated.length !== (rowBytes + 1) * height)
    throw new Error('Installer logo PNG pixel data has an invalid length.');
  const rgba = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (rowBytes + 1)];
    if (filter > 4) throw new Error('Installer logo PNG has an unsupported row filter.');
    for (let x = 0; x < rowBytes; x += 1) {
      const at = y * rowBytes + x;
      const left = x >= 4 ? rgba[at - 4] : 0;
      const up = y ? rgba[at - rowBytes] : 0;
      const upperLeft = y && x >= 4 ? rgba[at - rowBytes - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = up;
      if (filter === 3) predictor = Math.floor((left + up) / 2);
      if (filter === 4) {
        const candidate = left + up - upperLeft;
        const a = Math.abs(candidate - left);
        const b = Math.abs(candidate - up);
        const c = Math.abs(candidate - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      rgba[at] = (inflated[y * (rowBytes + 1) + 1 + x] + predictor) & 255;
    }
  }
  // The installer has a fixed white background. Composite before interpolation
  // so transparent PNG pixels cannot create dark fringes around the source mark.
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const alpha = rgba[pixel * 4 + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      rgb[pixel * 3 + channel] = Math.round(rgba[pixel * 4 + channel] * alpha + 255 * (1 - alpha));
    }
  }
  return { width, height, rgb };
}

function paletteLookup() {
  if (colorLookup) return colorLookup;
  colorLookup = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r += 1)
    for (let g = 0; g < 32; g += 1)
      for (let b = 0; b < 32; b += 1) {
        let best = 0;
        let distance = Infinity;
        for (let index = 0; index < 241; index += 1) {
          const color = PALETTE[index];
          const candidate =
            (r * 8 + 3.5 - color[0]) ** 2 +
            (g * 8 + 3.5 - color[1]) ** 2 +
            (b * 8 + 3.5 - color[2]) ** 2;
          if (candidate < distance) {
            distance = candidate;
            best = index;
          }
        }
        colorLookup[(r << 10) | (g << 5) | b] = best;
      }
  return colorLookup;
}

function pastelPaletteLookup() {
  if (pastelLookup) return pastelLookup;
  // Full channel precision in the small near-white region prevents visible
  // bands around soft gradients. Dark logo pixels keep the compact lookup.
  pastelLookup = new Uint8Array(32 * 32 * 24);
  for (let r = 224; r < 256; r += 1)
    for (let g = 224; g < 256; g += 1)
      for (let b = 232; b < 256; b += 1) {
        let best = 0;
        let distance = Infinity;
        for (let index = 0; index < 241; index += 1) {
          const color = PALETTE[index];
          const candidate = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
          if (candidate < distance) {
            distance = candidate;
            best = index;
          }
        }
        pastelLookup[((r - 224) * 32 + g - 224) * 24 + b - 232] = best;
      }
  return pastelLookup;
}

function sampleLogo(logo, x, y, channel) {
  const px = Math.max(0, Math.min(logo.width - 1, (x / 112 + 0.5) * logo.width - 0.5));
  const py = Math.max(0, Math.min(logo.height - 1, (y / 112 + 0.5) * logo.height - 0.5));
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, logo.width - 1);
  const y1 = Math.min(y0 + 1, logo.height - 1);
  const fx = px - x0;
  const fy = py - y0;
  const upper =
    logo.rgb[(y0 * logo.width + x0) * 3 + channel] * (1 - fx) +
    logo.rgb[(y0 * logo.width + x1) * 3 + channel] * fx;
  const lower =
    logo.rgb[(y1 * logo.width + x0) * 3 + channel] * (1 - fx) +
    logo.rgb[(y1 * logo.width + x1) * 3 + channel] * fx;
  return upper * (1 - fy) + lower * fy;
}

function renderInstallerFrame(logo, scale, frameIndex) {
  const width = scale.width;
  const height = scale.height;
  const ratio = width / 224;
  const result = Buffer.alloc(width * height, BACKGROUND_INDEX);
  const lookup = paletteLookup();
  const pastels = pastelPaletteLookup();
  const quantize = (r, g, b) => {
    if (r === 251 && g === 251 && b === 253) return BACKGROUND_INDEX;
    if (r > 254.5 && g > 254.5 && b > 254.5) return 63;
    r = Math.round(r);
    g = Math.round(g);
    b = Math.round(b);
    if (r >= 224 && g >= 224 && b >= 232) return pastels[((r - 224) * 32 + g - 224) * 24 + b - 232];
    return lookup[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
  };
  const intro = frameIndex < ANIMATION_CONTRACT.introFrames;
  const progress = intro ? frameIndex / (ANIMATION_CONTRACT.introFrames - 1) : 1;
  const separation = intro ? 48 * (1 - progress) ** 3 : 0;
  const phase = intro
    ? 0
    : ((frameIndex - ANIMATION_CONTRACT.loopFirstFrame) / ANIMATION_CONTRACT.loopFrames) *
      Math.PI *
      2;
  const turn = Math.sin(phase) * 0.38;
  const roll = Math.sin(phase) * 0.055;
  const bob = Math.sin(phase) * 2.2;
  const projection = Math.cos(turn);
  const centerX = width / 2;
  const centerY = (90 + bob) * ratio;
  const smoothEdge = value => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  // Both the ambient wash and contact shadow taper to the exact UI matte on
  // all four edges. Centered native controls can crop the decorative margins
  // at high DPI without cutting through the larger mark.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const dx = (x + 0.5 - centerX) / ratio;
      const logicalY = (y + 0.5) / ratio;
      const dy = logicalY - 88;
      const edge =
        smoothEdge((112 - Math.abs(dx)) / 24) * smoothEdge(Math.min(logicalY, 180 - logicalY) / 20);
      const breath = 0.88 + 0.12 * Math.cos(phase);
      const blue = Math.exp(-((dx + 34) ** 2 / 2800 + (dy + 6) ** 2 / 2200)) * 0.63 * edge * breath;
      const violet =
        Math.exp(-((dx - 38) ** 2 / 2350 + (dy - 3) ** 2 / 2050)) * 0.59 * edge * breath;
      const shadow = Math.exp(-((dx * dx) / 2350 + (logicalY - 160) ** 2 / 13)) * 0.12 * edge;
      result[y * width + x] = quantize(
        251 - blue * 31 - violet * 13 - shadow * 78,
        251 - blue * 18 - violet * 25 - shadow * 57,
        253 - shadow * 27,
      );
    }
  }
  // At the end of the entrance draw the complete mark once. The steady loop
  // never separates the character, avoiding a visible seam through its face.
  for (const side of separation > 0.01 ? [-1, 1] : [0]) {
    const cx = centerX + side * separation * ratio;
    const cy = centerY + side * separation * 0.13 * ratio;
    const angle = roll + side * separation * 0.004;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const extent = 63 * ratio;
    for (
      let y = Math.max(0, Math.floor(cy - extent));
      y < Math.min(height, Math.ceil(cy + extent));
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - extent));
        x < Math.min(width, Math.ceil(cx + extent));
        x += 1
      ) {
        const original = PALETTE[result[y * width + x]];
        const sum = [0, 0, 0];
        for (const oy of [0.25, 0.75])
          for (const ox of [0.25, 0.75]) {
            const dx = (x + ox - cx) / ratio;
            const dy = (y + oy - cy) / ratio;
            const localX = (dx * cosine + dy * sine) / projection;
            const localY = -dx * sine + dy * cosine;
            const boundary = 20.2 * Math.sin((localY / 56) * Math.PI);
            const masked = side < 0 ? localX > boundary : side > 0 && localX <= boundary;
            const distance = Math.hypot(localX - 1.2 - turn * 4, localY - 2.4);
            let color = original;
            if (!masked && distance <= 59.5) {
              const shade = Math.max(0, Math.min(1, (localX + localY + 78) / 156));
              color = [255 - shade * 33, 255 - shade * 24, 255 - shade * 9];
              if (localX * localX + localY * localY <= 3136) {
                const highlight =
                  Math.exp(-((localX + localY * 0.28 - Math.cos(phase) * 80) ** 2 / 64)) * 0.085;
                const shadeFace = 1 - Math.max(0, (localX / 56) * Math.sin(phase)) * 0.018;
                color = [0, 1, 2].map(channel => {
                  const value = sampleLogo(logo, localX, localY, channel) * shadeFace;
                  return value + (255 - value) * highlight;
                });
              }
            }
            for (let channel = 0; channel < 3; channel += 1) sum[channel] += color[channel];
          }
        result[y * width + x] = quantize(sum[0] / 4, sum[1] / 4, sum[2] / 4);
      }
    }
  }
  return result;
}

function encodeRle8Frame(pixels, width, height) {
  const output = [];
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width;
    let x = 0;
    const runAt = start => {
      let length = 1;
      while (
        start + length < width &&
        length < 255 &&
        pixels[row + start + length] === pixels[row + start]
      )
        length += 1;
      return length;
    };
    while (x < width) {
      const run = runAt(x);
      if (run >= 3) {
        output.push(run, pixels[row + x]);
        x += run;
        continue;
      }
      const start = x;
      x += run;
      while (x < width && x - start < 255) {
        const next = runAt(x);
        if (next >= 3) break;
        x += Math.min(next, 255 - (x - start));
      }
      const count = x - start;
      if (count < 3) {
        for (let i = start; i < x; i += 1) output.push(1, pixels[row + i]);
      } else {
        output.push(0, count);
        for (let i = start; i < x; i += 1) output.push(pixels[row + i]);
        if (count & 1) output.push(0);
      }
    }
    output.push(0, 0);
  }
  output.push(0, 1);
  return Buffer.from(output);
}

function paletteBytes() {
  return Buffer.from(PALETTE.flatMap(([r, g, b]) => [b, g, r, 0]));
}

function bitmapInfo(width, height, compression, imageSize) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(8, 14);
  header.writeUInt32LE(compression, 16);
  header.writeUInt32LE(imageSize, 20);
  header.writeUInt32LE(256, 32);
  return Buffer.concat([header, paletteBytes()]);
}

function chunk(type, bytes) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, ...(bytes.length & 1 ? [Buffer.alloc(1)] : [])]);
}

function list(type, children) {
  return chunk('LIST', Buffer.concat([Buffer.from(type, 'ascii'), ...children]));
}

function createAvi(width, height, frames, frameRate = ANIMATION_CONTRACT.frameRate) {
  const largest = Math.max(...frames.map(frame => frame.length));
  const main = Buffer.alloc(56);
  main.writeUInt32LE(Math.round(1_000_000 / frameRate), 0);
  main.writeUInt32LE(largest * frameRate, 4);
  main.writeUInt32LE(0x10, 12); // AVIF_HASINDEX
  main.writeUInt32LE(frames.length, 16);
  main.writeUInt32LE(1, 24); // One silent video stream; never an audio stream.
  main.writeUInt32LE(largest, 28);
  main.writeUInt32LE(width, 32);
  main.writeUInt32LE(height, 36);
  const stream = Buffer.alloc(56);
  stream.write('vidsMRLE', 0, 'ascii');
  stream.writeUInt32LE(1, 20);
  stream.writeUInt32LE(frameRate, 24);
  stream.writeUInt32LE(frames.length, 32);
  stream.writeUInt32LE(largest, 36);
  stream.writeUInt32LE(0xffffffff, 40);
  stream.writeInt16LE(width, 52);
  stream.writeInt16LE(height, 54);
  const header = list('hdrl', [
    chunk('avih', main),
    list('strl', [chunk('strh', stream), chunk('strf', bitmapInfo(width, height, 1, largest))]),
  ]);
  const index = Buffer.alloc(frames.length * 16);
  let offset = 4; // Index offsets are relative to the LIST movi type marker.
  const movie = frames.map((frame, number) => {
    const at = number * 16;
    index.write('00dc', at, 4, 'ascii');
    index.writeUInt32LE(0x10, at + 4); // Every RLE image is a complete key frame.
    index.writeUInt32LE(offset, at + 8);
    index.writeUInt32LE(frame.length, at + 12);
    const encoded = chunk('00dc', frame);
    offset += encoded.length;
    return encoded;
  });
  return chunk(
    'RIFF',
    Buffer.concat([
      Buffer.from('AVI ', 'ascii'),
      header,
      list('movi', movie),
      chunk('idx1', index),
    ]),
  );
}

function createBitmap(width, height, pixels) {
  const stride = (width + 3) & ~3;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1)
    pixels.copy(data, (height - y - 1) * stride, y * width, (y + 1) * width);
  const info = bitmapInfo(width, height, 0, data.length);
  const header = Buffer.alloc(14);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(header.length + info.length + data.length, 2);
  header.writeUInt32LE(header.length + info.length, 10);
  return Buffer.concat([header, info, data]);
}

function assetDescription(directory, fingerprint, cacheHit) {
  return {
    directory,
    fingerprint,
    cacheHit,
    frameRate: ANIMATION_CONTRACT.frameRate,
    introFrames: ANIMATION_CONTRACT.introFrames,
    loopFirstFrame: ANIMATION_CONTRACT.loopFirstFrame,
    lastFrame: ANIMATION_CONTRACT.lastFrame,
    scales: ANIMATION_CONTRACT.scales.map(scale => ({
      ...scale,
      aviPath: path.join(directory, `brand-${scale.percent}.avi`),
      bitmapPath: path.join(directory, `brand-${scale.percent}.bmp`),
    })),
  };
}

function readPrepared(directory, fingerprint) {
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
      return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (
      manifest.schemaVersion !== ANIMATION_CONTRACT.schemaVersion ||
      manifest.fingerprint !== fingerprint
    )
      return false;
    for (const key of [
      'frameRate',
      'introFrames',
      'loopFirstFrame',
      'loopFrames',
      'lastFrame',
      'background',
      'scales',
    ]) {
      if (JSON.stringify(manifest[key]) !== JSON.stringify(ANIMATION_CONTRACT[key])) return false;
    }
    for (const scale of ANIMATION_CONTRACT.scales)
      for (const extension of ['avi', 'bmp']) {
        const name = `brand-${scale.percent}.${extension}`;
        const filePath = path.join(directory, name);
        const stat = fs.lstatSync(filePath);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          manifest.files?.[name]?.bytes !== stat.size ||
          manifest.files[name].sha256 !== digest(fs.readFileSync(filePath))
        )
          return false;
      }
    return true;
  } catch {
    return false;
  }
}

function assertOwnedDirectory(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    path.dirname(resolvedCandidate) !== resolvedRoot ||
    !/^(?:[a-f0-9]{64}|\.animation-(?:staging|invalid)-[a-zA-Z0-9-]+)$/.test(
      path.basename(resolvedCandidate),
    )
  ) {
    throw new Error(
      'Refusing installer animation cache operation outside its owned build directory.',
    );
  }
  return resolvedCandidate;
}

function prepareInstallerAnimationAssets(projectDir) {
  const source = fs.readFileSync(path.join(projectDir, 'resources', 'icons', 'png', '128x128.png'));
  const fingerprint = digest(
    Buffer.concat([
      Buffer.from(JSON.stringify(ANIMATION_CONTRACT)),
      fs.readFileSync(__filename),
      source,
    ]),
  );
  const root = path.resolve(projectDir, 'build', 'installer');
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink())
    throw new Error('Installer animation build directory must not be a symbolic link.');
  const directory = assertOwnedDirectory(root, path.join(root, fingerprint));
  if (readPrepared(directory, fingerprint)) return assetDescription(directory, fingerprint, true);
  const logo = decodeLogoPng(source);
  const stage = assertOwnedDirectory(root, fs.mkdtempSync(path.join(root, '.animation-staging-')));
  try {
    const files = {};
    for (const scale of ANIMATION_CONTRACT.scales) {
      const frames = [];
      let fallback;
      for (let frame = 0; frame <= ANIMATION_CONTRACT.lastFrame; frame += 1) {
        const pixels = renderInstallerFrame(logo, scale, frame);
        if (frame === ANIMATION_CONTRACT.loopFirstFrame) fallback = pixels;
        frames.push(encodeRle8Frame(pixels, scale.width, scale.height));
      }
      const outputs = {
        [`brand-${scale.percent}.avi`]: createAvi(scale.width, scale.height, frames),
        [`brand-${scale.percent}.bmp`]: createBitmap(scale.width, scale.height, fallback),
      };
      for (const [name, bytes] of Object.entries(outputs)) {
        fs.writeFileSync(path.join(stage, name), bytes, { flag: 'wx' });
        files[name] = { bytes: bytes.length, sha256: digest(bytes) };
      }
    }
    fs.writeFileSync(
      path.join(stage, 'manifest.json'),
      JSON.stringify({ ...ANIMATION_CONTRACT, fingerprint, files }, null, 2) + '\n',
      { flag: 'wx' },
    );
    // Concurrent installer/uninstaller compilation may have published this exact
    // content while it was rendered. Reuse it without replacing valid evidence.
    if (readPrepared(directory, fingerprint)) return assetDescription(directory, fingerprint, true);
    if (fs.existsSync(directory)) {
      if (readPrepared(directory, fingerprint))
        return assetDescription(directory, fingerprint, true);
      // Preserve unexpected/corrupt cached data rather than recursively deleting
      // an arbitrary existing tree. Only our fresh staging directory is removed.
      const invalid = assertOwnedDirectory(
        root,
        path.join(root, `.animation-invalid-${crypto.randomUUID()}`),
      );
      fs.renameSync(directory, invalid);
    }
    try {
      fs.renameSync(stage, directory);
    } catch (error) {
      if (readPrepared(directory, fingerprint))
        return assetDescription(directory, fingerprint, true);
      throw error;
    }
    return assetDescription(directory, fingerprint, false);
  } finally {
    if (fs.existsSync(stage))
      fs.rmSync(assertOwnedDirectory(root, stage), { recursive: true, force: true });
  }
}

module.exports = {
  ANIMATION_CONTRACT,
  createAvi,
  createBitmap,
  decodeLogoPng,
  encodeRle8Frame,
  prepareInstallerAnimationAssets,
  renderInstallerFrame,
};
