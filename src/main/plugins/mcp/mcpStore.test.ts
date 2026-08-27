import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { McpStore } from './mcpStore';

describe('McpStore request timeout overrides', () => {
  let db: Database.Database;
  let store: McpStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    store = new McpStore(db);
  });

  afterEach(() => db.close());

  test('persists and clears a per-server request timeout override', () => {
    const created = store.createServer({
      name: 'docs',
      transportType: 'stdio',
      command: 'npx',
      requestTimeoutSeconds: 300,
    });

    expect(created.requestTimeoutSeconds).toBe(300);
    expect(store.updateServer(created.id, { requestTimeoutSeconds: null })).toMatchObject({
      requestTimeoutSeconds: undefined,
    });
    const row = db.prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(created.id) as {
      config_json: string;
    };
    expect(JSON.parse(row.config_json)).not.toHaveProperty('requestTimeoutSeconds');
  });

  test('rejects an invalid per-server request timeout', () => {
    expect(() =>
      store.createServer({
        name: 'docs',
        transportType: 'stdio',
        command: 'npx',
        requestTimeoutSeconds: 0,
      }),
    ).toThrow('MCP request timeout must be an integer between 1 and 86400 seconds.');
  });
});
