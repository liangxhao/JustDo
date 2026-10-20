import type Database from 'better-sqlite3';

/** Inert resource ownership survives a missing, broken or disabled optional implementation. */
export class AppProtectionJournal {
  constructor(private readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS app_plugin_resources (
      owner_id TEXT NOT NULL, artifact_hash TEXT NOT NULL, resource_id TEXT NOT NULL,
      PRIMARY KEY (owner_id, resource_id)
    ); CREATE INDEX IF NOT EXISTS app_plugin_resources_resource ON app_plugin_resources(resource_id);`);
  }
  owners(ids: readonly string[]): { ownerId: string; artifactHash: string }[] {
    const owners = new Map<string, { ownerId: string; artifactHash: string }>();
    const statement = this.database.prepare(
      'SELECT owner_id, artifact_hash FROM app_plugin_resources WHERE resource_id = ?',
    );
    for (const id of ids)
      for (const row of statement.all(id) as { owner_id: string; artifact_hash: string }[]) {
        owners.set(`${row.owner_id}:${row.artifact_hash}`, {
          ownerId: row.owner_id,
          artifactHash: row.artifact_hash,
        });
      }
    return [...owners.values()];
  }
  allOwners(): { ownerId: string; artifactHash: string }[] {
    return this.database
      .prepare(
        'SELECT DISTINCT owner_id AS ownerId, artifact_hash AS artifactHash FROM app_plugin_resources',
      )
      .all() as { ownerId: string; artifactHash: string }[];
  }
  prior(owner: string, currentHash: string): { artifactHash: string; resourceIds: string[] }[] {
    const groups = new Map<string, string[]>();
    for (const row of this.database
      .prepare(
        'SELECT artifact_hash,resource_id FROM app_plugin_resources WHERE owner_id = ? AND artifact_hash <> ?',
      )
      .all(owner, currentHash) as { artifact_hash: string; resource_id: string }[]) {
      const ids = groups.get(row.artifact_hash) ?? [];
      ids.push(row.resource_id);
      groups.set(row.artifact_hash, ids);
    }
    return [...groups].map(([artifactHash, resourceIds]) => ({ artifactHash, resourceIds }));
  }
  adopt(owner: string, previous: string, next: string, ids: readonly string[]): void {
    this.database.transaction(() => {
      const update = this.database.prepare(
        'UPDATE app_plugin_resources SET artifact_hash = ? WHERE owner_id = ? AND artifact_hash = ? AND resource_id = ?',
      );
      for (const id of ids) update.run(next, owner, previous, id);
    })();
  }
  confirmDeleted(ids: readonly string[]): void {
    this.database.transaction(() => {
      const remove = this.database.prepare(
        'DELETE FROM app_plugin_resources WHERE resource_id = ?',
      );
      for (const id of ids) remove.run(id);
    })();
  }
  replace(owner: string, hash: string, ids: readonly string[]): void {
    if (ids.length > 100000 || ids.some(id => typeof id !== 'string' || !id || id.length > 256))
      throw new Error('appPluginInvalidRequest');
    this.database.transaction(() => {
      // Empty projections cannot erase prior ownership or adopt a different artifact.
      const save = this.database.prepare(
        'INSERT OR IGNORE INTO app_plugin_resources VALUES (?, ?, ?)',
      );
      for (const id of new Set(ids)) save.run(owner, hash, id);
    })();
  }
}
