import { describe, expect, it } from "vitest";
import type { Op } from "@pocketed/shared";
import { handle } from "../src/worker";
import { MemoryStore } from "../src/store";

const PASS = "test-password-1";
const RECOVERY = "abcd-1234-efgh-5678";

async function freshApp() {
  const store = new MemoryStore();
  const init = await handle(
    new Request("https://pocketed.test/v1/init", {
      method: "POST",
      body: JSON.stringify({ password: PASS, recovery: RECOVERY }),
    }),
    store,
  );
  if (init.status !== 200) throw new Error("init failed: " + init.status);
  const call = (path: string, init: RequestInit = {}, token: string | null = PASS) =>
    handle(
      new Request("https://pocketed.test" + path, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      }),
      store,
    );
  return { store, call };
}

const op = (over: Partial<Op>): Op => ({
  id: "op-" + Math.random().toString(36).slice(2),
  kind: "upsert",
  noteId: "n-" + Math.random().toString(36).slice(2),
  text: "hello",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("auth lifecycle", () => {
  it("health reports initialized flag", async () => {
    const store = new MemoryStore();
    const before = (await (await handle(new Request("https://x/health"), store)).json()) as { initialized: boolean };
    expect(before.initialized).toBe(false);
    const { call } = await (async () => {
      const app = await freshApp();
      return app;
    })();
    const after = (await (await call("/health", {}, null)).json()) as { initialized: boolean };
    expect(after.initialized).toBe(true);
  });

  it("init only once", async () => {
    const { call } = await freshApp();
    const r = await call("/v1/init", { method: "POST", body: JSON.stringify({ password: "another-pass-1", recovery: "zzzz-0000" }) }, null);
    expect(r.status).toBe(409);
  });

  it("rejects weak passwords at init", async () => {
    const store = new MemoryStore();
    const r = await handle(
      new Request("https://x/v1/init", {
        method: "POST",
        body: JSON.stringify({ password: "short", recovery: "abcd-1234" }),
      }),
      store,
    );
    expect(r.status).toBe(400);
  });

  it("wrong password 401, right password 200", async () => {
    const { call } = await freshApp();
    expect((await call("/v1/pull", {}, "wrong-password-9")).status).toBe(401);
    expect((await call("/v1/pull", {}, null)).status).toBe(401);
    expect((await call("/v1/pull")).status).toBe(200);
  });

  it("change password: old stops working, new works", async () => {
    const { call } = await freshApp();
    const ch = await call("/v1/password", { method: "POST", body: JSON.stringify({ password: "second-password-2" }) });
    expect(ch.status).toBe(200);
    expect((await call("/v1/pull", {}, PASS)).status).toBe(401);
    expect((await call("/v1/pull", {}, "second-password-2")).status).toBe(200);
  });

  it("recovery key resets the password", async () => {
    const store = new MemoryStore();
    await handle(
      new Request("https://x/v1/init", {
        method: "POST",
        body: JSON.stringify({ password: PASS, recovery: RECOVERY }),
      }),
      store,
    );
    const rec = await handle(
      new Request("https://x/v1/recover", {
        method: "POST",
        body: JSON.stringify({ recovery: RECOVERY, password: "reset-password-3" }),
      }),
      store,
    );
    expect(rec.status).toBe(200);
    const bad = await handle(
      new Request("https://x/v1/recover", {
        method: "POST",
        body: JSON.stringify({ recovery: "wrong-key", password: "hack-hack-hack" }),
      }),
      store,
    );
    expect(bad.status).toBe(401);
    const pull = await handle(
      new Request("https://x/v1/pull", { headers: { authorization: "Bearer reset-password-3" } }),
      store,
    );
    expect(pull.status).toBe(200);
  });

  it("rotate recovery key", async () => {
    const { call } = await freshApp();
    const r = await call("/v1/recovery", { method: "POST", body: JSON.stringify({ recovery: "new-key-new-key" }) });
    expect(r.status).toBe(200);
    // old recovery no longer works
    const rec = await call("/v1/recover", { method: "POST", body: JSON.stringify({ recovery: RECOVERY, password: "stolen-pass-123" }) }, null);
    expect(rec.status).toBe(401);
  });
});

describe("sync api", () => {
  it("push then pull round-trips ops", async () => {
    const { call } = await freshApp();
    const o1 = op({});
    const push = await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [o1] }) });
    expect(push.status).toBe(200);
    const { serverSeq } = (await push.json()) as { serverSeq: number };
    expect(serverSeq).toBe(1);

    const pull = await call("/v1/pull?cursor=0");
    const body = (await pull.json()) as { ops: Op[]; cursor: number };
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0].id).toBe(o1.id);
    expect(body.cursor).toBe(1);
  });

  it("dedupes repeated op ids", async () => {
    const { call } = await freshApp();
    const o = op({});
    await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [o] }) });
    await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [o] }) });
    const pull = await call("/v1/pull?cursor=0&limit=100");
    const body = (await pull.json()) as { ops: Op[] };
    expect(body.ops).toHaveLength(1);
  });

  it("rejects oversized text", async () => {
    const { call } = await freshApp();
    const big = op({ text: "x".repeat(4001) });
    const r1 = await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [big] }) });
    expect(r1.status).toBe(400);
  });

  it("snapshot reflects LWW state and tombstones", async () => {
    const { call } = await freshApp();
    const id = "note-1";
    await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [op({ noteId: id, text: "v1", updatedAt: 10 })] }) });
    await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [op({ noteId: id, text: "v2", updatedAt: 20 })] }) });
    await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [op({ noteId: id, text: "stale", updatedAt: 15 })] }) });
    await call("/v1/push", { method: "POST", body: JSON.stringify({ ops: [{ id: "del-1", kind: "delete", noteId: id, updatedAt: 30 }] }) });
    const snap = await call("/v1/snapshot");
    const body = (await snap.json()) as { notes: { id: string; text: string; deleted: boolean }[] };
    const n = body.notes.find((n) => n.id === id);
    expect(n?.deleted).toBe(true);
    const health = await call("/health", {}, null);
    expect(((await health.json()) as { notes: number }).notes).toBe(0);
  });

  it("round-trips sections, colour-coded reminders with location, and notes with images", async () => {
    const { call } = await freshApp();
    const secOp: Op = {
      id: "op-sec-1",
      kind: "section-upsert",
      noteId: "sec-work",
      sectionName: "Work",
      createdAt: 100,
      updatedAt: 100,
    };
    const remOp = op({
      id: "op-rem-1",
      noteId: "rem-1",
      itemKind: "reminder",
      title: "Team Sync",
      body: "Weekly standup",
      text: "Team Sync\nWeekly standup",
      location: "Room 4B",
      color: "violet", // a name from Pocketed's retired palette: still accepted
      sectionId: "sec-work",
      reminderAt: 200_000,
      updatedAt: 101,
    });
    const noteOp = op({
      id: "op-note-1",
      noteId: "note-rich-1",
      itemKind: "note",
      title: "Design Mockups",
      body: "Attached whiteboard photos",
      text: "Design Mockups\nAttached whiteboard photos",
      sectionId: "sec-work",
      images: ["data:image/png;base64,iVBORw0KGgo="],
      updatedAt: 102,
    });

    const push = await call("/v1/push", {
      method: "POST",
      body: JSON.stringify({ ops: [secOp, remOp, noteOp] }),
    });
    expect(push.status).toBe(200);

    const snap = await call("/v1/snapshot");
    const body = (await snap.json()) as {
      notes: { id: string; location?: string; color?: string; images?: string[]; sectionId?: string }[];
      sections: { id: string; name: string }[];
    };
    expect(body.sections.map((s) => s.name)).toEqual(["Work"]);
    const savedRem = body.notes.find((n) => n.id === "rem-1")!;
    expect(savedRem.location).toBe("Room 4B");
    expect(savedRem.color).toBe("violet");
    expect(savedRem.sectionId).toBe("sec-work");

    const savedNote = body.notes.find((n) => n.id === "note-rich-1")!;
    expect(savedNote.images).toHaveLength(1);
  });
});
