'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findCSharpCompiler(windowsDirectory = process.env.WINDIR || 'C:\\Windows') {
  const candidates = [
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function csharpString(value) {
  return value == null
    ? 'null'
    : `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function createMulticaAgentLauncher(targetPath, options = {}) {
  if (process.platform !== 'win32' && !options.allowNonWindows)
    throw new Error('The native Multica launcher can only be built on Windows.');
  const compiler = options.compilerPath || findCSharpCompiler(options.windowsDirectory);
  if (!compiler) throw new Error('The .NET Framework C# compiler was not found.');

  const resolvedTarget = path.resolve(targetPath);
  const temporaryExe = `${resolvedTarget}.${process.pid}.tmp.exe`;
  const temporarySource = `${resolvedTarget}.${process.pid}.tmp.cs`;
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  const source = fs
    .readFileSync(path.join(__dirname, 'multica-agent-launcher.cs'), 'utf8')
    .replace(
      'private const string ProductExecutableOverride = null;',
      `private const string ProductExecutableOverride = ${csharpString(options.productExecutablePath)};`,
    )
    .replace(
      'private const string ApplicationPathOverride = null;',
      `private const string ApplicationPathOverride = ${csharpString(options.applicationPath)};`,
    );
  fs.writeFileSync(temporarySource, source, 'utf8');
  const result = spawnSync(
    compiler,
    ['/nologo', '/target:exe', '/optimize+', `/out:${temporaryExe}`, temporarySource],
    { encoding: 'utf8', windowsHide: true },
  );
  fs.rmSync(temporarySource, { force: true });
  if (result.status !== 0 || !fs.existsSync(temporaryExe)) {
    fs.rmSync(temporaryExe, { force: true });
    throw new Error(
      (result.stderr || result.stdout || result.error?.message || 'Compilation failed').trim(),
    );
  }
  fs.rmSync(resolvedTarget, { force: true });
  fs.renameSync(temporaryExe, resolvedTarget);
  return resolvedTarget;
}

module.exports = { createMulticaAgentLauncher, findCSharpCompiler };
