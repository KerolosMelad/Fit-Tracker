# Secure deploy checklist (Cut Tracker)

This app is static. **Photos and logs stay in the browser on each device** (IndexedDB). Hosting the code does not upload your images — unless you export a full backup or add a sync backend later.

## Deploy (Cloudflare Pages)

One-time in a **normal terminal** (Cursor agent cannot complete browser login for you):

```powershell
cd C:\Users\kelkess\cut-tracker
npx --yes wrangler@4 login
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Then lock it:

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access** → **Applications** → Add application
2. Protect your `cut-tracker*.pages.dev` URL
3. Policy: **Allow** only your email

iPhone: Safari → open URL → Share → **Add to Home Screen**.

## Before you deploy

- [ ] Prefer a **private** host gate (Cloudflare Access, Netlify password/invite) — not a public discoverable URL alone.
- [ ] Do **not** commit backups, exports, or photo files to Git.
- [ ] Confirm `.gitignore` excludes `*.backup.json`, `full-backup-*.json`, and any local export folders you use.

## Hosting (recommended)

- [ ] Deploy static files only (`index.html`, `styles.css`, `app.js`, `db.js`, and any PWA assets).
- [ ] Put **Cloudflare Access** (or equivalent) in front so only your email/device can open the app.
- [ ] Use **HTTPS** (default on Cloudflare Pages / Netlify).
- [ ] Do not enable a public backend, shared database, or “sync to cloud” without auth + encryption.

## On your iPhone

- [ ] Open the private URL in Safari → Share → **Add to Home Screen**.
- [ ] Keep the phone locked (passcode / Face ID).
- [ ] Remember: phone data and PC data are **separate** unless you import a backup.

## Backups (highest risk)

- [ ] Treat **Export full backup** like the photos themselves — it embeds image data.
- [ ] Prefer **AI pack** when you only need numbers/plans (photos are inventory only, not images).
- [ ] Store backup JSON offline or in a password-protected archive — not email, chat, or shared Drive/iCloud folders.
- [ ] Never paste a full backup into an AI chat if it may contain photos.

## Ongoing

- [ ] Re-check Access rules if you change email or lose a device.
- [ ] After a phone reset, restore only from a backup you still control.
- [ ] If the URL ever becomes public by mistake, rotate Access / change the project URL and assume only the *app shell* leaked — not on-device data (unless a backup also leaked).
