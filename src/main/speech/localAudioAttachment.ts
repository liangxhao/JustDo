import { type BigIntStats, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isLocalAudioAttachment } from '../../shared/speech/localAsr';

const MAX_AUDIO_ATTACHMENT_SIZE = 256n * 1024n * 1024n;

type StagedAudioAttachment = { path: string; draftPath?: string };

type StagedCopy = {
  attachment: StagedAudioAttachment;
  directoryIdentity: string;
  fileRevision: string;
};

const audioStages = new Map<string, StagedCopy | Promise<StagedCopy>>();

const fileIdentity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const fileRevision = (stat: BigIntStats): string =>
  `${fileIdentity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

async function readStagingDirectoryIdentity(directory: string): Promise<string | null> {
  try {
    const [realDirectory, stat] = await Promise.all([
      fs.realpath(directory), fs.lstat(directory, { bigint: true }),
    ]);
    return realDirectory === directory && stat.isDirectory() ? fileIdentity(stat) : null;
  } catch {
    return null;
  }
}

async function isCurrentCopy(copy: StagedCopy): Promise<boolean> {
  const file = copy.attachment.path;
  try {
    const [directoryIdentity, fileStat] = await Promise.all([
      readStagingDirectoryIdentity(path.dirname(file)), fs.lstat(file, { bigint: true }),
    ]);
    return directoryIdentity === copy.directoryIdentity && fileStat.isFile() && fileRevision(fileStat) === copy.fileRevision;
  } catch {
    return false;
  }
}

async function createStagedCopy(
  root: string,
  input: string,
  name: string,
  sourceStat: BigIntStats,
  draftPath?: string,
): Promise<StagedCopy> {
  // A new random direct child avoids writing through a pre-existing workspace link.
  const directory = await fs.mkdtemp(path.join(root, '.justdo-audio-'));
  const directoryIdentity = await readStagingDirectoryIdentity(directory);
  if (!directoryIdentity) throw new Error('Audio staging path changed.');
  const target = path.join(directory, name);
  let targetRevision: string;
  try {
    await fs.copyFile(input, target, constants.COPYFILE_EXCL);
    const [inputAfter, targetStat] = await Promise.all([
      fs.stat(input, { bigint: true }), fs.lstat(target, { bigint: true }),
    ]);
    if (fileRevision(inputAfter) !== fileRevision(sourceStat) || targetStat.size !== sourceStat.size) {
      throw new Error('Audio changed while it was being copied.');
    }
    if (!targetStat.isFile()) throw new Error('Audio staging path changed.');
    targetRevision = fileRevision(targetStat);
  } catch (error) {
    if (await readStagingDirectoryIdentity(directory) === directoryIdentity) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
  if (await readStagingDirectoryIdentity(directory) !== directoryIdentity) throw new Error('Audio staging path changed.');
  return {
    attachment: { path: target, ...(draftPath ? { draftPath } : {}) },
    directoryIdentity,
    fileRevision: targetRevision,
  };
}

export async function stageAudioAttachment(source: string, workspace: string): Promise<StagedAudioAttachment> {
  if (!path.isAbsolute(source) || !path.isAbsolute(workspace) || !isLocalAudioAttachment(source)) {
    throw new Error('A local audio file and an absolute workspace path are required.');
  }
  const [root, input] = await Promise.all([fs.realpath(workspace), fs.realpath(source)]);
  const stat = await fs.stat(input, { bigint: true });
  if (!stat.isFile() || stat.size === 0n || stat.size > MAX_AUDIO_ATTACHMENT_SIZE) {
    throw new Error('Audio must be a non-empty file no larger than 256 MiB.');
  }
  const relative = path.relative(root, input);
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return { path: input };

  const name = path.basename(source);
  const scope = JSON.stringify([root, input, name, fileRevision(stat)]);
  const previous = audioStages.get(scope);
  if (previous instanceof Promise) return (await previous).attachment;

  const pending = (async () => {
    if (previous && await isCurrentCopy(previous)) return previous;
    const draftPath = previous?.attachment.draftPath ?? previous?.attachment.path;
    return createStagedCopy(root, input, name, stat, draftPath);
  })();
  audioStages.set(scope, pending);
  try {
    const copy = await pending;
    audioStages.set(scope, copy);
    return copy.attachment;
  } catch (error) {
    if (previous) audioStages.set(scope, previous);
    else audioStages.delete(scope);
    throw error;
  }
}
