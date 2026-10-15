import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  addSection,
  canMoveSection,
  createNoteItem,
  createReminderItem,
  DEFAULT_REMINDER_COLOR,
  deleteNote,
  deleteSection,
  descendantSectionIds,
  flattenSectionTree,
  getReminderColor,
  isReminderItem,
  itemBody,
  itemTitle,
  LIMITS,
  markReminderDone,
  moveSection,
  normalizeReminderColor,
  quickReminders,
  renameSection,
  sectionPath,
  shortAgo,
  uid,
  updateItem,
  type ChecklistItem,
  type ItemKind,
  type Note,
  type ReminderColorId,
  type Section,
} from "@pocketed/shared";
import type { Config } from "../config";
import type { SyncManager } from "../store";
import { ReminderWatcher } from "../alerts";
import { CalendarAutoImport } from "../calendar-import";
import { ClassroomAutoImport } from "../classroom-import";
import {
  canPromptInstall,
  isInstalled,
  onInstallChange,
  promptInstall,
} from "../install";
import { fileToDataUrl } from "../images";
import {
  folderSummary,
  isNoteSortOrder,
  isSectionSortOrder,
  itemsInSection,
  NOTE_SORT_OPTIONS,
  SECTION_SORT_OPTIONS,
  sortedChildSections,
  sortedSectionTree,
  type NoteSortOrder,
  type SectionSortOrder,
  itemsWithinSection,
  matchesQuery,
  reminderMeta,
  rowsFor,
  sectionCounts,
  sectionsFor,
  sectionsWithPathNames,
  syncStatus,
  userSectionsFor,
} from "../view-model";
import { hasGoogleReturn } from "../google-return";
import { taskProgress, toggleTaskLine, toPlainText } from "../markdown";
import { textStats } from "../text-edit";
import { ColorPicker } from "./ColorPicker";
import { MarkdownView } from "./MarkdownView";
import { RichTextEditor } from "./RichTextEditor";
import { CalendarAccounts } from "./CalendarAccounts";
import { ReminderCalendar } from "./ReminderCalendar";
import { ReminderPicker, type ReminderValue } from "./ReminderPicker";
import { Settings } from "./Settings";
import { Brand, Icon } from "./Icon";
import { ThemePicker } from "./ThemePicker";
import { useDialog } from "../use-dialog";

const DISMISS_INSTALL_KEY = "pocketed.v2.installDismissed";
const EXPANDED_SECTIONS_KEY = "pocketed.v2.expandedSections";
const SECTION_SORT_KEY = "pocketed.v2.sectionSort";
const NOTE_SORT_KEY = "pocketed.v2.noteSort";
/** Unsaved new note, kept on this device so a reload or section switch doesn't lose it. */
const NOTE_DRAFT_KEY = "pocketed.v2.noteDraft";

interface NoteDraft {
  title: string;
  body: string;
  checklist: ChecklistItem[];
  pinned: boolean;
}

function loadNoteDraft(): NoteDraft | null {
  try {
    const raw = localStorage.getItem(NOTE_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<NoteDraft>;
    return {
      title: typeof d.title === "string" ? d.title : "",
      body: typeof d.body === "string" ? d.body : "",
      checklist: Array.isArray(d.checklist)
        ? d.checklist.filter(
            (c): c is ChecklistItem =>
              !!c && typeof c.id === "string" && typeof c.text === "string",
          )
        : [],
      pinned: d.pinned === true,
    };
  } catch {
    return null;
  }
}

function saveNoteDraft(d: NoteDraft) {
  try {
    if (!d.title.trim() && !d.body.trim() && d.checklist.length === 0) {
      localStorage.removeItem(NOTE_DRAFT_KEY);
    } else {
      localStorage.setItem(NOTE_DRAFT_KEY, JSON.stringify(d));
    }
  } catch {
    /* storage full or unavailable: the draft just isn't kept */
  }
}

function safeFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80);
  return (base || "note") + ".md";
}

function loadExpandedSections(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_SECTIONS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function loadSectionSortOrder(): SectionSortOrder {
  try {
    const value = localStorage.getItem(SECTION_SORT_KEY);
    return isSectionSortOrder(value) ? value : "added";
  } catch {
    return "added";
  }
}

function loadNoteSortOrder(): NoteSortOrder {
  try {
    const value = localStorage.getItem(NOTE_SORT_KEY);
    return isNoteSortOrder(value) ? value : "recently-edited";
  } catch {
    return "recently-edited";
  }
}

const PRESET_LOCATIONS = ["Home", "Work", "Office", "Supermarket", "Gym", "School"];

export const GENERAL_SECTION_ID = "__general__";

export function Notes({
  manager,
  onNewCfg,
}: {
  manager: SyncManager;
  onNewCfg: (c: Config | null) => void;
}) {
  useSyncExternalStore(manager.subscribe, () => manager.version);

  // Navigation: null = Home screen, string = inside a Section folder (or GENERAL_SECTION_ID)
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(() => !!loadNoteDraft());

  // Two-button creator mode: "note" | "reminder" | null
  const [composerKind, setComposerKind] = useState<ItemKind>("note");
  const [composerPreselectAt, setComposerPreselectAt] = useState<number | null>(null);
  const [composerPreselectColor, setComposerPreselectColor] =
    useState<ReminderColorId>(DEFAULT_REMINDER_COLOR);
  const [composerKey, setComposerKey] = useState(0);

  // New Section form state
  const [newSectionName, setNewSectionName] = useState("");
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
  const [renameSectionValue, setRenameSectionValue] = useState("");

  // Calendar colour filter on Home screen
  const [colorFilter, setColorFilter] = useState<ReminderColorId | "all">("all");

  // Sidebar (mobile drawer) + inline "new section" in the sidebar
  const [navOpen, setNavOpen] = useState(false);
  const sidebarRef = useDialog<HTMLElement>(() => setNavOpen(false), navOpen);
  const [addingSidebarSection, setAddingSidebarSection] = useState(false);
  const [sidebarSectionName, setSidebarSectionName] = useState("");
  // Which sections are unfolded in the sidebar tree (remembered on this device)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(loadExpandedSections);
  // Display-only ordering, remembered on this device. The stored creation
  // order (and everything synced) is untouched.
  const [sectionSort, setSectionSort] = useState<SectionSortOrder>(loadSectionSortOrder);
  const [noteSort, setNoteSort] = useState<NoteSortOrder>(loadNoteSortOrder);
  // "Move section" picker on a section page
  const [movingSectionId, setMovingSectionId] = useState<string | null>(null);

  // Search, Settings, Editing, and Interactive Modals
  const [query, setQuery] = useState("");
  // Opened straight away when coming back from "Sign in with Google".
  const [settings, setSettings] = useState(hasGoogleReturn);
  const [editing, setEditing] = useState<string | null>(null);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const lightboxRef = useDialog(() => setLightboxImage(null), !!lightboxImage);
  const [, setClock] = useState(0);

  const composerRef = useRef<HTMLDivElement | null>(null);

  // A drawer should not keep focus trapped after switching to a desktop layout.
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 768px)");
    const onResize = () => { if (!media?.matches) setNavOpen(false); };
    media?.addEventListener("change", onResize);
    return () => media?.removeEventListener("change", onResize);
  }, []);

  // Re-render every 30s so "5m ago" and due/upcoming labels stay current.
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Fire reminder alerts while the app is open.
  useEffect(() => {
    const w = new ReminderWatcher(
      () => Object.values(manager.state.notes),
      // A repeating reminder that just alerted moves on to its next occurrence.
      (n) => {
        if (n.repeat && n.repeat !== "none") {
          manager.mutate((st) => markReminderDone(st, n.id, Date.now()));
        }
      },
    );
    w.start();
    return () => w.stop();
  }, [manager]);

  // Calendar events and Classroom deadlines are independent reminder sources.
  useEffect(() => {
    const calendar = new CalendarAutoImport(manager);
    const classroom = new ClassroomAutoImport(manager);
    calendar.start();
    classroom.start();
    return () => {
      calendar.stop();
      classroom.stop();
    };
  }, [manager]);

  const now = Date.now();
  const all = rowsFor(manager);
  const userSections = userSectionsFor(manager);
  const status = syncStatus(manager.phase, manager.lastSync, now, manager.lastError);

  // Check if active section still exists
  const activeSectionObj =
    activeSectionId && activeSectionId !== GENERAL_SECTION_ID
      ? (userSections.find((s) => s.id === activeSectionId) ?? null)
      : null;

  useEffect(() => {
    if (
      activeSectionId &&
      activeSectionId !== GENERAL_SECTION_ID &&
      !activeSectionObj
    ) {
      setActiveSectionId(null);
    }
  }, [activeSectionId, activeSectionObj]);

  const targetSectionId =
    activeSectionId === GENERAL_SECTION_ID ? null : activeSectionId;

  // Top-level section … current section, for the breadcrumb.
  const activeSectionPath = activeSectionObj ? sectionPath(userSections, activeSectionObj.id) : [];

  // Unfold the sidebar down to wherever we are.
  const activePathKey = activeSectionPath.map((s) => s.id).join("/");
  useEffect(() => {
    for (const s of activeSectionPath.slice(0, -1)) setExpanded(s.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePathKey]);

  // On Home this makes a top-level section; inside a section, a subsection of it.
  function handleCreateSection(e: FormEvent) {
    e.preventDefault();
    const name = newSectionName.trim();
    if (!name) return;
    const parentId = activeSectionObj ? activeSectionObj.id : null;
    manager.mutate((s) => addSection(s, name, Date.now(), parentId).state);
    if (parentId) setExpanded(parentId, true);
    setNewSectionName("");
  }

  function changeSectionSort(order: SectionSortOrder) {
    setSectionSort(order);
    try {
      localStorage.setItem(SECTION_SORT_KEY, order);
    } catch {
      /* storage full or unavailable: keep the choice for this visit */
    }
  }

  function changeNoteSort(order: NoteSortOrder) {
    setNoteSort(order);
    try {
      localStorage.setItem(NOTE_SORT_KEY, order);
    } catch {
      /* storage full or unavailable: keep the choice for this visit */
    }
  }

  function setExpanded(id: string, open: boolean) {
    setExpandedSections((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(EXPANDED_SECTIONS_KEY, JSON.stringify([...next]));
      } catch {
        /* storage full or unavailable: just don't remember it */
      }
      return next;
    });
  }

  function handleMoveSection(id: string, parentId: string | null) {
    manager.mutate((s) => moveSection(s, id, parentId, Date.now()));
    if (parentId) setExpanded(parentId, true);
    setMovingSectionId(null);
  }

  function handleSaveRenameSection(id: string) {
    const name = renameSectionValue.trim();
    if (name) {
      manager.mutate((s) => renameSection(s, id, name, Date.now()));
    }
    setRenamingSectionId(null);
    setRenameSectionValue("");
  }

  function handleDeleteSection(sec: Section) {
    const nested = descendantSectionIds(userSections, sec.id).size;
    const what =
      nested > 0
        ? `its ${nested} ${nested === 1 ? "subsection" : "subsections"} and all notes/reminders inside them`
        : "all notes/reminders inside it";
    if (confirm(`Delete section "${sec.name}", ${what}?`)) {
      const parent = activeSectionPath.length > 1 ? activeSectionPath[activeSectionPath.length - 2] : null;
      const removed = new Set([sec.id, ...descendantSectionIds(userSections, sec.id)]);
      manager.mutate((s) => deleteSection(s, sec.id, Date.now()));
      // If we were inside what just got deleted, step back out to the nearest surviving folder.
      if (activeSectionId && removed.has(activeSectionId)) {
        setActiveSectionId(parent && !removed.has(parent.id) ? parent.id : null);
      }
    }
  }

  function openReminderComposerForDate(ts: number, color: ReminderColorId) {
    setComposerOpen(true);
    setComposerKind("reminder");
    setComposerPreselectAt(ts);
    setComposerPreselectColor(color);
    setComposerKey((k) => k + 1);
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      composerRef.current?.querySelector<HTMLInputElement>('[aria-label="Reminder title"]')?.focus({ preventScroll: true });
    });
  }

  function openNoteComposer() {
    setComposerOpen(true);
    setComposerKind("note");
    requestAnimationFrame(() => {
      composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      composerRef.current?.querySelector<HTMLInputElement>('[aria-label="Note title"]')?.focus({ preventScroll: true });
    });
  }

  function closeComposer() {
    setComposerOpen(false);
    document.querySelector<HTMLButtonElement>(".new-note-button")?.focus();
  }

  const searching = query.trim().length > 0;
  // Searching inside a section also searches every subsection nested in it.
  const scopedNotes =
    activeSectionId === null ? all : itemsWithinSection(all, userSections, targetSectionId);
  const searchHits = searching
    ? scopedNotes.filter((n) => matchesQuery(n, query))
    : [];

  const generalCounts = sectionCounts(all, null, now);
  const homeSections = sectionsFor(all, now);
  const expandedNote = expandedNoteId
    ? (all.find((n) => n.id === expandedNoteId) ?? null)
    : null;

  // Badges name the full path ("Work › Projects") so nested folders are unambiguous.
  const pathNamedSections = sectionsWithPathNames(userSections);
  const sectionMap = new Map(pathNamedSections.map((s) => [s.id, s]));
  const topSections = sortedChildSections(userSections, null, sectionSort);
  const subSections = activeSectionObj
    ? sortedChildSections(userSections, activeSectionObj.id, sectionSort)
    : [];

  function renderReminderCard(note: Note, sectionBadge?: Section | null) {
    if (editing === note.id) {
      return (
        <EditItemRow
          key={note.id}
          note={note}
          sections={userSections}
          manager={manager}
          done={() => setEditing(null)}
        />
      );
    }
    return (
      <ReminderCard
        key={note.id}
        note={note}
        now={now}
        sectionBadge={sectionBadge}
        onOpenSection={(secId) => setActiveSectionId(secId)}
        manager={manager}
        onEdit={() => setEditing(note.id)}
      />
    );
  }

  function renderNoteCard(note: Note, sectionBadge?: Section | null) {
    if (editing === note.id) {
      return (
        <EditItemRow
          key={note.id}
          note={note}
          sections={userSections}
          manager={manager}
          done={() => setEditing(null)}
        />
      );
    }
    return (
      <LargeNoteCard
        key={note.id}
        note={note}
        now={now}
        sectionBadge={sectionBadge}
        onOpenSection={(secId) => setActiveSectionId(secId)}
        manager={manager}
        onEdit={() => setEditing(note.id)}
        onExpand={() => setExpandedNoteId(note.id)}
        onViewImage={(img) => setLightboxImage(img)}
        highlight={searching ? query : undefined}
      />
    );
  }

  /**
   * Folder cards for a list of sections plus a "new section" form. On Home it
   * lists top-level sections; inside a section it lists that section's
   * subsections (and the form creates a subsection there).
   */
  function renderSectionsPanel(list: Section[], isHome: boolean) {
    const parentName = activeSectionObj?.name ?? "";
    return (
      <section
        className={"sections-panel" + (isHome ? "" : " subsections-panel")}
        aria-label={isHome ? "Sections" : "Subsections"}
      >
        <div className="block-head">
          <div>
            <h2 className="block-title">{isHome ? "Sections" : "Subsections"}</h2>
            <p className="muted small">
              {isHome
                ? "Bring a little structure to your everyday."
                : `Folders inside ${parentName}. They can have subsections of their own.`}
            </p>
          </div>
          {list.length > 1 && (
            <SortControl
              label={isHome ? "Sort sections" : "Sort subsections"}
              value={sectionSort}
              options={SECTION_SORT_OPTIONS}
              onChange={changeSectionSort}
            />
          )}
        </div>

        <form className="section-create-form" onSubmit={handleCreateSection}>
          <input
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            placeholder={
              isHome
                ? "New section, e.g. Work, Personal, Shopping…"
                : `New subsection in ${parentName}…`
            }
            maxLength={LIMITS.sectionNameChars}
            aria-label={isHome ? "New section name" : "New subsection name"}
          />
          <button type="submit" className="primary" disabled={!newSectionName.trim()}>
            {isHome ? "+ Create section" : "+ Create subsection"}
          </button>
        </form>

        {isHome && list.length === 0 && generalCounts.notes + generalCounts.reminders === 0 ? (
          <p className="muted small center-text sections-empty">
            No sections yet. Create one above to organise your notes and reminders into folders.
          </p>
        ) : list.length === 0 && !isHome ? null : (
          <div className="section-folders-grid">
            {list.map((sec) => renderFolderCard(sec))}

            {isHome && generalCounts.notes + generalCounts.reminders > 0 && (
              <div className="section-folder-card general-folder">
                <button
                  type="button"
                  className="section-folder-link"
                  onClick={() => goTo(GENERAL_SECTION_ID)}
                >
                  <span className="section-folder-icon" aria-hidden="true"><Icon name="folder" /></span>
                  <span className="section-folder-title">General (unsectioned)</span>
                  <span className="section-folder-counts">
                    {generalCounts.notes} {generalCounts.notes === 1 ? "note" : "notes"} ·{" "}
                    {generalCounts.reminders}{" "}
                    {generalCounts.reminders === 1 ? "reminder" : "reminders"}
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderFolderCard(sec: Section) {
    const counts = folderSummary(all, userSections, sec.id, now);
    const isRenaming = renamingSectionId === sec.id;
    return (
      <div key={sec.id} className="section-folder-card">
        {isRenaming ? (
          <div className="inline-rename">
            <input
              autoFocus
              value={renameSectionValue}
              onChange={(e) => setRenameSectionValue(e.target.value)}
              aria-label="Rename section"
            />
            <button
              type="button"
              className="small-btn primary"
              onClick={() => handleSaveRenameSection(sec.id)}
            >
              Save
            </button>
            <button
              type="button"
              className="small-btn"
              onClick={() => setRenamingSectionId(null)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="section-folder-link"
              onClick={() => goTo(sec.id)}
            >
              <span className="section-folder-icon" aria-hidden="true">
                <Icon name="folder" />
              </span>
              <span className="section-folder-title">{sec.name}</span>
              <span className="section-folder-counts">
                {counts.notes} {counts.notes === 1 ? "note" : "notes"} ·{" "}
                {counts.reminders} {counts.reminders === 1 ? "reminder" : "reminders"}
                {counts.subsections > 0
                  ? ` · ${counts.subsections} ${counts.subsections === 1 ? "subsection" : "subsections"}`
                  : ""}
                {counts.dueInside > 0 ? ` · ${counts.dueInside} due` : ""}
              </span>
            </button>
            <div className="section-folder-actions">
              <button
                type="button"
                className="icon-btn"
                aria-label={`Rename ${sec.name}`}
                title="Rename section"
                onClick={() => {
                  setRenamingSectionId(sec.id);
                  setRenameSectionValue(sec.name);
                }}
              >
                <Icon name="edit" />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Delete ${sec.name}`}
                title="Delete section"
                onClick={() => handleDeleteSection(sec)}
              >
                <Icon name="trash" />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const sidebarCounts = {
    due: homeSections.due.length,
    total: all.length,
  };

  function goTo(sectionId: string | null) {
    setActiveSectionId(sectionId);
    setQuery("");
    setNavOpen(false);
    setRenamingSectionId(null);
    setMovingSectionId(null);
    setNewSectionName("");
    const main = document.querySelector(".main");
    if (main) main.scrollTop = 0;
  }

  function goHomeAndScroll(anchor: string) {
    goTo(null);
    // Give Home a tick to render before scrolling to the anchor.
    setTimeout(() => {
      document
        .getElementById(anchor)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  function handleSidebarCreateSection(e: FormEvent) {
    e.preventDefault();
    const name = sidebarSectionName.trim();
    if (!name) return;
    manager.mutate((s) => addSection(s, name, Date.now()).state);
    setSidebarSectionName("");
    setAddingSidebarSection(false);
  }

  const pageTitle =
    activeSectionId === null
      ? "Home"
      : activeSectionObj
        ? activeSectionObj.name
        : "General";
  const pageSub =
    activeSectionId === null
      ? "A clear view of your notes, plans, and what’s next."
      : (() => {
          const c = sectionCounts(all, targetSectionId, now);
          const subs = subSections.length;
          return `${c.notes} ${c.notes === 1 ? "note" : "notes"} · ${c.reminders} ${c.reminders === 1 ? "reminder" : "reminders"}${subs ? ` · ${subs} ${subs === 1 ? "subsection" : "subsections"}` : ""}${c.due ? ` · ${c.due} due` : ""}`;
        })();

  return (
    <div className={"shell" + (navOpen ? " nav-open" : "")}>
      <a className="skip-link" href="#workspace-content">Skip to workspace</a>
      {/* ---- Workspace navigation ---- */}
      <aside ref={sidebarRef} className="sidebar" id="workspace-navigation" aria-label="Navigation" tabIndex={-1}>
        <div className="sidebar-top">
          <Brand />
          <button
            type="button"
            className="icon-btn sidebar-close"
            aria-label="Close menu"
            onClick={() => setNavOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="workspace-profile"><span className="profile-avatar">P</span><div><strong>Personal workspace</strong><span>Your everyday, together</span></div></div>
        <span className="nav-heading">WORKSPACE</span>
        <nav className="sidebar-nav">
          <button
            type="button"
            className={"nav-item" + (activeSectionId === null ? " active" : "")}
            aria-current={activeSectionId === null ? "page" : undefined}
            onClick={() => goTo(null)}
          >
            <span className="nav-icon"><Icon name="home" /></span>
            <span className="nav-label">Overview</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => goHomeAndScroll("calendar")}
          >
            <span className="nav-icon"><Icon name="calendar" /></span>
            <span className="nav-label">Calendar</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => goHomeAndScroll("due")}
          >
            <span className="nav-icon"><Icon name="clock" /></span>
            <span className="nav-label">Due now</span>
            {sidebarCounts.due > 0 && (
              <span className="nav-count due">{sidebarCounts.due}</span>
            )}
          </button>
        </nav>

        <div className="sidebar-group">
          <div className="sidebar-group-head">
            <span>Sections</span>
            <button
              type="button"
              className="icon-btn tiny"
              aria-label="New section"
              title="New section"
              onClick={() => setAddingSidebarSection((v) => !v)}
            >
              +
            </button>
          </div>

          {addingSidebarSection && (
            <form className="sidebar-new-section" onSubmit={handleSidebarCreateSection}>
              <input
                autoFocus
                value={sidebarSectionName}
                onChange={(e) => setSidebarSectionName(e.target.value)}
                placeholder="Section name…"
                maxLength={LIMITS.sectionNameChars}
                aria-label="New section name"
              />
            </form>
          )}

          <nav className="sidebar-nav">
            {(() => {
              // The section tree, depth-first; rows under a folded section are skipped.
              let hiddenBelow = Infinity;
              return sortedSectionTree(userSections, sectionSort).map(({ section: sec, depth, childCount }) => {
                if (depth > hiddenBelow) return null;
                const open = expandedSections.has(sec.id);
                hiddenBelow = childCount > 0 && !open ? depth : Infinity;
                const c = folderSummary(all, userSections, sec.id, now);
                const active = activeSectionId === sec.id;
                // Folded rows count everything inside; unfolded rows just their own items.
                const due = open ? c.due : c.dueInside;
                const items = open ? c.notes + c.reminders : c.itemsInside;
                return (
                  <div
                    key={sec.id}
                    className={"nav-tree-row" + (active ? " active" : "")}
                    style={{ paddingLeft: `${Math.min(depth, 8) * 14}px` }}
                  >
                    {childCount > 0 ? (
                      <button
                        type="button"
                        className={"nav-toggle" + (open ? " open" : "")}
                        aria-label={`${open ? "Fold" : "Unfold"} ${sec.name}`}
                        aria-expanded={open}
                        onClick={() => setExpanded(sec.id, !open)}
                      >
                        ▸
                      </button>
                    ) : (
                      <span className="nav-toggle-spacer" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className={"nav-item" + (active ? " active" : "")}
                      onClick={() => goTo(sec.id)}
                    >
                      <span className="nav-icon"><Icon name="folder" /></span>
                      <span className="nav-label">{sec.name}</span>
                      {due > 0 ? (
                        <span className="nav-count due">{due}</span>
                      ) : items > 0 ? (
                        <span className="nav-count">{items}</span>
                      ) : null}
                    </button>
                  </div>
                );
              });
            })()}
            {(generalCounts.notes > 0 || generalCounts.reminders > 0) && (
              <button
                type="button"
                className={
                  "nav-item" + (activeSectionId === GENERAL_SECTION_ID ? " active" : "")
                }
                onClick={() => goTo(GENERAL_SECTION_ID)}
              >
                <span className="nav-icon"><Icon name="folder" /></span>
                <span className="nav-label">General</span>
                <span className="nav-count">
                  {generalCounts.notes + generalCounts.reminders}
                </span>
              </button>
            )}
            {userSections.length === 0 && generalCounts.notes + generalCounts.reminders === 0 && (
              <p className="sidebar-hint">Create a section to organise your items.</p>
            )}
          </nav>
        </div>

        <div className="sidebar-foot">
          <div className="sidebar-theme-label">APPEARANCE</div>
          <ThemePicker />
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              setSettings(true);
              setNavOpen(false);
            }}
          >
            <span className="nav-icon"><Icon name="settings" /></span>
            <span className="nav-label">Settings</span>
          </button>
          <div className="sidebar-signoff"><Icon name="pocket" /><span>A little more organised.</span></div>
        </div>
      </aside>
      {navOpen && (
        <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}

      {/* ---- Main column: topbar + page ---- */}
      <main className="main" {...(navOpen ? { inert: "" } : {})}>
        <div className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-label="Open menu"
            aria-expanded={navOpen}
            aria-controls="workspace-navigation"
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="crumb" onClick={() => goTo(null)}>
              <Icon name="home" /> <span>Workspace</span>
            </button>
            {activeSectionPath.slice(0, -1).map((s) => (
              <span key={s.id} className="crumb-part">
                <span className="crumb-sep">/</span>
                <button type="button" className="crumb" onClick={() => goTo(s.id)}>
                  {s.name}
                </button>
              </span>
            ))}
            {activeSectionId !== null && (
              <>
                <span className="crumb-sep">/</span>
                <span className="crumb current">{pageTitle}</span>
              </>
            )}
          </nav>
          <div className="topbar-search">
            <span className="search-icon" aria-hidden="true"><Icon name="search" /></span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                activeSectionId
                  ? `Search ${pageTitle}…`
                  : "Search notes & reminders…"
              }
              aria-label="Search notes"
            />
          </div>
          <button
            className={"pill sync " + manager.phase}
            title="Tap to sync now"
            onClick={() => void manager.syncOnce()}
          >
            <span className="pill-dot" aria-hidden="true" />
            {status}
          </button>
        </div>

        <div className="page" id="workspace-content" tabIndex={-1}>
          <div className="page-kicker"><span className="eyebrow">{activeSectionId === null ? "YOUR WORKSPACE, AT A GLANCE" : "YOUR PERSONAL WORKSPACE"}</span><span className="workspace-date">{new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" }).format(now)}</span></div>
          <header className="page-header">
            <div className="page-title-block">
              {renamingSectionId === activeSectionId && activeSectionObj ? (
                <div className="inline-rename">
                  <input
                    autoFocus
                    value={renameSectionValue}
                    onChange={(e) => setRenameSectionValue(e.target.value)}
                    aria-label="Section name"
                  />
                  <button
                    type="button"
                    className="small-btn primary"
                    onClick={() => handleSaveRenameSection(activeSectionObj.id)}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="small-btn"
                    onClick={() => setRenamingSectionId(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  {activeSectionPath.length > 1 && (
                    <nav className="page-parents" aria-label="Inside">
                      <span className="muted">in</span>
                      {activeSectionPath.slice(0, -1).map((p, i) => (
                        <span key={p.id} className="page-parent">
                          {i > 0 && <span className="crumb-sep">›</span>}
                          <button type="button" className="crumb" onClick={() => goTo(p.id)}>
                            {p.name}
                          </button>
                        </span>
                      ))}
                    </nav>
                  )}
                  <h1 className="page-title">{activeSectionId === null ? "Your day, in perspective." : pageTitle}</h1>
                  <p className="page-sub">{pageSub}</p>
                </>
              )}
            </div>
            <button type="button" className="primary new-note-button" aria-expanded={composerOpen} aria-controls="workspace-composer" onClick={openNoteComposer}><Icon name="plus" /> New note</button>
            {activeSectionObj && renamingSectionId !== activeSectionObj.id && (
              <div className="page-actions">
                <button
                  type="button"
                  className="small-btn"
                  onClick={() => {
                    setRenamingSectionId(activeSectionObj.id);
                    setRenameSectionValue(activeSectionObj.name);
                  }}
                >
                  <Icon name="edit" /> Rename
                </button>
                <button
                  type="button"
                  className="small-btn"
                  aria-expanded={movingSectionId === activeSectionObj.id}
                  onClick={() =>
                    setMovingSectionId((cur) =>
                      cur === activeSectionObj.id ? null : activeSectionObj.id,
                    )
                  }
                >
                  <Icon name="folder" /> Move
                </button>
                <button
                  type="button"
                  className="small-btn danger-outline"
                  onClick={() => handleDeleteSection(activeSectionObj)}
                >
                  <Icon name="trash" /> Delete
                </button>
              </div>
            )}
          </header>

          {activeSectionId === null && !searching && (
            <section className="overview-stats" aria-label="Workspace summary">
              <div className="stat-card"><span className="stat-icon"><Icon name="note" /></span><span className="stat-label">Total notes</span><strong>{all.filter((n) => !isReminderItem(n)).length.toString().padStart(2, "0")}</strong><span className="stat-caption">Ideas worth keeping</span></div>
              <div className="stat-card"><span className="stat-icon"><Icon name="clock" /></span><span className="stat-label">Upcoming</span><strong>{homeSections.upcoming.length.toString().padStart(2, "0")}</strong><span className="stat-caption">Reminders on the horizon</span></div>
              <div className={"stat-card" + (homeSections.due.length ? " attention" : "")}><span className="stat-icon"><Icon name="calendar" /></span><span className="stat-label">Due now</span><strong>{homeSections.due.length.toString().padStart(2, "0")}</strong><span className="stat-caption">{homeSections.due.length ? "Ready for your attention" : "You’re all caught up"}</span></div>
              <div className="stat-card"><span className="stat-icon"><Icon name="folder" /></span><span className="stat-label">Sections</span><strong>{userSections.length.toString().padStart(2, "0")}</strong><span className="stat-caption">A place for everything</span></div>
            </section>
          )}

          {activeSectionObj && movingSectionId === activeSectionObj.id && (
            <MoveSectionPanel
              section={activeSectionObj}
              sections={userSections}
              onMove={(parentId) => handleMoveSection(activeSectionObj.id, parentId)}
              onCancel={() => setMovingSectionId(null)}
            />
          )}

          {!isInstalled() &&
            canPromptInstall() &&
            !localStorage.getItem(DISMISS_INSTALL_KEY) && <InstallBanner />}

          {/* Two buttons to choose Note vs Reminder creation */}
          <div className="creator-shell" ref={composerRef} id="workspace-composer" hidden={!composerOpen}>
            <div className="composer-heading"><div><h2>Make space for an idea.</h2><p className="muted small">Capture a note or plan your next reminder.</p></div><button type="button" className="icon-btn" aria-label="Close composer" onClick={closeComposer}><Icon name="close" /></button></div>
            <div className="creator-switcher" role="tablist" aria-label="Choose what to create">
              <button
                type="button"
                role="tab"
                aria-selected={composerKind === "note"}
                className={
                  "creator-mode-btn" + (composerKind === "note" ? " active" : "")
                }
                onClick={() => {
                  setComposerKind("note");
                  setComposerPreselectAt(null);
                }}
              >
                <Icon name="note" /> New Note
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={composerKind === "reminder"}
                className={
                  "creator-mode-btn" + (composerKind === "reminder" ? " active" : "")
                }
                onClick={() => setComposerKind("reminder")}
              >
                <Icon name="clock" /> New Reminder
              </button>
            </div>

            {composerKind === "note" ? (
              <NoteComposer
                key={`note-${composerKey}-${activeSectionId ?? "home"}`}
                defaultSectionId={targetSectionId}
                sections={userSections}
                manager={manager}
              />
            ) : (
              <ReminderComposer
                key={`rem-${composerKey}-${activeSectionId ?? "home"}`}
                defaultSectionId={targetSectionId}
                initialAt={composerPreselectAt}
                initialColor={composerPreselectColor}
                sections={userSections}
                manager={manager}
              />
            )}
          </div>

          {searching ? (
            <SectionBlock title={`Search results (${searchHits.length})`}>
              {searchHits.length === 0 ? (
                <p className="muted center-text">No notes or reminders match that.</p>
              ) : (
                <ul className="notes">
                  {searchHits.map((n) => {
                    const sec = n.sectionId ? (sectionMap.get(n.sectionId) ?? null) : null;
                    return isReminderItem(n)
                      ? renderReminderCard(n, sec)
                      : renderNoteCard(n, sec);
                  })}
                </ul>
              )}
            </SectionBlock>
          ) : activeSectionId !== null ? (
            /* ---- INSIDE A SECTION FOLDER VIEW ---- */
            <>
              {activeSectionObj && renderSectionsPanel(subSections, false)}
              <SectionFolderContent
                allNotes={all}
                sectionId={targetSectionId}
                sectionName={activeSectionObj ? activeSectionObj.name : "General"}
                hasSubsections={subSections.length > 0}
                noteSort={noteSort}
                onNoteSortChange={changeNoteSort}
                renderReminderCard={(n) => renderReminderCard(n, null)}
                renderNoteCard={(n) => renderNoteCard(n, null)}
              />
            </>
          ) : (
            /* ---- HOME VIEW ---- */
            <>
              <SectionBlock title="Needs your attention" tone={homeSections.due.length ? "due" : undefined} id="due">
                {homeSections.due.length > 0 ? (
                  <ul className="notes">
                    {homeSections.due.map((n) =>
                      renderReminderCard(
                        n,
                        n.sectionId ? (sectionMap.get(n.sectionId) ?? null) : null,
                      ),
                    )}
                  </ul>
                ) : <div className="all-clear"><span className="all-clear-icon"><Icon name="check" /></span><div><strong>All clear. A little room to focus.</strong><p>No reminders due right now. Plan ahead with your calendar below.</p></div><button type="button" className="small-btn" onClick={() => openReminderComposerForDate(Date.now() + 3600000, DEFAULT_REMINDER_COLOR)}><Icon name="plus" /> Add reminder</button></div>}
              </SectionBlock>

              {/* Sections (Folders) gallery */}
              {renderSectionsPanel(topSections, true)}

              <section className="recent-notes" aria-label="Recent notes">
                <div className="block-head"><h2 className="block-title">Recent notes</h2><span className="muted small">Pick up where you left off</span></div>
                {all.some((n) => !isReminderItem(n)) ? <ul className="notes">{all.filter((n) => !isReminderItem(n)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4).map((n) => renderNoteCard(n, n.sectionId ? sectionMap.get(n.sectionId) : null))}</ul> : <div className="workspace-empty"><span className="empty-icon"><Icon name="note" /></span><h3>Your next idea starts here.</h3><p>From a passing thought to a bigger plan. Give it a place to grow.</p><button type="button" className="small-btn" onClick={openNoteComposer}>Create your first note <Icon name="arrow" /></button></div>}
              </section>

              {/* Reminders calendar with colour coding & filtering */}
              <div id="calendar">
                <ReminderCalendar
                  accounts={manager.state.calendarAccounts}
                  accountControls={<CalendarAccounts manager={manager} />}
                  notes={all}
                  sections={pathNamedSections}
                  now={now}
                  colorFilter={colorFilter}
                  onColorFilterChange={setColorFilter}
                  onSelectSection={(secId) => goTo(secId)}
                  onQuickAddReminderForDate={openReminderComposerForDate}
                  renderReminderCard={renderReminderCard}
                />
              </div>
            </>
          )}
        </div>
      </main>

      {/* Full Interactive Note Modal ("interact further") */}
      {expandedNote && (
        <NoteDetailModal
          note={expandedNote}
          now={now}
          section={
            expandedNote.sectionId
              ? (sectionMap.get(expandedNote.sectionId) ?? null)
              : null
          }
          manager={manager}
          onClose={() => setExpandedNoteId(null)}
          onEdit={() => {
            setEditing(expandedNote.id);
            setExpandedNoteId(null);
          }}
          onViewImage={(img) => setLightboxImage(img)}
        />
      )}

      {/* Fullscreen Image Lightbox */}
      {lightboxImage && (
        <div
          className="overlay"
          ref={lightboxRef}
          tabIndex={-1}
          aria-modal="true"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-label="Image preview"
        >
          <div className="lightbox-box" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxImage} alt="Note attachment full view" />
            <button
              type="button"
              className="primary small-btn"
              onClick={() => setLightboxImage(null)}
            >
              Close preview
            </button>
          </div>
        </div>
      )}

      {settings && (
        <Settings
          cfg={manager.cfg}
          manager={manager}
          onClose={() => setSettings(false)}
          onNewCfg={onNewCfg}
        />
      )}
    </div>
  );
}

/* ---- Section Folder View Contents ---- */

function SectionFolderContent({
  allNotes,
  sectionId,
  sectionName,
  hasSubsections = false,
  noteSort,
  onNoteSortChange,
  renderReminderCard,
  renderNoteCard,
}: {
  allNotes: Note[];
  sectionId: string | null;
  sectionName: string;
  hasSubsections?: boolean;
  noteSort: NoteSortOrder;
  onNoteSortChange: (order: NoteSortOrder) => void;
  renderReminderCard: (n: Note) => ReactNode;
  renderNoteCard: (n: Note) => ReactNode;
}) {
  const { reminders, notes } = itemsInSection(allNotes, sectionId, noteSort);

  if (reminders.length === 0 && notes.length === 0) {
    return (
      <ul className="notes">
        <li className="note empty">
          No notes or reminders {hasSubsections ? "directly " : ""}in <b>{sectionName}</b> yet.
          <br />
          Use the <b>New Note</b> or <b>New Reminder</b> buttons above to add one!
        </li>
      </ul>
    );
  }

  return (
    <>
      {reminders.length > 0 && (
        <SectionBlock title={`Reminders (${reminders.length})`}>
          <ul className="notes">
            {reminders.map((r) => renderReminderCard(r))}
          </ul>
        </SectionBlock>
      )}
      {notes.length > 0 && (
        <SectionBlock
          title={`Notes (${notes.length})`}
          action={
            notes.length > 1 ? (
              <SortControl
                label="Sort notes"
                value={noteSort}
                options={NOTE_SORT_OPTIONS}
                onChange={onNoteSortChange}
              />
            ) : undefined
          }
        >
          <ul className="notes">{notes.map((n) => renderNoteCard(n))}</ul>
        </SectionBlock>
      )}
    </>
  );
}

/* ---- Nested section helpers ---- */

/** Indented <option>s for every section, subsections under their parents. */
function SectionTreeOptions({
  sections,
  exclude,
}: {
  sections: Section[];
  /** Section ids to leave out (e.g. a section can't be moved inside itself). */
  exclude?: ReadonlySet<string>;
}) {
  return (
    <>
      {flattenSectionTree(sections)
        .filter((r) => !exclude?.has(r.section.id))
        .map(({ section, depth }) => (
          <option key={section.id} value={section.id}>
            {"\u00a0\u00a0\u00a0".repeat(depth)}
            {depth > 0 ? "└ " : ""}
            {section.name}
          </option>
        ))}
    </>
  );
}

/** "Move this section into…" picker shown under a section's page header. */
function MoveSectionPanel({
  section,
  sections,
  onMove,
  onCancel,
}: {
  section: Section;
  sections: Section[];
  onMove: (parentId: string | null) => void;
  onCancel: () => void;
}) {
  const current = section.parentId && sections.some((s) => s.id === section.parentId)
    ? section.parentId
    : null;
  const [target, setTarget] = useState<string>(current ?? "");
  // Can't move a section inside itself or inside one of its own subsections.
  const exclude = new Set([section.id, ...descendantSectionIds(sections, section.id)]);
  const targetId = target || null;
  const unchanged = targetId === current;
  const allowed = canMoveSection(sections, section.id, targetId);
  return (
    <form
      className="move-section-panel"
      onSubmit={(e) => {
        e.preventDefault();
        if (!unchanged && allowed) onMove(targetId);
      }}
    >
      <label>
        <span className="move-section-label">
          Move <b>{section.name}</b> (and everything in it) into:
        </span>
        <select
          className="section-select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="New parent section"
        >
          <option value="">Top level (no parent)</option>
          <SectionTreeOptions sections={sections} exclude={exclude} />
        </select>
      </label>
      <div className="move-section-actions">
        <button type="submit" className="small-btn primary" disabled={unchanged || !allowed}>
          Move here
        </button>
        <button type="button" className="small-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ---- Note Composer (Large: Title, Large Body, Image Uploads, Interactive Checklist, Pin) ---- */

function NoteComposer({
  defaultSectionId,
  sections,
  manager,
}: {
  defaultSectionId: string | null;
  sections: Section[];
  manager: SyncManager;
}) {
  const [draft] = useState(loadNoteDraft);
  const [saved, setSaved] = useState(false);
  const [title, setTitle] = useState(draft?.title ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [sectionId, setSectionId] = useState<string | null>(defaultSectionId);
  const [images, setImages] = useState<string[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>(draft?.checklist ?? []);
  const [newTaskText, setNewTaskText] = useState("");
  const [showChecklistBuilder, setShowChecklistBuilder] = useState(
    (draft?.checklist.length ?? 0) > 0,
  );
  const [pinned, setPinned] = useState(draft?.pinned ?? false);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the unsaved note on this device as it's written.
  const hasDraft = title.trim() !== "" || body.trim() !== "" || checklist.length > 0;
  useEffect(() => {
    const t = setTimeout(() => {
      saveNoteDraft({ title, body, checklist, pinned });
      setDraftSavedAt(hasDraft ? Date.now() : null);
    }, 400);
    return () => clearTimeout(t);
  }, [title, body, checklist, pinned, hasDraft]);

  function discardDraft() {
    if (!confirm("Discard this unsaved note?")) return;
    setSaved(false);
    setTitle("");
    setBody("");
    setChecklist([]);
    setImages([]);
    setPinned(false);
    setNewTaskText("");
    saveNoteDraft({ title: "", body: "", checklist: [], pinned: false });
    setDraftSavedAt(null);
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    setImgErr(null);
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    if (images.length + files.length > LIMITS.maxImagesPerNote) {
      setImgErr(`You can attach up to ${LIMITS.maxImagesPerNote} images per note.`);
      return;
    }
    try {
      const converted: string[] = [];
      for (const f of files) {
        converted.push(await fileToDataUrl(f));
      }
      setImages((prev) => [...prev, ...converted]);
    } catch (err) {
      setImgErr(err instanceof Error ? err.message : "Could not upload image.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function addChecklistItem() {
    const t = newTaskText.trim();
    if (!t) return;
    setChecklist((prev) => [...prev, { id: uid(), text: t, done: false }]);
    setNewTaskText("");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save();
  }

  function save() {
    // Without a title, the first line becomes one (minus any formatting marks).
    const firstLine = toPlainText(body.split("\n").find((l) => l.trim()) ?? "");
    const finalTitle = (title.trim() || firstLine.trim()).slice(0, LIMITS.noteTitleChars);
    if (!finalTitle && !body.trim() && images.length === 0) return;
    manager.mutate(
      (s) =>
        createNoteItem(
          s,
          {
            title: finalTitle || "Untitled note",
            body,
            sectionId,
            images,
            checklist,
            pinned,
          },
          Date.now(),
        ).state,
    );
    setSaved(true);
    setTitle("");
    setBody("");
    setImages([]);
    setChecklist([]);
    setNewTaskText("");
    setPinned(false);
    setImgErr(null);
    saveNoteDraft({ title: "", body: "", checklist: [], pinned: false });
    setDraftSavedAt(null);
  }

  const canSubmit =
    title.trim().length > 0 || body.trim().length > 0 || images.length > 0;

  return (
    <form className="composer note-composer" onSubmit={submit}>
      {saved && <p className="save-feedback" role="status"><Icon name="check" /> Note added to your workspace.</p>}
      <div className="composer-header-row">
        <span className="composer-badge note-badge"><Icon name="note" /> Note</span>
        {sections.length > 0 && (
          <select
            className="section-select"
            value={sectionId ?? ""}
            onChange={(e) => setSectionId(e.target.value || null)}
            aria-label="Note section"
          >
            <option value="">General (No section)</option>
            <SectionTreeOptions sections={sections} />
          </select>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => { setTitle(e.target.value); setSaved(false); }}
        placeholder="Note title…"
        maxLength={LIMITS.noteTitleChars}
        aria-label="Note title"
      />

      <RichTextEditor
        value={body}
        onChange={setBody}
        placeholder="Write your note… Use the toolbar or type **bold**, # Heading, - list, - [ ] task"
        minRows={5}
        maxLength={LIMITS.noteBodyChars}
        ariaLabel="Note body"
        focusTitle={title}
        onSubmitShortcut={() => {
          if (canSubmit) save();
        }}
      />

      {/* Uploaded image previews */}
      {images.length > 0 && (
        <div className="image-preview-grid">
          {images.map((src, idx) => (
            <div key={idx} className="image-thumb-wrap">
              <img src={src} alt={`Attachment ${idx + 1}`} />
              <button
                type="button"
                className="remove-img-btn"
                aria-label="Remove image"
                onClick={() =>
                  setImages((prev) => prev.filter((_, i) => i !== idx))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {imgErr && <p className="err small" role="alert">{imgErr}</p>}

      {/* Interactive Checklist Builder */}
      {showChecklistBuilder && (
        <div className="checklist-builder">
          <div className="composer-row">
            <input
              value={newTaskText}
              onChange={(e) => setNewTaskText(e.target.value)}
              placeholder="Add an interactive checklist task…"
              aria-label="Checklist item text"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addChecklistItem();
                }
              }}
            />
            <button
              type="button"
              className="small-btn"
              onClick={addChecklistItem}
            >
              + Add Task
            </button>
          </div>
          {checklist.length > 0 && (
            <ul className="checklist-list">
              {checklist.map((item) => (
                <li key={item.id} className="checklist-row">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() =>
                      setChecklist((prev) =>
                        prev.map((c) =>
                          c.id === item.id ? { ...c, done: !c.done } : c,
                        ),
                      )
                    }
                  />
                  <span>{item.text}</span>
                  <button
                    type="button"
                    className="icon"
                    onClick={() =>
                      setChecklist((prev) =>
                        prev.filter((c) => c.id !== item.id),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Note Composer Toolbar & Submit */}
      <div className="composer-footer">
        <div className="composer-tools">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleFiles}
            aria-label="Upload images"
          />
          <button
            type="button"
            className="small-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="image" /> Upload Image{images.length > 0 ? ` (${images.length})` : ""}
          </button>
          <button
            type="button"
            className={
              "small-btn" + (showChecklistBuilder ? " active-tab" : "")
            }
            onClick={() => setShowChecklistBuilder((v) => !v)}
          >
            <Icon name="list" /> Checklist{checklist.length > 0 ? ` (${checklist.length})` : ""}
          </button>
          <button
            type="button"
            className={"small-btn" + (pinned ? " active-tab" : "")}
            onClick={() => setPinned((p) => !p)}
            aria-pressed={pinned}
          >
            <Icon name="pin" /> {pinned ? "Pinned" : "Pin"}
          </button>
        </div>

        <div className="composer-submit">
          {draftSavedAt != null && (
            <span className="muted small draft-status" title="Unsaved notes are kept on this device until you add or discard them">
              <Icon name="note" /> Draft kept on this device ·{" "}
              <button type="button" className="linklike inline-link" onClick={discardDraft}>
                Discard
              </button>
            </span>
          )}
          <button className="primary" type="submit" disabled={!canSubmit} title="Add note (Ctrl+Enter)">
            Add Note
          </button>
        </div>
      </div>
    </form>
  );
}

/* ---- Reminder Composer (Small: Title, Short Body, Location Tab, Due Picker, Colour Picker) ---- */

function ReminderComposer({
  defaultSectionId,
  initialAt,
  initialColor,
  sections,
  manager,
}: {
  defaultSectionId: string | null;
  initialAt: number | null;
  initialColor: ReminderColorId;
  sections: Section[];
  manager: SyncManager;
}) {
  const [saved, setSaved] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [location, setLocation] = useState("");
  const [activeTab, setActiveTab] = useState<"due" | "location" | "color">("due");
  const [color, setColor] = useState<ReminderColorId>(
    () => normalizeReminderColor(initialColor) ?? DEFAULT_REMINDER_COLOR,
  );
  const [sectionId, setSectionId] = useState<string | null>(defaultSectionId);
  const [pickerKey, setPickerKey] = useState(0);
  const [rem, setRem] = useState<ReminderValue>(() => ({
    at: initialAt ?? quickReminders(Date.now())[1].at,
    error: null,
    repeat: "none",
  }));

  const now = Date.now();
  const remError =
    rem.error ??
    (rem.at == null
      ? "Pick when this reminder is due."
      : rem.at <= now
        ? "That time has already passed."
        : null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || remError || rem.at == null) return;
    manager.mutate(
      (s) =>
        createReminderItem(
          s,
          {
            title: t,
            body: body.trim(),
            location: location.trim() || null,
            reminderAt: rem.at!,
            color,
            sectionId,
            repeat: rem.repeat,
          },
          Date.now(),
        ).state,
    );
    setSaved(true);
    setTitle("");
    setBody("");
    setLocation("");
    const nextDefault = quickReminders(Date.now())[1].at;
    setRem({ at: nextDefault, error: null, repeat: "none" });
    setPickerKey((k) => k + 1);
  }

  const selectedColorDef = getReminderColor(color);

  return (
    <form
      className="composer reminder-composer"
      style={{ borderLeft: `4px solid ${selectedColorDef.hex}` }}
      onSubmit={submit}
    >
      {saved && <p className="save-feedback" role="status"><Icon name="check" /> Reminder added to your calendar.</p>}
      <div className="composer-header-row">
        <span
          className="composer-badge reminder-badge"
          style={{
            backgroundColor: `color-mix(in srgb, ${selectedColorDef.hex} 14%, var(--card))`,
            borderColor: `color-mix(in srgb, ${selectedColorDef.hex} 40%, var(--line))`,
          }}
        >
          <Icon name="clock" /> Reminder · {selectedColorDef.label}
        </span>
        {sections.length > 0 && (
          <select
            className="section-select"
            value={sectionId ?? ""}
            onChange={(e) => setSectionId(e.target.value || null)}
            aria-label="Reminder section"
          >
            <option value="">General (No section)</option>
            <SectionTreeOptions sections={sections} />
          </select>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => { setTitle(e.target.value); setSaved(false); }}
        placeholder="Reminder title (e.g. Call dentist, Pick up parcel)…"
        maxLength={LIMITS.noteTitleChars}
        aria-label="Reminder title"
      />

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Short body text (optional)…"
        rows={2}
        maxLength={LIMITS.reminderBodyChars}
        aria-label="Reminder short body"
      />

      {/* Reminder Option Tabs: Due Time | Location Tab | Colour */}
      <div className="reminder-tabs-bar" role="tablist" aria-label="Reminder details tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "due"}
          className={"small-btn" + (activeTab === "due" ? " active-tab" : "")}
          onClick={() => setActiveTab("due")}
        >
          <Icon name="clock" /> When it's due
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "location"}
          className={
            "small-btn" + (activeTab === "location" ? " active-tab" : "")
          }
          onClick={() => setActiveTab("location")}
        >
          <Icon name="location" /> Location{location.trim() ? `: ${location.trim()}` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "color"}
          className={"small-btn" + (activeTab === "color" ? " active-tab" : "")}
          onClick={() => setActiveTab("color")}
        >
          <span
            className="color-dot"
            style={{ backgroundColor: selectedColorDef.hex }}
          />{" "}
          Colour: {selectedColorDef.label}
        </button>
      </div>

      {/* Tab Content Panels */}
      {activeTab === "due" && (
        <div className="reminder-tab-panel">
          <ReminderPicker
            key={pickerKey}
            initial={initialAt}
            allowNone={false}
            onChange={setRem}
          />
        </div>
      )}

      {activeTab === "location" && (
        <div className="reminder-tab-panel location-tab-panel">
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Enter location (e.g. Main St Pharmacy, Room 302)…"
            maxLength={LIMITS.locationChars}
            aria-label="Reminder location"
          />
          <div className="location-presets">
            {PRESET_LOCATIONS.map((loc) => (
              <button
                key={loc}
                type="button"
                className={
                  "preset-pill" + (location === loc ? " active" : "")
                }
                onClick={() =>
                  setLocation((cur) => (cur === loc ? "" : loc))
                }
              >
                <Icon name="location" /> {loc}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === "color" && (
        <div className="reminder-tab-panel">
          {/* The tab above already names the chosen colour. */}
          <ColorPicker
            value={color}
            original={initialColor}
            showName={false}
            onChange={setColor}
          />
        </div>
      )}

      {remError && <p className="err small" role="alert">{remError}</p>}

      <div className="composer-footer">
        <span className="muted small">
          {location.trim() ? location.trim() : "Tip: Use the Location & Colour tabs above"}
        </span>
        <button
          className="primary"
          type="submit"
          disabled={!title.trim() || !!remError}
        >
          Add Reminder
        </button>
      </div>
    </form>
  );
}

/* ---- Compact Reminder Card ---- */

export function ReminderCard({
  note,
  now,
  sectionBadge,
  onOpenSection,
  manager,
  onEdit,
}: {
  note: Note;
  now: number;
  sectionBadge?: Section | null;
  onOpenSection?: (sectionId: string) => void;
  manager: SyncManager;
  onEdit: () => void;
}) {
  const isDue = note.reminderAt != null && note.reminderAt <= now;
  const meta = reminderMeta(note, now);
  const col = getReminderColor(note.color);
  const title = itemTitle(note);
  const body = itemBody(note);

  return (
    <li
      className={"note reminder-card" + (isDue ? " is-due" : "")}
      style={{ borderLeft: `4px solid ${col.hex}` }}
    >
      <div className="reminder-card-header">
        <span
          className="color-tag"
          style={{ backgroundColor: `color-mix(in srgb, ${col.hex} 14%, var(--card))`, borderColor: `color-mix(in srgb, ${col.hex} 40%, var(--line))` }}
        >
          <span className="color-dot" style={{ backgroundColor: col.hex }} />
          {col.label}
        </span>
        {note.location && (
          <span className="location-badge" title="Location">
            <Icon name="location" /> {note.location}
          </span>
        )}
        {note.source === "gcal" && (
          <span
            className="location-badge source-badge"
            title="Imported from Google Calendar. Changes there update this reminder."
          >
            <Icon name="calendar" /> Google Calendar
          </span>
        )}
        {note.source === "classroom" && (
          <span
            className="location-badge source-badge"
            title="Imported from Google Classroom. Teacher changes update this deadline; marking done here does not submit work."
          >
            <Icon name="note" /> Google Classroom
          </span>
        )}
        {sectionBadge && onOpenSection && (
          <button
            type="button"
            className="section-tag-btn"
            onClick={() => onOpenSection(sectionBadge.id)}
            title={`Open section ${sectionBadge.name}`}
          >
            <Icon name="folder" /> {sectionBadge.name}
          </button>
        )}
      </div>

      <div className="item-title">{title}</div>
      {body && (note.source === "classroom"
        ? <MarkdownView source={body} className="reminder-body" />
        : <div className="reminder-body">{body}</div>)}

      <div className="meta">
        {meta ? meta : "Completed"}
        {isDue ? " · due now" : ""}
        {" · "}
        {shortAgo(note.updatedAt, now)}
      </div>

      <div className="actions">
        {note.reminderAt != null && (
          <button
            className="icon"
            aria-label="Mark done"
            title={
              note.repeat && note.repeat !== "none"
                ? "Done — moves to the next repeat"
                : "Done — clears the reminder"
            }
            onClick={() =>
              manager.mutate((s) => markReminderDone(s, note.id, Date.now()))
            }
          >
            <Icon name="check" />
          </button>
        )}
        <button className="icon" aria-label="Edit" onClick={onEdit}>
          <Icon name="edit" />
        </button>
        <button
          className="icon"
          aria-label="Delete"
          onClick={() => {
            if (confirm("Delete this reminder everywhere?")) {
              manager.mutate((s) => deleteNote(s, note.id, Date.now()));
            }
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

/* ---- Large Interactive Note Card ---- */

function LargeNoteCard({
  note,
  now,
  sectionBadge,
  onOpenSection,
  manager,
  onEdit,
  onExpand,
  onViewImage,
  highlight,
}: {
  note: Note;
  now: number;
  sectionBadge?: Section | null;
  onOpenSection?: (sectionId: string) => void;
  manager: SyncManager;
  onEdit: () => void;
  onExpand: () => void;
  onViewImage: (src: string) => void;
  highlight?: string;
}) {
  const title = itemTitle(note);
  const body = itemBody(note);
  const bodyTasks = taskProgress(body);
  const images = note.images ?? [];
  const checklist = note.checklist ?? [];
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [quickTask, setQuickTask] = useState("");
  const [addingTask, setAddingTask] = useState(false);

  function toggleChecklistItem(itemId: string) {
    const nextList = checklist.map((c) =>
      c.id === itemId ? { ...c, done: !c.done } : c,
    );
    manager.mutate((s) =>
      updateItem(s, note.id, { checklist: nextList }, Date.now()),
    );
  }

  function addQuickTask(e: FormEvent) {
    e.preventDefault();
    const t = quickTask.trim();
    if (!t) return;
    const nextList = [...checklist, { id: uid(), text: t, done: false }];
    manager.mutate((s) =>
      updateItem(s, note.id, { checklist: nextList }, Date.now()),
    );
    setQuickTask("");
    setAddingTask(false);
  }

  async function handleAddImage(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    try {
      const added: string[] = [];
      for (const f of files.slice(0, LIMITS.maxImagesPerNote - images.length)) {
        added.push(await fileToDataUrl(f));
      }
      if (added.length > 0) {
        manager.mutate((s) =>
          updateItem(
            s,
            note.id,
            { images: [...images, ...added] },
            Date.now(),
          ),
        );
      }
    } catch {
      /* ignore invalid file */
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <li className={"note large-note-card" + (note.pinned ? " is-pinned" : "")}>
      <div className="large-note-top">
        <div className="large-note-badges">
          <span className="note-type-pill"><Icon name="note" /> Note</span>
          {note.pinned && <span className="pin-badge"><Icon name="pin" /> Pinned</span>}
          {sectionBadge && onOpenSection && (
            <button
              type="button"
              className="section-tag-btn"
              onClick={() => onOpenSection(sectionBadge.id)}
            >
              <Icon name="folder" /> {sectionBadge.name}
            </button>
          )}
        </div>
        <div className="actions">
          <button
            className="icon"
            aria-label={note.pinned ? "Unpin note" : "Pin note"}
            title={note.pinned ? "Unpin note" : "Pin to top"}
            onClick={() =>
              manager.mutate((s) =>
                updateItem(s, note.id, { pinned: !note.pinned }, Date.now()),
              )
            }
          >
            <Icon name="pin" />
          </button>
          <button
            className="icon"
            aria-label="Expand note"
            title="Open full note view"
            onClick={onExpand}
          >
            <Icon name="search" />
          </button>
          <button className="icon" aria-label="Edit" onClick={onEdit}>
            <Icon name="edit" />
          </button>
          <button
            className="icon"
            aria-label="Delete"
            onClick={() => {
              if (confirm("Delete this note everywhere?")) {
                manager.mutate((s) => deleteNote(s, note.id, Date.now()));
              }
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <h3 className="large-note-title">
        <button type="button" className="note-title-link" onClick={onExpand}>{title}</button>
      </h3>

      {body && (
        <MarkdownView
          source={body}
          className="large-note-body"
          highlight={highlight}
          onToggleTask={(line) =>
            manager.mutate((s) =>
              updateItem(s, note.id, { body: toggleTaskLine(body, line) }, Date.now()),
            )
          }
        />
      )}

      {/* Interactive Checklist on Note Card */}
      {checklist.length > 0 && (
        <ul className="note-checklist">
          {checklist.map((item) => (
            <li
              key={item.id}
              className={"note-checklist-item" + (item.done ? " done" : "")}
            >
              <label>
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => toggleChecklistItem(item.id)}
                />
                <span>{item.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {/* Uploaded Images Gallery on Note Card */}
      {images.length > 0 && (
        <div className="note-images-grid">
          {images.map((src, i) => (
            <button
              key={i}
              type="button"
              className="note-image-btn"
              onClick={() => onViewImage(src)}
              title="Click to view full image"
            >
              <img src={src} alt={`${title} attachment ${i + 1}`} />
            </button>
          ))}
        </div>
      )}

      {addingTask && (
        <form className="quick-task-form" onSubmit={addQuickTask}>
          <input
            autoFocus
            value={quickTask}
            onChange={(e) => setQuickTask(e.target.value)}
            placeholder="New checklist item…"
          />
          <button type="submit" className="small-btn primary">
            Add
          </button>
          <button
            type="button"
            className="small-btn"
            onClick={() => setAddingTask(false)}
          >
            Cancel
          </button>
        </form>
      )}

      <div className="large-note-footer">
        <span className="meta">
          {shortAgo(note.updatedAt, now)}
          {bodyTasks.total > 0 && (
            <span className="task-progress" title="Tasks ticked in this note">
              {" "}· ☑ {bodyTasks.done}/{bodyTasks.total}
            </span>
          )}
        </span>
        <div className="note-interact-bar">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleAddImage}
          />
          {images.length < LIMITS.maxImagesPerNote && (
            <button
              type="button"
              className="interact-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="image" /> + Image
            </button>
          )}
          <button
            type="button"
            className="interact-btn"
            onClick={() => setAddingTask((v) => !v)}
          >
            <Icon name="list" /> + Task
          </button>
          <button type="button" className="interact-btn" onClick={onExpand}>
            <Icon name="expand" /> Open note
          </button>
        </div>
      </div>
    </li>
  );
}

/* ---- Full Interactive Note Detail Modal ---- */

function NoteDetailModal({
  note,
  now,
  section,
  manager,
  onClose,
  onEdit,
  onViewImage,
}: {
  note: Note;
  now: number;
  section: Section | null;
  manager: SyncManager;
  onClose: () => void;
  onEdit: () => void;
  onViewImage: (src: string) => void;
}) {
  const dialogRef = useDialog(onClose);
  const title = itemTitle(note);
  const body = itemBody(note);
  const images = note.images ?? [];
  const checklist = note.checklist ?? [];
  const [newTask, setNewTask] = useState("");
  const [copied, setCopied] = useState<"md" | "plain" | null>(null);
  const bodyTasks = taskProgress(body);

  function toggleTask(id: string) {
    const next = checklist.map((c) =>
      c.id === id ? { ...c, done: !c.done } : c,
    );
    manager.mutate((s) =>
      updateItem(s, note.id, { checklist: next }, Date.now()),
    );
  }

  function addTask(e: FormEvent) {
    e.preventDefault();
    const t = newTask.trim();
    if (!t) return;
    const next = [...checklist, { id: uid(), text: t, done: false }];
    manager.mutate((s) =>
      updateItem(s, note.id, { checklist: next }, Date.now()),
    );
    setNewTask("");
  }

  async function copyContent(kind: "md" | "plain") {
    const text =
      kind === "md" ? `# ${title}\n\n${body}` : `${title}\n\n${toPlainText(body)}`;
    try {
      await navigator.clipboard?.writeText(text.trim());
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
    }
  }

  function downloadNote() {
    const tasks = checklist.length
      ? "\n\n" + checklist.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n")
      : "";
    const text = `# ${title}\n\n${body.trim()}${tasks}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = safeFileName(title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toggleBodyTask(line: number) {
    manager.mutate((s) =>
      updateItem(s, note.id, { body: toggleTaskLine(body, line) }, Date.now()),
    );
  }

  const stats = textStats(body);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="card modal note-detail-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="note-detail-header">
          <div>
            {section && (
              <span className="section-tag-btn"><Icon name="folder" /> {section.name}</span>
            )}
            <h2>{title}</h2>
            <p className="muted small">
              Updated {shortAgo(note.updatedAt, now)} · {stats.words}{" "}
              {stats.words === 1 ? "word" : "words"}
              {stats.readingMinutes ? ` · ${stats.readingMinutes} min read` : ""}
              {bodyTasks.total > 0 ? ` · ☑ ${bodyTasks.done}/${bodyTasks.total} tasks` : ""}
            </p>
          </div>
          <div className="row">
            <button type="button" className="icon-btn" aria-label="Close note" onClick={onClose}><Icon name="close" /></button>
            <button
              type="button"
              className="small-btn"
              onClick={() => void copyContent("plain")}
              title="Copy the note as plain text, without formatting marks"
            >
              {copied === "plain" ? "✓ Copied" : "Copy text"}
            </button>
            <button
              type="button"
              className="small-btn"
              onClick={() => void copyContent("md")}
              title="Copy the note with its Markdown formatting"
            >
              {copied === "md" ? "✓ Copied" : "Copy Markdown"}
            </button>
            <button
              type="button"
              className="small-btn"
              onClick={downloadNote}
              title="Download this note as a Markdown (.md) file"
            >
              <Icon name="download" /> Download
            </button>
            <button type="button" className="small-btn primary" onClick={onEdit}>
              <Icon name="edit" /> Edit
            </button>
          </div>
        </div>

        {body && (
          <MarkdownView
            source={body}
            className="note-detail-body"
            onToggleTask={toggleBodyTask}
          />
        )}

        {images.length > 0 && (
          <div className="note-detail-images">
            <h3>Attached Images ({images.length})</h3>
            <div className="note-images-grid">
              {images.map((src, i) => (
                <button
                  key={i}
                  type="button"
                  className="note-image-btn"
                  onClick={() => onViewImage(src)}
                >
                  <img src={src} alt={`Attachment ${i + 1}`} />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="note-detail-checklist">
          <h3>Interactive Checklist</h3>
          {checklist.length > 0 && (
            <ul className="note-checklist">
              {checklist.map((item) => (
                <li
                  key={item.id}
                  className={"note-checklist-item" + (item.done ? " done" : "")}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={item.done}
                      onChange={() => toggleTask(item.id)}
                    />
                    <span>{item.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form className="quick-task-form" onSubmit={addTask}>
            <input
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              placeholder="Add an interactive task to this note…"
            />
            <button type="submit" className="small-btn primary" disabled={!newTask.trim()}>
              + Add
            </button>
          </form>
        </div>

        <button className="linklike done" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/* ---- Edit Row (for both Notes and Reminders) ---- */

function EditItemRow({
  note,
  sections,
  manager,
  done,
}: {
  note: Note;
  sections: Section[];
  manager: SyncManager;
  done: () => void;
}) {
  const isRem = isReminderItem(note);
  const [title, setTitle] = useState(() => itemTitle(note));
  const [body, setBody] = useState(() => itemBody(note));
  const [location, setLocation] = useState(note.location ?? "");
  const [color, setColor] = useState<ReminderColorId>(
    () => normalizeReminderColor(note.color) ?? DEFAULT_REMINDER_COLOR,
  );
  const [sectionId, setSectionId] = useState<string | null>(
    note.sectionId ?? null,
  );
  const [images, setImages] = useState<string[]>(note.images ?? []);
  const [rem, setRem] = useState<ReminderValue>({
    at: note.reminderAt,
    error: null,
    repeat: note.reminderAt != null ? (note.repeat ?? "none") : "none",
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const saveable = title.trim().length > 0 && (!isRem || !rem.error);
  const initialBody = useRef(itemBody(note));
  const initialTitle = useRef(itemTitle(note));

  function cancel() {
    const changed =
      body !== initialBody.current ||
      title !== initialTitle.current ||
      images.length !== (note.images ?? []).length;
    if (changed && !confirm("Discard your changes to this note?")) return;
    done();
  }

  async function handleFiles(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const f of files.slice(0, LIMITS.maxImagesPerNote - images.length)) {
      try {
        const dataUrl = await fileToDataUrl(f);
        setImages((prev) => [...prev, dataUrl]);
      } catch {
        /* ignore */
      }
    }
  }

  function save() {
    if (!saveable) return;
    manager.mutate((s) =>
      updateItem(
        s,
        note.id,
        {
          title: title.trim(),
          body: isRem ? body.trim() : body,
          sectionId,
          location: isRem ? location.trim() || null : null,
          color: isRem ? color : null,
          images: isRem ? [] : images,
          reminderAt: isRem ? rem.at : null,
          repeat: isRem && rem.at != null ? rem.repeat : null,
        },
        Date.now(),
      ),
    );
    done();
  }

  return (
    <li className="note editing">
      <div className="composer-header-row">
        <span className="composer-badge">
          {isRem ? "Edit Reminder" : "Edit Note"}
        </span>
        {sections.length > 0 && (
          <select
            className="section-select"
            value={sectionId ?? ""}
            onChange={(e) => setSectionId(e.target.value || null)}
          >
            <option value="">General</option>
            <SectionTreeOptions sections={sections} />
          </select>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title…"
        aria-label="Edit title"
      />

      {isRem ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="Short body…"
          aria-label="Edit body"
        />
      ) : (
        <RichTextEditor
          value={body}
          onChange={setBody}
          minRows={6}
          maxLength={LIMITS.noteBodyChars}
          placeholder="Note body…"
          ariaLabel="Edit body"
          focusTitle={title}
          onSubmitShortcut={save}
        />
      )}

      {isRem ? (
        <>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Location (optional)…"
            aria-label="Edit location"
          />
          <ColorPicker value={color} original={note.color} onChange={setColor} />
          <ReminderPicker
            initial={note.reminderAt}
            initialRepeat={note.repeat ?? "none"}
            onChange={setRem}
          />
          {rem.error && <p className="err small" role="alert">{rem.error}</p>}
        </>
      ) : (
        <>
          {images.length > 0 && (
            <div className="image-preview-grid">
              {images.map((src, idx) => (
                <div key={idx} className="image-thumb-wrap">
                  <img src={src} alt={`Attachment ${idx + 1}`} />
                  <button
                    type="button"
                    className="remove-img-btn"
                    onClick={() =>
                      setImages((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={handleFiles}
          />
          <button
            type="button"
            className="small-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="image" /> Upload Image
          </button>
        </>
      )}

      <div className="row">
        <button className="primary" disabled={!saveable} onClick={save} title="Save (Ctrl+Enter)">
          Save
        </button>
        <button type="button" onClick={isRem ? done : cancel}>
          Cancel
        </button>
      </div>
    </li>
  );
}

function SectionBlock({
  title,
  tone,
  id,
  action,
  children,
}: {
  title: string;
  tone?: "due";
  id?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={"section " + (tone ?? "")} id={id}>
      {action ? (
        <div className="block-head">
          <h2 className="block-title">{title}</h2>
          {action}
        </div>
      ) : (
        <h2 className="block-title">{title}</h2>
      )}
      {children}
    </section>
  );
}

/** A small "Sort: [select]" control. The label is also the select's accessible name. */
function SortControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="sort-control">
      <span aria-hidden="true">Sort</span>
      <select
        aria-label={label}
        title={label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function InstallBanner() {
  const [, bump] = useState(0);
  useEffect(() => onInstallChange(() => bump((n) => n + 1)), []);
  return (
    <div className="banner">
      <span>Install Pocketed on your phone for one-tap access and alerts.</span>
      <div className="row">
        <button
          className="primary small-btn"
          onClick={() => void promptInstall()}
        >
          Install
        </button>
        <button
          className="small-btn"
          onClick={() => {
            localStorage.setItem(DISMISS_INSTALL_KEY, "1");
            bump((n) => n + 1);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
