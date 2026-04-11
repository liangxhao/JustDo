/**
 * Generate PNG icons of various sizes from public/logo.png
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourcePng = path.join(projectRoot, 'public/logo.png');
const pngDir = path.join(projectRoot, 'build/icons/png');
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

// Ensure directory exists
fs.mkdirSync(pngDir, { recursive: true });

// Escape backslashes for PowerShell
const psSourcePng = sourcePng.replace(/\\/g, '\\\\');
const psPngDir = pngDir.replace(/\\/g, '\\\\');

// Create PowerShell script
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

const tmpDir = path.join(projectRoot, 'build/icons/_tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const psFile = path.join(tmpDir, 'resize-png.ps1');
fs.writeFileSync(psFile, psScript, 'utf8');

try {
  console.log('Generating PNG icons from', sourcePng);
  execSync(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'inherit' });
  console.log('PNG icons generated successfully to', pngDir);
} catch (err) {
  console.error('Failed to generate PNG icons:', err.message);
  process.exit(1);
} finally {
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
