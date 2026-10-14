// Execute the production D1Store SQL against SQLite (WASM), including legacy
// migrations and atomic batches. This is not a Cloudflare/workerd runtime test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import { D1Store, type ClassroomAccountRow, type GoogleAccountRow } from "../src/store";

const SQL = await initSqlJs();

class SQLiteStatement {
  private values: SqlValue[] = [];
  constructor(private db: Database, private sql: string) {}
  bind(...values: SqlValue[]): this { this.values = values; return this; }
  async run() {
    this.db.run(this.sql, this.values);
    return { meta: { changes: this.db.getRowsModified() } };
  }
  async all() {
    const statement = this.db.prepare(this.sql);
    try {
      statement.bind(this.values);
      const results: Record<string, SqlValue>[] = [];
      while (statement.step()) results.push(statement.getAsObject());
      return { results };
    } finally { statement.free(); }
  }
  async first<T>(): Promise<T | null> {
    return ((await this.all()).results[0] as T | undefined) ?? null;
  }
}

function d1Adapter(db: Database): D1Database {
  return {
    prepare: (sql: string) => new SQLiteStatement(db, sql),
    batch: async (statements: SQLiteStatement[]) => {
      db.run("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.run("COMMIT");
        return results;
      } catch (e) { db.run("ROLLBACK"); throw e; }
    },
  } as unknown as D1Database;
}

const google = (id: string): GoogleAccountRow => ({
  id: `google:${id}`, accountId: id, email: `${id}@example.com`, visible: true, legacyIds: false,
  refreshToken: `refresh-${id}`, accessToken: `access-${id}`, accessExpires: 9_000_000, connectedAt: 1000, problem: null,
});
const classroom = (id: string): ClassroomAccountRow => ({
  accountId: id, email: `${id}@example.com`, legacyNotes: false,
  refreshToken: `class-refresh-${id}`, accessToken: `class-access-${id}`, accessExpires: 9_000_000, connectedAt: 1000, problem: null,
});

describe("D1Store SQL on SQLite", () => {
  let db: Database;
  let store: D1Store;
  beforeEach(() => { db = new SQL.Database(); store = new D1Store(d1Adapter(db)); });
  afterEach(() => db.close());

  it("moves old singleton credentials once without losing auth, notes or OAuth state", async () => {
    db.run(`
      CREATE TABLE auth (id INTEGER PRIMARY KEY, salt TEXT, passHash TEXT, recoveryHash TEXT);
      INSERT INTO auth VALUES (1, 'salt', 'password-hash', 'recovery-hash');
      CREATE TABLE oauth_state (state TEXT PRIMARY KEY, returnUrl TEXT, expires INTEGER);
      INSERT INTO oauth_state VALUES ('calendar-attempt', 'https://app.example/', 9000000);
      CREATE TABLE google_account (id INTEGER PRIMARY KEY, refreshToken TEXT, accessToken TEXT, accessExpires INTEGER, email TEXT, connectedAt INTEGER, problem TEXT);
      INSERT INTO google_account VALUES (1, 'old-refresh', 'old-access', 9000000, 'home@example.com', 1000, NULL);
      CREATE TABLE classroom_account (id INTEGER PRIMARY KEY, refreshToken TEXT, accessToken TEXT, accessExpires INTEGER, accountId TEXT, email TEXT, connectedAt INTEGER, problem TEXT);
      INSERT INTO classroom_account VALUES (1, 'old-school-refresh', 'old-school-access', 9000000, 'school', 'school@example.com', 1000, NULL);
      CREATE TABLE note (id TEXT PRIMARY KEY, text TEXT, createdAt INTEGER, updatedAt INTEGER, reminderAt INTEGER, deleted INTEGER);
      INSERT INTO note VALUES ('existing-note', 'Keep me', 100, 100, NULL, 0);
    `);
    await store.init();
    expect(await store.getAuth()).toEqual({ salt: "salt", passHash: "password-hash", recoveryHash: "recovery-hash" });
    expect(await store.getGoogle("google:legacy")).toMatchObject({ refreshToken: "old-refresh", legacyIds: true, visible: true });
    expect(await store.getClassroom("school")).toMatchObject({ refreshToken: "old-school-refresh", legacyNotes: true });
    expect((await store.allNotes())[0].text).toBe("Keep me");
    expect(await store.takeOAuthState("calendar-attempt", 1000, "classroom")).toBeNull();
    expect(await store.takeOAuthState("calendar-attempt", 1000, "calendar")).toBe("https://app.example/");
    await store.setGoogleVisibility("google:legacy", false);
    await store.setGoogle(google("school"));
    const state = await store.getGoogleState();
    await store.init();
    expect(await store.getGoogleState()).toEqual(state); // doesn't reset visibility or credentials
    await store.removeGoogle("google:legacy");
    await store.removeClassroom("school");
    await store.init();
    expect(await store.getGoogle("google:legacy")).toBeNull();
    expect(await store.getClassroom("school")).toBeNull(); // never resurrects old singleton rows
    expect(await store.listGoogle()).toHaveLength(1);
  });

  it("stores multiple accounts, returns a safe revisioned snapshot and persists visibility across init/reconnect", async () => {
    await store.init();
    await store.setGoogle(google("home"));
    await store.setGoogle(google("school"));
    const before = await store.getGoogleState();
    expect(before.accounts).toHaveLength(2);
    expect(await store.setGoogleVisibility("google:school", false)).toBe(true);
    const hidden = await store.getGoogleState();
    expect(hidden.revision).toBe(before.revision + 1);
    expect(hidden.accounts.find((a) => a.id === "google:school")?.visible).toBe(false);
    expect(JSON.stringify(hidden)).not.toMatch(/refresh-|access-|refreshToken|accessToken/);
    await store.setGoogle({ ...google("school"), connectedAt: 2000 });
    await store.init();
    expect((await store.getGoogle("google:school"))?.visible).toBe(false);
    expect((await store.getGoogle("google:home"))?.visible).toBe(true);
    const version = (await store.getGoogleState()).revision;
    expect(await store.setGoogleVisibility("missing", false)).toBe(false);
    expect((await store.getGoogleState()).revision).toBe(version);
  });

  it("refreshes only the target connection, retaining visibility and rejecting replaced/disconnected credentials", async () => {
    await store.init();
    await store.setGoogle(google("home")); await store.setGoogle(google("school"));
    const old = (await store.getGoogle("google:school"))!;
    await store.setGoogleVisibility("google:school", false);
    expect(await store.updateGoogleTokens({ ...old, accessToken: "renewed-school" })).toBe(true);
    expect(await store.getGoogle("google:school")).toMatchObject({ accessToken: "renewed-school", visible: false });
    expect((await store.getGoogle("google:home"))?.accessToken).toBe("access-home");
    await store.setGoogle({ ...old, refreshToken: "replacement-refresh", connectedAt: 2000 });
    expect(await store.updateGoogleTokens({ ...old, accessToken: "stale" })).toBe(false);
    expect((await store.getGoogle("google:school"))?.refreshToken).toBe("replacement-refresh");
    await store.removeGoogle("google:school");
    expect(await store.updateGoogleTokens(old)).toBe(false);
    expect(await store.getGoogle("google:school")).toBeNull();
    expect(await store.getGoogle("google:home")).not.toBeNull();
  });

  it("independently stores/refreshes/removes multiple Classroom accounts", async () => {
    await store.init();
    await store.setClassroom(classroom("a")); await store.setClassroom(classroom("b"));
    const old = (await store.getClassroom("a"))!;
    expect(await store.updateClassroomTokens({ ...old, accessToken: "renewed-a" })).toBe(true);
    expect((await store.getClassroom("b"))?.accessToken).toBe("class-access-b");
    await store.setClassroom({ ...old, refreshToken: "new-a", connectedAt: 2000 });
    expect(await store.updateClassroomTokens(old)).toBe(false);
    await store.removeClassroom("a");
    expect(await store.updateClassroomTokens(old)).toBe(false);
    expect((await store.listClassroom()).map((a) => a.accountId)).toEqual(["b"]);
  });

  it("preserves ownership and personal metadata through old-client upserts and source-specific tombstones", async () => {
    await store.init();
    await store.appendOp({ id: "create", kind: "upsert", noteId: "event", text: "Event", title: "Title", body: "Description",
      sectionId: "folder", pinned: true, source: "gcal", sourceRef: "version", sourceAccountId: "google:school", updatedAt: 1000, reminderAt: 5000 });
    await store.appendOp({ id: "old-client", kind: "upsert", noteId: "event", text: "Edited", source: "gcal", sourceRef: "version", updatedAt: 2000, reminderAt: 5000 });
    expect((await store.allNotes())[0]).toMatchObject({ title: "Title", pinned: true, sectionId: "folder", sourceAccountId: "google:school" });
    await store.appendOp({ id: "remove", kind: "delete", noteId: "event", source: "gcal", sourceRef: "calendar-removed", sourceAccountId: "google:school", updatedAt: 3000 });
    expect((await store.allNotes())[0]).toMatchObject({ deleted: true, title: "Title", sourceRef: "calendar-removed", sourceAccountId: "google:school" });
    expect((await store.listOps(0, 100)).ops.at(-1)).toMatchObject({ kind: "delete", sourceAccountId: "google:school" });
    await store.appendOp({ id: "old-delete", kind: "delete", noteId: "event", updatedAt: 4000 });
    expect((await store.allNotes())[0].sourceAccountId).toBe("google:school");
  });
});
