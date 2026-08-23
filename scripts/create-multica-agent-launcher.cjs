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

function createMulticaAgentLauncher(targetPath, options = {}) {
  if (process.platform !== 'win32' && !options.allowNonWindows) {
    throw new Error('The Multica native Agent launcher can only be built on Windows.');
  }
  const compilerPath = options.compilerPath || findCSharpCompiler(options.windowsDirectory);
  if (!compilerPath) {
    throw new Error(
      'The .NET Framework C# compiler required for the Agent launcher was not found.',
    );
  }

  const sourcePath = path.resolve(__dirname, 'multica-agent-launcher.cs');
  const resolvedTargetPath = path.resolve(targetPath);
  const temporaryPath = `${resolvedTargetPath}.${process.pid}.tmp.exe`;
  const temporarySourcePath = `${resolvedTargetPath}.${process.pid}.tmp.cs`;
  fs.mkdirSync(path.dirname(resolvedTargetPath), { recursive: true });
  fs.rmSync(temporaryPath, { force: true });

  const csharpString = value =>
    value == null
      ? 'null'
      : `"${String(value)
          .replaceAll('\\', '\\\\')
          .replaceAll('"', '\\"')
          .replaceAll('\r', '\\r')
          .replaceAll('\n', '\\n')}"`;
  const source = fs
    .readFileSync(sourcePath, 'utf8')
    .replace(
      'private const string ProductExecutableOverride = null;',
      `private const string ProductExecutableOverride = ${csharpString(options.productExecutablePath)};`,
    )
    .replace(
      'private const string ApplicationPathOverride = null;',
      `private const string ApplicationPathOverride = ${csharpString(options.applicationPath)};`,
    );
  fs.writeFileSync(temporarySourcePath, source, 'utf8');

  const result = spawnSync(
    compilerPath,
    ['/nologo', '/target:exe', '/optimize+', `/out:${temporaryPath}`, temporarySourcePath],
    { encoding: 'utf8', windowsHide: true },
  );
  fs.rmSync(temporarySourcePath, { force: true });
  if (result.status !== 0 || !fs.existsSync(temporaryPath)) {
    fs.rmSync(temporaryPath, { force: true });
    const diagnostic = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(
      `Failed to compile the Multica Agent launcher${diagnostic ? `: ${diagnostic}` : '.'}`,
    );
  }

  const header = Buffer.alloc(2);
  const descriptor = fs.openSync(temporaryPath, 'r');
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.toString('ascii') !== 'MZ') {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error('The compiled Multica Agent launcher is not a Windows executable.');
  }

  fs.rmSync(resolvedTargetPath, { force: true });
  fs.renameSync(temporaryPath, resolvedTargetPath);
  return resolvedTargetPath;
}

module.exports = { createMulticaAgentLauncher, findCSharpCompiler };
