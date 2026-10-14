# Pocketed

Your "things I need to remember" app: quick notes and reminders, on every device.

- **Website** — a real URL on Cloudflare Pages. Open it, type your password once.
- **Installable app** — the website installs to an Android home screen (and iPhone/desktop) as a full-screen app, works offline for the shell, and shows reminder alerts. No app store, no APK.
- **Sync server** — a Cloudflare Worker + D1 database. Free tier.
- **Offline-first** — every device keeps a local copy; changes sync when online; conflicts resolve last-write-wins.

## Workspace and appearance

The workspace uses a shared navy-and-teal design system with responsive layouts,
line icons, live overview counts, recent notes, and an on-demand note/reminder editor.
Use **New note** to open the editor; closing it keeps the current draft mounted.
Text drafts continue to be saved on this device using the existing draft storage.

Choose **Light**, **Dark**, or **System** in the sidebar, in **Settings → Appearance**,
or using the icons on the sign-in screen. The choice is remembered on this device
and shared between tabs. System mode follows live operating-system changes.
The theme is applied before rendering (including offline), and the calendar,
editor, settings, and privacy page use the same theme. Text-size preferences
remain available in Settings.

Keyboard support includes visible focus indicators, a skip-to-workspace link,
and focus containment / Escape-to-close for Settings and the mobile navigation.
Reduced-motion preferences are respected. These are UI improvements, not a claim
of banking-grade security or regulatory certification.

Design tokens are in `web/src/styles.css`; theme state is in `web/src/theme.ts`.
`web/public/theme-init.js` mirrors the initial theme resolution before React loads.

## Day-to-day: change, push, done

You don't need a terminal or PowerShell for routine changes:

1. Edit the code (here in Arena, or on GitHub).
2. Push to your working branch. **CI** runs the tests, typecheck and a website build.
3. Open a pull request into `main` and merge it. The **Deploy Pocketed** workflow then
   redeploys the sync server and the website automatically (see [SETUP.md](SETUP.md)).

Nothing reaches your live site until a change is merged to `main`.

## Layout

```
packages/shared   sync engine, reminders, calendar import rules, auth (pure TypeScript, shared by everything)
server            Cloudflare Worker + D1 store (+ Calendar: calendar.ts/google.ts; Classroom: classroom.ts; OAuth: google-oauth.ts)
web               the website / installable app (React + Vite -> Cloudflare Pages)
                  imports: src/ical.ts, src/calendar-import.ts, src/classroom-import.ts
                  note editor: src/components/RichTextEditor.tsx (+ src/text-edit.ts), formatting: src/markdown.ts
  web/public      manifest, service worker (sw.js), app icons, Cloudflare headers
.github/workflows checks.yml (checks on branches/PRs and weekly) and deploy.yml (publishes on main)
```

## Local development

Use Node.js 22 LTS (at least 22.12; `.nvmrc` selects the maintained 22.x release).
The CI/deployment workflows use the same Node version.

```
nvm use                  # if you use nvm
npm ci
npm run dev:server        # terminal 1: local API on http://localhost:8787 (local D1)
npm run dev               # terminal 2: website on http://localhost:5173
npm run check             # tests + typecheck + production build (run before pushing)
npm run audit             # includes tooling; fails on moderate or higher advisories
```

In development the site already points at the local API, so you only type a password.
The development/preview servers accept localhost, IP addresses, and Arena's
`.e2b.app` preview hosts rather than arbitrary Host headers. For another trusted
preview host, explicitly extend `allowedHosts` in `web/vite.config.ts`.

## Security maintenance

- Dependencies are locked in `package-lock.json`; use `npm ci` for repeatable builds.
- Branch/PR checks and a weekly check run the full test/build suite and audit both
  production and development dependencies. Moderate-or-higher findings fail the audit.
- Deployment audits, tests, type-checks, and builds the website **before** publishing
  either the Worker or Pages site. An audit failure or build error stops deployment.
- KaTeX renders notes as untrusted input: HTML/links/external resources are disabled,
  with limits on macro expansion and layout size. Security regression tests cover
  malicious commands and inherited trust settings.
- A clean npm audit means no known advisories in the resolved dependency tree at
  that time; it is not a full security assessment or a banking-security certification.

## Installing on Android

1. Open the site in **Chrome**.
2. Tap the **⋮** menu → **Install app** (or ⚙️ Settings → **Install Pocketed**).
3. Open ⚙️ Settings → **Reminder alerts** → **Turn on alerts** and allow notifications.

On iPhone: Safari → Share → **Add to Home Screen**.

## Interface

- Notion-style workspace: a sidebar with Home, Calendar, Due now and your sections, a top bar with search
  and sync status, and pages that use the full width of the screen. Light and dark themes follow your system.
- **Scaling**: the layout is sized from the screen's short side, so phones (portrait or landscape) fit correctly
  and small phones shrink the UI instead of overflowing. On phones the sidebar opens from the ☰ button.
  ⚙️ Settings → **Text size** makes everything smaller or larger.

## Features: Sections, Notes & Reminders Calendar

- **Sections (Folders)** — create named sections on the home screen and click any section title to open its dedicated folder view.
- **Two Separate Creation Buttons** — choose between **📝 New Note** and **⏰ New Reminder**:
  - **Notes** are large items with a title, a large formatted body (see "Writing notes" below), image uploads (with fullscreen lightbox preview), interactive checklists, pinning, and an expandable detail view.
  - **Reminders** are compact items with a title, short body text, a **📍 Location** tab (with quick presets or custom text), a due date/time, and a colour from Google Calendar's palette.
- **Multiple Google accounts** — connect school and home calendars together, with account-level on/off switches
  shared across your devices. Calendar switches never hide Google Classroom assignments (see below).
- **Google Classroom import** — connect the student's school account in Settings and published assignment/question
  deadlines fill Pocketed's calendar automatically, independently of Google Calendar (see below).
- **Home Screen Reminders Calendar** — a monthly calendar populated with your scheduled reminders, colour-coded
  in **Google Calendar's palette** (Tomato, Basil, Peacock, Avocado…), with one-click colour filtering. The filter
  lists the colours your reminders actually use, so it stays short.
- **Multi-day events** — an event that runs across several days (a holiday, a conference, an overnight
  shift) shows on the calendar as one bar across all its days, like in Google Calendar. The bar keeps the same
  row every day so it lines up. It is titled on its first day and again at the start of each new week row.
  The event appears in the list for every day it covers, labelled with its whole range
  ("📅 Mon 12 Oct – Fri 16 Oct · 5 days", and "now, day 3 of 5" while it's on). It still shows when it
  started before the month you're viewing.

## Writing notes: the editor

A note's body is written in a proper text editor, used both when creating and when editing a note:

- **Formatting toolbar**: bold, italic, strikethrough, highlight, inline code, headings (H1–H3),
  bulleted / numbered / tick-able task lists, indent and outdent, quotes, code blocks, links, divider
  lines, an insert-date-and-time button, tables and maths. On phones the toolbar scrolls sideways.
- **Tables** (⊞): insert a starter table, or select a few lines and ⊞ turns them into rows.
  Tab / Shift+Tab jump between cells, and Enter starts the next row — Enter on an empty row ends
  the table. A header line over a `| --- | --- |` divider renders as a table everywhere a note shows.
- **Maths** (x², ∑): write LaTeX between `$…$` inline or on `$$…$$ lines as a display block —
  exponents (`x^2`), subscripts (`x_i`), fractions (`\frac{a}{b}`), roots (`\sqrt{2}`) and the like
  are typeset properly in previews and on note cards. Formulas are shown as their LaTeX source until
  the maths engine (KaTeX) has loaded, which happens once, the first time a note actually has maths.
- **Find & replace** (🔍 or Ctrl/⌘+F): matches are highlighted in the text, with match case,
  whole words, replace and replace all.
- **Preview** (👁) shows the note formatted, and you can tick its tasks there.
- **Focus mode** (⛶) opens the editor full screen as a distraction-free page. Esc closes it.
- **Status bar**: word and character count, reading time, and the cursor's line and column.
- **Paste a link over selected words** and they become a link.
- **Drafts**: a new note you haven't added yet is kept on this device. Reloading or switching sections won't
  lose it, and **Discard** clears it.
- **Ctrl/⌘+Enter** saves. Cancelling an edit with unsaved changes asks first.
- **?** in the toolbar lists every shortcut and the formatting you can type yourself.

Formatting is stored as plain Markdown-style text (`**bold**`, `# Heading`, `- [ ] task`, `==highlight==`,
`| a | b |` table rows, `$x^2$` maths), so it syncs like any other note and older notes look the same as
before. Notes are shown formatted on their cards and in the full view. Task boxes written in the body can be
ticked right there, and the card shows progress (☑ 2/5). Search results highlight the words you searched for.
In the full view, **Copy text** copies the note without formatting marks, **Copy Markdown** copies it with
them, and **Download** saves it as a `.md` file. Formatting is drawn safely: a note can't inject HTML or
scripts, and only `http(s)` and `mailto` links work.

## Reminders: what to expect

- Reminders are set from the composer or while editing a note: quick picks
  (15 min, 1 hour, 3 hours, tomorrow 9:00) or an exact date and time. A time in the past is refused.
- **Repeating reminders**: pick **🔁 Repeat** next to a reminder's time: every day, every weekday (Mon–Fri),
  every week, every 2 weeks, every month or every year. Repeats appear on every matching day in the calendar.
  ✅ on a repeating reminder moves it to its next occurrence; a repeating alert moves it on automatically.
- ✅ on a one-off note clears its reminder without deleting the note.
- Due reminders appear under **Due now** at the top, whether or not an alert fired.
- **Alerts fire while the app is running** — an open tab, or the installed app in the background.
  If the app is fully closed when a reminder comes due, you'll see it under **Due now** the next time you open it.
- Reminders that fire **while the phone is locked and the app is closed** need Web Push
  (a server-side push service). That is not built yet; see "Next steps" below.

## Google Calendar: auto-filled reminders

In ⚙️ Settings → **Google Calendar**, sign in with your home account, then choose **Add Google Calendar account**
and sign in with your school account. Both stay connected (up to **10 Calendar accounts** per workspace).
Each account has its own **Check now**, **Reconnect** and **Disconnect account** controls. Choosing an account
that is already connected renews only that connection; it never replaces the others.
There are two ways to connect:

- **Sign in with Google** (recommended): copies each event's **exact Google colour**, so colour-coding
  carries over. Pocketed requests `calendar.readonly`, plus `openid` and `email` to identify each account,
  and imports **all readable calendars** on that account:
  primary, additional, shared and subscribed calendars (including hidden/unchecked ones). Calendars that
  only expose free/busy information are skipped. The server owner has to set this up once first
  (SETUP.md, step 8). Until then the button doesn't appear.
- **Secret link**: on a computer, open **calendar.google.com** → ⚙️ **Settings** → under **Settings for my
  calendars** click your calendar → **Integrate calendar** → copy **Secret address in iCal format**, then
  paste it into Pocketed. A secret link imports **only that one calendar** and carries no colours, so these reminders are **Peacock** (blue).

What happens:

- Events in the **next 60 days** become reminders, labelled 📅 Google Calendar (up to the earliest **500 per account**, across that account's readable calendars).
- **Colours**: a reminder keeps the colour you gave it in Google — any of Google's 24 colours (Tomato, Sage,
  Basil, Avocado…), including custom shades mixed in Google's colour picker. Events without their own colour take
  the calendar's colour. Some colours come with Sign in with Google (a secret link carries none), but the colour
  picker on your own reminders offers the same palette, so everything matches. Changing an event's colour in
  Google updates the reminder.
- Pocketed's earlier six colours (Ruby, Amber, Emerald, Sky, Violet, Rose) are gone: reminders that used them show
  the closest Google shade — Ruby as Flamingo, Emerald as Eucalyptus, and so on.
- **Events that run across several days** keep their full length (all-day events from the first to the
  last day, timed events from start to end), so the calendar shows them on every day they cover. An event
  ending exactly at midnight doesn't spill into the next day. Reminders imported before this was added
  pick up their end time on the next check, without losing anything you changed on them.
- Timed events alert **30 minutes before** ("⏰ In 30 min") and again **when they start** ("📅 Starting now").
  All-day events alert once, at 9:00 on the day.
- Repeating events are added one occurrence at a time; skipped, moved and cancelled occurrences are respected.
  With Sign in with Google, invitations you declined and "working location" markers are left out.
- **A check never deletes reminders it can't vouch for.** An event you cancel or delete in Google removes its
  reminder straight away, because the calendar says so. Everything else is only removed once the event has
  *started* and is no longer on the calendar — an event still to come is never removed just because it wasn't in
  one feed, and a check that comes back empty, cut short, or from a different calendar source changes nothing
  but says so in Settings. Reminders a check did remove in bulk come back by themselves on the next check if the
  calendar still has the events.
- Pocketed checks the calendar **shortly after it opens, then every 15 minutes while it's on screen** (hourly in
  the background), or straight away with **Check now**. Changes sync to your other devices as usual.
- An event changed in Google updates its reminder; any section or pin you set yourself stays. Your own colour
  choice also stays when connected by secret link (which has no colours).
  A cancelled event's reminder is removed, and once an event has ended its reminder is cleared away.
- ✅ or 🗑️ on an imported reminder sticks. It only comes back if the event is moved to a new time.
- Switching from a primary-calendar secret link to Sign in with Google keeps the same reminders and just recolours them.
  Google accounts can coexist, but a secret link remains an alternative: connecting a link replaces **all**
  Calendar accounts, with an explicit confirmation when multiple accounts are connected. Classroom is unaffected.
- **Show Calendar events from** appears above the calendar and in Calendar settings. Untick the school account
  to show home events **and still see school Classroom assignments**. The choice is stored on the server and
  reaches other open devices with their normal notes sync (normally within **15 seconds**); offline devices
  pick it up when they reconnect. It works alongside the existing colour/date filters.
- Hiding is **not disconnecting or deleting**. Hidden events keep importing teacher/calendar edits, and turning
  the account back on restores its events immediately without another import. This is a **calendar-view filter**:
  reminder lists, search and alerts are unchanged. Classroom and handmade reminders are never hidden by it.
- **Disconnect account** removes only that account's imported Calendar items and credentials from all devices.
  Other Calendar accounts, Classroom assignments and handmade notes stay. Disconnecting a secret link removes
  its imported events. Google revocation is coordinated with other connections for the same identity.
- The import is one-way: nothing is ever written back to Google.
- **Upgrade:** existing single-account connections and their reminder IDs are migrated automatically; no data
  or visibility choice is reset. Existing tokens keep importing. On your next sign-in/reconnect Google also
  asks for basic account identity. Deploy the server before the website and update every client using the workspace.
- Events on different **accounts** remain separate even if both accounts can read the same shared calendar or
  event UID. You may see copies when both are on; switch one account off to isolate them. If one account fails,
  its previous reminders stay and other accounts can still update. A partial feed within one account is rejected.

How it works: the sync server keeps the connection and relays the calendar to the app; the app turns events
into reminders. With a secret link the app receives the whole calendar file and reads it on the device (a
calendar's full history can be megabytes, more than the free Cloudflare plan's 10 ms of CPU per request
allows). With Sign in with Google the server asks Google's Calendar API for just the next two months, already
expanded, with colours. Alerts only fire while the app is running, so nothing is lost by checking from the app.

Privacy: the secret address, and Google's sign-in token, are stored only in your sync server's database and are
never sent back to the apps. If a secret link leaks, use **Reset** next to it in Google Calendar, then paste
the new link into Pocketed (**Use a secret link instead**). Google access can also be removed any time at
myaccount.google.com → Security → Third-party apps.

## Google Classroom: assignment deadlines

Connect in ⚙️ Settings → **Google Classroom** → **Connect Google Classroom**. The server owner must first
set up the Classroom API and OAuth callback ([SETUP.md, step 9](SETUP.md#9-google-classroom-optional--student-assignment-deadlines)).
Choose the **student's own Google account** and grant the read-only permissions. A school-managed account
may need the school's administrator to approve Pocketed; a parent's guardian account does not provide
access to the student's coursework through this connection.

- Imports **published assignments and questions with valid deadlines** from all **active classes the student
  is enrolled in**. It does not import teacher-only drafts, announcements, materials or other students' work.
- New imports cover the **next 60 days**, plus deadlines in the **last 30 days**, up to the earliest **500 new
  assignments per account per check**. Existing imported assignments keep being updated even if a teacher moves the
  deadline outside that window. Overdue reminders stay until you dismiss them or the teacher removes them.
- Each reminder has the **class name and assignment title**, a short description, and an **Open in Classroom**
  link. It starts in **Basil** green; you can change the colour or put it in a section. Teacher updates keep
  your colour, section, pin, checklist and alert lead time.
- Classroom supplies deadlines in **UTC**; Pocketed displays that exact instant in your device's local time,
  including daylight-saving changes. There are default alerts **30 minutes before** and **when due**.
- Checks run shortly after opening, then **every 15 minutes while visible** (hourly in the background), or with
  **Check now**. Like other reminders, alerts and checks require the app to be running; no closed-app jobs.
- Teacher edits update the **same** reminder, not a duplicate. A full, successful check removes a reminder if
  its assignment or due date was removed. Failed, malformed or truncated checks change nothing. If a class
  is archived or becomes inaccessible, its reminders are kept rather than guessed away; dismiss them yourself.
- **Submission status and grades are not imported.** This is a deadline calendar, not an outstanding-work
  tracker: assignments already submitted in Classroom can still appear. ✅ clears a Pocketed reminder; it
  does **not** submit work. ✅ and 🗑️ stay respected unless the teacher gives the assignment a new deadline.
- Classroom and Google Calendar connect independently, so you can use a **school account for Classroom** and
  a **personal account for Calendar**, or use Classroom with a secret-link calendar. Disconnecting either does
  not remove the other's reminders. If Classroom deadlines also appear in your connected Google Calendar,
  the two independent sources may show the same deadline twice.
- **Add Classroom account** connects another student without replacing the first (up to **10 Classroom
  accounts** per workspace). Each student's assignments have distinct IDs and separate check/error states.
  **Reconnect** renews only the selected identity; choose the same account on Google's account chooser.
  **Disconnect Classroom** in a student's card removes only that student's Classroom credentials and imports,
  never another student's work or any Calendar events. Reconnecting after disconnect can import the work again.
- Turning a school's **Calendar events** off never hides its **Classroom assignments**, even when both use the
  same Google account. This is useful if Classroom deadlines also appear in Google's own calendar.
- The connection and its reminders belong to the **Pocketed workspace**, not to an individual browser login.
  Everyone using that workspace's password can see them. Separate users still need separate instances or
  a future multi-user account system.

Privacy: tokens stay in the sync server's D1 database, never in the browser or OAuth redirect. Pocketed asks
for read-only classes and **your own** coursework, plus basic account identity. It never reads rosters, grades,
submissions, Drive files or attachments, and never writes anything to Classroom or Google Calendar. Removing
one connection forgets only its own credentials. Google revocation is requested only when no remaining
connection may rely on that account's grant. Unknown legacy Calendar identities are handled conservatively
until reauthorized, so revocation may be deferred to avoid breaking another integration. You can also revoke Pocketed at
**myaccount.google.com → Third-party connections** (which may disconnect both integrations).

## Security notes

- Your password is the login for every device. It's stored only as a salted hash on the server.
  The app keeps it in the browser's local storage so it can sync; treat the device as trusted.
- The server does not rate-limit password attempts yet. Use a long password (the minimum is 8 characters).
- The recovery key is shown once; if you lose both password and key, your notes can't be recovered.

## Next steps (not built yet)

- **Google Calendar extras**: select individual calendars within an account (account-level visibility is already supported),
  and optionally write back to Google.
- **Classroom extras**: select a subset of classes, and optionally check your own submission status.
- **Closed-app reminders**: Web Push from the Worker, using a scheduled trigger to send alerts on time.
- **Native Android app** (Expo, with a home-screen widget): the shared reminder helpers are ready for it.
- Login rate limiting on the server.
