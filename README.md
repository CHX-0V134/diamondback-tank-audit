# SLB Tank Config Audit

Offline-first field audit tool for chemical-injection **tank → well** configurations
(Diamondback continuous program base). Static PWA on GitHub Pages, backed by Supabase.

## What it does
- Field teams sign in with an **approved email** (whitelist), see each tank's current
  configuration, edit it, and **attach / detach wells** when the field differs from the sheet.
- Editable: product (dropdown from the product list **+ "Other" free-text** that persists for
  everyone after sync), tank size, target PPM, product type, program, application, asset tag,
  notes; per-well name, accounting ID, pump make, pump S/N.
- **Works fully offline.** Every edit is written to IndexedDB first and queued in a durable
  outbox; it auto-syncs on reconnect and via a manual **Sync** button. Nothing is lost across
  reloads, crashes, or offline stretches.
- Every field change is recorded append-only in `audit_change_log` (who / when / old / new) —
  the data-loss backstop.
- SLB blue theme, light + dark.

## Architecture
- **Frontend:** vanilla JS, no build step. `index.html` + `js/*` + `css/styles.css`.
  Supabase client is vendored at `js/supabase.js` so the app loads with no network.
- **Offline:** `js/db.js` (IndexedDB snapshot + outbox), `js/sync.js` (push/pull engine),
  `sw.js` (service worker caches the app shell). Supabase traffic is never cached by the SW.
- **Backend (Supabase project `Cierra Insurance Adds`, ref `kvixnerqxegaehpmfidh`):**
  `audit_tanks`, `audit_wells` (a "well" row = a well-on-a-tank assignment; a well can serve
  more than one tank), `audit_products`, `audit_change_log`, `audit_allowed_emails`.
  RLS restricts all access to whitelisted emails via `public.audit_is_allowed()`.

## Deploy (GitHub Pages)
1. Push this repo to GitHub.
2. Settings → Pages → deploy from branch, `main` / root.
3. The live URL is `https://<user-or-org>.github.io/<repo>/`.

## One-time Supabase setup (required for login to work)
These are **not** doable from here and must be set in the Supabase dashboard:
1. **Auth → URL Configuration:** set **Site URL** and add a **Redirect URL** equal to the
   GitHub Pages URL above. Magic-link sign-in redirects here.
2. **Auth → Email:** the default Supabase mailer only sends to project members and is heavily
   rate-limited. For a real field crew, configure **custom SMTP** (or pre-invite users).
3. **Whitelist:** add each approved email to `audit_allowed_emails`:
   ```sql
   insert into public.audit_allowed_emails (email, note) values ('tech@slb.com','Field tech');
   ```
   Non-listed users can sign in but see and write nothing (RLS denies).

## Notes
- The anon key in `js/config.js` is a public client key; safe to ship because RLS + the email
  whitelist gate all data access.
- Bump `CACHE` in `sw.js` (and `APP_VERSION` in `js/config.js`) on each deploy to refresh the
  service-worker cache.
- Seeded from `DiamondbackBaseNewContinuousProgramInfo.xlsx`: 290 tanks, 345 well assignments,
  28 products.
