#!/usr/bin/env node
'use strict';

/**
 * Generate all app icons from public/logo.png.
 *
 * Modes:
 *   node scripts/generate-icons.cjs png          — PNG sizes (build/icons/png/)
 *   node scripts/generate-icons.cjs app-icon     — Windows .ico (build/icons/win/)
 *   node scripts/generate-icons.cjs tray-icons   — tray icons for all platforms (resources/tray/)
 *   node scripts/generate-icons.cjs all          — run all three in order
 *   node scripts/generate-icons.cjs              — same as "all"
 *
 * Dependencies:
 *   - PNG & app-icon modes use PowerShell + System.Drawing (Windows only)
 *   - tray-icons mode uses ImageMagick (magick or convert)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourcePng = path.join(projectRoot, 'public', 'logo.png');
const mode = (process.argv[2] || 'all').toLowerCase();

// ── shared helpers ──────────────────────────────────────────────────────────

function runSpawn(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${result.status}`).trim();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${detail}`);
  }
}

function hasCommand(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

// ── PNG mode ────────────────────────────────────────────────────────────────

function generatePngIcons() {
  const pngDir = path.join(projectRoot, 'build', 'icons', 'png');
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

  fs.mkdirSync(pngDir, { recursive: true });

  const psSourcePng = sourcePng.replace(/\\/g, '\\\\');
  const psPngDir = pngDir.replace(/\\/g, '\\\\');
  const sizesStr = sizes.join(',');
  const psScript = `
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile("${psSourcePng}")
$sizes = @(${sizesStr})

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $outPath = "${psPngDir}" + "\\" + $s + "x" + $s + ".png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Generated" $s"x"$s".png"
}

$src.Dispose()
`;

  const tmpDir = path.join(projectRoot, 'build', 'icons', '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const psFile = path.join(tmpDir, 'resize-png.ps1');
  fs.writeFileSync(psFile, psScript, 'utf8');

  try {
    console.log('[generate-icons:png] Generating PNG icons from', sourcePng);
    execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'inherit' });
    console.log('[generate-icons:png] Done ->', pngDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── App icon (.ico) mode ────────────────────────────────────────────────────

function generateAppIcon() {
  const OUT_DIR = path.join(projectRoot, 'build', 'icons', 'win');
  const OUT_ICO = path.join(OUT_DIR, 'icon.ico');
  const SIZES = [256, 128, 64, 48, 32, 16];

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const tmpDir = path.join(projectRoot, 'build', 'icons', '_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const psScript = `
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile("${sourcePng.replace(/\\/g, '\\\\')}")
$sizes = @(${SIZES.join(',')})

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $outPath = "${tmpDir.replace(/\\/g, '\\\\')}\\\\icon_$s.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$src.Dispose()
`;

  const psFile = path.join(tmpDir, 'resize.ps1');
  fs.writeFileSync(psFile, psScript, 'utf8');

  try {
    console.log('[generate-icons:app-icon] Resizing source image...');
    execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'inherit' });

    // Pack PNGs into ICO buffer.
    const pngBuffers = SIZES.map(s => {
      const p = path.join(tmpDir, `icon_${s}.png`);
      return { size: s, data: fs.readFileSync(p) };
    });

    const count = pngBuffers.length;
    const headerSize = 6;
    const entrySize = 16;
    const dataOffset0 = headerSize + entrySize * count;

    let currentOffset = dataOffset0;
    const entries = pngBuffers.map(({ size, data }) => {
      const entry = {
        width: size >= 256 ? 0 : size,
        height: size >= 256 ? 0 : size,
        dataSize: data.length,
        offset: currentOffset,
        data,
      };
      currentOffset += data.length;
      return entry;
    });

    const ico = Buffer.alloc(currentOffset);
    ico.writeUInt16LE(0, 0);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(count, 4);

    entries.forEach((e, i) => {
      const off = headerSize + i * entrySize;
      ico.writeUInt8(e.width, off + 0);
      ico.writeUInt8(e.height, off + 1);
      ico.writeUInt8(0, off + 2);
      ico.writeUInt8(0, off + 3);
      ico.writeUInt16LE(1, off + 4);
      ico.writeUInt16LE(32, off + 6);
      ico.writeUInt32LE(e.dataSize, off + 8);
      ico.writeUInt32LE(e.offset, off + 12);
    });

    entries.forEach(e => e.data.copy(ico, e.offset));

    fs.writeFileSync(OUT_ICO, ico);
    console.log(`[generate-icons:app-icon] Generated ${OUT_ICO} (${SIZES.join(', ')}px) — ${ico.length} bytes`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Tray icons mode ─────────────────────────────────────────────────────────

function generateTrayIcons(inputOverride) {
  const inputPath = inputOverride
    ? path.resolve(projectRoot, inputOverride)
    : sourcePng;
  const outputDir = path.resolve(projectRoot, 'resources', 'tray');

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input logo not found: ${inputPath}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const magick = (() => {
    if (hasCommand('magick', ['-version'])) return 'magick';
    if (hasCommand('convert', ['-version'])) return 'convert';
    throw new Error('ImageMagick is required. Please install `magick` or `convert`.');
  })();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-icons-'));

  const win16 = path.join(tmpDir, 'tray-16.png');
  const win32 = path.join(tmpDir, 'tray-32.png');
  const win48 = path.join(tmpDir, 'tray-48.png');
  const linuxPng = path.join(outputDir, 'tray-icon.png');
  const winIco = path.join(outputDir, 'tray-icon.ico');
  const macTemplate = path.join(outputDir, 'trayIconTemplate.png');
  const macTemplate2x = path.join(outputDir, 'trayIconTemplate@2x.png');
  const macColor = path.join(outputDir, 'tray-icon-mac.png');
  const macColor2x = path.join(outputDir, 'tray-icon-mac@2x.png');
  const macColorRaw = path.join(tmpDir, 'tray-icon-mac-raw.png');
  const macColor2xRaw = path.join(tmpDir, 'tray-icon-mac@2x-raw.png');

  try {
    runSpawn(magick, [inputPath, '-resize', '48x48', linuxPng]);

    runSpawn(magick, [inputPath, '-resize', '16x16', win16]);
    runSpawn(magick, [inputPath, '-resize', '32x32', win32]);
    runSpawn(magick, [inputPath, '-resize', '48x48', win48]);
    runSpawn(magick, [win16, win32, win48, winIco]);

    // macOS template images
    runSpawn(magick, [inputPath, '-resize', '18x18', '-colorspace', 'Gray', '-threshold', '70%', '-alpha', 'copy', '-channel', 'RGB', '-fill', 'black', '-colorize', '100', '-trim', '+repage', '-background', 'none', '-gravity', 'center', '-extent', '18x18', macTemplate]);
    runSpawn(magick, [inputPath, '-resize', '36x36', '-colorspace', 'Gray', '-threshold', '70%', '-alpha', 'copy', '-channel', 'RGB', '-fill', 'black', '-colorize', '100', '-trim', '+repage', '-background', 'none', '-gravity', 'center', '-extent', '36x36', macTemplate2x]);

    // macOS color tray icons
    runSpawn(magick, [inputPath, '-trim', '+repage', '-resize', '16x16', '-modulate', '108,118,100', '-sigmoidal-contrast', '4,50%', '-background', 'none', '-gravity', 'center', '-extent', '18x18', macColorRaw]);
    runSpawn(magick, [inputPath, '-trim', '+repage', '-resize', '32x32', '-modulate', '108,118,100', '-sigmoidal-contrast', '4,50%', '-background', 'none', '-gravity', 'center', '-extent', '36x36', macColor2xRaw]);

    runSpawn(magick, [macColorRaw, '-alpha', 'on', '-colorspace', 'sRGB', '-type', 'TrueColorAlpha', '-strip', '-define', 'png:color-type=6', macColor]);
    runSpawn(magick, [macColor2xRaw, '-alpha', 'on', '-colorspace', 'sRGB', '-type', 'TrueColorAlpha', '-strip', '-define', 'png:color-type=6', macColor2x]);

    console.log(`[generate-icons:tray-icons] Generated tray icons -> ${outputDir}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

const modes = {
  png: () => generatePngIcons(),
  'app-icon': () => generateAppIcon(),
  'tray-icons': () => generateTrayIcons(process.argv[3]),
  all: () => {
    generatePngIcons();
    generateAppIcon();
    generateTrayIcons(process.argv[3]);
  },
};

if (modes[mode]) {
  try {
    modes[mode]();
  } catch (error) {
    console.error(`[generate-icons] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  console.error(`[generate-icons] Unknown mode: ${mode}. Use: png | app-icon | tray-icons | all`);
  process.exit(1);
}
