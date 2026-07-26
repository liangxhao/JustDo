import { readTranscriptIdentity } from './transcript-identity';

function identityKey(message: unknown): string | null {
  const identity = readTranscriptIdentity(message);
  return identity ? `${identity.kind}:${identity.value}` : null;
}

/**
 * Keeps older history pages as immutable chunks. The newest chunk is the
 * reconciliation snapshot and may be replaced as live messages settle.
 */
export class ChunkedMessageHistory {
  private olderChunks: unknown[][] = [];
  private olderMessageCount = 0;
  private recentChunk: unknown[] = [];
  private olderIdentities = new Set<string>();
  private recentIdentities = new Set<string>();
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
    this.recentChunk = messages;
    this.rebuildRecentIdentities();
    this.flattenedCache = messages;
  }

  replaceRecent(messages: unknown[]): void {
    const nextRecentIdentities = new Set<string>();
    for (const message of messages) {
      const key = identityKey(message);
      if (key) nextRecentIdentities.add(key);
    }

    const overlapsOlderChunk =
      this.olderChunks.length > 0 &&
      [...nextRecentIdentities].some(key => this.olderIdentities.has(key));
    if (overlapsOlderChunk) {
      this.olderChunks = this.olderChunks
        .map(chunk =>
          chunk.filter(message => {
            const key = identityKey(message);
            return !key || !nextRecentIdentities.has(key);
          }),
        )
        .filter(chunk => chunk.length > 0);
      this.rebuildOlderIdentities();
    }

    this.recentChunk = messages;
    this.recentIdentities = nextRecentIdentities;
    this.flattenedCache = this.olderChunks.length === 0 ? messages : null;
  }

  prepend(messages: unknown[]): number {
    const pageIdentities = new Set<string>();
    const unique = messages.filter(message => {
      const key = identityKey(message);
      if (!key) return true;
      if (
        this.olderIdentities.has(key) ||
        this.recentIdentities.has(key) ||
        pageIdentities.has(key)
      ) {
        return false;
      }
      pageIdentities.add(key);
      return true;
    });
    if (unique.length === 0) return 0;

    this.olderChunks.unshift(unique);
    this.olderMessageCount += unique.length;
    for (const key of pageIdentities) this.olderIdentities.add(key);
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
      if (key) this.recentIdentities.add(key);
    }
  }

  private rebuildOlderIdentities(): void {
    this.olderIdentities.clear();
    this.olderMessageCount = 0;
    for (const chunk of this.olderChunks) {
      this.olderMessageCount += chunk.length;
      for (const message of chunk) {
        const key = identityKey(message);
        if (key) this.olderIdentities.add(key);
      }
    }
  }
}
