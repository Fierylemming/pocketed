// Storage layer. Two implementations of one tiny interface:
//  - D1Store:     production, backed by Cloudflare D1
//  - MemoryStore: tests

import type {
  ChecklistItem,
  ItemKind,
  ItemSource,
  Note,
  Op,
  RepeatId,
  ReminderColorId,
  Section,
} from "@pocketed/shared";

export interface AuthRow {
  salt: string;
  passHash: string;
  recoveryHash: string;
}

/** The connected calendar feed (one per Pocketed account). */
export interface CalendarFeedRow {
  /** Secret iCal address. Never sent back to the apps. */
  url: string;
  connectedAt: number;
}

/** "Sign in with Google" connection (one per Pocketed account). */
export interface GoogleAccountRow {
  /** Long-lived; never sent back to the apps. */
  refreshToken: string;
  accessToken: string | null;
  /** Epoch ms when accessToken stops working. */
  accessExpires: number | null;
  /** Primary calendar id (the Google account's address), for display. */
  email: string | null;
  connectedAt: number;
  /** Set when Google stopped accepting the refresh token (sign in again). */
  problem: string | null;
}

interface StoredMeta {
  itemKind?: ItemKind;
  title?: string;
  body?: string;
  sectionId?: string | null;
  location?: string | null;
  color?: ReminderColorId | null;
  images?: string[];
  checklist?: ChecklistItem[];
  pinned?: boolean;
  sectionName?: string;
  parentId?: string | null;
  repeat?: RepeatId | null;
  alertBefore?: number | null;
  source?: ItemSource | null;
  sourceRef?: string | null;
}

function encodeMeta(op: Op): string | null {
  const m: StoredMeta = {};
  if (op.itemKind !== undefined) m.itemKind = op.itemKind;
  if (op.title !== undefined) m.title = op.title;
  if (op.body !== undefined) m.body = op.body;
  if (op.sectionId !== undefined) m.sectionId = op.sectionId;
  if (op.location !== undefined) m.location = op.location;
  if (op.color !== undefined) m.color = op.color;
  if (op.images !== undefined) m.images = op.images;
  if (op.checklist !== undefined) m.checklist = op.checklist;
  if (op.pinned !== undefined) m.pinned = op.pinned;
  if (op.sectionName !== undefined) m.sectionName = op.sectionName;
  if (op.parentId !== undefined) m.parentId = op.parentId;
  if (op.repeat !== undefined) m.repeat = op.repeat;
  if (op.alertBefore !== undefined) m.alertBefore = op.alertBefore;
  if (op.source !== undefined) m.source = op.source;
  if (op.sourceRef !== undefined) m.sourceRef = op.sourceRef;
  return Object.keys(m).length > 0 ? JSON.stringify(m) : null;
}

function decodeMeta(raw: unknown): StoredMeta {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoredMeta) : {};
  } catch {
    return {};
  }
}

export interface Store {
  init(): Promise<void>;
  noteCount(): Promise<number>;
  serverSeq(): Promise<number>;
  /** Idempotent by op.id; applies the op to the note/section table (LWW). */
  appendOp(op: Op): Promise<void>;
  listOps(cursor: number, limit: number): Promise<{ ops: Op[]; cursor: number }>;
  allNotes(): Promise<Note[]>;
  allSections(): Promise<Section[]>;
  getAuth(): Promise<AuthRow | null>;
  setAuth(row: AuthRow): Promise<void>;
  // ---- calendar link ----
  getCalendar(): Promise<CalendarFeedRow | null>;
  /** null disconnects. */
  setCalendar(row: CalendarFeedRow | null): Promise<void>;
  // ---- Sign in with Google ----
  getGoogle(): Promise<GoogleAccountRow | null>;
  /** null disconnects. */
  setGoogle(row: GoogleAccountRow | null): Promise<void>;
  /** Remembers a one-time sign-in attempt (and drops expired ones). */
  putOAuthState(state: string, returnUrl: string, expires: number, now: number): Promise<void>;
  /** Uses up a sign-in attempt: its return URL if it exists and hasn't expired. */
  takeOAuthState(state: string, now: number): Promise<string | null>;
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
  updatedAt INTEGER NOT NULL,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS note (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  reminderAt INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS section (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  parentId TEXT
);
CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  passHash TEXT NOT NULL,
  recoveryHash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_feed (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL,
  connectedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS google_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refreshToken TEXT NOT NULL,
  accessToken TEXT,
  accessExpires INTEGER,
  email TEXT,
  connectedAt INTEGER NOT NULL,
  problem TEXT
);
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  returnUrl TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`;

type NoteRow = Record<string, unknown>;

function rowToNote(r: NoteRow): Note {
  const m = decodeMeta(r.meta);
  const reminderAt = (r.reminderAt as number) ?? null;
  return {
    id: r.id as string,
    text: r.text as string,
    kind: m.itemKind,
    title: m.title,
    body: m.body,
    sectionId: m.sectionId ?? null,
    location: m.location ?? null,
    color: m.color ?? null,
    images: m.images ?? [],
    checklist: m.checklist ?? [],
    pinned: m.pinned ?? false,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    reminderAt,
    repeat: reminderAt == null ? null : (m.repeat ?? "none"),
    alertBefore: m.alertBefore ?? null,
    source: m.source ?? null,
    sourceRef: m.sourceRef ?? null,
    deleted: (r.deleted as number) === 1,
  };
}

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  async init(): Promise<void> {
    for (const stmt of SCHEMA.split(";\n").filter((s) => s.trim())) {
      await this.db.prepare(stmt).run();
    }
    // Safe migrations for existing v2.0 databases created before `meta` existed
    for (const alter of [
      "ALTER TABLE op ADD COLUMN meta TEXT",
      "ALTER TABLE note ADD COLUMN meta TEXT",
      // Subsections: databases created before sections could nest.
      "ALTER TABLE section ADD COLUMN parentId TEXT",
    ]) {
      try {
        await this.db.prepare(alter).run();
      } catch {
        /* Column already exists */
      }
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
    const metaJson = encodeMeta(op);
    const res = await this.db
      .prepare(
        `INSERT OR IGNORE INTO op (id, kind, noteId, text, reminderAt, createdAt, updatedAt, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        op.id,
        op.kind,
        op.noteId,
        op.text ?? null,
        op.reminderAt ?? null,
        op.createdAt ?? op.updatedAt,
        op.updatedAt,
        metaJson,
      )
      .run();
    if ((res.meta.changes ?? 0) === 0) return; // duplicate op id

    if (op.kind === "section-delete") {
      await this.db
        .prepare(
          `INSERT INTO section (id, name, createdAt, updatedAt, deleted)
           VALUES (?, '', ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET
             deleted = 1,
             updatedAt = excluded.updatedAt
           WHERE excluded.updatedAt >= section.updatedAt`,
        )
        .bind(op.noteId, op.updatedAt, op.updatedAt)
        .run();
      return;
    }

    if (op.kind === "section-upsert") {
      await this.db
        .prepare(
          // ?6 = 0 when the op predates subsections (no parentId): keep the stored parent.
          `INSERT INTO section (id, name, createdAt, updatedAt, deleted, parentId)
           VALUES (?1, ?2, ?3, ?4, 0, ?5)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             deleted = 0,
             parentId = CASE WHEN ?6 = 1 THEN excluded.parentId ELSE section.parentId END,
             updatedAt = excluded.updatedAt
           WHERE excluded.updatedAt >= section.updatedAt`,
        )
        .bind(
          op.noteId,
          op.sectionName ?? "Untitled",
          op.createdAt ?? op.updatedAt,
          op.updatedAt,
          op.parentId ?? null,
          op.parentId !== undefined ? 1 : 0,
        )
        .run();
      return;
    }

    if (op.kind === "delete") {
      await this.db
        .prepare(
          `INSERT INTO note (id, text, createdAt, updatedAt, reminderAt, deleted, meta)
           VALUES (?, '', ?, ?, NULL, 1, NULL)
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
          `INSERT INTO note (id, text, createdAt, updatedAt, reminderAt, deleted, meta)
           VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             reminderAt = excluded.reminderAt,
             meta = excluded.meta,
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
          metaJson,
        )
        .run();
    }
  }

  async listOps(cursor: number, limit: number) {
    const rows = await this.db
      .prepare(
        `SELECT seq, id, kind, noteId, text, reminderAt, createdAt, updatedAt, meta
         FROM op WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2`,
      )
      .bind(cursor, limit)
      .all();
    const ops: Op[] = rows.results.map((r) => {
      const m = decodeMeta(r.meta);
      return {
        id: r.id as string,
        kind: r.kind as Op["kind"],
        noteId: r.noteId as string,
        text: (r.text as string) ?? undefined,
        reminderAt: (r.reminderAt as number) ?? null,
        createdAt: (r.createdAt as number) ?? undefined,
        updatedAt: r.updatedAt as number,
        ...m,
      };
    });
    const next = ops.length ? (rows.results.at(-1)!.seq as number) : cursor;
    return { ops, cursor: next };
  }

  async allNotes(): Promise<Note[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, text, createdAt, updatedAt, reminderAt, deleted, meta FROM note`,
      )
      .all();
    return rows.results.map(rowToNote);
  }

  async allSections(): Promise<Section[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, name, createdAt, updatedAt, deleted, parentId FROM section`,
      )
      .all();
    return rows.results.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      parentId: (r.parentId as string | null) ?? null,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
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

  async getCalendar(): Promise<CalendarFeedRow | null> {
    const r = await this.db
      .prepare(`SELECT url, connectedAt FROM calendar_feed WHERE id = 1`)
      .first<CalendarFeedRow>();
    return r ?? null;
  }

  async setCalendar(row: CalendarFeedRow | null): Promise<void> {
    if (!row) {
      await this.db.prepare(`DELETE FROM calendar_feed`).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO calendar_feed (id, url, connectedAt) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url, connectedAt = excluded.connectedAt`,
      )
      .bind(row.url, row.connectedAt)
      .run();
  }

  async getGoogle(): Promise<GoogleAccountRow | null> {
    const r = await this.db
      .prepare(
        `SELECT refreshToken, accessToken, accessExpires, email, connectedAt, problem
         FROM google_account WHERE id = 1`,
      )
      .first<GoogleAccountRow>();
    return r ?? null;
  }

  async setGoogle(row: GoogleAccountRow | null): Promise<void> {
    if (!row) {
      await this.db.prepare(`DELETE FROM google_account`).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO google_account (id, refreshToken, accessToken, accessExpires, email, connectedAt, problem)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET refreshToken = excluded.refreshToken,
           accessToken = excluded.accessToken, accessExpires = excluded.accessExpires,
           email = excluded.email, connectedAt = excluded.connectedAt, problem = excluded.problem`,
      )
      .bind(
        row.refreshToken,
        row.accessToken,
        row.accessExpires,
        row.email,
        row.connectedAt,
        row.problem,
      )
      .run();
  }

  async putOAuthState(state: string, returnUrl: string, expires: number, now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM oauth_state WHERE expires < ?`).bind(now),
      this.db
        .prepare(`INSERT INTO oauth_state (state, returnUrl, expires) VALUES (?, ?, ?)`)
        .bind(state, returnUrl, expires),
    ]);
  }

  async takeOAuthState(state: string, now: number): Promise<string | null> {
    const r = await this.db
      .prepare(`DELETE FROM oauth_state WHERE state = ? RETURNING returnUrl, expires`)
      .bind(state)
      .first<{ returnUrl: string; expires: number }>();
    return r && r.expires >= now ? r.returnUrl : null;
  }
}

export class MemoryStore implements Store {
  ops: (Op & { seq: number })[] = [];
  notes = new Map<string, Note>();
  sections = new Map<string, Section>();
  auth: AuthRow | null = null;
  calendar: CalendarFeedRow | null = null;
  google: GoogleAccountRow | null = null;
  oauthStates = new Map<string, { returnUrl: string; expires: number }>();
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

    if (op.kind === "section-delete" || op.kind === "section-upsert") {
      const curSec = this.sections.get(op.noteId);
      if (op.kind === "section-delete") {
        if (!curSec || op.updatedAt >= curSec.updatedAt) {
          this.sections.set(op.noteId, {
            id: op.noteId,
            name: curSec?.name ?? "",
            parentId: curSec?.parentId ?? null,
            createdAt: curSec?.createdAt ?? op.updatedAt,
            updatedAt: Math.max(curSec?.updatedAt ?? 0, op.updatedAt),
            deleted: true,
          });
        }
      } else if (!curSec || op.updatedAt >= curSec.updatedAt) {
        this.sections.set(op.noteId, {
          id: op.noteId,
          name: op.sectionName ?? curSec?.name ?? "Untitled",
          parentId: op.parentId !== undefined ? op.parentId : (curSec?.parentId ?? null),
          createdAt: op.createdAt ?? curSec?.createdAt ?? op.updatedAt,
          updatedAt: op.updatedAt,
          deleted: false,
        });
      }
      return;
    }

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
        kind: op.itemKind ?? cur?.kind,
        title: op.title ?? cur?.title,
        body: op.body ?? cur?.body,
        sectionId: op.sectionId !== undefined ? op.sectionId : (cur?.sectionId ?? null),
        location: op.location !== undefined ? op.location : (cur?.location ?? null),
        color: op.color !== undefined ? op.color : (cur?.color ?? null),
        images: op.images ?? cur?.images ?? [],
        checklist: op.checklist ?? cur?.checklist ?? [],
        pinned: op.pinned ?? cur?.pinned ?? false,
        createdAt: op.createdAt ?? cur?.createdAt ?? op.updatedAt,
        updatedAt: op.updatedAt,
        reminderAt: op.reminderAt ?? null,
        repeat:
          op.reminderAt == null
            ? null
            : (op.repeat !== undefined ? op.repeat : (cur?.repeat ?? "none")),
        alertBefore:
          op.alertBefore !== undefined ? op.alertBefore : (cur?.alertBefore ?? null),
        source: op.source !== undefined ? op.source : (cur?.source ?? null),
        sourceRef: op.sourceRef !== undefined ? op.sourceRef : (cur?.sourceRef ?? null),
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

  async allSections(): Promise<Section[]> {
    return [...this.sections.values()];
  }

  async getCalendar(): Promise<CalendarFeedRow | null> {
    return this.calendar;
  }

  async setCalendar(row: CalendarFeedRow | null): Promise<void> {
    this.calendar = row;
  }

  async getGoogle(): Promise<GoogleAccountRow | null> {
    return this.google ? { ...this.google } : null;
  }

  async setGoogle(row: GoogleAccountRow | null): Promise<void> {
    this.google = row ? { ...row } : null;
  }

  async putOAuthState(state: string, returnUrl: string, expires: number, now: number): Promise<void> {
    for (const [k, v] of this.oauthStates) if (v.expires < now) this.oauthStates.delete(k);
    this.oauthStates.set(state, { returnUrl, expires });
  }

  async takeOAuthState(state: string, now: number): Promise<string | null> {
    const r = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    return r && r.expires >= now ? r.returnUrl : null;
  }
}
