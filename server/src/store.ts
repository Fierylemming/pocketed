// Storage layer. Two implementations of one tiny interface:
//  - D1Store:     production, backed by Cloudflare D1
//  - MemoryStore: tests

import type {
  CalendarAccountSummary,
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

/** Server-only OAuth credentials, shared in shape but stored per integration. */
export interface GoogleOAuthRow {
  /** Long-lived; never sent back to the apps. */
  refreshToken: string;
  accessToken: string | null;
  /** Epoch ms when accessToken stops working. */
  accessExpires: number | null;
  connectedAt: number;
  /** Set when Google stopped accepting the refresh token (sign in again). */
  problem: string | null;
}

/** One of the Google Calendar connections in this Pocketed workspace. */
export interface GoogleAccountRow extends GoogleOAuthRow {
  id?: string;
  /** OIDC subject, absent on the migrated pre-multi-account connection. */
  accountId?: string | null;
  legacyIds?: boolean;
  visible?: boolean;
  /** Primary calendar id (the Google account's address), for display. */
  email: string | null;
}

export interface GoogleConnectionRow extends GoogleAccountRow {
  id: string;
  accountId: string | null;
  legacyIds: boolean;
  visible: boolean;
}

/** Classroom remains independent, even for the same Google account. */
export interface ClassroomAccountRow extends GoogleOAuthRow {
  /** Ownership fallback for reminders created before account tags existed. */
  legacyNotes?: boolean;
  accountId: string;
  email: string | null;
}

export type OAuthPurpose = "calendar" | "classroom";

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
  endAt?: number | null;
  allDay?: boolean | null;
  source?: ItemSource | null;
  sourceRef?: string | null;
  sourceAccountId?: string | null;
}

function encodeMeta(op: Partial<Op>): string | null {
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
  if (op.endAt !== undefined) m.endAt = op.endAt;
  if (op.allDay !== undefined) m.allDay = op.allDay;
  if (op.source !== undefined) m.source = op.source;
  if (op.sourceRef !== undefined) m.sourceRef = op.sourceRef;
  if (op.sourceAccountId !== undefined) m.sourceAccountId = op.sourceAccountId;
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
  getGoogle(id?: string): Promise<GoogleConnectionRow | null>;
  listGoogle(): Promise<GoogleConnectionRow[]>;
  getGoogleState(): Promise<{ accounts: CalendarAccountSummary[]; revision: number }>;
  removeGoogle(id: string): Promise<void>;
  setGoogleVisibility(id: string, visible: boolean): Promise<boolean>;
  /** null disconnects. */
  setGoogle(row: GoogleAccountRow | null): Promise<void>;
  /** Refresh only the existing connection; never resurrect a disconnected/replaced row. */
  updateGoogleTokens(row: GoogleAccountRow): Promise<boolean>;
  // ---- Google Classroom (does not replace the Calendar connection) ----
  getClassroom(accountId?: string): Promise<ClassroomAccountRow | null>;
  listClassroom(): Promise<ClassroomAccountRow[]>;
  removeClassroom(accountId: string): Promise<void>;
  setClassroom(row: ClassroomAccountRow | null): Promise<void>;
  updateClassroomTokens(row: ClassroomAccountRow): Promise<boolean>;
  /** Remembers a one-time sign-in attempt, bound to the intended integration. */
  putOAuthState(state: string, returnUrl: string, expires: number, now: number, purpose?: OAuthPurpose): Promise<void>;
  /** Uses up an unexpired attempt for THIS integration only. */
  takeOAuthState(state: string, now: number, purpose?: OAuthPurpose): Promise<string | null>;
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
CREATE TABLE IF NOT EXISTS classroom_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refreshToken TEXT NOT NULL,
  accessToken TEXT,
  accessExpires INTEGER,
  accountId TEXT NOT NULL,
  email TEXT,
  connectedAt INTEGER NOT NULL,
  problem TEXT
);
CREATE TABLE IF NOT EXISTS google_connection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO google_connection_state (id, revision) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS google_connection (
  id TEXT PRIMARY KEY,
  accountId TEXT UNIQUE,
  refreshToken TEXT NOT NULL,
  accessToken TEXT,
  accessExpires INTEGER,
  email TEXT,
  connectedAt INTEGER NOT NULL,
  problem TEXT,
  legacyIds INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS classroom_connection (
  accountId TEXT PRIMARY KEY,
  refreshToken TEXT NOT NULL,
  accessToken TEXT,
  accessExpires INTEGER,
  email TEXT,
  connectedAt INTEGER NOT NULL,
  problem TEXT,
  legacyNotes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  returnUrl TEXT NOT NULL,
  expires INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'calendar'
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
    endAt: reminderAt == null ? null : (m.endAt ?? null),
    allDay: m.allDay ?? null,
    source: m.source ?? null,
    sourceRef: m.sourceRef ?? null,
    sourceAccountId: m.sourceAccountId ?? null,
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
      // Existing Calendar sign-in attempts keep their purpose on upgrade.
      "ALTER TABLE oauth_state ADD COLUMN purpose TEXT NOT NULL DEFAULT 'calendar'",
    ]) {
      try {
        await this.db.prepare(alter).run();
      } catch {
        /* Column already exists */
      }
    }
    // Atomically move the old singleton credentials once. Emptying the old
    // tables prevents a later Worker cold start from resurrecting disconnects.
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO google_connection
        (id, accountId, refreshToken, accessToken, accessExpires, email, connectedAt, problem, legacyIds, visible)
        SELECT 'google:legacy', NULL, refreshToken, accessToken, accessExpires, email, connectedAt, problem, 1, 1
        FROM google_account WHERE id = 1`),
      this.db.prepare(`UPDATE google_connection_state SET revision = revision + 1 WHERE id = 1 AND EXISTS (SELECT 1 FROM google_account WHERE id = 1)`),
      this.db.prepare(`DELETE FROM google_account`),
      this.db.prepare(`INSERT OR IGNORE INTO classroom_connection
        (accountId, refreshToken, accessToken, accessExpires, email, connectedAt, problem, legacyNotes)
        SELECT accountId, refreshToken, accessToken, accessExpires, email, connectedAt, problem, 1
        FROM classroom_account WHERE id = 1`),
      this.db.prepare(`DELETE FROM classroom_account`),
    ]);
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
    const metaJson = encodeMeta(op.kind === "delete" ? { source: op.source, sourceRef: op.sourceRef, sourceAccountId: op.sourceAccountId } : op);
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
           VALUES (?1, '', ?2, ?3, NULL, 1, ?4)
           ON CONFLICT(id) DO UPDATE SET
             deleted = 1, reminderAt = NULL,
             meta = CASE WHEN ?4 IS NULL THEN note.meta ELSE json_patch(coalesce(note.meta, '{}'), ?4) END,
             updatedAt = excluded.updatedAt
           WHERE excluded.updatedAt >= note.updatedAt`,
        )
        .bind(op.noteId, op.updatedAt, op.updatedAt, metaJson)
        .run();
    } else {
      await this.db
        .prepare(
          `INSERT INTO note (id, text, createdAt, updatedAt, reminderAt, deleted, meta)
           VALUES (?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(id) DO UPDATE SET
             text = excluded.text,
             reminderAt = excluded.reminderAt,
             meta = json_patch(coalesce(note.meta, '{}'), coalesce(excluded.meta, '{}')),
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

  async listGoogle(): Promise<GoogleConnectionRow[]> {
    const rows = await this.db.prepare(`SELECT * FROM google_connection ORDER BY legacyIds DESC, connectedAt, id`).all();
    return rows.results.map((r) => ({
      id: r.id as string, accountId: (r.accountId as string | null) ?? null,
      refreshToken: r.refreshToken as string, accessToken: (r.accessToken as string | null) ?? null,
      accessExpires: (r.accessExpires as number | null) ?? null, email: (r.email as string | null) ?? null,
      connectedAt: r.connectedAt as number, problem: (r.problem as string | null) ?? null,
      legacyIds: r.legacyIds === 1, visible: r.visible === 1,
    }));
  }

  async getGoogle(id?: string): Promise<GoogleConnectionRow | null> {
    const rows = await this.listGoogle();
    return (id === undefined ? rows[0] : rows.find((r) => r.id === id)) ?? null;
  }

  async getGoogleState(): Promise<{ accounts: CalendarAccountSummary[]; revision: number }> {
    // A single statement gives visibility and its revision the same snapshot.
    const rows = await this.db.prepare(`SELECT s.revision, g.id, g.email, g.connectedAt, g.problem, g.visible, g.legacyIds
      FROM google_connection_state s LEFT JOIN google_connection g ON 1 = 1 WHERE s.id = 1
      ORDER BY g.legacyIds DESC, g.connectedAt, g.id`).all();
    return { revision: Number(rows.results[0]?.revision ?? 0), accounts: rows.results.filter((r) => r.id != null).map((r) => ({
      id: r.id as string, email: (r.email as string | null) ?? null, connectedAt: r.connectedAt as number,
      problem: (r.problem as string | null) ?? null, visible: r.visible === 1, legacyIds: r.legacyIds === 1,
    })) };
  }

  async setGoogle(row: GoogleAccountRow | null): Promise<void> {
    if (!row) {
      await this.db.batch([this.db.prepare(`DELETE FROM google_connection`), this.db.prepare(`UPDATE google_connection_state SET revision = revision + 1 WHERE id = 1`)]);
      return;
    }
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO google_connection (id, accountId, refreshToken, accessToken, accessExpires, email, connectedAt, problem, legacyIds, visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET accountId = excluded.accountId, refreshToken = excluded.refreshToken,
           accessToken = excluded.accessToken, accessExpires = excluded.accessExpires,
           email = excluded.email, connectedAt = excluded.connectedAt, problem = excluded.problem,
           legacyIds = excluded.legacyIds`,
      ).bind(row.id ?? "google:legacy", row.accountId ?? null, row.refreshToken, row.accessToken,
        row.accessExpires, row.email, row.connectedAt, row.problem, (row.legacyIds ?? !row.id) ? 1 : 0, row.visible === false ? 0 : 1),
      this.db.prepare(`UPDATE google_connection_state SET revision = revision + 1 WHERE id = 1`),
    ]);
    // Reauthorization deliberately does not reset an existing visibility choice.
  }

  async removeGoogle(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM google_connection WHERE id = ?`).bind(id),
      this.db.prepare(`UPDATE google_connection_state SET revision = revision + 1 WHERE id = 1`),
    ]);
  }

  async setGoogleVisibility(id: string, visible: boolean): Promise<boolean> {
    const result = await this.db.batch([
      this.db.prepare(`UPDATE google_connection SET visible = ? WHERE id = ?`).bind(visible ? 1 : 0, id),
      this.db.prepare(`UPDATE google_connection_state SET revision = revision + 1 WHERE id = 1 AND EXISTS (SELECT 1 FROM google_connection WHERE id = ?)`).bind(id),
    ]);
    return (result[0].meta.changes ?? 0) > 0;
  }

  async updateGoogleTokens(row: GoogleAccountRow): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE google_connection SET accessToken = ?, accessExpires = ?, problem = ?
       WHERE id = ? AND refreshToken = ? AND connectedAt = ?`,
    ).bind(row.accessToken, row.accessExpires, row.problem, row.id ?? "google:legacy", row.refreshToken, row.connectedAt).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async listClassroom(): Promise<ClassroomAccountRow[]> {
    const rows = await this.db.prepare(`SELECT * FROM classroom_connection ORDER BY legacyNotes DESC, connectedAt, accountId`).all();
    return rows.results.map((r) => ({
      accountId: r.accountId as string, refreshToken: r.refreshToken as string,
      accessToken: (r.accessToken as string | null) ?? null, accessExpires: (r.accessExpires as number | null) ?? null,
      email: (r.email as string | null) ?? null, connectedAt: r.connectedAt as number,
      problem: (r.problem as string | null) ?? null, legacyNotes: r.legacyNotes === 1,
    }));
  }

  async getClassroom(accountId?: string): Promise<ClassroomAccountRow | null> {
    const rows = await this.listClassroom();
    return (accountId === undefined ? rows[0] : rows.find((r) => r.accountId === accountId)) ?? null;
  }

  async setClassroom(row: ClassroomAccountRow | null): Promise<void> {
    if (!row) { await this.db.prepare(`DELETE FROM classroom_connection`).run(); return; }
    await this.db.prepare(
      `INSERT INTO classroom_connection (accountId, refreshToken, accessToken, accessExpires, email, connectedAt, problem, legacyNotes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(accountId) DO UPDATE SET refreshToken = excluded.refreshToken,
         accessToken = excluded.accessToken, accessExpires = excluded.accessExpires,
         email = excluded.email, connectedAt = excluded.connectedAt, problem = excluded.problem`,
    ).bind(row.accountId, row.refreshToken, row.accessToken, row.accessExpires, row.email, row.connectedAt, row.problem,
      row.legacyNotes ? 1 : 0).run();
  }

  async removeClassroom(accountId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM classroom_connection WHERE accountId = ?`).bind(accountId).run();
  }

  async updateClassroomTokens(row: ClassroomAccountRow): Promise<boolean> {
    const result = await this.db.prepare(
      `UPDATE classroom_connection SET accessToken = ?, accessExpires = ?, problem = ?
       WHERE accountId = ? AND refreshToken = ? AND connectedAt = ?`,
    ).bind(row.accessToken, row.accessExpires, row.problem, row.accountId, row.refreshToken, row.connectedAt).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async putOAuthState(state: string, returnUrl: string, expires: number, now: number, purpose: OAuthPurpose = "calendar"): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM oauth_state WHERE expires < ?`).bind(now),
      this.db
        .prepare(`INSERT INTO oauth_state (state, returnUrl, expires, purpose) VALUES (?, ?, ?, ?)`)
        .bind(state, returnUrl, expires, purpose),
    ]);
  }

  async takeOAuthState(state: string, now: number, purpose: OAuthPurpose = "calendar"): Promise<string | null> {
    const r = await this.db
      .prepare(`DELETE FROM oauth_state WHERE state = ? AND purpose = ? RETURNING returnUrl, expires`)
      .bind(state, purpose)
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
  googleRevision = 0;
  googleAccounts = new Map<string, GoogleConnectionRow>();
  classroomAccounts = new Map<string, ClassroomAccountRow>();
  get google(): GoogleConnectionRow | null { return [...this.googleAccounts.values()][0] ?? null; }
  get classroom(): ClassroomAccountRow | null { return [...this.classroomAccounts.values()][0] ?? null; }
  oauthStates = new Map<string, { returnUrl: string; expires: number; purpose: OAuthPurpose }>();
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
          repeat: null,
          source: op.source !== undefined ? op.source : (base.source ?? null),
          sourceRef: op.sourceRef !== undefined ? op.sourceRef : (base.sourceRef ?? null),
          sourceAccountId: op.sourceAccountId !== undefined ? op.sourceAccountId : (base.sourceAccountId ?? null),
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
        endAt:
          op.reminderAt == null
            ? null
            : op.endAt !== undefined
              ? op.endAt
              : (cur?.endAt ?? null),
        allDay: op.allDay !== undefined ? op.allDay : (cur?.allDay ?? null),
        source: op.source !== undefined ? op.source : (cur?.source ?? null),
        sourceRef: op.sourceRef !== undefined ? op.sourceRef : (cur?.sourceRef ?? null),
        sourceAccountId: op.sourceAccountId !== undefined ? op.sourceAccountId : (cur?.sourceAccountId ?? null),
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

  async listGoogle(): Promise<GoogleConnectionRow[]> {
    return [...this.googleAccounts.values()].sort((a, b) => Number(b.legacyIds) - Number(a.legacyIds) || a.connectedAt - b.connectedAt || a.id.localeCompare(b.id)).map((r) => ({ ...r }));
  }

  async getGoogle(id?: string): Promise<GoogleConnectionRow | null> {
    const row = id === undefined ? (await this.listGoogle())[0] : this.googleAccounts.get(id);
    return row ? { ...row } : null;
  }

  async getGoogleState(): Promise<{ accounts: CalendarAccountSummary[]; revision: number }> {
    const revision = this.googleRevision;
    return { revision, accounts: (await this.listGoogle()).map((r) => ({
      id: r.id, email: r.email, connectedAt: r.connectedAt, problem: r.problem, visible: r.visible, legacyIds: r.legacyIds,
    })) };
  }

  async setGoogle(row: GoogleAccountRow | null): Promise<void> {
    this.googleRevision++;
    if (!row) { this.googleAccounts.clear(); return; }
    const id = row.id ?? "google:legacy";
    const old = this.googleAccounts.get(id);
    this.googleAccounts.set(id, { ...row, id, accountId: row.accountId ?? null, legacyIds: row.legacyIds ?? !row.id,
      visible: old?.visible ?? row.visible ?? true });
  }

  async removeGoogle(id: string): Promise<void> { this.googleAccounts.delete(id); this.googleRevision++; }

  async setGoogleVisibility(id: string, visible: boolean): Promise<boolean> {
    const row = this.googleAccounts.get(id);
    if (!row) return false;
    this.googleAccounts.set(id, { ...row, visible });
    this.googleRevision++;
    return true;
  }

  async updateGoogleTokens(row: GoogleAccountRow): Promise<boolean> {
    const id = row.id ?? "google:legacy";
    const old = this.googleAccounts.get(id);
    if (!old || old.refreshToken !== row.refreshToken || old.connectedAt !== row.connectedAt) return false;
    this.googleAccounts.set(id, { ...old, accessToken: row.accessToken, accessExpires: row.accessExpires, problem: row.problem });
    return true;
  }

  async listClassroom(): Promise<ClassroomAccountRow[]> {
    return [...this.classroomAccounts.values()].sort((a, b) => Number(b.legacyNotes) - Number(a.legacyNotes) || a.connectedAt - b.connectedAt || a.accountId.localeCompare(b.accountId)).map((r) => ({ ...r }));
  }

  async getClassroom(accountId?: string): Promise<ClassroomAccountRow | null> {
    const row = accountId === undefined ? (await this.listClassroom())[0] : this.classroomAccounts.get(accountId);
    return row ? { ...row } : null;
  }

  async setClassroom(row: ClassroomAccountRow | null): Promise<void> {
    if (!row) { this.classroomAccounts.clear(); return; }
    const old = this.classroomAccounts.get(row.accountId);
    this.classroomAccounts.set(row.accountId, { ...row, legacyNotes: old?.legacyNotes ?? row.legacyNotes ?? false });
  }

  async removeClassroom(accountId: string): Promise<void> { this.classroomAccounts.delete(accountId); }

  async updateClassroomTokens(row: ClassroomAccountRow): Promise<boolean> {
    const old = this.classroomAccounts.get(row.accountId);
    if (!old || old.refreshToken !== row.refreshToken || old.connectedAt !== row.connectedAt) return false;
    this.classroomAccounts.set(row.accountId, { ...old, accessToken: row.accessToken, accessExpires: row.accessExpires, problem: row.problem });
    return true;
  }

  async putOAuthState(state: string, returnUrl: string, expires: number, now: number, purpose: OAuthPurpose = "calendar"): Promise<void> {
    for (const [k, v] of this.oauthStates) if (v.expires < now) this.oauthStates.delete(k);
    this.oauthStates.set(state, { returnUrl, expires, purpose });
  }

  async takeOAuthState(state: string, now: number, purpose: OAuthPurpose = "calendar"): Promise<string | null> {
    const r = this.oauthStates.get(state);
    if (!r || r.purpose !== purpose) return null;
    this.oauthStates.delete(state);
    return r.expires >= now ? r.returnUrl : null;
  }
}
