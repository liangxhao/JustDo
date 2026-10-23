'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const packageJson = require('../../package.json');
const { formatAgentCliHelp } = require('../../src/shared/integrations/agentCli.ts');

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
    : `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}"`;
}

function createAgentCliLauncher(targetPath, options = {}) {
  if (process.platform !== 'win32' && !options.allowNonWindows)
    throw new Error('The native agent CLI launcher can only be built on Windows.');
  const compiler = options.compilerPath || findCSharpCompiler(options.windowsDirectory);
  if (!compiler) throw new Error('The .NET Framework C# compiler was not found.');

  const resolvedTarget = path.resolve(targetPath);
  const temporaryExe = `${resolvedTarget}.${process.pid}.tmp.exe`;
  const temporarySource = `${resolvedTarget}.${process.pid}.tmp.cs`;
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  const productName = options.productName || packageJson.productName;
  const source = fs
    .readFileSync(path.join(__dirname, 'agent-cli-launcher.cs'), 'utf8')
    .replace(
      'private const string UserDataPathOverride = null;',
      () => `private const string UserDataPathOverride = ${csharpString(options.userDataPath)};`,
    )
    .replace(
      'private const string ProductDisplayName = null;',
      () => `private const string ProductDisplayName = ${csharpString(productName)};`,
    )
    .replace(
      'private const string ApplicationVersion = null;',
      () =>
        `private const string ApplicationVersion = ${csharpString(options.version || packageJson.version)};`,
    )
    .replace(
      'private const string HelpEnglish = null;',
      () =>
        `private const string HelpEnglish = ${csharpString(formatAgentCliHelp(productName, 'en'))};`,
    )
    .replace(
      'private const string HelpChinese = null;',
      () =>
        `private const string HelpChinese = ${csharpString(formatAgentCliHelp(productName, 'zh'))};`,
    );
  fs.writeFileSync(temporarySource, source, 'utf8');
  const result = spawnSync(
    compiler,
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/reference:System.Web.Extensions.dll',
      `/out:${temporaryExe}`,
      temporarySource,
    ],
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

module.exports = { createAgentCliLauncher, findCSharpCompiler };
