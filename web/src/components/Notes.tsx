import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  addNote,
  deleteNote,
  editNote,
  shortAgo,
  type Note,
} from "@pocketed/shared";
import type { Config } from "../config";
import type { SyncManager } from "../store";
import { ReminderWatcher } from "../alerts";
import { canPromptInstall, isInstalled, onInstallChange, promptInstall } from "../install";
import {
  matchesQuery,
  reminderMeta,
  rowsFor,
  sectionsFor,
  syncStatus,
} from "../view-model";
import { ReminderPicker, type ReminderValue } from "./ReminderPicker";
import { Settings } from "./Settings";

const NO_REMINDER: ReminderValue = { at: null, error: null };
const DISMISS_INSTALL_KEY = "pocketed.v2.installDismissed";

export function Notes({
  manager,
  onNewCfg,
}: {
  manager: SyncManager;
  onNewCfg: (c: Config | null) => void;
}) {
  useSyncExternalStore(manager.subscribe, () => manager.version);

  const [text, setText] = useState("");
  const [rem, setRem] = useState<ReminderValue>(NO_REMINDER);
  const [pickerKey, setPickerKey] = useState(0);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [, setClock] = useState(0);

  // Re-render every 30s so "5m ago" and due/upcoming labels stay current.
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Fire reminder alerts while the app is open.
  useEffect(() => {
    const w = new ReminderWatcher(() => Object.values(manager.state.notes));
    w.start();
    return () => w.stop();
  }, [manager]);

  const now = Date.now();
  const all = rowsFor(manager);
  const status = syncStatus(manager.phase, manager.lastSync, now, manager.lastError);
  const remError =
    rem.error ?? (rem.at != null && rem.at <= now ? "That time has already passed." : null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || remError) return;
    const at = rem.at;
    manager.mutate((s) => addNote(s, t, at, Date.now()).state);
    setText("");
    setRem(NO_REMINDER);
    setPickerKey((k) => k + 1);
  }

  const searching = query.trim().length > 0;
  const sections = sectionsFor(all, now);
  const hits = searching ? all.filter((n) => matchesQuery(n, query)) : [];

  return (
    <div className="app">
      <header>
        <h1>Pocketed</h1>
        <button
          className={"pill " + manager.phase}
          title="Tap to sync now"
          onClick={() => void manager.syncOnce()}
        >
          {status}
        </button>
        <button className="icon" aria-label="Settings" onClick={() => setSettings(true)}>
          ⚙️
        </button>
      </header>

      {!isInstalled() && canPromptInstall() && !localStorage.getItem(DISMISS_INSTALL_KEY) && (
        <InstallBanner />
      )}

      <form className="composer" onSubmit={submit}>
        <div className="composer-row">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What should I remember?"
            maxLength={4000}
            aria-label="New note"
          />
          <button className="primary" disabled={!text.trim() || !!remError}>
            Add
          </button>
        </div>
        <ReminderPicker key={pickerKey} initial={null} onChange={setRem} />
        {remError && <p className="err small">{remError}</p>}
      </form>

      <div className="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes"
          aria-label="Search notes"
        />
      </div>

      {searching ? (
        <NoteList
          rows={hits}
          now={now}
          editing={editing}
          setEditing={setEditing}
          manager={manager}
          empty="No notes match that."
        />
      ) : all.length === 0 ? (
        <ul className="notes">
          <li className="empty">
            Nothing yet.
            <br />
            Type something above and press Add — it appears on your phone too.
          </li>
        </ul>
      ) : (
        <>
          {sections.due.length > 0 && (
            <Section title="Due now" tone="due">
              <NoteList rows={sections.due} now={now} editing={editing} setEditing={setEditing} manager={manager} />
            </Section>
          )}
          {sections.upcoming.length > 0 && (
            <Section title="Upcoming reminders">
              <NoteList rows={sections.upcoming} now={now} editing={editing} setEditing={setEditing} manager={manager} />
            </Section>
          )}
          {sections.notes.length > 0 && (
            <Section title="Notes">
              <NoteList rows={sections.notes} now={now} editing={editing} setEditing={setEditing} manager={manager} />
            </Section>
          )}
        </>
      )}

      {settings && (
        <Settings cfg={manager.cfg} onClose={() => setSettings(false)} onNewCfg={onNewCfg} />
      )}
    </div>
  );
}

function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "due";
  children: ReactNode;
}) {
  return (
    <section className={"section " + (tone ?? "")}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function NoteList({
  rows,
  now,
  editing,
  setEditing,
  manager,
  empty,
}: {
  rows: Note[];
  now: number;
  editing: string | null;
  setEditing: (id: string | null) => void;
  manager: SyncManager;
  empty?: string;
}) {
  if (rows.length === 0 && empty) return <p className="muted center-text">{empty}</p>;
  return (
    <ul className="notes">
      {rows.map((n) =>
        editing === n.id ? (
          <EditRow key={n.id} note={n} manager={manager} done={() => setEditing(null)} />
        ) : (
          <NoteCard key={n.id} note={n} now={now} manager={manager} onEdit={() => setEditing(n.id)} />
        ),
      )}
    </ul>
  );
}

function NoteCard({
  note,
  now,
  manager,
  onEdit,
}: {
  note: Note;
  now: number;
  manager: SyncManager;
  onEdit: () => void;
}) {
  const isDue = note.reminderAt != null && note.reminderAt <= now;
  const meta = reminderMeta(note, now);
  return (
    <li className={"note" + (isDue ? " is-due" : "")}>
      <div className="text">{note.text}</div>
      <div className="meta">
        {shortAgo(note.updatedAt, now)}
        {meta ? " · " + meta : ""}
        {isDue ? " · due" : ""}
      </div>
      <div className="actions">
        {note.reminderAt != null && (
          <button
            className="icon"
            aria-label="Mark done and clear reminder"
            title="Done — clears the reminder"
            onClick={() => manager.mutate((s) => editNote(s, note.id, note.text, null, Date.now()))}
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
            if (confirm("Delete this note everywhere?")) {
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

function EditRow({
  note,
  manager,
  done,
}: {
  note: Note;
  manager: SyncManager;
  done: () => void;
}) {
  const [text, setText] = useState(note.text);
  const [rem, setRem] = useState<ReminderValue>({ at: note.reminderAt, error: null });
  const saveable = text.trim().length > 0 && !rem.error;

  function save() {
    if (!saveable) return;
    manager.mutate((s) => editNote(s, note.id, text.trim(), rem.at, Date.now()));
    done();
  }

  return (
    <li className="note editing">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Edit note" />
      <ReminderPicker initial={note.reminderAt} onChange={setRem} />
      {rem.error && <p className="err small">{rem.error}</p>}
      <div className="row">
        <button className="primary" disabled={!saveable} onClick={save}>
          Save
        </button>
        <button onClick={done}>Cancel</button>
      </div>
    </li>
  );
}

function InstallBanner() {
  const [, bump] = useState(0);
  useEffect(() => onInstallChange(() => bump((n) => n + 1)), []);
  return (
    <div className="banner">
      <span>Install Pocketed on your phone for one-tap access and alerts.</span>
      <div className="row">
        <button className="primary small-btn" onClick={() => void promptInstall()}>
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
