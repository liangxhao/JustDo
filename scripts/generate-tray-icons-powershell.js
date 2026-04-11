/**
 * Generate tray icons from public/logo.png
 * Uses PowerShell + System.Drawing (no ImageMagick required)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourcePng = path.join(projectRoot, 'public/logo.png');
const outputDir = path.join(projectRoot, 'resources/tray');

// Ensure output directory exists
fs.mkdirSync(outputDir, { recursive: true });

// Escape backslashes for PowerShell
const psSourcePng = sourcePng.replace(/\\/g, '\\\\');
const psOutputDir = outputDir.replace(/\\/g, '\\\\');

const tmpDir = path.join(projectRoot, 'resources/tray/_tmp');
fs.mkdirSync(tmpDir, { recursive: true });

// Generate Linux tray icon (48x48)
const linuxPsScript = `
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile("${psSourcePng}")
$bmp = New-Object System.Drawing.Bitmap(48, 48)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.DrawImage($src, 0, 0, 48, 48)
$g.Dispose()
$bmp.Save("${psOutputDir}\\tray-icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$src.Dispose()
Write-Host "Generated tray-icon.png (48x48)"
`;

// Generate Windows ICO sizes (16, 32, 48)
const winPsScript = `
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile("${psSourcePng}")
$sizes = @(16, 32, 48)

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $outPath = "${tmpDir.replace(/\\/g, '\\\\')}\\tray-" + $s + ".png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Generated tray-" $s ".png"
}

$src.Dispose()
`;

function runPowerShell(script, description) {
  const psFile = path.join(tmpDir, 'temp.ps1');
  fs.writeFileSync(psFile, script, 'utf8');
  try {
    console.log(`Generating ${description}...`);
    execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed to generate ${description}:`, err.message);
  }
}

try {
  // Generate Linux tray icon
  runPowerShell(linuxPsScript, 'Linux tray icon');

  // Generate Windows ICO PNGs
  runPowerShell(winPsScript, 'Windows ICO source PNGs');

  // Pack into ICO
  const sizes = [16, 32, 48];
  const pngBuffers = sizes.map(s => {
    const p = path.join(tmpDir, `tray-${s}.png`);
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

  const totalSize = currentOffset;
  const ico = Buffer.alloc(totalSize);

  // ICONDIR
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(count, 4);

  // ICONDIRENTRY for each image
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

  // Image data
  entries.forEach(e => {
    e.data.copy(ico, e.offset);
  });

  const icoPath = path.join(outputDir, 'tray-icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`Generated ${icoPath} (${sizes.join(', ')}px) - ${ico.length} bytes`);

  // Generate macOS tray icons (basic versions without special processing)
  // Note: For proper macOS template icons, run generate-tray-icons.js on a Mac with ImageMagick
  const macPsScript = `
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile("${psSourcePng}")

# Standard macOS icons (16x16 and 32x32)
$sizes = @(16, 32)
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $suffix = if ($s -eq 16) { "" } else { "@2x" }
    $outPath = "${psOutputDir}\\tray-icon-mac" + $suffix + ".png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Generated tray-icon-mac" $suffix ".png"
}

$src.Dispose()
`;

  runPowerShell(macPsScript, 'macOS tray icons');

  console.log('\nTray icons generated successfully!');
  console.log(
    'Note: For optimal macOS template icons, run scripts/generate-tray-icons.js on a Mac with ImageMagick.',
  );
} finally {
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
