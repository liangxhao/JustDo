/** One successor per exact predecessor, shared by independently owned policies. */
export class ExecutionSuccessorClaims {
  private readonly claims = new Map<string, string>();

  claim(predecessorRunId: string, owner: string): boolean {
    const existing = this.claims.get(predecessorRunId);
    if (existing !== undefined) return existing === owner;
    this.claims.set(predecessorRunId, owner);
    return true;
  }

  release(predecessorRunId: string, owner: string): void {
    if (this.claims.get(predecessorRunId) === owner) this.claims.delete(predecessorRunId);
  }

  isCurrent(predecessorRunId: string, owner: string): boolean {
    return this.claims.get(predecessorRunId) === owner;
  }

  clear(): void {
    this.claims.clear();
  }
}
