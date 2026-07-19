export const MemoryIpc = {
  GetOverview: 'openclaw:memory:getOverview',
  GetDocument: 'openclaw:memory:getDocument',
  Search: 'openclaw:memory:search',
  RebuildIndex: 'openclaw:memory:rebuildIndex',
} as const;

export type MemoryDocumentKind = 'longTerm' | 'daily' | 'dream' | 'dreaming';

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
  content: string;
}

export interface MemoryDocumentCounts {
  total: number;
  longTerm: number;
  daily: number;
  dream: number;
  dreaming: number;
}

export interface MemoryIndexStatus {
  available: boolean;
  chunks: number;
  dirty: boolean;
  error?: string;
}

export interface MemoryOverview {
  documents: MemoryDocumentSummary[];
  counts: MemoryDocumentCounts;
  index: MemoryIndexStatus;
  loadedAt: number;
}

export interface MemorySearchHit {
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

export interface MemoryDocumentResult {
  success: boolean;
  document?: MemoryDocument;
  error?: string;
}

export interface MemorySearchResult {
  success: boolean;
  hits?: MemorySearchHit[];
  error?: string;
}

export interface MemoryRebuildResult {
  success: boolean;
  index?: MemoryIndexStatus;
  durationMs?: number;
  error?: string;
}
