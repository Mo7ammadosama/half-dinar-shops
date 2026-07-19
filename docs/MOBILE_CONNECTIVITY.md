# Running the customer app on your phone

> **TL;DR — one command, works from any network, no router/hotspot changes:**
> ```bash
> cd "C:\MY NEW APP\mobile"
> npm run start:remote
> ```
> Scan the QR with Expo Go. The app AND all its API calls now reach your PC over
> the internet, whatever network your phone or PC is on. Press **Ctrl+C** when
> done. Read the security note before you rely on it.

---

## ⭐ Primary method — `npm run start:remote` (network-independent)

This is the recommended way to run the app on your phone. It does **not** depend
on your Wi-Fi, your router, AP isolation, or a hotspot. Your phone can be on
cellular data and your PC on home Wi-Fi — different networks entirely — and it
still works.

### Why this exists (the problem it solves)

Plain `expo start --tunnel` only tunnels the **Metro bundler** (the JavaScript
bundle). It does **not** tunnel the **backend API** on port 3000. So the app
loads over the tunnel, then every API call — login included — fails, because the
phone has no route to the API. `npm run start:remote` fixes that by tunnelling
**both**:

1. It makes sure the **backend** is running on `:3000` (starts it if it isn't).
2. It opens a public tunnel to the **API** with **cloudflared** (no account).
3. It injects that tunnel's URL into the app **at runtime** (via the Expo
   manifest — see `app.config.js`), so the app automatically calls the tunneled
   API. **You never edit a URL.**
4. It starts **Expo in `--tunnel` mode** for the bundle, retrying automatically
   if the tunnel is slow to come up.

### One-time setup

Nothing to sign up for. The **first** run downloads `cloudflared` (~54 MB, no
account) into `mobile/.tunnel/` automatically. After that it is instant.

You need **Expo Go** installed on your phone (App Store / Play Store) — the same
app you already use.

### Run it

```bash
cd "C:\MY NEW APP\mobile"
npm run start:remote
```

You'll see it print the API tunnel URL, then Expo's QR code.

### Verify on your phone

1. Open **Expo Go** and **scan the QR code** shown in the terminal.
2. The app loads (over the tunnel — your phone can be on **any** network).
3. On the login screen, sign in:
   - customer: **`0791111111`**  · merchant: **`0791234567`** · admin: **`0799999999`**
   - Enter the phone in local form, tap **Send code** — the code appears on screen
     and is prefilled (no SMS yet) — then **Sign in**.
4. Browse the shop, add items, place an order. **Every one of those is an API
   call succeeding over the tunnel** — which is exactly what plain `--tunnel`
   could not do.

Press **Ctrl+C** in the terminal to close both tunnels when you're finished.

### Testing the customer AND merchant app at the same time (two phones)

Both apps ship `npm run start:remote`, and the two are built to run **in parallel**
so you can test the whole marketplace at once — customer on one phone, shopkeeper
on another:

1. **Start the shared backend yourself first**, once, in its own terminal:
   ```bash
   cd backend && npm run start
   ```
   This matters: if you skip it, whichever app you launch first starts the backend
   and *owns* it — pressing Ctrl+C there would stop the API for both apps. Start it
   yourself and **neither** app owns it, so quitting one never disturbs the other.
2. In a second terminal: `cd mobile && npm run start:remote` (customer, Metro 8081).
3. In a third terminal: `cd merchant-app && npm run start:remote` (merchant, Metro 8082).

Each app uses a **different Metro port** and opens its **own** cloudflared API
tunnel, and each tears down **only its own** processes on Ctrl+C (by PID, never by
image name). So the two sessions no longer fight over port 8081 or kill each
other's tunnel — earlier they did, and starting the second app knocked the first
one offline. Scan each QR with a separate phone (or two Expo Go sessions).

### 🔒 Security — read this once

While `start:remote` is running, your **development** backend is reachable on a
public URL (random, unguessable, and it dies the moment you press Ctrl+C). Two
things follow from that:

- Because there is **no SMS provider yet, the API returns login codes in its
  response**. So anyone who obtained the live tunnel URL could request a login
  code for any of the test numbers — **including admin `0799999999`** — and read
  it back. The URL is random and temporary, so the practical risk is low, but:
- **Only run `start:remote` while you are actively testing, and press Ctrl+C when
  you're done.** Don't leave it running unattended.

This is dev data on a dev box, so it's an acceptable trade for "works anywhere."
If you ever want a **private** version (no public URL at all), **Tailscale** is
the clean alternative: install it on the PC and the phone, and both get stable
addresses that work across any network — then plain `npx expo start` works with
no code change. That needs a (free) Tailscale login on both devices; `start:remote`
needs nothing, which is why it's the default here.

### If the QR/tunnel doesn't come up

The tunnel Expo uses (ngrok) is occasionally slow and times out with
*"ngrok tunnel took too long to connect."* The script **already retries this
automatically** (up to 4 times). If it still gives up, just run
`npm run start:remote` again — it's intermittent, not broken.

### What was tested (from the PC, 2026-07-18)

Everything except your phone physically rendering the screen was verified here:

- The **API is reachable over the public internet** through the tunnel:
  `GET https://<random>.trycloudflare.com/api/shops` → **HTTP 401** (reachable,
  needs login), and a login-code request over the public URL returned a real code.
- The **app is wired to the tunneled API at runtime**: the Expo manifest served to
  the phone carries `extra.apiBase = https://<random>.trycloudflare.com/api`, which
  is exactly what the app reads to choose its API base. No manual editing, no stale
  URL.
- The Expo tunnel came up on repeated runs; the retry loop covers the times it
  doesn't.

What could **not** be tested without your device: the phone actually rendering the
screens and making the calls end-to-end. That's the one step above for you.

---

## Alternative method — LAN / hotspot (same network)

Use this if you'd rather not expose anything publicly and both devices are on the
**same** network.

1. From `backend/`: `npm run start` (or `npm run start:prod`).
2. From `mobile/`: `npx expo start` (plain — **no** `EXPO_PUBLIC_API_BASE`; on a
   phone "localhost" means the phone itself).
3. Scan the QR in Expo Go. The app derives the API from the Metro host
   automatically.

This needs the phone to be able to reach the PC on the LAN — which is exactly what
**AP Isolation** (below) blocks on many home routers. A **phone hotspot** (PC
joined to it) is the reliable same-network option, because hotspots don't isolate
their clients. To see multiple shops sorted by distance, run `npm run seed:demo`
in `backend/` first.

---

## Reference — why home Wi-Fi blocked the phone (AP Isolation)

You don't need this if you use `start:remote` (it bypasses the whole issue). Kept
for reference:

Many ISP routers enable **AP Isolation** (a.k.a. Client / Wireless / Station
Isolation, or a Guest SSID): devices can reach the internet but **not each other**
on the LAN. That's why the phone couldn't reach the PC on home Wi-Fi even with the
firewall open, while a hotspot worked. The router setting to disable, if you ever
want the LAN method to work, is **AP Isolation**, usually under **Wireless →
Advanced**. That's a change on your router, which the assistant can't reach —
documented only so you have the exact name. **`start:remote` needs none of this.**

### Windows firewall note (LAN method only)

Two inbound rules (TCP 8081 + 3000, local subnet) were added so a phone can reach
the dev server on the LAN — see the top of `PHASE_REPORTS.md` for how to remove
them. The tunnel method does not rely on them.
