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
  createNoteItem,
  createReminderItem,
  DEFAULT_REMINDER_COLOR,
  deleteNote,
  deleteSection,
  getReminderColor,
  isReminderItem,
  itemBody,
  itemTitle,
  LIMITS,
  markReminderDone,
  quickReminders,
  renameSection,
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
import {
  canPromptInstall,
  isInstalled,
  onInstallChange,
  promptInstall,
} from "../install";
import { fileToDataUrl } from "../images";
import {
  itemsInSection,
  matchesQuery,
  reminderMeta,
  rowsFor,
  sectionCounts,
  colorPickerChoices,
  sectionsFor,
  syncStatus,
  userSectionsFor,
} from "../view-model";
import { hasGoogleReturn } from "../google-return";
import { ReminderCalendar } from "./ReminderCalendar";
import { ReminderPicker, type ReminderValue } from "./ReminderPicker";
import { Settings } from "./Settings";

const DISMISS_INSTALL_KEY = "pocketed.v2.installDismissed";
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
  const [addingSidebarSection, setAddingSidebarSection] = useState(false);
  const [sidebarSectionName, setSidebarSectionName] = useState("");

  // Search, Settings, Editing, and Interactive Modals
  const [query, setQuery] = useState("");
  // Opened straight away when coming back from "Sign in with Google".
  const [settings, setSettings] = useState(hasGoogleReturn);
  const [editing, setEditing] = useState<string | null>(null);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [, setClock] = useState(0);

  const composerRef = useRef<HTMLDivElement | null>(null);

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

  // Keep Google Calendar events imported as reminders (when a calendar is linked).
  useEffect(() => {
    const c = new CalendarAutoImport(manager);
    c.start();
    return () => c.stop();
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

  function handleCreateSection(e: FormEvent) {
    e.preventDefault();
    const name = newSectionName.trim();
    if (!name) return;
    manager.mutate((s) => addSection(s, name, Date.now()).state);
    setNewSectionName("");
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
    if (
      confirm(
        `Delete section "${sec.name}" and all notes/reminders inside it?`,
      )
    ) {
      manager.mutate((s) => deleteSection(s, sec.id, Date.now()));
      if (activeSectionId === sec.id) {
        setActiveSectionId(null);
      }
    }
  }

  function openReminderComposerForDate(ts: number, color: ReminderColorId) {
    setComposerKind("reminder");
    setComposerPreselectAt(ts);
    setComposerPreselectColor(color);
    setComposerKey((k) => k + 1);
    composerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const searching = query.trim().length > 0;
  const scopedNotes =
    activeSectionId === null
      ? all
      : all.filter((n) => (n.sectionId ?? null) === targetSectionId);
  const searchHits = searching
    ? scopedNotes.filter((n) => matchesQuery(n, query))
    : [];

  const generalCounts = sectionCounts(all, null, now);
  const homeSections = sectionsFor(all, now);
  const expandedNote = expandedNoteId
    ? (all.find((n) => n.id === expandedNoteId) ?? null)
    : null;

  const sectionMap = new Map(userSections.map((s) => [s.id, s]));

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
      />
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
  const pageIcon =
    activeSectionId === null ? "🏠" : activeSectionObj ? "📁" : "🗂️";
  const pageSub =
    activeSectionId === null
      ? `${homeSections.due.length} due · ${homeSections.upcoming.length} upcoming reminders · ${homeSections.notes.length} notes`
      : (() => {
          const c = sectionCounts(all, targetSectionId, now);
          return `${c.notes} ${c.notes === 1 ? "note" : "notes"} · ${c.reminders} ${c.reminders === 1 ? "reminder" : "reminders"}${c.due ? ` · ${c.due} due` : ""}`;
        })();

  return (
    <div className={"shell" + (navOpen ? " nav-open" : "")}>
      {/* ---- Sidebar (Notion-style workspace navigation) ---- */}
      <aside className="sidebar" aria-label="Navigation">
        <div className="sidebar-top">
          <div className="workspace">
            <span className="workspace-logo" aria-hidden="true">🗒️</span>
            <span className="workspace-name">Pocketed</span>
          </div>
          <button
            type="button"
            className="icon-btn sidebar-close"
            aria-label="Close menu"
            onClick={() => setNavOpen(false)}
          >
            ✕
          </button>
        </div>

        <nav className="sidebar-nav">
          <button
            type="button"
            className={"nav-item" + (activeSectionId === null ? " active" : "")}
            onClick={() => goTo(null)}
          >
            <span className="nav-icon">🏠</span>
            <span className="nav-label">Home</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => goHomeAndScroll("calendar")}
          >
            <span className="nav-icon">📅</span>
            <span className="nav-label">Calendar</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => goHomeAndScroll("due")}
          >
            <span className="nav-icon">⏰</span>
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
            {userSections.map((sec) => {
              const c = sectionCounts(all, sec.id, now);
              const active = activeSectionId === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  className={"nav-item" + (active ? " active" : "")}
                  onClick={() => goTo(sec.id)}
                >
                  <span className="nav-icon">📁</span>
                  <span className="nav-label">{sec.name}</span>
                  {c.due > 0 ? (
                    <span className="nav-count due">{c.due}</span>
                  ) : c.notes + c.reminders > 0 ? (
                    <span className="nav-count">{c.notes + c.reminders}</span>
                  ) : null}
                </button>
              );
            })}
            {(generalCounts.notes > 0 || generalCounts.reminders > 0) && (
              <button
                type="button"
                className={
                  "nav-item" + (activeSectionId === GENERAL_SECTION_ID ? " active" : "")
                }
                onClick={() => goTo(GENERAL_SECTION_ID)}
              >
                <span className="nav-icon">🗂️</span>
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
          <button
            type="button"
            className="nav-item"
            onClick={() => {
              setSettings(true);
              setNavOpen(false);
            }}
          >
            <span className="nav-icon">⚙️</span>
            <span className="nav-label">Settings</span>
          </button>
        </div>
      </aside>
      {navOpen && (
        <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
      )}

      {/* ---- Main column: topbar + page ---- */}
      <main className="main">
        <div className="topbar">
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
          >
            ☰
          </button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="crumb" onClick={() => goTo(null)}>
              Home
            </button>
            {activeSectionId !== null && (
              <>
                <span className="crumb-sep">/</span>
                <span className="crumb current">{pageTitle}</span>
              </>
            )}
          </nav>
          <div className="topbar-search">
            <span className="search-icon" aria-hidden="true">🔍</span>
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

        <div className="page">
          <header className="page-header">
            <div className="page-icon" aria-hidden="true">
              {pageIcon}
            </div>
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
                  <h1 className="page-title">{pageTitle}</h1>
                  <p className="page-sub">{pageSub}</p>
                </>
              )}
            </div>
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
                  ✏️ Rename
                </button>
                <button
                  type="button"
                  className="small-btn danger-outline"
                  onClick={() => handleDeleteSection(activeSectionObj)}
                >
                  🗑️ Delete
                </button>
              </div>
            )}
          </header>

          {!isInstalled() &&
            canPromptInstall() &&
            !localStorage.getItem(DISMISS_INSTALL_KEY) && <InstallBanner />}

          {/* Two buttons to choose Note vs Reminder creation */}
          <div className="creator-shell" ref={composerRef}>
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
                📝 New Note
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
                ⏰ New Reminder
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
            <SectionFolderContent
              allNotes={all}
              sectionId={targetSectionId}
              sectionName={activeSectionObj ? activeSectionObj.name : "General"}
              renderReminderCard={(n) => renderReminderCard(n, null)}
              renderNoteCard={(n) => renderNoteCard(n, null)}
            />
          ) : (
            /* ---- HOME VIEW ---- */
            <>
              {homeSections.due.length > 0 && (
                <SectionBlock title="Due now" tone="due" id="due">
                  <ul className="notes">
                    {homeSections.due.map((n) =>
                      renderReminderCard(
                        n,
                        n.sectionId ? (sectionMap.get(n.sectionId) ?? null) : null,
                      ),
                    )}
                  </ul>
                </SectionBlock>
              )}

              {/* Sections (Folders) gallery */}
              <section className="sections-panel" aria-label="Sections">
                <div className="block-head">
                  <h2 className="block-title">Sections</h2>
                  <p className="muted small">
                    Click a section to open its folder.
                  </p>
                </div>

                <form className="section-create-form" onSubmit={handleCreateSection}>
                  <input
                    value={newSectionName}
                    onChange={(e) => setNewSectionName(e.target.value)}
                    placeholder="New section, e.g. Work, Personal, Shopping…"
                    maxLength={LIMITS.sectionNameChars}
                    aria-label="New section name"
                  />
                  <button type="submit" className="primary" disabled={!newSectionName.trim()}>
                    + Create section
                  </button>
                </form>

                {userSections.length === 0 && generalCounts.notes + generalCounts.reminders === 0 ? (
                  <p className="muted small center-text sections-empty">
                    No sections yet. Create one above to organise your notes and reminders into folders.
                  </p>
                ) : (
                  <div className="section-folders-grid">
                    {userSections.map((sec) => {
                      const counts = sectionCounts(all, sec.id, now);
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
                                <span className="section-folder-icon" aria-hidden="true">📁</span>
                                <span className="section-folder-title">{sec.name}</span>
                                <span className="section-folder-counts">
                                  {counts.notes} {counts.notes === 1 ? "note" : "notes"} ·{" "}
                                  {counts.reminders}{" "}
                                  {counts.reminders === 1 ? "reminder" : "reminders"}
                                  {counts.due > 0 ? ` · ${counts.due} due` : ""}
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
                                  ✏️
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn"
                                  aria-label={`Delete ${sec.name}`}
                                  title="Delete section"
                                  onClick={() => handleDeleteSection(sec)}
                                >
                                  🗑️
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}

                    {(generalCounts.notes > 0 || generalCounts.reminders > 0) && (
                      <div className="section-folder-card general-folder">
                        <button
                          type="button"
                          className="section-folder-link"
                          onClick={() => goTo(GENERAL_SECTION_ID)}
                        >
                          <span className="section-folder-icon" aria-hidden="true">🗂️</span>
                          <span className="section-folder-title">General (unsectioned)</span>
                          <span className="section-folder-counts">
                            {generalCounts.notes}{" "}
                            {generalCounts.notes === 1 ? "note" : "notes"} ·{" "}
                            {generalCounts.reminders}{" "}
                            {generalCounts.reminders === 1 ? "reminder" : "reminders"}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Reminders calendar with colour coding & filtering */}
              <div id="calendar">
                <ReminderCalendar
                  notes={all}
                  sections={userSections}
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
  renderReminderCard,
  renderNoteCard,
}: {
  allNotes: Note[];
  sectionId: string | null;
  sectionName: string;
  renderReminderCard: (n: Note) => ReactNode;
  renderNoteCard: (n: Note) => ReactNode;
}) {
  const { reminders, notes } = itemsInSection(allNotes, sectionId);

  if (reminders.length === 0 && notes.length === 0) {
    return (
      <ul className="notes">
        <li className="note empty">
          No notes or reminders in <b>{sectionName}</b> yet.
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
        <SectionBlock title={`Notes (${notes.length})`}>
          <ul className="notes">{notes.map((n) => renderNoteCard(n))}</ul>
        </SectionBlock>
      )}
    </>
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
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sectionId, setSectionId] = useState<string | null>(defaultSectionId);
  const [images, setImages] = useState<string[]>([]);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [newTaskText, setNewTaskText] = useState("");
  const [showChecklistBuilder, setShowChecklistBuilder] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
    const finalTitle = title.trim() || body.split("\n")[0]?.trim() || "";
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
    setTitle("");
    setBody("");
    setImages([]);
    setChecklist([]);
    setNewTaskText("");
    setPinned(false);
    setImgErr(null);
  }

  const canSubmit =
    title.trim().length > 0 || body.trim().length > 0 || images.length > 0;

  return (
    <form className="composer note-composer" onSubmit={submit}>
      <div className="composer-header-row">
        <span className="composer-badge note-badge">📝 Large Note</span>
        {sections.length > 0 && (
          <select
            className="section-select"
            value={sectionId ?? ""}
            onChange={(e) => setSectionId(e.target.value || null)}
            aria-label="Note section"
          >
            <option value="">🗂️ General (No section)</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                📁 {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Note title…"
        maxLength={LIMITS.noteTitleChars}
        aria-label="Note title"
      />

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write your note here (supports large detailed notes, checklists, and images)…"
        rows={5}
        maxLength={LIMITS.noteBodyChars}
        aria-label="Note body"
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
      {imgErr && <p className="err small">{imgErr}</p>}

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
            📷 Upload Image{images.length > 0 ? ` (${images.length})` : ""}
          </button>
          <button
            type="button"
            className={
              "small-btn" + (showChecklistBuilder ? " active-tab" : "")
            }
            onClick={() => setShowChecklistBuilder((v) => !v)}
          >
            ☑️ Checklist{checklist.length > 0 ? ` (${checklist.length})` : ""}
          </button>
          <button
            type="button"
            className={"small-btn" + (pinned ? " active-tab" : "")}
            onClick={() => setPinned((p) => !p)}
            aria-pressed={pinned}
          >
            📌 {pinned ? "Pinned" : "Pin"}
          </button>
        </div>

        <button className="primary" type="submit" disabled={!canSubmit}>
          Add Note
        </button>
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
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [location, setLocation] = useState("");
  const [activeTab, setActiveTab] = useState<"due" | "location" | "color">("due");
  const [color, setColor] = useState<ReminderColorId>(initialColor);
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
      <div className="composer-header-row">
        <span
          className="composer-badge reminder-badge"
          style={{
            backgroundColor: selectedColorDef.bg,
            borderColor: selectedColorDef.border,
          }}
        >
          ⏰ Small Reminder · {selectedColorDef.label}
        </span>
        {sections.length > 0 && (
          <select
            className="section-select"
            value={sectionId ?? ""}
            onChange={(e) => setSectionId(e.target.value || null)}
            aria-label="Reminder section"
          >
            <option value="">🗂️ General (No section)</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                📁 {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
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
          ⏰ When it's due
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
          📍 Location{location.trim() ? `: ${location.trim()}` : ""}
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
                📍 {loc}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === "color" && (
        <div className="reminder-tab-panel color-picker-row" role="radiogroup" aria-label="Reminder colour">
          {colorPickerChoices(initialColor).map((c) => {
            const selected = color === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={"color-swatch-btn" + (selected ? " selected" : "")}
                style={{
                  borderColor: selected ? c.hex : undefined,
                  backgroundColor: selected ? c.bg : undefined,
                }}
                onClick={() => setColor(c.id)}
              >
                <span
                  className="color-dot"
                  style={{ backgroundColor: c.hex }}
                />
                <span>{c.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {remError && <p className="err small">{remError}</p>}

      <div className="composer-footer">
        <span className="muted small">
          {location.trim() ? `📍 ${location.trim()}` : "Tip: Use the Location & Colour tabs above"}
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

function ReminderCard({
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
          style={{ backgroundColor: col.bg, borderColor: col.border }}
        >
          <span className="color-dot" style={{ backgroundColor: col.hex }} />
          {col.label}
        </span>
        {note.location && (
          <span className="location-badge" title="Location">
            📍 {note.location}
          </span>
        )}
        {note.source === "gcal" && (
          <span
            className="location-badge source-badge"
            title="Imported from Google Calendar. Changes there update this reminder."
          >
            📅 Google Calendar
          </span>
        )}
        {sectionBadge && onOpenSection && (
          <button
            type="button"
            className="section-tag-btn"
            onClick={() => onOpenSection(sectionBadge.id)}
            title={`Open section ${sectionBadge.name}`}
          >
            📁 {sectionBadge.name}
          </button>
        )}
      </div>

      <div className="item-title">{title}</div>
      {body && <div className="reminder-body">{body}</div>}

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
            ✅
          </button>
        )}
        <button className="icon" aria-label="Edit" onClick={onEdit}>
          ✏️
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
          🗑️
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
}: {
  note: Note;
  now: number;
  sectionBadge?: Section | null;
  onOpenSection?: (sectionId: string) => void;
  manager: SyncManager;
  onEdit: () => void;
  onExpand: () => void;
  onViewImage: (src: string) => void;
}) {
  const title = itemTitle(note);
  const body = itemBody(note);
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
          <span className="note-type-pill">📝 Note</span>
          {note.pinned && <span className="pin-badge">📌 Pinned</span>}
          {sectionBadge && onOpenSection && (
            <button
              type="button"
              className="section-tag-btn"
              onClick={() => onOpenSection(sectionBadge.id)}
            >
              📁 {sectionBadge.name}
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
            📌
          </button>
          <button
            className="icon"
            aria-label="Expand note"
            title="Open full note view"
            onClick={onExpand}
          >
            🔍
          </button>
          <button className="icon" aria-label="Edit" onClick={onEdit}>
            ✏️
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
            🗑️
          </button>
        </div>
      </div>

      <h3 className="large-note-title" onClick={onExpand}>
        {title}
      </h3>

      {body && <div className="large-note-body">{body}</div>}

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
        <span className="meta">{shortAgo(note.updatedAt, now)}</span>
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
              📷 + Image
            </button>
          )}
          <button
            type="button"
            className="interact-btn"
            onClick={() => setAddingTask((v) => !v)}
          >
            ☑️ + Task
          </button>
          <button type="button" className="interact-btn" onClick={onExpand}>
            🔍 Open & Interact
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
  const title = itemTitle(note);
  const body = itemBody(note);
  const images = note.images ?? [];
  const checklist = note.checklist ?? [];
  const [newTask, setNewTask] = useState("");
  const [copied, setCopied] = useState(false);

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

  async function copyContent() {
    try {
      await navigator.clipboard?.writeText(
        `${title}\n\n${body}`.trim(),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  const wordCount = body.trim()
    ? body.trim().split(/\s+/).length
    : 0;

  return (
    <div className="overlay" onClick={onClose} role="dialog" aria-label={title}>
      <div
        className="card modal note-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="note-detail-header">
          <div>
            {section && (
              <span className="section-tag-btn">📁 {section.name}</span>
            )}
            <h2>{title}</h2>
            <p className="muted small">
              Updated {shortAgo(note.updatedAt, now)} · {wordCount} words
            </p>
          </div>
          <div className="row">
            <button type="button" className="small-btn" onClick={copyContent}>
              {copied ? "✓ Copied" : "📋 Copy"}
            </button>
            <button type="button" className="small-btn primary" onClick={onEdit}>
              ✏️ Edit
            </button>
          </div>
        </div>

        {body && <div className="note-detail-body">{body}</div>}

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
    note.color ?? DEFAULT_REMINDER_COLOR,
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
          {isRem ? "⏰ Edit Reminder" : "📝 Edit Note"}
        </span>
        {sections.length > 0 && (
          <select
            className="section-select"
            value={sectionId ?? ""}
            onChange={(e) => setSectionId(e.target.value || null)}
          >
            <option value="">🗂️ General</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                📁 {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title…"
        aria-label="Edit title"
      />

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={isRem ? 2 : 5}
        placeholder={isRem ? "Short body…" : "Large note body…"}
        aria-label="Edit body"
      />

      {isRem ? (
        <>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="📍 Location (optional)…"
            aria-label="Edit location"
          />
          <div className="color-picker-row">
            {colorPickerChoices(note.color).map((c) => (
              <button
                key={c.id}
                type="button"
                className={
                  "color-swatch-btn" + (color === c.id ? " selected" : "")
                }
                style={{
                  borderColor: color === c.id ? c.hex : undefined,
                  backgroundColor: color === c.id ? c.bg : undefined,
                }}
                onClick={() => setColor(c.id)}
              >
                <span className="color-dot" style={{ backgroundColor: c.hex }} />
                <span>{c.label}</span>
              </button>
            ))}
          </div>
          <ReminderPicker
            initial={note.reminderAt}
            initialRepeat={note.repeat ?? "none"}
            onChange={setRem}
          />
          {rem.error && <p className="err small">{rem.error}</p>}
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
            📷 Upload Image
          </button>
        </>
      )}

      <div className="row">
        <button className="primary" disabled={!saveable} onClick={save}>
          Save
        </button>
        <button type="button" onClick={done}>
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
  children,
}: {
  title: string;
  tone?: "due";
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className={"section " + (tone ?? "")} id={id}>
      <h2 className="block-title">{title}</h2>
      {children}
    </section>
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
