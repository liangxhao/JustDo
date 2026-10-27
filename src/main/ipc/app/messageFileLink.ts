import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  isPrepareMessageFileLinkRequest,
  MessageFileLinkPreparationError,
  MessageFileLinkSourceKind,
  type PrepareMessageFileLinkRequest,
  type PrepareMessageFileLinkResult,
} from '../../../shared/preview/messageFileLink';
import { isWorkspaceFileName } from '../../../shared/preview/workspaceFiles';

interface MessageFileLinkPreparationOptions {
  resolveWorkspaceRoot?: (sessionId: string) => string | null | undefined;
  isCurrent?: () => boolean;
}

interface SourceDirectory {
  requestedRoot: string;
  canonicalRoot: string;
  stats: fs.Stats;
}

const isHtmlPath = (filePath: string): boolean => /\.(?:html?|xhtml)$/iu.test(filePath);

const isNativeAbsolutePath = (value: string): boolean =>
  process.platform === 'win32'
    ? /^[A-Za-z]:[\\/]/u.test(value)
    : value.startsWith('/') && !value.startsWith('//');

const isSafeNativePath = (value: string): boolean => {
  if (!value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) return false;
  const normalized = value.replace(/\\/gu, '/');
  if (
    normalized.startsWith('//') ||
    /^\/(?:\?\??|\.)\//u.test(normalized) ||
    (/^[A-Za-z]:/u.test(value) &&
      (process.platform !== 'win32' || !/^[A-Za-z]:[\\/]/u.test(value))) ||
    (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[A-Za-z]:[\\/]/u.test(value))
  )
    return false;
  if (process.platform !== 'win32') return true;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  const parts = normalized.replace(/^[A-Za-z]:\//u, '').split('/');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.every(part => part === '.' || part === '..' || isWorkspaceFileName(part));
};

const nativeTarget = (request: PrepareMessageFileLinkRequest): string | null => {
  if (request.sourceKind === MessageFileLinkSourceKind.NativePath) {
    if (!isSafeNativePath(request.target)) return null;
    // The relative native form is solely the existing HTML message contract.
    return isNativeAbsolutePath(request.target) || isHtmlPath(request.target)
      ? request.target
      : null;
  }
  try {
    if (request.sourceKind === MessageFileLinkSourceKind.FileUrl) {
      if (!/^file:\/\/\//iu.test(request.target) || /\s|\\/u.test(request.target)) return null;
      const url = new URL(request.target);
      if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return null;
      const filePath = fileURLToPath(url);
      return isSafeNativePath(filePath) && isNativeAbsolutePath(filePath) ? filePath : null;
    }
    if (
      !/^(?:[A-Za-z]:\/|\.\.?\/)/u.test(request.target) ||
      /[\\?#]|%(?:2f|5c)/iu.test(request.target)
    )
      return null;
    const decoded = decodeURIComponent(request.target);
    if (
      decoded.includes('\\') ||
      !isSafeNativePath(decoded) ||
      !/\.[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(decoded)
    )
      return null;
    return decoded;
  } catch {
    return null;
  }
};

const normalizeRoot = (value: string): string => {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const sourceMatches = (
  request: PrepareMessageFileLinkRequest,
  source: SourceDirectory,
  resolveWorkspaceRoot: MessageFileLinkPreparationOptions['resolveWorkspaceRoot'],
): boolean => {
  try {
    const currentRoot = resolveWorkspaceRoot?.(request.workspaceSessionId!);
    return (
      typeof currentRoot === 'string' &&
      isSafeNativePath(currentRoot) &&
      isNativeAbsolutePath(currentRoot) &&
      normalizeRoot(currentRoot) === normalizeRoot(source.requestedRoot)
    );
  } catch {
    // The authoritative owner can become unavailable while metadata is read.
    return false;
  }
};

const failure = (error: MessageFileLinkPreparationError): PrepareMessageFileLinkResult => ({
  success: false,
  error,
});

/** Prepares identity only; every consuming reader retains its own access checks. */
export async function prepareMessageFileLink(
  input: unknown,
  { resolveWorkspaceRoot, isCurrent = () => true }: MessageFileLinkPreparationOptions = {},
): Promise<PrepareMessageFileLinkResult> {
  if (!isCurrent()) return failure(MessageFileLinkPreparationError.Unavailable);
  if (!isPrepareMessageFileLinkRequest(input))
    return failure(MessageFileLinkPreparationError.InvalidTarget);
  const target = nativeTarget(input);
  if (target === null || (input.navigationSuffix && !isHtmlPath(target)))
    return failure(MessageFileLinkPreparationError.InvalidTarget);
  let source: SourceDirectory | undefined;
  try {
    if (!isNativeAbsolutePath(target)) {
      if (!input.workspaceSessionId || !input.expectedProjectRoot)
        return failure(MessageFileLinkPreparationError.MissingSource);
      const root = resolveWorkspaceRoot?.(input.workspaceSessionId);
      if (!root || !isSafeNativePath(root) || !isNativeAbsolutePath(root))
        return failure(MessageFileLinkPreparationError.MissingSource);
      if (
        !isSafeNativePath(input.expectedProjectRoot) ||
        !isNativeAbsolutePath(input.expectedProjectRoot) ||
        normalizeRoot(root) !== normalizeRoot(input.expectedProjectRoot)
      )
        return failure(MessageFileLinkPreparationError.SourceChanged);
      const canonicalRoot = await fs.promises.realpath(root);
      const stats = await fs.promises.stat(canonicalRoot);
      if (!stats.isDirectory()) return failure(MessageFileLinkPreparationError.MissingSource);
      source = { requestedRoot: root, canonicalRoot, stats };
    }
    const requestedPath = source
      ? path.resolve(source.requestedRoot, target)
      : path.normalize(target);
    const requestedStats = await fs.promises.lstat(requestedPath);
    if (requestedStats.isSymbolicLink() || !requestedStats.isFile())
      return failure(MessageFileLinkPreparationError.NotRegularFile);
    const filePath = await fs.promises.realpath(requestedPath);
    if (!isSafeNativePath(filePath) || !isNativeAbsolutePath(filePath))
      return failure(MessageFileLinkPreparationError.InvalidTarget);
    const canonicalStats = await fs.promises.lstat(filePath);
    if (
      canonicalStats.isSymbolicLink() ||
      !canonicalStats.isFile() ||
      canonicalStats.dev !== requestedStats.dev ||
      canonicalStats.ino !== requestedStats.ino
    )
      return failure(MessageFileLinkPreparationError.NotRegularFile);
    if (!isCurrent()) return failure(MessageFileLinkPreparationError.Unavailable);
    if (source) {
      if (!sourceMatches(input, source, resolveWorkspaceRoot))
        return failure(MessageFileLinkPreparationError.SourceChanged);
      const [root, stats] = await Promise.all([
        fs.promises.realpath(source.requestedRoot),
        fs.promises.stat(source.canonicalRoot),
      ]);
      if (
        root !== source.canonicalRoot ||
        !stats.isDirectory() ||
        stats.dev !== source.stats.dev ||
        stats.ino !== source.stats.ino ||
        !sourceMatches(input, source, resolveWorkspaceRoot)
      )
        return failure(MessageFileLinkPreparationError.SourceChanged);
    }
    if (!isCurrent()) return failure(MessageFileLinkPreparationError.Unavailable);
    return {
      success: true,
      filePath,
      ...(input.navigationSuffix ? { navigationSuffix: input.navigationSuffix } : {}),
    };
  } catch (error) {
    if (!isCurrent()) return failure(MessageFileLinkPreparationError.Unavailable);
    if (source && !sourceMatches(input, source, resolveWorkspaceRoot))
      return failure(MessageFileLinkPreparationError.SourceChanged);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return failure(
      code === 'ENOENT' || code === 'ENOTDIR'
        ? MessageFileLinkPreparationError.NotFound
        : MessageFileLinkPreparationError.Failed,
    );
  }
}
