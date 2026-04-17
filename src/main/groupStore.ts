import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export interface SessionGroup {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: number;
}

export interface CreateGroupInput {
  name: string;
  color?: string;
}

export interface UpdateGroupInput {
  name?: string;
  color?: string;
  sortOrder?: number;
}

const DEFAULT_GROUP_COLOR = '#6366f1';

export class GroupStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  listGroups(): SessionGroup[] {
    return this.db
      .prepare(
        `SELECT id, name, color, sort_order as sortOrder, created_at as createdAt
         FROM session_groups
         ORDER BY sort_order ASC, created_at ASC`,
      )
      .all() as SessionGroup[];
  }

  getGroup(id: string): SessionGroup | null {
    const row = this.db
      .prepare(
        `SELECT id, name, color, sort_order as sortOrder, created_at as createdAt
         FROM session_groups
         WHERE id = ?`,
      )
      .get(id);
    return row ? (row as SessionGroup) : null;
  }

  createGroup(input: CreateGroupInput): SessionGroup {
    const id = uuidv4();
    const now = Date.now();
    const color = input.color || DEFAULT_GROUP_COLOR;

    // Get max sort_order to place new group at end
    const maxOrderRow = this.db
      .prepare(`SELECT MAX(sort_order) as maxOrder FROM session_groups`)
      .get() as { maxOrder: number | null } | undefined;
    const sortOrder = (maxOrderRow?.maxOrder ?? -1) + 1;

    this.db
      .prepare(
        `INSERT INTO session_groups (id, name, color, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, color, sortOrder, now);

    return {
      id,
      name: input.name,
      color,
      sortOrder,
      createdAt: now,
    };
  }

  updateGroup(id: string, input: UpdateGroupInput): SessionGroup | null {
    const existing = this.getGroup(id);
    if (!existing) return null;

    const name = input.name ?? existing.name;
    const color = input.color ?? existing.color;
    const sortOrder = input.sortOrder ?? existing.sortOrder;

    this.db
      .prepare(
        `UPDATE session_groups
         SET name = ?, color = ?, sort_order = ?
         WHERE id = ?`,
      )
      .run(name, color, sortOrder, id);

    return { ...existing, name, color, sortOrder };
  }

  deleteGroup(id: string): boolean {
    // Set group_id to NULL for all sessions in this group
    this.db.prepare(`UPDATE cowork_sessions SET group_id = NULL WHERE group_id = ?`).run(id);

    // Delete the group
    const result = this.db.prepare(`DELETE FROM session_groups WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  moveSessionToGroup(sessionId: string, groupId: string | null): boolean {
    const result = this.db
      .prepare(`UPDATE cowork_sessions SET group_id = ? WHERE id = ?`)
      .run(groupId, sessionId);
    return result.changes > 0;
  }

  reorderGroups(groupIds: string[]): void {
    const update = this.db.prepare(`UPDATE session_groups SET sort_order = ? WHERE id = ?`);

    for (let i = 0; i < groupIds.length; i++) {
      update.run(i, groupIds[i]);
    }
  }
}
