import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const nsisScript = readFileSync(
  path.resolve(__dirname, '../scripts/nsis-installer.nsh'),
  'utf8',
);

describe('Windows uninstaller process handling', () => {
  it('excludes the uninstaller process from installed-process detection', () => {
    expect(nsisScript).toContain('Kernel32::GetCurrentProcessId()');
    expect(nsisScript).toContain('$$_.ProcessId -ne $$uninstallerPid');
    expect(nsisScript).toContain('if ($$process.ProcessId -eq $$uninstallerPid)');
  });

  it('prompts interactive users to close the running app and retry', () => {
    expect(nsisScript).toContain('MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION');
    expect(nsisScript).toContain('正在运行。请先关闭应用');
    expect(nsisScript).toContain('is currently running. Close the app');
    expect(nsisScript).toMatch(
      /\$\{If\} \$\{Silent\}[\s\S]*StopJustDoProcesses[\s\S]*\$\{Else\}[\s\S]*FindJustDoProcesses/,
    );
  });
});
