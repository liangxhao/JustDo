import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import {
  BATCH_LIMITS,
  RESULT_TRANSPORT_BYTES,
  resultTransportCost,
  type BatchManifest,
  type FrozenFile,
  type FrozenInput,
} from './batch-contract.js';
import type { Flow, FlowNode, FlowSubmission } from './contract.js';
import type { ItemResultManifest } from './batch-contract.js';
import { inside, assertFilesystemAdmission } from './filesystem-admission.js';
import { swarmSettings } from './settings.js';

type Root = Awaited<ReturnType<typeof import('openclaw/plugin-sdk/file-access-runtime').root>>;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function* boundedLines(handle: FileHandle, guard: () => void): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  const chunk = Buffer.allocUnsafe(4096);
  let position = 0;
  while (true) {
    const result = await handle.read(chunk, 0, chunk.length, position);
    guard();
    if (!result.bytesRead) break;
    position += result.bytesRead;
    pending = Buffer.concat([pending, chunk.subarray(0, result.bytesRead)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > BATCH_LIMITS.envelopeBytes / 2)
        throw new Error('JSONL row exceeds the input envelope.');
      yield pending.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > BATCH_LIMITS.envelopeBytes / 2)
      throw new Error('JSONL row exceeds the input envelope.');
  }
  if (pending.length) yield pending.toString('utf8');
}
async function hashFile(
  scope: Root,
  relative: string,
  budget: number,
  guard: () => void,
): Promise<{ bytes: number; sha256: string }> {
  guard();
  const opened = await scope.open(relative, { symlinks: 'reject', hardlinks: 'reject' });
  try {
    guard();
    if (opened.stat.size > budget) throw new Error('Batch snapshot disk budget exceeded.');
    const hash = createHash('sha256');
    let bytes = 0;
    const chunk = Buffer.allocUnsafe(256 * 1024);
    while (true) {
      const read = await opened.handle.read(chunk, 0, chunk.length, bytes);
      guard();
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > budget) throw new Error('Batch snapshot disk budget exceeded.');
      hash.update(chunk.subarray(0, read.bytesRead));
    }
    const after = await opened.handle.stat();
    guard();
    if (
      after.size !== opened.stat.size ||
      after.mtimeMs !== opened.stat.mtimeMs ||
      bytes !== after.size
    )
      throw new Error('Batch input changed while being frozen.');
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await opened.handle.close();
  }
}
const sourceRelative = (scopeRoot: string, requested: string): string => {
  if (requested.includes('\0') || /^\\\\/.test(requested))
    throw new Error('Invalid batch source path.');
  const absolute = path.resolve(scopeRoot, requested);
  if (!inside(scopeRoot, absolute)) throw new Error('Batch source is outside the parent project.');
  const relative = path.relative(scopeRoot, absolute);
  if (ownedPath(relative)) throw new Error('Batch source cannot use workflow-owned output.');
  return relative;
};
const ownedPath = (relative: string): boolean =>
  relative
    .split(path.sep)
    .some(
      segment =>
        (process.platform === 'win32' ? segment.toLowerCase() : segment) === '.justdo-tasks',
    );

/** Freeze before expanding the queue. Every host operation is fenced by the
 * trusted admission; Root protects aliases and identities but grants no rights. */
export async function freezeBatch(
  flow: Flow,
  stage: FlowNode,
  guard: () => void,
): Promise<{ manifest: BatchManifest; manifestPath: string }> {
  if (!stage.batch || !flow.filesystemAdmission)
    throw new Error(
      'Batch requires a native filesystem admission. Restart it from the parent conversation.',
    );
  const outerGuard = guard;
  guard = () => {
    outerGuard();
    assertFilesystemAdmission(flow.filesystemAdmission!);
  };
  guard();
  const { root } = await import('openclaw/plugin-sdk/file-access-runtime');
  guard();
  const scope = await root(flow.filesystemAdmission.root, {
    symlinks: 'reject',
    hardlinks: 'reject',
    assertBeforeMutation: guard,
  });
  guard();
  if (path.relative(flow.filesystemAdmission.root, scope.rootReal) !== '')
    throw new Error('Project root changed.');
  const settings = flow.settings ?? swarmSettings({});
  // Reserve enough room for the frozen original and every permitted attempt's
  // input copies. This is a cooperative disk budget, not a shell filesystem quota.
  let remaining = Math.floor(
    (settings.snapshotBudgetMiB * 1024 * 1024) / (settings.maxAttempts + 1),
  );
  const originalBudget = remaining;
  const stageRoot = path.join('.justdo-tasks', 'swarm', flow.id, stage.id);
  // Failed freezes are retained: mkdir has no creation receipt that authorizes
  // deleting a directory another actor may have replaced. Charge retained
  // snapshots to the same budget so retries cannot accumulate unlimited copies.
  if (await scope.exists(stageRoot)) {
    for await (const entry of scope.walk(stageRoot, {
      order: 'sorted',
      maxDepth: 32,
      maxEntries: 100000,
      limitBehavior: 'throw',
      symlinkPolicy: 'include',
      entryFilter: entry =>
        path.relative(stageRoot, entry.relativePath).split(path.sep)[0].startsWith('snapshot-')
          ? 'include'
          : 'skip-subtree',
    })) {
      guard();
      if (entry.kind === 'symlink')
        throw new Error('Retained snapshot contains an unsafe alias. Inspect it before retrying.');
      if (entry.kind !== 'file') continue;
      const opened = await scope.open(entry.relativePath, {
        symlinks: 'reject',
        hardlinks: 'reject',
      });
      try {
        remaining -= opened.stat.size;
      } finally {
        await opened.handle.close();
      }
      if (remaining <= 0)
        throw new Error(
          'Retained snapshots exhausted this stage disk budget. Inspect them before retrying.',
        );
    }
  }
  guard();
  const freeBytes = async () => {
    const volume = await statfs(scope.rootReal);
    guard();
    return volume.bavail * volume.bsize;
  };
  if ((await freeBytes()) < remaining * (settings.maxAttempts + 1))
    throw new Error('Insufficient free disk space for the snapshot and permitted attempts.');
  const relativeRoot = path.join(
    '.justdo-tasks',
    'swarm',
    flow.id,
    stage.id,
    'snapshot-' + randomUUID(),
  );
  await scope.mkdir(relativeRoot, { recursive: true });
  try {
    guard();
    const source = stage.batch.source;
    const relativeSource = sourceRelative(scope.rootReal, source.path);
    const copy = async (
      relative: string,
      ordinal: number,
      index: number,
      seenPaths = new Set<string>(),
    ): Promise<FrozenFile> => {
      const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
      if (seenPaths.has(key)) throw new Error('Duplicate batch file reference.');
      seenPaths.add(key);
      const before = await hashFile(scope, relative, remaining, guard);
      const target = path.join(
        relativeRoot,
        'inputs',
        String(ordinal),
        'file-' +
          index +
          path
            .extname(relative)
            .replace(/[^a-zA-Z0-9.]/g, '')
            .slice(0, 20),
      );
      await scope.copyIn(
        target,
        { root: scope, relativePath: relative },
        { mkdir: true, maxBytes: remaining, symlinks: 'reject', hardlinks: 'reject' },
      );
      guard();
      const frozen = await hashFile(scope, target, remaining, guard);
      const after = await hashFile(scope, relative, remaining, guard);
      if (before.sha256 !== frozen.sha256 || before.sha256 !== after.sha256)
        throw new Error('Batch input changed while being frozen.');
      remaining -= frozen.bytes;
      return {
        source: path.join(scope.rootReal, relative),
        relativePath: path.relative(scope.rootReal, path.join(scope.rootReal, target)),
        path: path.join(scope.rootReal, target),
        ...frozen,
      };
    };
    const inputs: FrozenInput[] = [];
    const keys = new Set<string>();
    const add = (
      key: string,
      title: string,
      files: FrozenFile[],
      data?: Record<string, unknown>,
    ) => {
      if (!key.trim() || key.length > 200 || keys.has(key) || !title.trim() || title.length > 200)
        throw new Error('Invalid or duplicate batch input identity.');
      if (inputs.length >= settings.maxBatchItems) throw new Error('Batch item limit exceeded.');
      if (data && Buffer.byteLength(JSON.stringify(data)) > BATCH_LIMITS.envelopeBytes / 2)
        throw new Error('Batch item data exceeds the input envelope.');
      keys.add(key);
      inputs.push({
        id: randomUUID(),
        ordinal: inputs.length,
        key,
        title,
        files,
        ...(data ? { data } : {}),
      });
    };
    if (source.kind === 'files') {
      const stat = await scope.stat(relativeSource);
      guard();
      const matches: string[] = [];
      if (stat.isFile && !stat.isSymbolicLink) matches.push(relativeSource);
      else if (stat.isDirectory && !stat.isSymbolicLink) {
        for await (const file of scope.walk(relativeSource, {
          symlinkPolicy: 'include',
          order: 'sorted',
          maxDepth: 32,
          maxEntries: 10000,
          limitBehavior: 'throw',
          entryFilter: entry => (ownedPath(entry.relativePath) ? 'skip-subtree' : 'include'),
        })) {
          guard();
          if (file.kind === 'symlink')
            throw new Error('Batch input must not contain symbolic links.');
          if (file.kind !== 'file') continue;
          const patternPath = path
            .relative(relativeSource, file.relativePath)
            .split(path.sep)
            .join('/');
          if (source.pattern && !path.matchesGlob(patternPath, source.pattern)) continue;
          matches.push(file.relativePath);
          if (matches.length > settings.maxBatchItems)
            throw new Error('Batch item limit exceeded.');
        }
      } else throw new Error('Batch source must be a regular file or directory.');
      matches.sort();
      for (const relative of matches)
        add(
          path.relative(relativeSource, relative) || path.basename(relative),
          path.basename(relative),
          [await copy(relative, inputs.length, 0)],
        );
    } else {
      const sourceCopy = await copy(relativeSource, 0, 0);
      // Parse only the frozen copy. References on each row are frozen separately.
      const opened = await scope.open(sourceCopy.relativePath, {
        symlinks: 'reject',
        hardlinks: 'reject',
      });
      try {
        guard();
        for await (const line of boundedLines(opened.handle, guard)) {
          guard();
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > BATCH_LIMITS.envelopeBytes / 2)
            throw new Error('JSONL row exceeds the input envelope.');
          const value = JSON.parse(line) as Record<string, unknown>;
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof value.id !== 'string' ||
            (value.title !== undefined && typeof value.title !== 'string') ||
            (value.data !== undefined &&
              (!value.data || typeof value.data !== 'object' || Array.isArray(value.data))) ||
            (value.files !== undefined &&
              (!Array.isArray(value.files) ||
                value.files.length > 16 ||
                value.files.some(file => typeof file !== 'string'))) ||
            Object.keys(value).some(key => !['id', 'title', 'data', 'files'].includes(key))
          )
            throw new Error('Invalid JSONL batch input.');
          const files: FrozenFile[] = [];
          const seenPaths = new Set<string>();
          for (const file of (value.files ?? []) as string[])
            files.push(
              await copy(
                sourceRelative(scope.rootReal, file),
                inputs.length,
                files.length + 1,
                seenPaths,
              ),
            );
          add(
            value.id,
            (value.title as string) ?? value.id,
            files,
            value.data as Record<string, unknown> | undefined,
          );
        }
      } finally {
        await opened.handle.close();
      }
      const unchanged = await hashFile(scope, relativeSource, originalBudget, guard);
      if (unchanged.sha256 !== sourceCopy.sha256)
        throw new Error('JSONL source changed while being frozen.');
    }
    if (!inputs.length) throw new Error('Batch source contains no matching inputs.');
    let projectRules = '';
    if (await scope.exists('AGENTS.md'))
      projectRules = await scope.readText('AGENTS.md', {
        maxBytes: 65536,
        symlinks: 'reject',
        hardlinks: 'reject',
      });
    guard();
    const manifest: BatchManifest = {
      version: '',
      createdAt: Date.now(),
      root: scope.rootReal,
      bytes: originalBudget - remaining,
      projectRules,
      rulesOrigin: path.join(scope.rootReal, 'AGENTS.md'),
      rulesVersion: digest(projectRules),
      inputs,
    };
    manifest.version = digest(JSON.stringify(manifest));
    const manifestPath = path.join(relativeRoot, 'manifest.json');
    const text = JSON.stringify(manifest);
    if (Buffer.byteLength(text) > remaining)
      throw new Error('Batch manifest exceeds the snapshot disk budget.');
    if (
      (await freeBytes()) <
      (originalBudget - remaining) * settings.maxAttempts + Buffer.byteLength(text)
    )
      throw new Error('Insufficient free disk space for the remaining attempt inputs.');
    await scope.create(manifestPath, text, { mkdir: true, maxBytes: remaining });
    guard();
    return { manifest, manifestPath: path.join(scope.rootReal, manifestPath) };
  } catch (error) {
    throw new Error(String(error) + ' Snapshot retained for inspection at ' + relativeRoot + '.');
  }
}

export const itemWorkspace = (flow: Flow, node: FlowNode): string =>
  path.join(
    flow.cwd,
    '.justdo-tasks',
    'swarm',
    flow.id,
    node.batchItem!.stageId,
    node.id,
    'attempt-' + (node.attempt ?? 1),
  );

export async function readBatchManifest(
  flow: Flow,
  stage: FlowNode,
  guard: () => void,
): Promise<BatchManifest> {
  if (!stage.batchInput || !flow.filesystemAdmission)
    throw new Error('Frozen batch input is unavailable.');
  const outerGuard = guard;
  guard = () => {
    outerGuard();
    assertFilesystemAdmission(flow.filesystemAdmission!);
  };
  guard();
  const { root } = await import('openclaw/plugin-sdk/file-access-runtime');
  guard();
  const scope = await root(flow.filesystemAdmission.root, {
    symlinks: 'reject',
    hardlinks: 'reject',
    assertBeforeMutation: guard,
  });
  guard();
  if (path.relative(flow.filesystemAdmission.root, scope.rootReal) !== '')
    throw new Error('Project root changed.');
  if (!inside(scope.rootReal, stage.batchInput.manifestPath))
    throw new Error('Invalid batch manifest path.');
  const manifest = (await scope.readJson(
    path.relative(scope.rootReal, stage.batchInput.manifestPath),
    { maxBytes: 32 * 1024 * 1024, symlinks: 'reject', hardlinks: 'reject' },
  )) as BatchManifest;
  guard();
  if (
    manifest.version !== stage.batchInput.version ||
    manifest.root !== scope.rootReal ||
    !Array.isArray(manifest.inputs) ||
    digest(JSON.stringify({ ...manifest, version: '' })) !== manifest.version
  )
    throw new Error(
      'Frozen batch manifest changed. Re-admit the batch instead of retrying different data.',
    );
  const rules = (await scope.exists('AGENTS.md'))
    ? await scope.readText('AGENTS.md', {
        maxBytes: 65536,
        symlinks: 'reject',
        hardlinks: 'reject',
      })
    : '';
  guard();
  if (
    manifest.rulesOrigin !== path.join(scope.rootReal, 'AGENTS.md') ||
    manifest.rulesVersion !== digest(rules)
  )
    throw new Error(
      'Project AGENTS.md changed. Start a newly admitted flow with the current rules.',
    );
  return manifest;
}

export async function prepareItemWorkspace(
  flow: Flow,
  node: FlowNode,
  guard: () => void,
): Promise<void> {
  if (!node.batchItem || !flow.filesystemAdmission)
    throw new Error('Invalid batch item admission.');
  const outerGuard = guard;
  guard = () => {
    outerGuard();
    assertFilesystemAdmission(flow.filesystemAdmission!);
  };
  const stage = flow.nodes.find(candidate => candidate.id === node.batchItem!.stageId)!;
  const manifest = await readBatchManifest(flow, stage, guard);
  const input = manifest.inputs.find(
    item =>
      item.id === node.id &&
      item.ordinal === node.batchItem!.ordinal &&
      item.key === node.batchItem!.key,
  );
  if (
    !input ||
    node.batchItem.manifestVersion !== manifest.version ||
    node.batchItem.workspace !== itemWorkspace(flow, node)
  )
    throw new Error('Batch item does not match its frozen input.');
  const { root } = await import('openclaw/plugin-sdk/file-access-runtime');
  guard();
  const scope = await root(flow.filesystemAdmission.root, {
    symlinks: 'reject',
    hardlinks: 'reject',
    assertBeforeMutation: guard,
  });
  guard();
  if (path.relative(flow.filesystemAdmission.root, scope.rootReal) !== '')
    throw new Error('Project root changed.');
  const directory = path.relative(scope.rootReal, node.batchItem.workspace);
  await scope.mkdir(path.join(directory, 'output'), { recursive: true });
  guard();
  const files: Array<{ path: string; sourceName: string; bytes: number; sha256: string }> = [];
  for (const [index, file] of input.files.entries()) {
    if (
      !inside(scope.rootReal, file.path) ||
      path.relative(scope.rootReal, file.path) !== file.relativePath
    )
      throw new Error('Invalid frozen input path.');
    const existing = await hashFile(scope, file.relativePath, file.bytes, guard);
    if (existing.sha256 !== file.sha256) throw new Error('Frozen input file changed.');
    const target = path.join(directory, 'input', 'file-' + index + path.extname(file.path));
    if (!(await scope.exists(target)))
      await scope.copyIn(
        target,
        { root: scope, relativePath: file.relativePath },
        { maxBytes: file.bytes, mkdir: true },
      );
    guard();
    const copied = await hashFile(scope, target, file.bytes, guard);
    if (copied.sha256 !== file.sha256)
      throw new Error('Attempt input does not match the frozen input.');
    files.push({
      path: path.relative(directory, target),
      sourceName: path.basename(file.source),
      ...copied,
    });
  }
  const envelope = { id: input.key, manifestVersion: manifest.version, data: input.data, files };
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > BATCH_LIMITS.envelopeBytes)
    throw new Error('Batch item input exceeds the execution envelope.');
  const inputPath = path.join(directory, 'input.json');
  if (await scope.exists(inputPath)) {
    if ((await scope.readText(inputPath, { maxBytes: BATCH_LIMITS.envelopeBytes })) !== text)
      throw new Error('Attempt input envelope changed.');
  } else await scope.create(inputPath, text, { maxBytes: BATCH_LIMITS.envelopeBytes });
  guard();
}

export async function candidateItemResult(
  flow: Flow,
  node: FlowNode,
  submission: FlowSubmission,
  guard: () => void,
): Promise<ItemResultManifest> {
  if (
    !node.batchItem ||
    !flow.filesystemAdmission ||
    submission.outcome !== 'complete' ||
    submission.summary.length > BATCH_LIMITS.summary ||
    !submission.evidence.length
  )
    throw new Error('A batch result requires a completion summary of at most 512 characters.');
  const outerGuard = guard;
  guard = () => {
    outerGuard();
    assertFilesystemAdmission(flow.filesystemAdmission!);
  };
  await verifyAttemptInput(flow, node, guard);
  const { root } = await import('openclaw/plugin-sdk/file-access-runtime');
  guard();
  const scope = await root(node.batchItem.workspace, {
    symlinks: 'reject',
    hardlinks: 'reject',
    assertBeforeMutation: guard,
  });
  guard();
  if (
    path.relative(node.batchItem.workspace, scope.rootReal) !== '' ||
    !inside(flow.filesystemAdmission.root, scope.rootReal)
  )
    throw new Error('Batch output workspace identity changed.');
  const artifacts: ItemResultManifest['artifacts'] = [];
  const seen = new Set<string>();
  for (const evidence of submission.evidence) {
    const absolute = path.resolve(scope.rootReal, evidence);
    const relative = path.relative(scope.rootReal, absolute);
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (
      !inside(path.join(scope.rootReal, 'output'), absolute) ||
      absolute === path.join(scope.rootReal, 'output') ||
      seen.has(key)
    )
      throw new Error(
        'Batch evidence must contain unique regular files inside this attempt output directory.',
      );
    seen.add(key);
    const artifact = await hashFile(scope, relative, 1024 * 1024 * 1024, guard);
    artifacts.push({ path: absolute, ...artifact });
  }
  const result = {
    flowId: flow.id,
    stageId: node.batchItem.stageId,
    itemId: node.id,
    manifestVersion: node.batchItem.manifestVersion,
    attempt: node.attempt ?? 1,
    runId: node.runId ?? node.intendedRunId!,
    inputKey: node.batchItem.key,
    summary: submission.summary,
    artifacts,
  };
  const entry = { id: node.id, title: node.title, result };
  if (
    Buffer.byteLength(JSON.stringify(entry)) > BATCH_LIMITS.resultPageBytes - 1024 ||
    resultTransportCost({ items: [entry] }) > RESULT_TRANSPORT_BYTES - 1024
  )
    throw new Error(
      'Result index entry exceeds its page budget. Use shorter artifact paths, fewer artifacts, or a compact output manifest file.',
    );
  return result;
}

/** Inspection only: never repair or recreate a damaged attempt's inputs. */
export async function verifyAttemptInput(
  flow: Flow,
  node: FlowNode,
  guard: () => void,
): Promise<void> {
  if (!node.batchItem || !flow.filesystemAdmission)
    throw new Error('Invalid batch input identity.');
  const stage = flow.nodes.find(candidate => candidate.id === node.batchItem!.stageId)!;
  const manifest = await readBatchManifest(flow, stage, guard);
  const input = manifest.inputs.find(
    item =>
      item.id === node.id &&
      item.ordinal === node.batchItem!.ordinal &&
      item.key === node.batchItem!.key,
  );
  if (
    !input ||
    node.batchItem.manifestVersion !== manifest.version ||
    node.batchItem.workspace !== itemWorkspace(flow, node)
  )
    throw new Error('Batch attempt input identity changed.');
  const { root } = await import('openclaw/plugin-sdk/file-access-runtime');
  guard();
  const scope = await root(flow.filesystemAdmission.root, {
    symlinks: 'reject',
    hardlinks: 'reject',
  });
  guard();
  if (path.relative(flow.filesystemAdmission.root, scope.rootReal) !== '')
    throw new Error('Project root changed.');
  const directory = path.relative(scope.rootReal, node.batchItem.workspace);
  const files: Array<{ path: string; sourceName: string; bytes: number; sha256: string }> = [];
  for (const [index, file] of input.files.entries()) {
    const target = path.join(directory, 'input', 'file-' + index + path.extname(file.path));
    const copied = await hashFile(scope, target, file.bytes, guard);
    if (copied.sha256 !== file.sha256 || copied.bytes !== file.bytes)
      throw new Error('Batch attempt input file changed.');
    files.push({
      path: path.relative(directory, target),
      sourceName: path.basename(file.source),
      ...copied,
    });
  }
  const expected = JSON.stringify({
    id: input.key,
    manifestVersion: manifest.version,
    data: input.data,
    files,
  });
  const actual = await scope.readText(path.join(directory, 'input.json'), {
    maxBytes: BATCH_LIMITS.envelopeBytes,
    symlinks: 'reject',
    hardlinks: 'reject',
  });
  guard();
  if (actual !== expected) throw new Error('Batch attempt input envelope changed.');
}

export async function verifyItemResult(
  flow: Flow,
  node: FlowNode,
  guard: () => void,
): Promise<void> {
  const candidate = node.artifacts;
  if (
    !candidate ||
    candidate.flowId !== flow.id ||
    candidate.itemId !== node.id ||
    candidate.stageId !== node.batchItem?.stageId ||
    candidate.manifestVersion !== node.batchItem.manifestVersion ||
    candidate.attempt !== (node.attempt ?? 1) ||
    candidate.runId !== (node.runId ?? node.intendedRunId)
  )
    throw new Error('Batch result belongs to another attempt or run.');
  const current = await candidateItemResult(
    flow,
    node,
    {
      outcome: 'complete',
      summary: candidate.summary,
      evidence: candidate.artifacts.map(artifact => artifact.path),
    },
    guard,
  );
  if (JSON.stringify(current) !== JSON.stringify(candidate))
    throw new Error('Batch output changed after submission.');
}
