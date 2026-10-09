// Storage layer. Two implementations of one tiny interface:
//  - D1Store:     production, backed by Cloudflare D1
//  - MemoryStore: tests

import type { Note, Op } from "@pocketed/shared";

export interface AuthRow {
  salt: string;
  passHash: string;
  recoveryHash: string;
}

export interface Store {
  init(): Promise<void>;
  noteCount(): Promise<number>;
  serverSeq(): Promise<number>;
  /** Idempotent by op.id; applies the op to the note table (LWW). */
  appendOp(op: Op): Promise<void>;
  listOps(cursor: number, limit: number): Promise<{ ops: Op[]; cursor: number }>;
  allNotes(): Promise<Note[]>;
  getAuth(): Promise<AuthRow | null>;
  setAuth(row: AuthRow): Promise<void>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS op (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  noteId TEXT NOT NULL,
  text TEXT,
  reminderAt INTEGER,
  createdAt INTEGER,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  reminderAt INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  passHash TEXT NOT NULL,
  recoveryHash TEXT NOT NULL
);
`;

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async init(): Promise<void> {
    for (const stmt of SCHEMA.split(";\n").filter((s) => s.trim())) {
      await this.db.prepare(stmt).run();
    }
  }

  async noteCount(): Promise<number> {
    const r = await this.db
      .prepare("SELECT count(*) AS n FROM note WHERE deleted = 0")
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async serverSeq(): Promise<number> {
    const r = await this.db
      .prepare("SELECT coalesce(max(seq), 0) AS s FROM op")
      .first<{ s: number }>();
    return r?.s ?? 0;
  }

  async appendOp(op: Op): Promise<void> {
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO op (id, kind, noteId, text, reminderAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        op.id,
        op.kind,
        op.noteId,
        op.text ?? null,
        op.reminderAt ?? null,
        op.createdAt ?? op.updatedAt,
        op.updatedAt,
      )
      .run();
    if ((res.meta.changes ?? 0) === 0) return; // duplicate op id

    if (op.kind === "delete") {
      await this.db
        .prepare(
          `INSERT INTO note (id, text, createdAt, updatedAt, reminderAt, deleted)
           VALUES (?, '', ?, ?, NULL, 1)
           ON CONFLICT(id) DO UPDATE SET
             deleted = 1, reminderAt = NULL,
             updatedAt = excluded.updatedAt
           WHERE excluded.updatedAt >= note.updatedAt`,
        )
        .bind(op.noteId, op.updatedAt, op.updatedAt)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO note (id, text, createdAt, updatedAt, reminderAt, deleted)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             reminderAt = excluded.reminderAt,
             deleted = 0,
             updatedAt = excluded.updatedAt
           WHERE excluded.updatedAt >= note.updatedAt`,
        )
        .bind(
          op.noteId,
          op.text ?? "",
          op.createdAt ?? op.updatedAt,
          op.updatedAt,
          op.reminderAt ?? null,
        )
        .run();
    }
  }

  async listOps(cursor: number, limit: number) {
    const rows = await this.db
      .prepare(
        `SELECT seq, id, kind, noteId, text, reminderAt, createdAt, updatedAt
         FROM op WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2`,
      )
      .bind(cursor, limit)
      .all();
    const ops: Op[] = rows.results.map((r) => ({
      id: r.id as string,
      kind: r.kind as Op["kind"],
      noteId: r.noteId as string,
      text: (r.text as string) ?? undefined,
      reminderAt: (r.reminderAt as number) ?? null,
      createdAt: (r.createdAt as number) ?? undefined,
      updatedAt: r.updatedAt as number,
    }));
    const next = ops.length ? (rows.results.at(-1)!.seq as number) : cursor;
    return { ops, cursor: next };
  }

  async allNotes(): Promise<Note[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, text, createdAt, updatedAt, reminderAt, deleted FROM note`,
      )
      .all();
    return rows.results.map((r) => ({
      id: r.id as string,
      text: r.text as string,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      reminderAt: (r.reminderAt as number) ?? null,
      deleted: (r.deleted as number) === 1,
    }));
  }

  async getAuth() {
    const r = await this.db
      .prepare(`SELECT salt, passHash, recoveryHash FROM auth WHERE id = 1`)
      .first<{ salt: string; passHash: string; recoveryHash: string }>();
    return r ?? null;
  }

  async setAuth(row: AuthRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO auth (id, salt, passHash, recoveryHash) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           salt = excluded.salt,
           passHash = excluded.passHash,
           recoveryHash = excluded.recoveryHash`,
      )
      .bind(row.salt, row.passHash, row.recoveryHash)
      .run();
  }
}

export class MemoryStore implements Store {
  ops: (Op & { seq: number })[] = [];
  notes = new Map<string, Note>();
  auth: AuthRow | null = null;
  private seq = 0;

  async init(): Promise<void> {}

  async getAuth(): Promise<AuthRow | null> {
    return this.auth;
  }

  async setAuth(row: AuthRow): Promise<void> {
    this.auth = row;
  }

  async noteCount(): Promise<number> {
    return [...this.notes.values()].filter((n) => !n.deleted).length;
  }

  async serverSeq(): Promise<number> {
    return this.seq;
  }

  async appendOp(op: Op): Promise<void> {
    if (this.ops.some((o) => o.id === op.id)) return;
    this.seq += 1;
    this.ops.push({ ...op, seq: this.seq });
    const cur = this.notes.get(op.noteId);
    if (op.kind === "delete") {
      const base =
        cur ??
        ({
          id: op.noteId,
          text: "",
          createdAt: op.updatedAt,
          updatedAt: op.updatedAt,
          reminderAt: null,
          deleted: true,
        } as Note);
      if (!cur || op.updatedAt >= cur.updatedAt) {
        this.notes.set(op.noteId, {
          ...base,
          deleted: true,
          reminderAt: null,
          updatedAt: Math.max(cur?.updatedAt ?? 0, op.updatedAt),
        });
      }
    } else if (!cur || op.updatedAt >= cur.updatedAt) {
      this.notes.set(op.noteId, {
        id: op.noteId,
        text: op.text ?? "",
        createdAt: op.createdAt ?? op.updatedAt,
        updatedAt: op.updatedAt,
        reminderAt: op.reminderAt ?? null,
        deleted: false,
      });
    }
  }

  async listOps(cursor: number, limit: number) {
    const rows = this.ops.filter((o) => o.seq > cursor).slice(0, limit);
    return {
      ops: rows.map(({ seq: _s, ...op }) => op),
      cursor: rows.length ? rows.at(-1)!.seq : cursor,
    };
  }

  async allNotes(): Promise<Note[]> {
    return [...this.notes.values()];
  }
}
