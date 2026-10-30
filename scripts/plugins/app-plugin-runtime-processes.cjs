'use strict';

const { execFileSync } = require('node:child_process');
const { existsSync, realpathSync } = require('node:fs');
const path = require('node:path');

function runningGateways(roots, options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.execFileSync ?? execFileSync;
  let processes;
  if (platform === 'win32') {
    const output = run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('electron.exe','node.exe') } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    processes = [].concat(JSON.parse(output.trim() || '[]')).map(item => ({
      pid: item?.ProcessId,
      command: item?.CommandLine,
    }));
  } else if (['darwin', 'linux', 'freebsd'].includes(platform)) {
    const output = run('ps', ['-ax', '-o', 'pid=', '-o', 'command='], {
      encoding: 'utf8',
      windowsHide: true,
    });
    processes = output
      .split(/\r?\n/u)
      .filter(line => line.trim())
      .map(line => {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
        return { pid: Number(match?.[1]), command: match?.[2] };
      });
    if (!processes.length) throw new Error('Gateway process inventory is unavailable');
  } else throw new Error('Gateway process ownership checks do not support this platform');
  if (
    processes.some(
      item =>
        !Number.isInteger(item.pid) ||
        item.pid < 1 ||
        typeof item.command !== 'string' ||
        !item.command.trim(),
    )
  )
    throw new Error('Gateway process inventory is unavailable');
  const normalize = value =>
    platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replaceAll('\\', '/');
  return processes
    .filter(({ command }) => {
      if (!/(?:gateway-launcher\.cjs|gateway-bundle\.mjs|openclaw\.mjs)/u.test(command))
        return false;
      if (roots.some(root => normalize(command).includes(normalize(root) + '/'))) return true;
      const entries = [...command.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/gu)]
        .map(match => match[1] ?? match[2] ?? match[3])
        .filter(entry =>
          /(?:gateway-launcher\.cjs|gateway-bundle\.mjs|openclaw\.mjs)$/u.test(entry),
        );
      for (const entry of entries) {
        // ps cannot identify the cwd of an arbitrary relative launch. Do not
        // treat that process as absent from the runtime being changed.
        if (platform !== 'win32' && !path.posix.isAbsolute(entry))
          throw new Error('Gateway process ownership is unavailable for a relative launch');
        if (!existsSync(entry)) {
          if (platform !== 'win32') throw new Error('Gateway process entry is unavailable');
          continue;
        }
        if (
          roots.some(root =>
            normalize(realpathSync(entry)).startsWith(normalize(realpathSync(root)) + '/'),
          )
        )
          return true;
      }
      return false;
    })
    .map(item => item.pid);
}

function assertNoRunningGateways(roots, findRunningGateways = runningGateways) {
  const active = findRunningGateways(roots);
  if (!Array.isArray(active) || active.some(pid => !Number.isInteger(pid) || pid < 1))
    throw new Error('Gateway process inventory is unavailable');
  if (active.length)
    throw new Error(
      `Close the development application before preparing changed plugin packages (Gateway PID: ${active.join(', ')}). Plugin enablement does not require a restart.`,
    );
}

module.exports = { assertNoRunningGateways, runningGateways };
