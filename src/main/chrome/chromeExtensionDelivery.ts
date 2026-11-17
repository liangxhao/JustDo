import { lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocalAssistantDeliverableSource } from '../../shared/openclaw/assistantDeliverables';
import { isWorkspaceFileName } from '../../shared/preview/workspaceFiles';
import type { ManagedAssistantDelivery } from '../openclaw/media/readManagedAssistantDelivery';

const OPENABLE_TYPES: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['.pdf'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/json': ['.json'],
  'application/yaml': ['.yaml', '.yml'],
  'text/plain': ['.txt', '.log'],
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv'],
  'text/markdown': ['.md', '.markdown'],
  'application/zip': ['.zip'],
  'application/x-7z-compressed': ['.7z'],
  'application/x-tar': ['.tar'],
  'application/gzip': ['.gz'],
  'image/png': ['.png', '.apng'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/avif': ['.avif'],
  'image/bmp': ['.bmp'],
  'image/tiff': ['.tif', '.tiff'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.ogg', '.oga'],
  'audio/mp4': ['.m4a'],
  'audio/flac': ['.flac'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
};
const OPENABLE_SUFFIXES = new Set(Object.values(OPENABLE_TYPES).flat());
export const CHROME_MANAGED_DELIVERY_MIME_TYPES = Object.keys(OPENABLE_TYPES);
const DELIVERY_DIRECTORY_PREFIX = 'delivery-';
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;

export const isChromeOpenableFilePath = (filePath: string): boolean =>
  OPENABLE_SUFFIXES.has(path.extname(filePath).toLowerCase());

export const isChromeOpenableFileMode = (mode: number): boolean =>
  process.platform === 'win32' || (mode & 0o111) === 0;

function deliveryPathParts(value: string): string[] {
  return value.slice(path.parse(value).root.length).split(/[\\/]/u).filter(Boolean);
}

function isLocalAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) &&
    !/^[\\/]{2}/u.test(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/iu.test(value));
}

function workspaceRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' ||
      relative.startsWith('..' + path.sep)) {
    throw new Error('Delivery is outside the conversation workspace.');
  }
  return relative;
}

/** Resolve only a named, passive regular file inside the conversation workspace. */
export async function resolveChromeLocalDelivery(source: string, cwd: string): Promise<{
  filePath: string;
  assertCurrent: () => void;
}> {
  if (!isLocalAssistantDeliverableSource(source) || !isLocalAbsolutePath(cwd)) {
    throw new Error('Delivery is not a local workspace file.');
  }
  let candidate = source;
  if (/^(?:file|localfile):/iu.test(source)) {
    const url = new URL(source.replace(/^localfile:/iu, 'file:'));
    if (url.hostname || url.search || url.hash) throw new Error('Invalid local delivery URL.');
    candidate = fileURLToPath(url);
  }
  if (/^[\\/]{2}/u.test(candidate) || /^[\\/]/u.test(candidate) && !isLocalAbsolutePath(candidate) ||
      process.platform !== 'win32' && candidate.includes('\\') ||
      !deliveryPathParts(candidate).every(part => part === '.' || isWorkspaceFileName(part)) ||
      !isChromeOpenableFilePath(candidate)) {
    throw new Error('Unsupported local delivery path.');
  }

  const workspace = path.resolve(cwd);
  const relative = workspaceRelativePath(workspace, path.resolve(workspace, candidate));
  const root = await realpath(workspace);
  if (!isLocalAbsolutePath(root)) throw new Error('Delivery workspace is not local.');
  // Walk the workspace-relative components without traversing a user-supplied
  // symlink or junction before proving the target is inside the workspace.
  let target = root;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error('Delivery workspace is unavailable.');
  const checked = [{ path: root, info: rootInfo }];
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    const info = await lstat(target);
    const regularFile = info.isFile() && isChromeOpenableFileMode(info.mode);
    if (index === parts.length - 1 ? !regularFile : !info.isDirectory()) {
      throw new Error('Delivery is not a regular workspace file.');
    }
    checked.push({ path: target, info });
  }
  const canonical = await realpath(target);
  workspaceRelativePath(root, canonical);
  if (!isLocalAbsolutePath(canonical) || path.relative(target, canonical)) {
    throw new Error('Delivery path changed during validation.');
  }
  return {
    filePath: canonical,
    // Check the same directory chain and leaf immediately before invoking the OS.
    assertCurrent: () => {
      if (path.relative(root, realpathSync.native(workspace))) {
        throw new Error('Delivery workspace changed while opening.');
      }
      for (const entry of checked) {
        const current = lstatSync(entry.path);
        const before = entry.info;
        if (current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode ||
            current.isSymbolicLink()) {
          throw new Error('Delivery path changed while opening.');
        }
      }
    },
  };
}

function filenameForManagedDelivery(
  delivery: ManagedAssistantDelivery,
  declaredName: string,
): string {
  const suffixes = OPENABLE_TYPES[delivery.mimeType];
  if (!suffixes) throw new Error('Unsupported delivery type.');
  const name = delivery.filename ?? declaredName;
  return isWorkspaceFileName(name) && suffixes.includes(path.extname(name).toLowerCase())
    ? name
    : 'attachment' + suffixes[0];
}

async function discardDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

async function pruneOpenedDeliveries(root: string): Promise<void> {
  const cutoff = Date.now() - DELIVERY_RETENTION_MS;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^delivery-[a-z0-9]{6}$/iu.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const info = await lstat(directory).catch((): undefined => undefined);
    if (info?.isDirectory() && info.mtimeMs < cutoff) await discardDirectory(directory);
  }
}

/** Keep an opened copy long enough for the default app to read it. */
export async function openStagedChromeDelivery(
  root: string,
  delivery: ManagedAssistantDelivery,
  declaredName: string,
  openPath: (filePath: string) => Promise<void>,
): Promise<void> {
  const filename = filenameForManagedDelivery(delivery, declaredName);
  if (!isLocalAbsolutePath(root)) throw new Error('Delivery staging is not local.');
  const parent = await realpath(path.dirname(root));
  if (!isLocalAbsolutePath(parent)) throw new Error('Delivery staging is not local.');
  const staging = path.join(parent, path.basename(root));
  await mkdir(staging, { recursive: true, mode: 0o700 });
  if (!(await lstat(staging)).isDirectory()) throw new Error('Delivery staging is not a directory.');
  await pruneOpenedDeliveries(staging);
  const directory = await mkdtemp(path.join(staging, DELIVERY_DIRECTORY_PREFIX));
  try {
    const target = path.join(directory, filename);
    await writeFile(target, delivery.bytes, { flag: 'wx', mode: 0o600 });
    delivery.assertCurrent();
    await openPath(target);
  } catch (error) {
    await discardDirectory(directory);
    throw error;
  }
  setTimeout(() => void discardDirectory(directory), DELIVERY_RETENTION_MS).unref();
}
