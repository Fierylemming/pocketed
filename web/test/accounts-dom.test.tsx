// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { backend, CFG, HOME, SCHOOL, STUDENT, classroomFeed, NOW } from "./fake-google-accounts";
import type { SyncManager } from "../src/store";

let mock: ReturnType<typeof backend>;
let host: HTMLDivElement;
let root: Root;
let manager: SyncManager;
const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  localStorage.clear(); history.replaceState(null, "", "/");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock = backend(); vi.stubGlobal("fetch", mock.fetchMock);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  manager?.stop(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

async function newManager() {
  const { SyncManager } = await import("../src/store");
  manager = new SyncManager(CFG);
}
function checkbox(email: string): HTMLInputElement {
  const label = [...host.querySelectorAll<HTMLLabelElement>(".account-switch")].find((l) => l.textContent?.includes(email));
  if (!label) throw new Error(`No account switch for ${email}`);
  return label.querySelector("input")!;
}

describe("interactive multiple-account UI", () => {
  it("turns school events off/on without hiding assignments, and reflects the switch in both controls", async () => {
    await newManager();
    const { importCalendarNow } = await import("../src/calendar-import");
    const { importClassroomNow } = await import("../src/classroom-import");
    const { CalendarAccounts } = await import("../src/components/CalendarAccounts");
    const { ReminderCalendar } = await import("../src/components/ReminderCalendar");
    const { GoogleCalendar } = await import("../src/components/GoogleCalendar");
    await importCalendarNow(manager); await importClassroomNow(manager);
    function Workspace() {
      useSyncExternalStore(manager.subscribe, () => manager.version);
      return <><GoogleCalendar manager={manager} /><ReminderCalendar
        notes={Object.values(manager.state.notes)} accounts={manager.state.calendarAccounts}
        accountControls={<CalendarAccounts manager={manager} />} sections={[]} now={NOW} colorFilter="all"
        onColorFilterChange={() => {}} onSelectSection={() => {}} onQuickAddReminderForDate={() => {}}
        renderReminderCard={(note) => <li key={note.id}>{note.title}</li>} /></>;
    }
    await act(async () => { root.render(<Workspace />); await quiet(); });
    expect(host.querySelector(".calendar-grid")!.textContent).toContain("School event");
    expect(host.querySelector(".calendar-grid")!.innerHTML).toContain("Maths: Assignment");
    await act(async () => { checkbox("student@school.example").click(); await quiet(); });
    expect(mock.server.accounts.find((a) => a.id === SCHOOL)?.visible).toBe(false);
    expect(host.querySelector(".calendar-grid")!.textContent).not.toContain("School event");
    expect(host.querySelector(".calendar-grid")!.textContent).toContain("Home meeting");
    expect(host.querySelector(".calendar-grid")!.innerHTML).toContain("Maths: Assignment");
    const schoolSwitches = [...host.querySelectorAll<HTMLLabelElement>(".account-switch")].filter((l) => l.textContent?.includes("student@school.example"));
    expect(schoolSwitches).toHaveLength(2);
    expect(schoolSwitches.every((l) => !l.querySelector<HTMLInputElement>("input")!.checked)).toBe(true);
    expect(mock.server.log.some((op) => op.kind === "delete")).toBe(false);
    await act(async () => { checkbox("student@school.example").click(); await quiet(); });
    expect(host.querySelector(".calendar-grid")!.textContent).toContain("School event");
    expect(host.querySelector(".calendar-grid")!.innerHTML).toContain("Maths: Assignment");
  });

  it("keeps the current visibility and reports an error if the server cannot save a switch", async () => {
    await newManager();
    const { importCalendarNow } = await import("../src/calendar-import");
    const { CalendarAccounts } = await import("../src/components/CalendarAccounts");
    await importCalendarNow(manager);
    mock.server.failVisibility = true;
    await act(async () => { root.render(<CalendarAccounts manager={manager} />); });
    await act(async () => { checkbox("student@school.example").click(); await quiet(); });
    expect(checkbox("student@school.example").checked).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save");
    expect(checkbox("student@school.example").disabled).toBe(false);
  });

  it("a Calendar callback imports the selected account exactly once under StrictMode", async () => {
    history.replaceState(null, "", "/#google=connected&account=google%3Aschool");
    await newManager();
    const { GoogleCalendar } = await import("../src/components/GoogleCalendar");
    await act(async () => { root.render(<StrictMode><GoogleCalendar manager={manager} /></StrictMode>); await quiet(); });
    expect(location.hash).toBe("");
    expect(mock.server.feedCalls.filter((c) => c === `calendar:${SCHOOL}`)).toHaveLength(1);
    expect(mock.server.feedCalls.filter((c) => c === `calendar:${HOME}`)).toHaveLength(0);
    expect(host.textContent).toContain("Add Google Calendar account");
    expect(host.textContent).toContain("Connected. 1 added");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Check now" && !b.disabled)).toBe(true);
  });

  it("a Classroom callback imports just that student once, displays both accounts and disconnects only one", async () => {
    mock.server.classAccounts.push({ id: "second-student", email: "second@school.example", connectedAt: NOW, problem: null, legacyNotes: false });
    mock.server.classFeeds["second-student"] = classroomFeed("second-student");
    history.replaceState(null, "", "/#classroom=connected&account=second-student");
    await newManager();
    const { GoogleClassroom } = await import("../src/components/GoogleClassroom");
    await act(async () => { root.render(<StrictMode><GoogleClassroom manager={manager} /></StrictMode>); await quiet(); });
    expect(location.hash).toBe("");
    expect(mock.server.feedCalls.filter((c) => c === "classroom:second-student")).toHaveLength(1);
    expect(mock.server.feedCalls.filter((c) => c === `classroom:${STUDENT}`)).toHaveLength(0);
    expect(host.textContent).toContain("student@school.example"); expect(host.textContent).toContain("second@school.example");
    expect(host.textContent).toContain("Add Classroom account");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const row = [...host.querySelectorAll<HTMLDivElement>(".account-card")].find((r) => r.textContent?.includes("second@school.example"))!;
    const disconnect = [...row.querySelectorAll("button")].find((b) => b.textContent === "Disconnect Classroom")!;
    await act(async () => { disconnect.click(); await quiet(); });
    expect(mock.server.classAccounts.map((a) => a.id)).toEqual([STUDENT]);
    expect(host.textContent).toContain("student@school.example"); expect(host.textContent).not.toContain("second@school.example");
    expect(Object.values(manager.state.notes).find((n) => n.sourceAccountId === "second-student")?.deleted).toBe(true);
  });
});
