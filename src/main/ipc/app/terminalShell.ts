import fs from 'node:fs';
import path from 'node:path';

const POWERSHELL_UTF8_INIT =
  '[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
  '$global:OutputEncoding = [Console]::OutputEncoding';

export const resolveTerminalShell = (): { shell: string; args: string[] } => {
  if (process.platform !== 'win32') {
    return { shell: process.env.SHELL || '/bin/bash', args: ['-l'] };
  }
  const pwsh = (process.env.PATH?.split(path.delimiter) ?? [])
    .map(directory => directory.replace(/^"|"$/g, '').trim())
    .filter(directory => path.isAbsolute(directory))
    .map(directory => path.join(directory, 'pwsh.exe'))
    .find(candidate => fs.existsSync(candidate));
  const systemPowerShell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : undefined;
  return {
    shell:
      pwsh ||
      (systemPowerShell && fs.existsSync(systemPowerShell) ? systemPowerShell : 'powershell.exe'),
    args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_UTF8_INIT],
  };
};
