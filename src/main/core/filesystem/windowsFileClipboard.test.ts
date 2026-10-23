import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));

import {
  WindowsFileClipboard,
  type WindowsFileClipboardSnapshot,
  type WindowsFileMutationIdentity,
} from './windowsFileClipboard';

interface HelperCall {
  executable: string;
  args: string[];
  options: { windowsHide: boolean; timeout: number; encoding: string };
  input?: Record<string, unknown>;
}

const calls: HelperCall[] = [];
const directories: string[] = [];
const original: WindowsFileClipboardSnapshot = {
  paths: ['C:\\workspace\\季度 report #100%.txt'],
  mode: 'copy',
  revision: '42',
};
const mutationIdentity: WindowsFileMutationIdentity = {
  dev: '1',
  ino: '9007199254740993',
  parentDev: '1',
  parentIno: '9007199254740995',
};
const identityOf = (filePath: string): WindowsFileMutationIdentity => {
  const source = fs.lstatSync(filePath, { bigint: true });
  const parent = fs.lstatSync(path.dirname(filePath), { bigint: true });
  return {
    dev: String(source.dev),
    ino: String(source.ino),
    parentDev: String(parent.dev),
    parentIno: String(parent.ino),
  };
};
let result: unknown;
let processError: Error | null;
let rawOutput: string | undefined;
const windowsTest = test.runIf(process.platform === 'win32');

beforeEach(() => {
  calls.length = 0;
  result = original;
  processError = null;
  rawOutput = undefined;
  execFileMock.mockReset();
  execFileMock.mockImplementation((executable, args, options, callback) => {
    const call: HelperCall = { executable, args, options };
    calls.push(call);
    const stdin = {
      on: vi.fn().mockReturnThis(),
      end: vi.fn((input: string) => {
        call.input = JSON.parse(input) as Record<string, unknown>;
        queueMicrotask(() => callback(processError, rawOutput ?? JSON.stringify(result), ''));
      }),
    };
    return { stdin };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('native-file-clipboard-')
    )
      throw new Error('Unexpected native clipboard test directory');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

windowsTest(
  'reads the system file clipboard through a hidden STA helper with a bounded static command',
  async () => {
    const snapshot = await new WindowsFileClipboard().read();

    expect(snapshot).toEqual(original);
    expect(calls).toHaveLength(1);
    expect(calls[0].executable).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']),
    );
    expect(calls[0].options).toMatchObject({
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
    });
    expect(calls[0].input).toMatchObject({ action: 'read', nativeSource: expect.any(String) });
    const encoded = calls[0].args.at(-1)!;
    expect(encoded.length).toBeLessThan(8_000);
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).not.toContain(original.paths[0]);
  },
);

windowsTest(
  'writes file drop and cut intent as JSON without interpolating shell syntax or file paths',
  async () => {
    const paths = [
      'C:\\workspace\\中文 space #100%.txt',
      "C:\\workspace\\literal '$(); & name.txt",
    ];
    result = { paths, mode: 'move', revision: '43' };

    await expect(new WindowsFileClipboard().write(paths, 'move')).resolves.toEqual(result);

    expect(calls[0].input).toMatchObject({ action: 'write', paths, mode: 'move' });
    const script = Buffer.from(calls[0].args.at(-1)!, 'base64').toString('utf16le');
    expect(script).not.toContain(paths[1]);
  },
);

windowsTest(
  'passes the reviewed clipboard snapshot and owner to native paste without imposing a dialog timeout',
  async () => {
    const clipboard = { paths: [], mode: 'copy', revision: '44' };
    result = { cancelled: false, clipboard };

    await expect(
      new WindowsFileClipboard().paste(
        original,
        'C:\\workspace\\target',
        '0x1234',
        mutationIdentity,
      ),
    ).resolves.toEqual({ cancelled: false, clipboard });

    expect(calls[0].input).toMatchObject({
      action: 'paste',
      ...original,
      targetDirectory: 'C:\\workspace\\target',
      ownerHandle: '0x1234',
      targetIdentity: mutationIdentity,
    });
    expect(calls[0].options.timeout).toBe(0);
  },
);

windowsTest(
  'returns native cancellation and the remaining clipboard after a partially completed operation',
  async () => {
    result = { cancelled: true, clipboard: { ...original, mode: 'move' } };

    await expect(
      new WindowsFileClipboard().paste(original, 'C:\\workspace\\target', '0', mutationIdentity),
    ).resolves.toEqual(result);
  },
);

windowsTest(
  'rejects a changed clipboard without automatically retrying the operation',
  async () => {
    processError = new Error('Command failed with private paths');
    result = { error: 'clipboard-changed', hresult: -2146233079 };

    await expect(
      new WindowsFileClipboard().paste(original, 'C:\\workspace\\target', '0', mutationIdentity),
    ).rejects.toMatchObject({
      code: 'clipboard-changed',
      message: 'The system clipboard changed before paste.',
    });
    expect(execFileMock).toHaveBeenCalledOnce();
  },
);

windowsTest(
  'renames one item through JSON without reading or replacing the system clipboard',
  async () => {
    result = { renamed: true };
    const sourcePath = 'C:\\workspace\\源 file.txt';
    const newName = "renamed '$(); & name.txt";

    await expect(
      new WindowsFileClipboard().rename(sourcePath, newName, mutationIdentity),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({
      action: 'rename',
      sourcePath,
      newName,
      identity: mutationIdentity,
    });
    expect(calls[0].input).not.toHaveProperty('paths');
    expect(calls[0].input).not.toHaveProperty('revision');
    expect(calls[0].options.timeout).toBe(0);
    const script = Buffer.from(calls[0].args.at(-1)!, 'base64').toString('utf16le');
    expect(script).not.toContain(newName);
  },
);

windowsTest(
  'reports a native rename collision without retrying or exposing the command',
  async () => {
    processError = new Error('powershell.exe -EncodedCommand PRIVATE C:\\workspace\\source.txt');
    result = { error: 'already-exists', hresult: -2146233079 };

    await expect(
      new WindowsFileClipboard().rename(
        'C:\\workspace\\source.txt',
        'existing.txt',
        mutationIdentity,
      ),
    ).rejects.toMatchObject({
      code: 'already-exists',
      message: 'A file or folder with that name already exists.',
    });
    expect(execFileMock).toHaveBeenCalledOnce();
  },
);

windowsTest('recycles one reviewed item without a timeout or clipboard mutation', async () => {
  result = { recycled: true };

  await expect(
    new WindowsFileClipboard().trash('C:\\workspace\\source.txt', mutationIdentity),
  ).resolves.toBeUndefined();

  expect(calls).toHaveLength(1);
  expect(calls[0].input).toMatchObject({
    action: 'trash',
    sourcePath: 'C:\\workspace\\source.txt',
    identity: mutationIdentity,
  });
  expect(calls[0].input).not.toHaveProperty('paths');
  expect(calls[0].input).not.toHaveProperty('revision');
  expect(calls[0].options.timeout).toBe(0);
});

windowsTest('rejects a failed native recycle without invoking a deletion fallback', async () => {
  processError = new Error('private native command');
  result = { error: 'native-file-clipboard-failed' };

  await expect(
    new WindowsFileClipboard().trash('C:\\workspace\\source.txt', mutationIdentity),
  ).rejects.toMatchObject({ code: 'native-file-clipboard-failed' });
  expect(execFileMock).toHaveBeenCalledOnce();
});

windowsTest('keeps command details and file paths out of process errors', async () => {
  processError = new Error('powershell.exe -EncodedCommand SECRET C:\\private\\document.txt');
  rawOutput = 'private stderr and command data';

  await expect(new WindowsFileClipboard().read()).rejects.toThrow(
    'Windows file clipboard helper failed.',
  );
  expect(execFileMock).toHaveBeenCalledOnce();
});

windowsTest.each([
  null,
  { paths: 'C:\\workspace\\a.txt', mode: 'copy', revision: '1' },
  { paths: ['a\0b'], mode: 'copy', revision: '1' },
  { paths: [], mode: 'delete', revision: '1' },
  { paths: [], mode: 'copy', revision: 'not-a-revision' },
])('rejects malformed native snapshot data: %j', async malformed => {
  result = malformed;

  await expect(new WindowsFileClipboard().read()).rejects.toThrow(
    'Invalid native file clipboard response.',
  );
});

windowsTest(
  'does not report a completed move as failed when post-operation clipboard reading is unavailable',
  async () => {
    result = { cancelled: false, clipboard: { paths: [], mode: 'copy', revision: '' } };

    await expect(
      new WindowsFileClipboard().paste(original, 'C:\\workspace\\target', '0', mutationIdentity),
    ).resolves.toEqual(result);
  },
);

// Explicit opt-in only: the single STA process materializes every original
// clipboard format before writing test data, then restores them in finally.
test.runIf(process.platform === 'win32' && process.env.NATIVE_FILE_CLIPBOARD_SMOKE === '1')(
  'exchanges real Windows file drops and performs native file/folder copy and move while restoring the clipboard',
  async () => {
    await new WindowsFileClipboard().read();
    const nativeSource = calls[0].input!.nativeSource;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-file-clipboard-'));
    directories.push(root);
    const file = path.join(root, '季度 report #100%.txt');
    const folder = path.join(root, 'source-folder');
    const copyTarget = path.join(root, 'copy-target');
    const moveTarget = path.join(root, 'move-target');
    const linkedTarget = path.join(root, 'linked-target');
    const replacedTarget = path.join(root, 'replaced-target');
    fs.writeFileSync(file, 'native clipboard smoke');
    fs.mkdirSync(path.join(folder, 'empty'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'nested.txt'), 'nested content');
    fs.mkdirSync(copyTarget);
    fs.mkdirSync(moveTarget);
    fs.symlinkSync(copyTarget, linkedTarget, 'junction');
    fs.mkdirSync(replacedTarget);
    const copyIdentity = identityOf(copyTarget);
    const moveIdentity = identityOf(moveTarget);
    const replacedTargetIdentity = identityOf(replacedTarget);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') -TypeDefinition ([string]$payload.nativeSource)
function Get-TargetIdentity($value) {
  $identity = New-Object NativeFileIdentity
  $identity.dev = [string]$value.dev
  $identity.ino = [string]$value.ino
  return $identity
}
function Read-TestClipboard {
  [System.Windows.Forms.Application]::DoEvents()
  return [NativeFileClipboard]::Read()
}
function Assert-ConsumedOrChanged($result, $snapshot) {
  if ($result.clipboard.paths.Length -gt 0 -and $result.clipboard.revision -eq $snapshot.revision) {
    throw 'completed-move-clipboard-not-consumed'
  }
}
$copyIdentity = Get-TargetIdentity $payload.copyIdentity
$moveIdentity = Get-TargetIdentity $payload.moveIdentity
$stage = 'backup'
$existing = [System.Windows.Forms.Clipboard]::GetDataObject()
$backup = New-Object System.Windows.Forms.DataObject
$formats = @()
if ($existing) {
  $formats = @($existing.GetFormats($false))
  foreach ($format in $formats) {
    $value = $existing.GetData($format, $false)
    if ($null -eq $value) { throw 'Cannot materialize every original clipboard format; no test data written.' }
    if ($value -is [System.IO.Stream]) {
      if (-not $value.CanSeek) { throw 'Cannot preserve a non-seekable original clipboard stream.' }
      $position = $value.Position
      $value.Position = 0
      $clone = New-Object System.IO.MemoryStream
      $value.CopyTo($clone)
      $value.Position = $position
      $clone.Position = 0
      $value = $clone
    } elseif ($value -is [System.ICloneable]) {
      $value = $value.Clone()
    } elseif (-not ($value -is [string] -or $value -is [System.ValueType])) {
      throw 'Cannot safely preserve an original clipboard format; no test data written.'
    }
    $backup.SetData($format, $false, $value)
  }
}
try {
  $stage = 'multi-copy'
  $sources = [string[]]@($payload.file, $payload.folder)
  $copy = [NativeFileClipboard]::Write($sources, 'copy')
  $copy = Read-TestClipboard
  $copyResult = [NativeFileClipboard]::Paste($copy.paths, $copy.mode, $copy.revision, [string]$payload.copyTarget, '0', $copyIdentity)
  if ($copyResult.cancelled) { throw 'Native copy cancelled' }
  $stage = 'multi-move'
  $cut = [NativeFileClipboard]::Write($sources, 'move')
  $cut = Read-TestClipboard
  $moveResult = [NativeFileClipboard]::Paste($cut.paths, $cut.mode, $cut.revision, [string]$payload.moveTarget, '0', $moveIdentity)
  if ($moveResult.cancelled) { throw 'Native move did not finish' }
  Assert-ConsumedOrChanged $moveResult $cut
  $stage = 'same-directory-copy'
  $movedFile = [System.IO.Path]::Combine([string]$payload.moveTarget, [System.IO.Path]::GetFileName([string]$payload.file))
  $sameCopy = [NativeFileClipboard]::Write([string[]]@($movedFile), 'copy')
  $sameCopy = Read-TestClipboard
  $sameResult = [NativeFileClipboard]::Paste($sameCopy.paths, $sameCopy.mode, $sameCopy.revision, [string]$payload.moveTarget, '0', $moveIdentity)
  if ($sameResult.cancelled) { throw 'Same-directory copy cancelled' }
  $stage = 'same-directory-move'
  $sameCut = [NativeFileClipboard]::Write([string[]]@($movedFile), 'move')
  $sameCut = Read-TestClipboard
  $sameMove = [NativeFileClipboard]::Paste($sameCut.paths, $sameCut.mode, $sameCut.revision, [string]$payload.moveTarget, '0', $moveIdentity)
  if ($sameMove.cancelled) { throw 'same-move-cancelled' }
  if ($sameCut.mode -ne 'move') { throw 'same-move-effect-lost' }
  Assert-ConsumedOrChanged $sameMove $sameCut
  $stage = 'stale-clipboard'
  $stale = [NativeFileClipboard]::Write([string[]]@($movedFile), 'copy')
  $latest = [NativeFileClipboard]::Write([string[]]@([string]$payload.copyTarget), 'copy')
  $rejected = $false
  try { [void][NativeFileClipboard]::Paste($stale.paths, $stale.mode, $stale.revision, [string]$payload.moveTarget, '0', $moveIdentity) }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'Changed clipboard was accepted' }
  $stage = 'linked-target'
  $linked = [NativeFileClipboard]::Write([string[]]@($movedFile), 'copy')
  $linked = Read-TestClipboard
  $linkRejected = $false
  try { [void][NativeFileClipboard]::Paste($linked.paths, $linked.mode, $linked.revision, [string]$payload.linkedTarget, '0', $copyIdentity) }
  catch { $linkRejected = $true }
  if (-not $linkRejected) { throw 'A reparse point paste target was accepted' }
  $stage = 'partial-move'
  $remainingFile = [System.IO.Path]::Combine([string]$payload.moveTarget, 'remaining-after-partial.txt')
  [System.IO.File]::WriteAllText($remainingFile, 'remaining cut item')
  $missingFile = [System.IO.Path]::Combine([string]$payload.moveTarget, 'already-moved.txt')
  $partial = [NativeFileClipboard]::Write([string[]]@($missingFile, $remainingFile), 'move')
  $partial = Read-TestClipboard
  $remaining = [NativeFileClipboard]::Paste($partial.paths, $partial.mode, $partial.revision, [string]$payload.copyTarget, '0', $copyIdentity)
  if ($remaining.cancelled) { throw 'Remaining partial move did not finish' }
  Assert-ConsumedOrChanged $remaining $partial
  if ([System.IO.File]::ReadAllText([System.IO.Path]::Combine([string]$payload.copyTarget, 'remaining-after-partial.txt')) -ne 'remaining cut item') { throw 'Remaining partial item was not moved' }
  $stage = 'replaced-target'
  [System.IO.Directory]::Move([string]$payload.replacedTarget, ([string]$payload.replacedTarget + '-original'))
  [void][System.IO.Directory]::CreateDirectory([string]$payload.replacedTarget)
  $replacement = [NativeFileClipboard]::Write([string[]]@($movedFile), 'copy')
  $replacement = Read-TestClipboard
  $rejected = $false
  try { [void][NativeFileClipboard]::Paste($replacement.paths, $replacement.mode, $replacement.revision, [string]$payload.replacedTarget, '0', (Get-TargetIdentity $payload.replacedTargetIdentity)) }
  catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    $rejected = $failure.Message -eq 'workspace-item-changed'
  }
  if (-not $rejected) { throw 'A replaced target identity was accepted' }
} catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  $code = if ($failure.Message -match '^(clipboard-changed|workspace-item-changed|same-move-cancelled|same-move-effect-lost|completed-move-clipboard-not-consumed)$') { $failure.Message } else { 'smoke-failed' }
  [Console]::Out.WriteLine('native-smoke-stage=' + $stage + ';code=' + $code + ';line=' + $_.InvocationInfo.ScriptLineNumber + ';type=' + $failure.GetType().Name + ';hresult=' + $failure.HResult)
  throw
} finally {
  if ($formats.Length -gt 0) { [System.Windows.Forms.Clipboard]::SetDataObject($backup, $true, 0, 0) }
  else { [System.Windows.Forms.Clipboard]::Clear() }
}
$restored = [System.Windows.Forms.Clipboard]::GetDataObject()
$restoredFormats = if ($restored) { @($restored.GetFormats($false)) } else { @() }
ConvertTo-Json -InputObject @{ completed = $true; restoredFormats = $restoredFormats } -Compress
`;
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const output = await new Promise<string>((resolve, reject) => {
      const child = actual.execFile(
        calls[0].executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            const diagnostic = stdout.match(
              /native-smoke-stage=([a-z-]+);code=([a-z-]+);line=(\d+);type=([A-Za-z]+);hresult=(-?\d+)/,
            );
            reject(
              new Error(
                `Native clipboard smoke failed${diagnostic ? ` at ${diagnostic[1]} (${diagnostic[2]}, line ${diagnostic[3]}, ${diagnostic[4]} ${diagnostic[5]})` : ' before file operations'}; original clipboard restoration was attempted.`,
              ),
            );
          } else resolve(stdout);
        },
      );
      child.stdin!.on('error', () => {});
      child.stdin!.end(
        JSON.stringify({
          nativeSource,
          file,
          folder,
          copyTarget,
          moveTarget,
          linkedTarget,
          replacedTarget,
          copyIdentity,
          moveIdentity,
          replacedTargetIdentity,
        }),
      );
    });

    expect(JSON.parse(output)).toMatchObject({ completed: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(folder)).toBe(false);
    for (const target of [copyTarget, moveTarget]) {
      expect(fs.readFileSync(path.join(target, path.basename(file)), 'utf8')).toBe(
        'native clipboard smoke',
      );
      expect(fs.readFileSync(path.join(target, 'source-folder', 'nested.txt'), 'utf8')).toBe(
        'nested content',
      );
      expect(fs.statSync(path.join(target, 'source-folder', 'empty')).isDirectory()).toBe(true);
    }
    expect(fs.readdirSync(moveTarget).filter(name => name.endsWith('.txt'))).toHaveLength(2);
  },
  70_000,
);

test.runIf(process.platform === 'win32' && process.env.NATIVE_FILE_CLIPBOARD_SMOKE === '1')(
  'blocks top-level and deeply nested destination junctions during native copy and move while allowing ordinary merges',
  async () => {
    await new WindowsFileClipboard().read();
    const nativeSource = String(calls[0].input!.nativeSource).replace(
      'public static class NativeFileClipboard {',
      `public static class NativeFileClipboard {
  public static bool ReviewPerform(string[] paths, string target, string mode, NativeFileIdentity identity) {
    return Perform(new List<string>(paths), target, mode, IntPtr.Zero, false, identity);
  }
  public static int ReviewNewItem(string target, NativeFileIdentity identity, string parent, string name) {
    IFileClipboardShellItem item = ShellItem(parent);
    try { return new FileTransferProgressSink(target, identity).PreNewItem(0, item, name); }
    finally { Marshal.ReleaseComObject(item); }
  }`,
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-file-clipboard-'));
    directories.push(root);
    const cases = ['copy', 'move'].flatMap(mode =>
      ['top', 'nested', 'ordinary'].map(shape => {
        const fixture = path.join(root, `${mode}-${shape}`);
        const source = path.join(fixture, 'source', 'foo');
        const target = path.join(fixture, 'target');
        const outside = path.join(fixture, 'outside');
        const relativeMarker =
          shape === 'nested' ? path.join('first', 'second', 'third', 'marker.txt') : 'marker.txt';
        fs.mkdirSync(path.dirname(path.join(source, relativeMarker)), { recursive: true });
        fs.writeFileSync(path.join(source, relativeMarker), 'selected source content');
        fs.mkdirSync(target);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside must remain untouched');
        if (shape === 'top') {
          fs.symlinkSync(outside, path.join(target, 'foo'), 'junction');
        } else if (shape === 'nested') {
          fs.mkdirSync(path.join(target, 'foo', 'first', 'second'), { recursive: true });
          fs.symlinkSync(outside, path.join(target, 'foo', 'first', 'second', 'third'), 'junction');
        } else {
          fs.mkdirSync(path.join(target, 'foo'));
          fs.writeFileSync(path.join(target, 'foo', 'keep.txt'), 'existing destination content');
        }
        return {
          mode,
          shape,
          source,
          target,
          outside,
          relativeMarker,
          identity: identityOf(target),
        };
      }),
    );
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') -TypeDefinition ([string]$payload.nativeSource)
function Get-TargetIdentity($value) {
  $identity = New-Object NativeFileIdentity
  $identity.dev = [string]$value.dev
  $identity.ino = [string]$value.ino
  return $identity
}
$blocked = 0
$merged = 0
$stage = 'initial'
trap {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  [Console]::Out.WriteLine('native-link-stage=' + $stage + ';line=' + $_.InvocationInfo.ScriptLineNumber + ';type=' + $failure.GetType().Name + ';hresult=' + $failure.HResult)
  exit 1
}
foreach ($case in $payload.cases) {
  $stage = [string]$case.mode + '-' + [string]$case.shape
  $identity = Get-TargetIdentity $case.identity
  $failed = $false
  try {
    $cancelled = [NativeFileClipboard]::ReviewPerform([string[]]@([string]$case.source), [string]$case.target, [string]$case.mode, $identity)
    if ($cancelled) { throw 'Native merge cancelled' }
  } catch { $failed = $true }
  if ($case.shape -eq 'ordinary') {
    if ($failed) { throw 'An ordinary directory merge was rejected' }
    $merged++
  } else {
    if (-not $failed) { throw 'A reparse destination was accepted' }
    if ([System.IO.File]::ReadAllText([System.IO.Path]::Combine([string]$case.source, [string]$case.relativeMarker)) -ne 'selected source content') { throw 'A rejected move consumed the source' }
    if (@([System.IO.Directory]::GetFileSystemEntries([string]$case.outside)).Length -ne 1) { throw 'A rejected transfer wrote outside the target' }
    if ([System.IO.File]::ReadAllText([System.IO.Path]::Combine([string]$case.outside, 'sentinel.txt')) -ne 'outside must remain untouched') { throw 'An outside file changed' }
    if ([NativeFileClipboard]::ReviewNewItem([string]$case.target, $identity, [string]$case.outside, 'new.txt') -ge 0) { throw 'An outside new-item target was accepted' }
    $blocked++
  }
  if ([NativeFileClipboard]::ReviewNewItem([string]$case.target, $identity, [string]$case.target, 'safe-new.txt') -ne 0) { throw 'An ordinary new-item target was rejected' }
}
ConvertTo-Json -InputObject @{ completed = $true; blocked = $blocked; merged = $merged } -Compress
`;
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const output = await new Promise<string>((resolve, reject) => {
      const child = actual.execFile(
        calls[0].executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            const diagnostic = stdout.match(
              /native-link-stage=([a-z-]+);line=(\d+);type=([A-Za-z]+);hresult=(-?\d+)/,
            );
            reject(
              new Error(
                `Native destination-link refusal smoke failed${diagnostic ? ` at ${diagnostic[1]}, line ${diagnostic[2]}, ${diagnostic[3]} ${diagnostic[4]}` : ''}.`,
              ),
            );
          } else resolve(stdout);
        },
      );
      child.stdin!.on('error', () => {});
      child.stdin!.end(JSON.stringify({ nativeSource, cases }));
    });

    expect(JSON.parse(output)).toEqual({ completed: true, blocked: 4, merged: 2 });
    for (const fixture of cases) {
      expect(fs.readFileSync(path.join(fixture.outside, 'sentinel.txt'), 'utf8')).toBe(
        'outside must remain untouched',
      );
      expect(fs.readdirSync(fixture.outside)).toEqual(['sentinel.txt']);
      if (fixture.shape === 'ordinary') {
        expect(fs.readFileSync(path.join(fixture.target, 'foo', 'marker.txt'), 'utf8')).toBe(
          'selected source content',
        );
        expect(fs.readFileSync(path.join(fixture.target, 'foo', 'keep.txt'), 'utf8')).toBe(
          'existing destination content',
        );
        expect(fs.existsSync(fixture.source)).toBe(fixture.mode === 'copy');
      } else {
        expect(fs.readFileSync(path.join(fixture.source, fixture.relativeMarker), 'utf8')).toBe(
          'selected source content',
        );
      }
    }
  },
  40_000,
);

test.runIf(process.platform === 'win32' && process.env.NATIVE_FILE_CLIPBOARD_SMOKE === '1')(
  'renames real files and folders without replacement, supports case changes and rejects unsafe names and links',
  async () => {
    result = { renamed: true };
    await new WindowsFileClipboard().rename(
      'C:\\fixture\\source.txt',
      'target.txt',
      mutationIdentity,
    );
    const nativeSource = calls[0].input!.nativeSource;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-file-clipboard-'));
    directories.push(root);
    fs.writeFileSync(path.join(root, 'source.txt'), 'rename source');
    fs.writeFileSync(path.join(root, 'existing.txt'), 'keep existing');
    fs.mkdirSync(path.join(root, 'folder'));
    fs.writeFileSync(path.join(root, 'folder', 'nested.txt'), 'nested content');
    fs.symlinkSync(path.join(root, 'folder'), path.join(root, 'linked-folder'), 'junction');
    fs.writeFileSync(path.join(root, 'replace-source.txt'), 'original selected source');
    fs.mkdirSync(path.join(root, 'replace-parent'));
    fs.writeFileSync(path.join(root, 'replace-parent', 'child.txt'), 'original selected child');
    const fileIdentity = identityOf(path.join(root, 'source.txt'));
    const folderIdentity = identityOf(path.join(root, 'folder'));
    const replacedIdentity = identityOf(path.join(root, 'replace-source.txt'));
    const parentIdentity = identityOf(path.join(root, 'replace-parent', 'child.txt'));
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') -TypeDefinition ([string]$payload.nativeSource)
function Get-MutationIdentity($value) {
  $identity = New-Object NativeFileMutationIdentity
  $identity.dev = [string]$value.dev
  $identity.ino = [string]$value.ino
  $identity.parentDev = [string]$value.parentDev
  $identity.parentIno = [string]$value.parentIno
  return $identity
}
$fileIdentity = Get-MutationIdentity $payload.fileIdentity
$folderIdentity = Get-MutationIdentity $payload.folderIdentity
$source = [System.IO.Path]::Combine([string]$payload.root, 'source.txt')
$renamed = [System.IO.Path]::Combine([string]$payload.root, 'renamed 中文 #100%.txt')
$caseOnly = [System.IO.Path]::Combine([string]$payload.root, 'RENAMED 中文 #100%.txt')
[NativeFileClipboard]::Rename($source, 'renamed 中文 #100%.txt', $fileIdentity)
[NativeFileClipboard]::Rename($renamed, 'RENAMED 中文 #100%.txt', $fileIdentity)
$actualNames = @([System.IO.Directory]::GetFiles([string]$payload.root) | ForEach-Object { [System.IO.Path]::GetFileName($_) })
if (-not ($actualNames -ccontains 'RENAMED 中文 #100%.txt')) { throw 'Case-only rename did not update the name' }
$collision = $false
try { [NativeFileClipboard]::Rename($caseOnly, 'existing.txt', $fileIdentity) }
catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  $collision = $failure.Message -eq 'already-exists'
}
if (-not $collision) { throw 'Existing target was not rejected as a collision' }
foreach ($name in @('../escape', 'nested/name', 'bad:name', 'CON', 'LPT1.txt', 'COM².txt', 'trailing.', 'trailing ', '', '.', '..')) {
  $rejected = $false
  try { [NativeFileClipboard]::Rename($caseOnly, $name, $fileIdentity) } catch { $rejected = $true }
  if (-not $rejected) { throw 'An invalid name was accepted' }
}
foreach ($linkedSource in @(
  [System.IO.Path]::Combine([string]$payload.root, 'linked-folder'),
  [System.IO.Path]::Combine([string]$payload.root, 'linked-folder', 'nested.txt')
)) {
  $rejected = $false
  try { [NativeFileClipboard]::Rename($linkedSource, 'unsafe-rename', $folderIdentity) } catch { $rejected = $true }
  if (-not $rejected) { throw 'A source link or linked ancestor was accepted' }
}
[NativeFileClipboard]::Rename([System.IO.Path]::Combine([string]$payload.root, 'folder'), 'renamed-folder', $folderIdentity)
$replacedSource = [System.IO.Path]::Combine([string]$payload.root, 'replace-source.txt')
[System.IO.File]::Move($replacedSource, [System.IO.Path]::Combine([string]$payload.root, 'source-before-replacement.txt'))
[System.IO.File]::WriteAllText($replacedSource, 'replacement source')
$rejected = $false
try { [NativeFileClipboard]::Rename($replacedSource, 'wrong-source.txt', (Get-MutationIdentity $payload.replacedIdentity)) } catch { $rejected = $true }
if (-not $rejected) { throw 'Replaced source identity was accepted' }
$parent = [System.IO.Path]::Combine([string]$payload.root, 'replace-parent')
$oldParent = [System.IO.Path]::Combine([string]$payload.root, 'parent-before-replacement')
[System.IO.Directory]::Move($parent, $oldParent)
[void][System.IO.Directory]::CreateDirectory($parent)
[System.IO.File]::Move([System.IO.Path]::Combine($oldParent, 'child.txt'), [System.IO.Path]::Combine($parent, 'child.txt'))
$rejected = $false
try { [NativeFileClipboard]::Rename([System.IO.Path]::Combine($parent, 'child.txt'), 'wrong-parent.txt', (Get-MutationIdentity $payload.parentIdentity)) } catch { $rejected = $true }
if (-not $rejected) { throw 'Replaced parent identity was accepted' }
ConvertTo-Json -InputObject @{ completed = $true } -Compress
`;
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const output = await new Promise<string>((resolve, reject) => {
      const child = actual.execFile(
        calls[0].executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(new Error('Native no-replacement rename smoke failed.'));
          else resolve(stdout);
        },
      );
      child.stdin!.on('error', () => {});
      child.stdin!.end(
        JSON.stringify({
          nativeSource,
          root,
          fileIdentity,
          folderIdentity,
          replacedIdentity,
          parentIdentity,
        }),
      );
    });

    expect(JSON.parse(output)).toEqual({ completed: true });
    expect(fs.existsSync(path.join(root, 'source.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'RENAMED 中文 #100%.txt'), 'utf8')).toBe(
      'rename source',
    );
    expect(fs.readFileSync(path.join(root, 'existing.txt'), 'utf8')).toBe('keep existing');
    expect(fs.readFileSync(path.join(root, 'renamed-folder', 'nested.txt'), 'utf8')).toBe(
      'nested content',
    );
    expect(fs.readFileSync(path.join(root, 'replace-source.txt'), 'utf8')).toBe(
      'replacement source',
    );
    expect(fs.readFileSync(path.join(root, 'replace-parent', 'child.txt'), 'utf8')).toBe(
      'original selected child',
    );
  },
  40_000,
);

test.runIf(process.platform === 'win32' && process.env.NATIVE_FILE_CLIPBOARD_SMOKE === '1')(
  'recycles only selected temporary items, vetoes permanent deletion and restores its own recycle-bin entries',
  async () => {
    result = { recycled: true };
    await new WindowsFileClipboard().trash('C:\\fixture\\source.txt', mutationIdentity);
    const nativeSource = calls[0].input!.nativeSource;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-file-clipboard-'));
    directories.push(root);
    const html = path.join(root, 'selected-page.html');
    const companion = path.join(root, 'selected-page_files');
    const folder = path.join(root, 'selected-folder');
    fs.writeFileSync(html, '<html>temporary recycle smoke</html>');
    fs.mkdirSync(companion);
    fs.writeFileSync(path.join(companion, 'image.txt'), 'keep companion folder');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'nested.txt'), 'recoverable folder');
    const htmlIdentity = identityOf(html);
    const folderIdentity = identityOf(folder);
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') -TypeDefinition ([string]$payload.nativeSource)
function Get-MutationIdentity($value) {
  $identity = New-Object NativeFileMutationIdentity
  $identity.dev = [string]$value.dev
  $identity.ino = [string]$value.ino
  $identity.parentDev = [string]$value.parentDev
  $identity.parentIno = [string]$value.parentIno
  return $identity
}
$htmlIdentity = Get-MutationIdentity $payload.htmlIdentity
$folderIdentity = Get-MutationIdentity $payload.folderIdentity
$sink = New-Object RecycleOnlyProgressSink -ArgumentList @([string]$payload.html, $htmlIdentity)
if ($sink.PreDeleteItem(0, $null) -ge 0) { throw 'Permanent deletion was not vetoed' }
$sink = New-Object RecycleOnlyProgressSink -ArgumentList @([string]$payload.html, $htmlIdentity)
if ($sink.PreDeleteItem(128, $null) -ne 0) { throw 'Recyclable selected identity was rejected' }
$shell = New-Object -ComObject Shell.Application
$recycleBin = $shell.NameSpace(10)
function Get-OwnRecycleItems {
  $found = @()
  foreach ($item in $recycleBin.Items()) {
    if ([string]$item.ExtendedProperty('System.Recycle.DeletedFrom') -eq [string]$payload.root) { $found += $item }
  }
  return $found
}
$recoveredCount = 0
try {
  [NativeFileClipboard]::Trash([string]$payload.html, $htmlIdentity)
  if ([System.IO.File]::Exists([string]$payload.html)) { throw 'Selected HTML was not recycled' }
  if (-not [System.IO.Directory]::Exists([string]$payload.companion)) { throw 'An unselected HTML companion folder was recycled' }
  [NativeFileClipboard]::Trash([string]$payload.folder, $folderIdentity)
  if ([System.IO.Directory]::Exists([string]$payload.folder)) { throw 'Selected folder was not recycled' }
  $own = @(Get-OwnRecycleItems)
  $recoveredCount = $own.Length
  if ($recoveredCount -ne 2) { throw 'The selected items were not found in the system recycle bin' }
} finally {
  foreach ($item in @(Get-OwnRecycleItems)) { $item.InvokeVerb('undelete') }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((-not [System.IO.File]::Exists([string]$payload.html) -or -not [System.IO.Directory]::Exists([string]$payload.folder)) -and [DateTime]::UtcNow -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    [System.Threading.Thread]::Sleep(25)
  }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($recycleBin)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}
if (-not [System.IO.File]::Exists([string]$payload.html) -or -not [System.IO.Directory]::Exists([string]$payload.folder)) { throw 'Test recycle entries could not be restored' }
ConvertTo-Json -InputObject @{ completed = $true; recoveredCount = $recoveredCount } -Compress
`;
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    const output = await new Promise<string>((resolve, reject) => {
      const child = actual.execFile(
        calls[0].executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error)
            reject(
              new Error(
                'Native recycle-only smoke failed; restoration of its own recycle entries was attempted.',
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin!.on('error', () => {});
      child.stdin!.end(
        JSON.stringify({
          nativeSource,
          root,
          html,
          companion,
          folder,
          htmlIdentity,
          folderIdentity,
        }),
      );
    });

    expect(JSON.parse(output)).toEqual({ completed: true, recoveredCount: 2 });
    expect(fs.readFileSync(html, 'utf8')).toBe('<html>temporary recycle smoke</html>');
    expect(fs.readFileSync(path.join(companion, 'image.txt'), 'utf8')).toBe(
      'keep companion folder',
    );
    expect(fs.readFileSync(path.join(folder, 'nested.txt'), 'utf8')).toBe('recoverable folder');
  },
  40_000,
);
