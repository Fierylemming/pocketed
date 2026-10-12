# Pocketed

Your "things I need to remember" app: quick notes and reminders, on every device.

- **Website** — a real URL on Cloudflare Pages. Open it, type your password once.
- **Installable app** — the website installs to an Android home screen (and iPhone/desktop) as a full-screen app, works offline for the shell, and shows reminder alerts. No app store, no APK.
- **Sync server** — a Cloudflare Worker + D1 database. Free tier.
- **Offline-first** — every device keeps a local copy; changes sync when online; conflicts resolve last-write-wins.

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
server            Cloudflare Worker + D1 store (+ Google Calendar: src/calendar.ts link, src/google.ts sign-in)
web               the website / installable app (React + Vite -> Cloudflare Pages)
                  calendar parsing: src/ical.ts, src/calendar-import.ts
  web/public      manifest, service worker (sw.js), app icons, Cloudflare headers
.github/workflows ci.yml (checks on branches/PRs) and deploy.yml (publishes on main)
```

## Local development

```
npm install
npm run dev:server        # terminal 1: local API on http://localhost:8787 (local D1)
npm run dev               # terminal 2: website on http://localhost:5173
npm run check             # tests + typecheck + production build (run before pushing)
```

In development the site already points at the local API, so you only type a password.

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
  - **Notes** are large items with a title, large body, image uploads (with fullscreen lightbox preview), interactive checklists, pinning, and an expandable detail view.
  - **Reminders** are compact items with a title, short body text, a **📍 Location** tab (with quick presets or custom text), a due date/time, and a colour code.
- **Google Calendar import** — connect your calendar once and its events show up as reminders automatically
  (see below).
- **Home Screen Reminders Calendar** — a monthly calendar populated with your scheduled reminders, colour-coded across a curated 6-colour palette (Ruby, Amber, Emerald, Sky, Violet, Rose) with one-click colour filtering.

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

Connect once in ⚙️ Settings → **Google Calendar** and your events show up as reminders on every device.
There are two ways to connect:

- **Sign in with Google** (recommended): copies each event's **exact Google colour**, so colour-coding
  carries over. Pocketed asks for read-only access and imports **all readable calendars** on your account:
  primary, additional, shared and subscribed calendars (including hidden/unchecked ones). Calendars that
  only expose free/busy information are skipped. The server owner has to set this up once first
  (SETUP.md, step 8). Until then the button doesn't appear.
- **Secret link**: on a computer, open **calendar.google.com** → ⚙️ **Settings** → under **Settings for my
  calendars** click your calendar → **Integrate calendar** → copy **Secret address in iCal format**, then
  paste it into Pocketed. A secret link imports **only that one calendar** and carries no colours, so these reminders are **Sky**.

What happens:

- Events in the **next 60 days** become reminders, labelled 📅 Google Calendar (up to the earliest 500 across all calendars).
- **Colours** (with Sign in with Google): an event keeps the colour you gave it in Google — any of Google's
  24 colours (Tomato, Sage, Basil, Avocado…), including custom shades mixed in Google's colour picker.
  Events without their own colour take the calendar's colour. Google's colours appear as extra chips
  in the calendar's colour filter, next to Pocketed's six. Changing an event's colour in Google updates the
  reminder.
- Timed events alert **30 minutes before** ("⏰ In 30 min") and again **when they start** ("📅 Starting now").
  All-day events alert once, at 9:00 on the day.
- Repeating events are added one occurrence at a time; skipped, moved and cancelled occurrences are respected.
  With Sign in with Google, invitations you declined and "working location" markers are left out.
- Pocketed checks the calendar **shortly after it opens, then every 15 minutes while it's on screen** (hourly in
  the background), or straight away with **Check now**. Changes sync to your other devices as usual.
- An event changed in Google updates its reminder; any section or pin you set yourself stays. Your own colour
  choice also stays when connected by secret link (which has no colours).
  A cancelled event's reminder is removed, and once an event has ended its reminder is cleared away.
- ✅ or 🗑️ on an imported reminder sticks. It only comes back if the event is moved to a new time.
- Switching from a primary-calendar secret link to Sign in with Google keeps the same reminders and just recolours them.
  Only one connection is active at a time.
- **Disconnect** removes the imported reminders and forgets the link, or revokes Pocketed's Google access.
- The import is one-way: nothing is ever written back to Google.
- Already signed in? No new permissions or reconnection are needed. After updating both the server and
  website, use **Check now** (or wait for the next automatic check) to import your other calendars.
  The calendar list is refreshed on every check, so newly added calendars are picked up automatically.
- Events on different calendars remain separate, even when they share an event UID. Existing primary-calendar
  reminder IDs stay unchanged. If any calendar fails to load, the check fails without removing reminders.

How it works: the sync server keeps the connection and relays the calendar to the app; the app turns events
into reminders. With a secret link the app receives the whole calendar file and reads it on the device (a
calendar's full history can be megabytes, more than the free Cloudflare plan's 10 ms of CPU per request
allows). With Sign in with Google the server asks Google's Calendar API for just the next two months, already
expanded, with colours. Alerts only fire while the app is running, so nothing is lost by checking from the app.

Privacy: the secret address, and Google's sign-in token, are stored only in your sync server's database and are
never sent back to the apps. If a secret link leaks, use **Reset** next to it in Google Calendar, then paste
the new link into Pocketed (**Change link**). Google access can also be removed any time at
myaccount.google.com → Security → Third-party apps.

## Security notes

- Your password is the login for every device. It's stored only as a salted hash on the server.
  The app keeps it in the browser's local storage so it can sync; treat the device as trusted.
- The server does not rate-limit password attempts yet. Use a long password (the minimum is 8 characters).
- The recovery key is shown once; if you lose both password and key, your notes can't be recovered.

## Next steps (not built yet)

- **Google Calendar extras**: choose a subset of calendars to import (Sign in with Google reads all readable calendars),
  and optionally write back to Google.
- **Closed-app reminders**: Web Push from the Worker, using a scheduled trigger to send alerts on time.
- **Native Android app** (Expo, with a home-screen widget): the shared reminder helpers are ready for it.
- Login rate limiting on the server.
