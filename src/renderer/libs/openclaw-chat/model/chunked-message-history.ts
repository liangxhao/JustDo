import { readHistoryProjectionIdentity, readTranscriptIdentity } from './transcript-identity';

function identityKey(message: unknown): string | null {
  return readHistoryProjectionIdentity(message);
}

function sourceIdentityKey(message: unknown): string | null {
  const identity = readTranscriptIdentity(message);
  return identity ? `${identity.kind}:${identity.value}` : null;
}

function incrementIdentity(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function consumeIdentity(counts: Map<string, number>, key: string): boolean {
  const remaining = counts.get(key) ?? 0;
  if (remaining <= 0) return false;
  if (remaining === 1) counts.delete(key);
  else counts.set(key, remaining - 1);
  return true;
}

/**
 * Keeps older history pages as immutable chunks. The newest chunk is the
 * reconciliation snapshot and may be replaced as live messages settle.
 */
export class ChunkedMessageHistory {
  private olderChunks: unknown[][] = [];
  private olderMessageCount = 0;
  private recentChunk: unknown[] = [];
  private olderIdentities = new Map<string, number>();
  private olderSourceIdentities = new Map<string, number>();
  private recentIdentities = new Map<string, number>();
  private flattenedCache: unknown[] | null = [];

  get length(): number {
    return this.olderMessageCount + this.recentChunk.length;
  }

  get recentMessages(): unknown[] {
    return this.recentChunk;
  }

  get chunkCount(): number {
    return this.olderChunks.length + (this.recentChunk.length > 0 ? 1 : 0);
  }

  reset(messages: unknown[] = []): void {
    this.olderChunks = [];
    this.olderMessageCount = 0;
    this.olderIdentities.clear();
    this.olderSourceIdentities.clear();
    this.recentChunk = messages;
    this.rebuildRecentIdentities();
    this.flattenedCache = messages;
  }

  replaceRecent(messages: unknown[]): void {
    const nextRecentIdentities = new Map<string, number>();
    const nextRecentSourceIdentities = new Map<string, number>();
    for (const message of messages) {
      const key = identityKey(message);
      if (key) incrementIdentity(nextRecentIdentities, key);
      const sourceKey = sourceIdentityKey(message);
      if (sourceKey) incrementIdentity(nextRecentSourceIdentities, sourceKey);
    }

    const overlapsOlderChunk =
      this.olderChunks.length > 0 &&
      [...nextRecentSourceIdentities.keys()].some(key => this.olderSourceIdentities.has(key));
    if (overlapsOlderChunk) {
      // A refreshed tail may change a projection's bytes while retaining its
      // native source identity. Consume occurrences one-for-one so sibling
      // Thinking/Tool/Content projections survive, but stale seam copies are
      // replaced by the authoritative recent snapshot.
      const duplicatesRemaining = new Map(nextRecentSourceIdentities);
      this.olderChunks = this.olderChunks
        .map(chunk => {
          const keep = new Array<boolean>(chunk.length).fill(true);
          for (let index = chunk.length - 1; index >= 0; index -= 1) {
            const message = chunk[index];
            const key = sourceIdentityKey(message);
            if (key && consumeIdentity(duplicatesRemaining, key)) keep[index] = false;
          }
          return chunk.filter((_, index) => keep[index]);
        })
        .filter(chunk => chunk.length > 0);
      this.rebuildOlderIdentities();
    }

    this.recentChunk = messages;
    this.recentIdentities = nextRecentIdentities;
    this.flattenedCache = this.olderChunks.length === 0 ? messages : null;
  }

  prepend(messages: unknown[]): number {
    const duplicatesRemaining = new Map(this.olderIdentities);
    for (const [key, count] of this.recentIdentities) {
      duplicatesRemaining.set(key, (duplicatesRemaining.get(key) ?? 0) + count);
    }
    const unique = messages.filter(message => {
      const key = identityKey(message);
      if (!key) return true;
      return !consumeIdentity(duplicatesRemaining, key);
    });
    if (unique.length === 0) return 0;

    this.olderChunks.unshift(unique);
    this.olderMessageCount += unique.length;
    for (const message of unique) {
      const key = identityKey(message);
      if (key) incrementIdentity(this.olderIdentities, key);
      const sourceKey = sourceIdentityKey(message);
      if (sourceKey) incrementIdentity(this.olderSourceIdentities, sourceKey);
    }
    this.flattenedCache = null;
    return unique.length;
  }

  slice(start: number, end: number): unknown[] {
    const boundedStart = Math.max(0, Math.min(this.length, start));
    const boundedEnd = Math.max(boundedStart, Math.min(this.length, end));
    if (boundedStart === boundedEnd) return [];

    const result: unknown[] = [];
    let offset = 0;
    for (const chunk of [...this.olderChunks, this.recentChunk]) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd > boundedStart && offset < boundedEnd) {
        result.push(
          ...chunk.slice(
            Math.max(0, boundedStart - offset),
            Math.min(chunk.length, boundedEnd - offset),
          ),
        );
      }
      if (chunkEnd >= boundedEnd) break;
      offset = chunkEnd;
    }
    return result;
  }

  toArray(): unknown[] {
    if (!this.flattenedCache) {
      this.flattenedCache = this.olderChunks.flatMap(chunk => chunk).concat(this.recentChunk);
    }
    return this.flattenedCache;
  }

  private rebuildRecentIdentities(): void {
    this.recentIdentities.clear();
    for (const message of this.recentChunk) {
      const key = identityKey(message);
      if (key) incrementIdentity(this.recentIdentities, key);
    }
  }

  private rebuildOlderIdentities(): void {
    this.olderIdentities.clear();
    this.olderSourceIdentities.clear();
    this.olderMessageCount = 0;
    for (const chunk of this.olderChunks) {
      this.olderMessageCount += chunk.length;
      for (const message of chunk) {
        const key = identityKey(message);
        if (key) incrementIdentity(this.olderIdentities, key);
        const sourceKey = sourceIdentityKey(message);
        if (sourceKey) incrementIdentity(this.olderSourceIdentities, sourceKey);
      }
    }
  }
}
