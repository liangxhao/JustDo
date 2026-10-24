import type { ExternalSessionMetadata } from '../integrations/externalSession';
import type { CoworkSessionSource } from './sessionSource';

export const SESSION_SUMMARY_BATCH_LIMIT = 200;
export const SESSION_LIST_PAGE_SIZE = 20;

export const SessionDirectoryIpc = {
  List: 'cowork:session:directory',
  ReadSummaries: 'cowork:session:summaries',
  SearchSummaries: 'cowork:session:searchSummaries',
} as const;

/** Complete product navigation metadata; titles and native history are loaded separately. */
export interface SessionDirectoryEntry {
  id: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  agentId?: string;
  groupId?: string | null;
  source?: CoworkSessionSource;
  external?: ExternalSessionMetadata;
  nativeSessionKey?: string;
  createdAt: number;
  updatedAt: number;
}
