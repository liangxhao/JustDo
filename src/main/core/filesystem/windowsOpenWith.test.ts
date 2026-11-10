import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));

import { showWindowsOpenWithDialog } from './windowsOpenWith';

const end = vi.fn();
let complete: (error: Error | null, stdout: string) => void;

beforeEach(() => {
  execFileMock.mockReset();
  end.mockReset();
  execFileMock.mockImplementation((_executable, _args, _options, callback) => {
    complete = callback;
    return { stdin: { on: vi.fn(), end } };
  });
});

afterEach(() => vi.restoreAllMocks());

test('passes literal Unicode paths and the owner separately to a hidden STA chooser and waits for its result', async () => {
  const filePath = "C:\\workspace\\中文 space '$()`; #100%.docx";
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x123456789n);
  const finished = vi.fn();

  const result = showWindowsOpenWithDialog(filePath, handle).then(finished);
  await Promise.resolve();

  expect(finished).not.toHaveBeenCalled();
  const [executable, args, options] = execFileMock.mock.calls[0];
  expect(executable).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  expect(args).toEqual(
    expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']),
  );
  expect(options).toMatchObject({ windowsHide: true, timeout: 0, maxBuffer: 64 * 1024 });
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  expect(script).toContain('$info.CreateNoWindow = $true');
  expect(script).toContain('[System.Diagnostics.ProcessWindowStyle]::Normal');
  expect(script).not.toContain(filePath);
  const payload = JSON.parse(end.mock.calls[0][0]);
  expect(payload).toMatchObject({
    filePath,
    ownerHandle: '4886718345',
  });
  const nativeScript = Buffer.from(payload.chooserCommand, 'base64').toString('utf16le');
  expect(nativeScript).toContain('SHOpenWithDialog');
  expect(nativeScript).not.toContain(filePath);

  complete(null, '{"hresult":0}');
  await result;
  expect(finished).toHaveBeenCalledOnce();
});

test('treats native cancellation as a normal closed dialog', async () => {
  const result = showWindowsOpenWithDialog('C:\\report.docx');
  complete(null, '{"hresult":-2147023673}');
  await expect(result).resolves.toBeUndefined();
  expect(JSON.parse(end.mock.calls[0][0]).ownerHandle).toBe('0');
});

test('reports a native failure instead of treating a launched helper as success', async () => {
  const result = showWindowsOpenWithDialog('C:\\report.docx');
  complete(null, '{"hresult":-2147467259}');
  await expect(result).rejects.toThrow('HRESULT 0x80004005');
});

test('reports helper startup or exit failure even with a success-shaped response', async () => {
  const result = showWindowsOpenWithDialog('C:\\report.docx');
  complete(new Error('Could not start'), '{"hresult":0}');
  await expect(result).rejects.toThrow('could not run');
});

test.each(['', '{"hresult":"0"}'])(
  'rejects incomplete or malformed helper evidence: %s',
  async stdout => {
    const result = showWindowsOpenWithDialog('C:\\report.docx');
    complete(null, stdout);
    await expect(result).rejects.toThrow('invalid response');
  },
);
