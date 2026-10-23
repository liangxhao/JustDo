/** Restore only a refused local Windows publish, retaining the copied artifact and native owner. */
export function createPluginDirectoryPublicationRecovery(state, dependencies) {
  const { fs, path, execFile, platform, env } = dependencies;
  if (platform !== 'win32' || state.manifest.kind !== 'directory') return undefined;
  const now = dependencies.now ?? (() => performance.now());
  const wait = dependencies.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const budgetMs = 5_000;
  const stale = () => Object.assign(new Error('Plugin publication artifact changed during recovery.'), { code: 'ESTALE' });
  const sameObject = (stat, expected) => stat.dev === expected.dev && stat.ino === expected.ino;
  const fingerprint = (stat, expected) =>
    sameObject(stat, expected) && ['mode', 'nlink', 'size', 'mtimeNs'].every(key => stat[key] === expected[key]) &&
    stat.ctimeNs === expected.ctimeNs;
  const eligible = error => error && (error.code === 'EPERM' || error.code === 'EBUSY') &&
    error.syscall === 'rename' && error.path === state.staged && error.dest === state.targetPath;
  const stat = file => fs.lstatSync(file, { bigint: true });
  const assertAbsent = () => {
    try { stat(state.targetPath); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw stale();
  };
  const proveLocalNtfs = dependencies.proveLocalNtfs ?? ((directory, timeoutMs) => new Promise(resolve => {
    // A mapped drive, UNC path, mount-point swap or unknown filesystem is never recovery authority.
    if (!/^[A-Za-z]:\\/.test(directory) || directory.startsWith('\\\\')) return resolve(false);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PluginPublicationVolume {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumePathName(string file, StringBuilder volume, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string volume);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumeInformation(string volume, StringBuilder name, uint nameLength, out uint serial, out uint maximum, out uint flags, StringBuilder format, uint formatLength);
}
'@
$volume = New-Object System.Text.StringBuilder 32768
$format = New-Object System.Text.StringBuilder 64
[uint32]$serial = 0; [uint32]$maximum = 0; [uint32]$flags = 0
$local = [PluginPublicationVolume]::GetVolumePathName($env:PLUGIN_PUBLICATION_DIRECTORY, $volume, $volume.Capacity) -and
  [PluginPublicationVolume]::GetDriveType($volume.ToString()) -eq 3 -and
  [PluginPublicationVolume]::GetVolumeInformation($volume.ToString(), $null, 0, [ref]$serial, [ref]$maximum, [ref]$flags, $format, $format.Capacity) -and
  $format.ToString() -ceq 'NTFS'
ConvertTo-Json -InputObject ([bool]$local) -Compress
`;
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC)$/i.test(key)));
    childEnv.PLUGIN_PUBLICATION_DIRECTORY = directory;
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR;
    const executable = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: childEnv, encoding: 'utf8', timeout: Math.max(1, Math.floor(timeoutMs)), windowsHide: true, maxBuffer: 1024,
    }, (error, stdout) => resolve(!error && stdout.trim() === 'true'));
  }));
  return async (firstError, dispatch) => {
    if (!eligible(firstError)) throw firstError;
    const deadline = now() + budgetMs;
    const assertTime = () => { if (now() >= deadline) throw firstError; };
    const assertCurrent = () => { assertTime(); state.assertCurrent(); assertAbsent(); };
    assertCurrent();
    const parent = path.dirname(state.staged);
    if (parent !== path.dirname(state.targetPath) || fs.realpathSync.native(parent) !== parent ||
        !(await proveLocalNtfs(parent, deadline - now()))) throw firstError;
    assertCurrent();

    const assertCopy = () => {
      let visited = 0;
      let verifiedBytes = 0;
      // Refuse recovery rather than block Gateway on a large dependency tree.
      const verificationDeadline = Math.min(deadline, now() + 100);
      const assertVerificationTime = () => {
        assertTime();
        if (now() >= verificationDeadline) throw firstError;
      };
      const inspect = (relative, manifest) => {
        assertVerificationTime();
        if (++visited > 4_096) throw firstError;
        const source = path.join(state.sourcePath, relative);
        const copied = path.join(state.staged, relative);
        const original = stat(source);
        const destination = stat(copied);
        const receipt = state.copied.get(copied);
        if (!receipt || !sameObject(destination, receipt) || !fingerprint(original, manifest)) throw stale();
        if (manifest.kind === 'directory') {
          if (!original.isDirectory() || !destination.isDirectory() || destination.isSymbolicLink()) throw stale();
          const names = manifest.children.map(child => child.name).sort();
          for (const directory of [source, copied]) {
            const actual = fs.readdirSync(directory).sort();
            if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) throw stale();
          }
          for (const child of manifest.children) {
            if (child.name === '.' || child.name === '..' || /[\\/]/.test(child.name)) throw stale();
            inspect(path.join(relative, child.name), child.manifest);
          }
          if (!fingerprint(stat(source), original) || !fingerprint(stat(copied), destination)) throw stale();
          return;
        }
        if (original.isSymbolicLink()) {
          if (!destination.isSymbolicLink() || fs.readlinkSync(source) !== fs.readlinkSync(copied) ||
              !fingerprint(stat(source), original) || !sameObject(stat(copied), receipt)) throw stale();
          return;
        }
        if (!original.isFile() || !destination.isFile() || destination.nlink !== 1n || original.nlink !== 1n) throw stale();
        if (original.size > BigInt(64 * 1024 * 1024 - verifiedBytes)) throw firstError;
        verifiedBytes += Number(original.size);
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
        let sourceFd;
        let copiedFd;
        try {
          sourceFd = fs.openSync(source, flags);
          copiedFd = fs.openSync(copied, flags);
          const sourceOpened = fs.fstatSync(sourceFd, { bigint: true });
          const copiedOpened = fs.fstatSync(copiedFd, { bigint: true });
          if (!fingerprint(sourceOpened, original) || !sameObject(copiedOpened, receipt) ||
              copiedOpened.nlink !== 1n || copiedOpened.size !== sourceOpened.size) throw stale();
          const left = Buffer.allocUnsafe(64 * 1024);
          const right = Buffer.allocUnsafe(left.length);
          let position = 0;
          for (;;) {
            assertVerificationTime();
            const read = fs.readSync(sourceFd, left, 0, left.length, position);
            const copiedRead = fs.readSync(copiedFd, right, 0, right.length, position);
            if (read !== copiedRead || !left.subarray(0, read).equals(right.subarray(0, copiedRead))) throw stale();
            if (read === 0) break;
            position += read;
          }
          if (!fingerprint(fs.fstatSync(sourceFd, { bigint: true }), sourceOpened) ||
              !fingerprint(fs.fstatSync(copiedFd, { bigint: true }), copiedOpened) ||
              !fingerprint(stat(source), sourceOpened) || !fingerprint(stat(copied), copiedOpened)) throw stale();
        } finally {
          try { if (copiedFd !== undefined) fs.closeSync(copiedFd); }
          finally { if (sourceFd !== undefined) fs.closeSync(sourceFd); }
        }
      };
      inspect('', state.manifest);
    };
    let error = firstError;
    for (let attempt = 0;; attempt += 1) {
      const delay = Math.min(40 * 2 ** Math.min(attempt, 4), 500);
      if (now() + delay >= deadline) throw error;
      await wait(delay);
      assertCurrent();
      assertCopy();
      assertCurrent();
      // dispatch performs original parent/authority/stage checks synchronously.
      // A callback's own EPERM throws here and cannot become a retryable syscall error.
      const pending = dispatch();
      try { return await pending; }
      catch (failure) { if (!eligible(failure)) throw failure; error = failure; }
    }
  };
}
