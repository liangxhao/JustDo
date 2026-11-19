import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { stageAudioAttachment } from './localAudioAttachment';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-stage-'));
  roots.push(root);
  const workspace = path.join(root, '项目 space');
  await fs.mkdir(workspace);
  const source = path.join(root, '录音.mp3');
  await fs.writeFile(source, 'audio');
  return { root, source, workspace };
}

it('copies external audio into the workspace and reuses files already inside it', async () => {
  const { root, source, workspace } = await fixture();
  const { path: staged } = await stageAudioAttachment(source, workspace);
  expect(path.relative(workspace, staged).startsWith('..')).toBe(false);
  expect(await fs.readFile(staged, 'utf8')).toBe('audio');
  expect(await stageAudioAttachment(staged, workspace)).toEqual({ path: staged });
  expect(await fs.readFile(source, 'utf8')).toBe('audio');
  await expect(stageAudioAttachment(path.join(root, 'list.m3u8'), workspace)).rejects.toThrow();
});

it('coalesces concurrent copies and reuses the exact stage for an unchanged source', async () => {
  const { source, workspace } = await fixture();

  const [first, concurrent] = await Promise.all([
    stageAudioAttachment(source, workspace),
    stageAudioAttachment(source, workspace),
  ]);

  expect(concurrent).toEqual(first);
  expect(await stageAudioAttachment(source, workspace)).toEqual(first);
  expect(await fs.readdir(workspace)).toHaveLength(1);
});

it('stages a new source version independently while keeping the earlier audio readable', async () => {
  const { source, workspace } = await fixture();
  const first = await stageAudioAttachment(source, workspace);
  await fs.writeFile(source, 'other');
  const changedTime = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(source, changedTime, changedTime);

  const revised = await stageAudioAttachment(source, workspace);

  expect(revised.path).not.toBe(first.path);
  expect(revised.draftPath).toBeUndefined();
  expect(await fs.readFile(revised.path, 'utf8')).toBe('other');
  expect(await fs.readFile(first.path, 'utf8')).toBe('audio');
});

it('retains the new stage when an older concurrent source observation finishes late', async () => {
  const { source, workspace } = await fixture();
  const readStat = fs.stat.bind(fs);
  let observed!: () => void;
  let continueStage!: () => void;
  const oldVersionObserved = new Promise<void>(resolve => { observed = resolve; });
  const continueOldStage = new Promise<void>(resolve => { continueStage = resolve; });
  vi.spyOn(fs, 'stat').mockImplementationOnce(async (...args) => {
    const oldStat = await readStat(...args);
    observed();
    await continueOldStage;
    return oldStat;
  });
  const oldStage = stageAudioAttachment(source, workspace);
  await oldVersionObserved;
  await fs.writeFile(source, 'a newer audio version');
  const current = await stageAudioAttachment(source, workspace);

  continueStage();
  await expect(oldStage).rejects.toThrow('Audio changed while it was being copied.');
  expect(await stageAudioAttachment(source, workspace)).toEqual(current);
});

it('restages modified or missing copies while retaining the first draft path', async () => {
  const { source, workspace } = await fixture();
  const first = await stageAudioAttachment(source, workspace);
  await fs.writeFile(first.path, 'tampered');

  const repaired = await stageAudioAttachment(source, workspace);
  expect(repaired.path).not.toBe(first.path);
  expect(repaired.draftPath).toBe(first.path);
  expect(await fs.readFile(repaired.path, 'utf8')).toBe('audio');
  expect(await fs.readFile(first.path, 'utf8')).toBe('tampered');

  await fs.unlink(repaired.path);
  const restaged = await stageAudioAttachment(source, workspace);
  expect(restaged.path).not.toBe(repaired.path);
  expect(restaged.draftPath).toBe(first.path);
  expect(await stageAudioAttachment(source, workspace)).toEqual(restaged);
});

it('uses a fresh workspace copy if the prior staging directory is redirected', async () => {
  const { root, source, workspace } = await fixture();
  const first = await stageAudioAttachment(source, workspace);
  const directory = path.dirname(first.path);
  const elsewhere = path.join(root, 'moved stage');
  await fs.rename(directory, elsewhere);
  await fs.symlink(elsewhere, directory, process.platform === 'win32' ? 'junction' : 'dir');

  const repaired = await stageAudioAttachment(source, workspace);

  expect(repaired.path).not.toBe(first.path);
  expect(repaired.draftPath).toBe(first.path);
  expect(await fs.readFile(repaired.path, 'utf8')).toBe('audio');
  expect(await fs.readFile(path.join(elsewhere, path.basename(first.path)), 'utf8')).toBe('audio');
});

it.each([false, true])('leaves a swapped staging directory untouched (copy failure=%s)', async copyFails => {
  const { root, source, workspace } = await fixture();
  const copy = fs.copyFile.bind(fs);
  const moved = path.join(root, 'moved copy');
  let replacementFile = '';
  vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (input, target, mode) => {
    await copy(input, target, mode);
    const directory = path.dirname(String(target));
    await fs.rename(directory, moved);
    await fs.mkdir(directory);
    replacementFile = String(target);
    await fs.writeFile(replacementFile, 'audio');
    if (copyFails) throw new Error('Simulated copy failure.');
  });

  await expect(stageAudioAttachment(source, workspace)).rejects.toThrow(
    copyFails ? 'Simulated copy failure.' : 'Audio staging path changed.',
  );
  expect(await fs.readFile(replacementFile, 'utf8')).toBe('audio');
  expect(await fs.readFile(path.join(moved, path.basename(source)), 'utf8')).toBe('audio');
});
