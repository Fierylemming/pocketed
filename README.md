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
packages/shared   sync engine, reminders, auth rules (pure TypeScript, shared by everything)
server            Cloudflare Worker + D1 store
web               the website / installable app (React + Vite -> Cloudflare Pages)
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

## Security notes

- Your password is the login for every device. It's stored only as a salted hash on the server.
  The app keeps it in the browser's local storage so it can sync; treat the device as trusted.
- The server does not rate-limit password attempts yet. Use a long password (the minimum is 8 characters).
- The recovery key is shown once; if you lose both password and key, your notes can't be recovered.

## Next steps (not built yet)

- **Closed-app reminders**: Web Push from the Worker, using a scheduled trigger to send alerts on time.
- **Native Android app** (Expo, with a home-screen widget): the shared reminder helpers are ready for it.
- Login rate limiting on the server.
