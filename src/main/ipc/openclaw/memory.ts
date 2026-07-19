import { spawn } from 'child_process';
import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  type MemoryDocument,
  type MemoryDocumentCounts,
  type MemoryDocumentKind,
  type MemoryDocumentResult,
  type MemoryDocumentSummary,
  type MemoryIndexStatus,
  MemoryIpc,
  type MemoryOverview,
  type MemoryOverviewResult,
  type MemoryRebuildResult,
  type MemorySearchHit,
  type MemorySearchResult,
} from '../../../shared/openclaw/memory';
import type {
  OpenClawCliEnvironment,
  OpenClawEngineManager,
} from '../../openclaw/runtime/openclawEngineManager';

const MEMORY_AGENT_ID = 'main';
const MAX_MEMORY_DOCUMENTS = 2_000;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_CHARS = 2 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 60_000;
const REBUILD_TIMEOUT_MS = 15 * 60_000;

interface MemoryHandlerDependencies {
  getManager: () => OpenClawEngineManager;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type OpenClawConfig = {
  agents?: {
    defaults?: { workspace?: unknown };
    list?: Array<{ id?: unknown; workspace?: unknown }>;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readJsonFile = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

export const resolveMemoryWorkspace = (manager: OpenClawEngineManager): string => {
  const config = readJsonFile<OpenClawConfig>(manager.getConfigPath());
  const agent = config?.agents?.list?.find(item => item.id === MEMORY_AGENT_ID);
  const configured =
    typeof agent?.workspace === 'string'
      ? agent.workspace.trim()
      : typeof config?.agents?.defaults?.workspace === 'string'
        ? config.agents.defaults.workspace.trim()
        : '';
  return path.resolve(configured || path.join(manager.getStateDir(), 'workspace'));
};

const readFilePrefix = (filePath: string, maxBytes: number): string => {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/\0/g, '');
  } finally {
    fs.closeSync(descriptor);
  }
};

const extractHeadings = (content: string): string[] =>
  content
    .split(/\r?\n/)
    .flatMap(line => {
      const match = /^#{1,4}\s+(.+?)\s*$/.exec(line);
      return match ? [match[1].replace(/[*_`]/g, '').trim()] : [];
    })
    .filter(Boolean)
    .slice(0, 8);

const extractPreview = (content: string): string => {
  const preview = content
    .replace(/^---[\s\S]*?---\s*/m, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[`*_>[\]]/g, '')
    .replace(/\((?:https?:\/\/|localfile:)[^)]+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return preview.length > 280 ? `${preview.slice(0, 277)}…` : preview;
};

const classifyMemoryDocument = (relativePath: string): { kind: MemoryDocumentKind; date?: string } => {
  const normalized = relativePath.replace(/\\/g, '/');
  if (/^MEMORY\.md$/i.test(normalized)) return { kind: 'longTerm' };
  if (/^DREAMS\.md$/i.test(normalized)) return { kind: 'dream' };
  if (/^memory\/dreaming\//i.test(normalized)) return { kind: 'dreaming' };
  const date = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:-[^/]*)?\.md$/i.exec(normalized)?.[1];
  return { kind: 'daily', ...(date ? { date } : {}) };
};

const isTopLevelMemoryFile = (fileName: string): boolean =>
  /^MEMORY\.md$/i.test(fileName) || /^DREAMS\.md$/i.test(fileName);

const isAllowedMemoryRelativePath = (relativePath: string): boolean =>
  isTopLevelMemoryFile(relativePath) ||
  (relativePath.toLowerCase().startsWith('memory/') &&
    relativePath.toLowerCase().endsWith('.md'));

const walkMarkdownFiles = (directory: string, output: string[]): void => {
  if (output.length >= MAX_MEMORY_DOCUMENTS || !fs.existsSync(directory)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= MAX_MEMORY_DOCUMENTS) return;
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkMarkdownFiles(entryPath, output);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      output.push(entryPath);
    }
  }
};

const summarizeMemoryFile = (
  workspaceDir: string,
  filePath: string,
): MemoryDocumentSummary | null => {
  try {
    const stats = fs.statSync(filePath);
    const relativePath = path.relative(workspaceDir, filePath).replace(/\\/g, '/');
    const content = readFilePrefix(filePath, MAX_PREVIEW_BYTES);
    const headings = extractHeadings(content);
    const classification = classifyMemoryDocument(relativePath);
    return {
      id: relativePath,
      relativePath,
      fileName: path.basename(filePath),
      title: headings[0] || classification.date || path.basename(filePath, path.extname(filePath)),
      kind: classification.kind,
      ...(classification.date ? { date: classification.date } : {}),
      modifiedAt: stats.mtimeMs,
      size: stats.size,
      preview: extractPreview(content),
      headings,
    };
  } catch {
    return null;
  }
};

export const scanMemoryDocuments = (workspaceDir: string): MemoryDocumentSummary[] => {
  const filePaths: string[] = [];
  for (const fileName of ['MEMORY.md', 'DREAMS.md', 'dreams.md']) {
    const filePath = path.join(workspaceDir, fileName);
    try {
      if (fs.statSync(filePath).isFile() && !fs.lstatSync(filePath).isSymbolicLink()) {
        filePaths.push(filePath);
      }
    } catch {
      // The optional top-level memory file does not exist or changed during the scan.
    }
  }
  walkMarkdownFiles(path.join(workspaceDir, 'memory'), filePaths);

  const uniqueFilePaths = Array.from(
    new Map(
      filePaths.map(filePath => {
        const resolvedPath = path.resolve(filePath);
        return [process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath, filePath];
      }),
    ).values(),
  );

  return uniqueFilePaths
    .slice(0, MAX_MEMORY_DOCUMENTS)
    .flatMap(filePath => {
      const summary = summarizeMemoryFile(workspaceDir, filePath);
      return summary ? [summary] : [];
    })
    .sort((left, right) => {
      if (left.kind === 'longTerm' && right.kind !== 'longTerm') return -1;
      if (right.kind === 'longTerm' && left.kind !== 'longTerm') return 1;
      return right.modifiedAt - left.modifiedAt;
    });
};

const countDocuments = (documents: MemoryDocumentSummary[]): MemoryDocumentCounts => ({
  total: documents.length,
  longTerm: documents.filter(document => document.kind === 'longTerm').length,
  daily: documents.filter(document => document.kind === 'daily').length,
  dream: documents.filter(document => document.kind === 'dream').length,
  dreaming: documents.filter(document => document.kind === 'dreaming').length,
});

const terminateProcess = (child: ReturnType<typeof spawn>): void => {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGKILL');
  }
};

const removeEngineBrand = (value: string): string =>
  value.replace(/openclaw/gi, 'memory service');

const toPublicMemoryError = (error: unknown, fallback: string): string =>
  removeEngineBrand(error instanceof Error ? error.message : fallback);

const runOpenClawCommand = (
  cli: OpenClawCliEnvironment,
  args: string[],
  timeoutMs: number,
  cwd: string,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const executable = cli.env.JUSTDO_ELECTRON_PATH || process.execPath;
    const child = spawn(executable, [cli.openclawEntry, ...args], {
      cwd,
      env: { ...cli.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout?.on('data', chunk => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
    });
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => finish({ exitCode: code ?? 1, stdout, stderr, timedOut: false }));
    const timeout = setTimeout(() => {
      terminateProcess(child);
      finish({ exitCode: 124, stdout, stderr, timedOut: true });
    }, timeoutMs);
  });

const sanitizeCommandError = (result: CommandResult): string => {
  if (result.timedOut) return 'Memory service command timed out';
  const output = (result.stderr || result.stdout)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***:***@')
    .trim();
  return (
    removeEngineBrand(output.slice(-1_500)) ||
    `Memory service command exited with code ${result.exitCode}`
  );
};

const readNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

export const normalizeMemoryIndexStatus = (value: unknown): MemoryIndexStatus => {
  const root = Array.isArray(value) ? value[0] : value;
  const item = isRecord(root) && isRecord(root.status) ? root.status : root;
  if (!isRecord(item)) {
    return {
      available: false,
      chunks: 0,
      dirty: false,
      error: 'Memory index status is unavailable',
    };
  }
  return {
    available: true,
    chunks: readNumber(item.chunks),
    dirty: item.dirty === true,
  };
};

const loadIndexStatus = async (
  manager: OpenClawEngineManager,
  workspaceDir: string,
): Promise<MemoryIndexStatus> => {
  try {
    const cli = await manager.buildCliEnvironment();
    const result = await runOpenClawCommand(
      cli,
      ['memory', 'status', '--agent', MEMORY_AGENT_ID, '--json'],
      STATUS_TIMEOUT_MS,
      workspaceDir,
    );
    if (result.exitCode !== 0) throw new Error(sanitizeCommandError(result));
    return normalizeMemoryIndexStatus(JSON.parse(result.stdout));
  } catch (error) {
    return {
      available: false,
      chunks: 0,
      dirty: false,
      error: toPublicMemoryError(error, 'Failed to load memory index status'),
    };
  }
};

const buildOverview = async (manager: OpenClawEngineManager): Promise<MemoryOverview> => {
  const workspaceDir = resolveMemoryWorkspace(manager);
  const documents = scanMemoryDocuments(workspaceDir);
  const index = await loadIndexStatus(manager, workspaceDir);
  return {
    documents,
    counts: countDocuments(documents),
    index,
    loadedAt: Date.now(),
  };
};

const resolveDocumentPath = (
  workspaceDir: string,
  relativePath: string,
): { filePath: string; relativePath: string } | null => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized) || normalized.includes('\0')) return null;
  if (!isAllowedMemoryRelativePath(normalized)) return null;
  const workspaceRoot = path.resolve(workspaceDir);
  const filePath = path.resolve(workspaceRoot, normalized);
  if (filePath !== workspaceRoot && !filePath.startsWith(`${workspaceRoot}${path.sep}`)) return null;
  try {
    if (!fs.statSync(filePath).isFile() || fs.lstatSync(filePath).isSymbolicLink()) return null;
    const realWorkspace = fs.realpathSync(workspaceRoot);
    const realFile = fs.realpathSync(filePath);
    if (!realFile.startsWith(`${realWorkspace}${path.sep}`)) return null;
  } catch {
    return null;
  }
  return { filePath, relativePath: normalized };
};

export const normalizeSearchHits = (value: unknown, workspaceDir: string): MemorySearchHit[] => {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.slice(0, 20).flatMap(result => {
    if (!isRecord(result) || typeof result.path !== 'string' || typeof result.snippet !== 'string') {
      return [];
    }
    const workspaceRoot = path.resolve(workspaceDir);
    const absolutePath = path.isAbsolute(result.path)
      ? path.resolve(result.path)
      : path.resolve(workspaceRoot, result.path);
    const displayPath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
    if (!isAllowedMemoryRelativePath(displayPath)) return [];
    return [
      {
        path: displayPath,
        startLine: readNumber(result.startLine),
        endLine: readNumber(result.endLine),
        score: typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : 0,
        snippet: result.snippet.slice(0, 8_000),
      },
    ];
  });
};

export const registerOpenClawMemoryHandlers = ({
  getManager,
}: MemoryHandlerDependencies): void => {
  let rebuildPromise: Promise<MemoryRebuildResult> | null = null;

  ipcMain.handle(MemoryIpc.GetOverview, async (): Promise<MemoryOverviewResult> => {
    try {
      return { success: true, overview: await buildOverview(getManager()) };
    } catch (error) {
      return {
        success: false,
        error: toPublicMemoryError(error, 'Failed to load memory overview'),
      };
    }
  });

  ipcMain.handle(
    MemoryIpc.GetDocument,
    async (_event, relativePath: string): Promise<MemoryDocumentResult> => {
      try {
        const workspaceDir = resolveMemoryWorkspace(getManager());
        const resolved = resolveDocumentPath(workspaceDir, relativePath);
        if (!resolved) return { success: false, error: 'Memory document was not found' };
        const stats = fs.statSync(resolved.filePath);
        if (stats.size > MAX_DOCUMENT_BYTES) {
          return { success: false, error: 'Memory document is too large to preview' };
        }
        const summary = summarizeMemoryFile(workspaceDir, resolved.filePath);
        if (!summary) return { success: false, error: 'Memory document was not found' };
        const document: MemoryDocument = {
          ...summary,
          content: fs.readFileSync(resolved.filePath, 'utf8').replace(/\0/g, ''),
        };
        return { success: true, document };
      } catch (error) {
        return {
          success: false,
          error: toPublicMemoryError(error, 'Failed to read memory document'),
        };
      }
    },
  );

  ipcMain.handle(MemoryIpc.Search, async (_event, query: string): Promise<MemorySearchResult> => {
    const normalizedQuery = typeof query === 'string' ? query.trim().slice(0, 500) : '';
    if (!normalizedQuery) return { success: true, hits: [] };
    try {
      const manager = getManager();
      const workspaceDir = resolveMemoryWorkspace(manager);
      const cli = await manager.buildCliEnvironment();
      const result = await runOpenClawCommand(
        cli,
        [
          'memory',
          'search',
          '--query',
          normalizedQuery,
          '--agent',
          MEMORY_AGENT_ID,
          '--max-results',
          '20',
          '--json',
        ],
        SEARCH_TIMEOUT_MS,
        workspaceDir,
      );
      if (result.exitCode !== 0) return { success: false, error: sanitizeCommandError(result) };
      return { success: true, hits: normalizeSearchHits(JSON.parse(result.stdout), workspaceDir) };
    } catch (error) {
      return {
        success: false,
        error: toPublicMemoryError(error, 'Failed to search memory'),
      };
    }
  });

  ipcMain.handle(MemoryIpc.RebuildIndex, async (): Promise<MemoryRebuildResult> => {
    if (rebuildPromise) return rebuildPromise;
    rebuildPromise = (async () => {
      const startedAt = Date.now();
      try {
        const manager = getManager();
        const workspaceDir = resolveMemoryWorkspace(manager);
        const cli = await manager.buildCliEnvironment();
        const result = await runOpenClawCommand(
          cli,
          ['memory', 'index', '--force', '--agent', MEMORY_AGENT_ID],
          REBUILD_TIMEOUT_MS,
          workspaceDir,
        );
        if (result.exitCode !== 0) {
          return { success: false, durationMs: Date.now() - startedAt, error: sanitizeCommandError(result) };
        }
        return {
          success: true,
          durationMs: Date.now() - startedAt,
          index: await loadIndexStatus(manager, workspaceDir),
        };
      } catch (error) {
        return {
          success: false,
          durationMs: Date.now() - startedAt,
          error: toPublicMemoryError(error, 'Failed to rebuild memory index'),
        };
      } finally {
        rebuildPromise = null;
      }
    })();
    return rebuildPromise;
  });
};
