export const MemoryIpc = {
  GetOverview: 'openclaw:memory:getOverview',
  GetIndexStatus: 'openclaw:memory:getIndexStatus',
  GetDocument: 'openclaw:memory:getDocument',
  Search: 'openclaw:memory:search',
  RebuildIndex: 'openclaw:memory:rebuildIndex',
} as const;

export type MemoryDocumentKind = 'profile' | 'longTerm' | 'daily' | 'dream' | 'dreaming';

export const MemoryIndexHealth = {
  Ready: 'ready',
  Indexed: 'indexed',
  KeywordOnly: 'keyword-only',
  Stale: 'stale',
  Disabled: 'disabled',
  Unavailable: 'unavailable',
  Unknown: 'unknown',
} as const;

export type MemoryIndexHealth = (typeof MemoryIndexHealth)[keyof typeof MemoryIndexHealth];

export interface MemoryDocumentSummary {
  id: string;
  relativePath: string;
  fileName: string;
  title: string;
  kind: MemoryDocumentKind;
  date?: string;
  modifiedAt: number;
  size: number;
  preview: string;
  headings: string[];
}

export interface MemoryDocument extends MemoryDocumentSummary {
  filePath: string;
  content: string;
}

export interface MemoryDocumentCounts {
  total: number;
  profile: number;
  longTerm: number;
  daily: number;
  dream: number;
  dreaming: number;
}

export interface MemoryIndexStatus {
  health?: MemoryIndexHealth;
  warning?: string;
  available: boolean;
  chunks: number;
  dirty: boolean;
  loading?: boolean;
  error?: string;
}

export interface MemoryOverview {
  documents: MemoryDocumentSummary[];
  counts: MemoryDocumentCounts;
  index: MemoryIndexStatus;
  loadedAt: number;
}

export interface MemorySearchHit {
  source?: 'memory' | 'sessions';
  previewable?: boolean;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface MemoryOverviewResult {
  success: boolean;
  overview?: MemoryOverview;
  error?: string;
}

export interface MemoryIndexStatusResult {
  success: boolean;
  index?: MemoryIndexStatus;
  error?: string;
}

export interface MemoryDocumentResult {
  success: boolean;
  document?: MemoryDocument;
  error?: string;
}

export interface MemorySearchResult {
  searchMode?: 'hybrid' | 'fts-only';
  stale?: boolean;
  warning?: string;
  action?: string;
  success: boolean;
  hits?: MemorySearchHit[];
  error?: string;
}

export interface MemoryRebuildResult {
  warning?: string;
  success: boolean;
  index?: MemoryIndexStatus;
  durationMs?: number;
  error?: string;
}
