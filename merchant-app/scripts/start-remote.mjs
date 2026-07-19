#!/usr/bin/env node
/*
 * start-remote.mjs — run the MERCHANT app so a phone reaches it from ANY network.
 *
 * Ported verbatim from mobile/scripts/start-remote.mjs (the customer app). The
 * logic is identical and fully path-relative: APP_DIR is derived from this
 * script's own location and BACKEND_DIR is its sibling ../backend, so the same
 * file works unchanged from either app directory.
 *
 * WHY NODE, NOT BASH (this is the whole point):
 *   npm runs scripts through cmd.exe, and on a Windows machine with WSL installed
 *   the bare command `bash` resolves to C:\Windows\System32\bash.exe — i.e. WSL.
 *   A script run under WSL2 lives in a DIFFERENT network namespace, so its
 *   `127.0.0.1:3000` is NOT the Windows-side backend, and the health check can
 *   never see it ("the backend did not come up on :3000"). Proven live 2026-07-18:
 *   WSL curl to 127.0.0.1:3000 -> 000, Git Bash -> 401, same backend.
 *   Running via `node` uses the SAME Windows Node that runs everything else, so
 *   networking, ports and child processes are all Windows-native. No shell in the
 *   loop, no WSL, works the same however you launch it.
 *
 * What it does: ensure the backend is up on :3000, open a public cloudflared
 * tunnel to it, inject that URL into the app at runtime (EXPO_TUNNEL_API_BASE ->
 * app.config.js -> manifest extra.apiBase, read by src/api.ts), then start Expo
 * in --tunnel mode (with auto-retry). Ctrl+C tears the tunnels down.
 *
 * SECURITY: while running, the dev backend is on a public URL and (no SMS yet)
 * returns login codes in its responses — anyone with the live URL could read one,
 * including admin. The URL is random and dies on Ctrl+C. Only run while testing.
 * See docs/MOBILE_CONNECTIVITY.md.
 *
 * RUNNING BOTH APPS AT ONCE (customer + merchant, two phones): this script and
 * mobile/scripts/start-remote.mjs are designed to run in parallel. The merchant
 * app uses Metro port 8082, the customer app 8081; each opens its own cloudflared
 * API tunnel and tears down ONLY its own (kills by PID, never by image name), so
 * Ctrl+C on one leaves the other running. Recommended: start the shared backend
 * yourself first — `npm run start` in backend/ — so NEITHER script owns it and
 * quitting one never takes the other's API down. If you don't, whichever script
 * started the backend owns it, and Ctrl+C there stops the API for both.
 */
import { spawn, execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BACKEND_DIR = join(APP_DIR, "..", "backend");
const CACHE_DIR = join(APP_DIR, ".tunnel");
const CF = join(CACHE_DIR, "cloudflared.exe");
const CF_DOWNLOAD =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const API_PORT = 3000;

// Metro/Expo port for THIS app. The merchant app uses 8082 so it can run at the
// same time as the customer app (which keeps Metro's default 8081). Distinct ports
// are what let both `start:remote` scripts run in parallel — otherwise the second
// Expo would collide on 8081 and each script's freePort() would kill the OTHER
// app's Metro. Only start:remote uses this; the plain `start`/`web` scripts (which
// the e2e suite drives on 8081) are untouched.
const METRO_PORT = 8082;

let cfProc = null;
let backendProc = null; // set only if THIS script started the backend
let cleanedUp = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  process.stdout.write("\nShutting down tunnels...\n");
  // Kill ONLY our own cloudflared child TREE, by PID — never `taskkill /IM
  // cloudflared.exe`, which would also kill the OTHER app's start:remote tunnel
  // when you Ctrl+C this one. We spawn CF directly, so cfProc.pid IS cloudflared;
  // /T /F takes any children and survives cloudflared ignoring a soft kill.
  if (cfProc?.pid) {
    try { execSync(`taskkill /PID ${cfProc.pid} /T /F`, { stdio: "ignore" }); } catch {}
  } else {
    try { cfProc?.kill(); } catch {}
  }
  if (backendProc?.pid) {
    // Only if we started it. /T kills the cmd->node tree.
    try { execSync(`taskkill /PID ${backendProc.pid} /T /F`, { stdio: "ignore" }); } catch {}
  }
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

/** Resolves to the API's HTTP status, or 0 if nothing answered on :3000. */
function apiStatus() {
  return new Promise((resolve) => {
    const req = httpGet(
      { host: "127.0.0.1", port: API_PORT, path: "/api/shops", timeout: 5000 },
      (res) => { res.resume(); resolve(res.statusCode || 0); },
    );
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}
// A live server answers with SOME status (401 normally, but 429/200/etc. all mean
// "up"). Only 0 — no HTTP response — means down.
async function apiIsUp() { return (await apiStatus()) > 0; }

/** Downloads a file, following GitHub's redirects. */
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    httpsGet(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

/** Reads cloudflared's output until it prints the public tunnel URL. */
function captureTunnelUrl(proc) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error("no tunnel URL from cloudflared")); }
    }, 40000);
    const scan = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) { done = true; clearTimeout(timer); resolve(m[0]); }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.on("exit", () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error("cloudflared exited early")); }
    });
  });
}

/**
 * Kills whatever is LISTENING on a TCP port (Windows). Used to clear a stale
 * Metro on 8081 — otherwise `expo start` prompts "use another port?" and, with no
 * interactive terminal, gives up with "Skipping dev server". 8081 is Metro's own
 * port, so a leftover there is always a previous dev server, safe to reclaim.
 * Returns how many processes it killed.
 */
function freePort(port) {
  let out = "";
  try { out = execSync("netstat -ano -p tcp", { encoding: "utf8" }); } catch { return 0; }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || "";
    if (local.endsWith(`:${port}`)) {
      const pid = cols[cols.length - 1];
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
  }
  for (const pid of pids) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch {}
  }
  return pids.size;
}

/** Set of currently-running PIDs for a process image (Windows). */
function listPids(image) {
  const pids = new Set();
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"[^"]+","(\d+)"/);
      if (m) pids.add(m[1]);
    }
  } catch {}
  return pids;
}

/**
 * Kills only the `image` processes that were NOT already running in `keep`.
 * Used to tear down the ngrok tunnel THIS attempt spawned without touching an
 * ngrok belonging to the other app's start:remote (which was in the snapshot).
 */
function killNewPids(image, keep) {
  for (const pid of listPids(image)) {
    if (!keep.has(pid)) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch {}
    }
  }
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  // 0. cloudflared present? (one-time download, no account)
  if (!existsSync(CF)) {
    console.log("First run: downloading cloudflared (one-time, ~54 MB, no account needed)...");
    await download(CF_DOWNLOAD, CF);
    console.log("cloudflared downloaded.");
  }

  // 1. backend up on :3000? start it if not
  const status = await apiStatus();
  if (status > 0) {
    console.log(`Backend already running on :${API_PORT} (HTTP ${status}) — using it.`);
  } else {
    console.log("Starting the backend (logs: .tunnel/backend.log)...");
    const backendLog = createWriteStream(join(CACHE_DIR, "backend.log"));
    backendProc = spawn("npm", ["run", "start"], { cwd: BACKEND_DIR, shell: true });
    backendProc.stdout.pipe(backendLog);
    backendProc.stderr.pipe(backendLog);
    process.stdout.write("Waiting for the backend to come up");
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (await apiIsUp()) { up = true; break; }
      process.stdout.write(".");
      await sleep(2000);
    }
    console.log("");
    if (!up) {
      console.error(`ERROR: the backend did not come up on :${API_PORT}. See .tunnel/backend.log`);
      cleanup();
      process.exit(1);
    }
    console.log("Backend is up.");
  }

  // 2. open the API tunnel and capture its public URL
  console.log("Opening a public tunnel to the API...");
  cfProc = spawn(CF, ["tunnel", "--url", `http://localhost:${API_PORT}`]);
  let apiUrl;
  try {
    apiUrl = await captureTunnelUrl(cfProc);
  } catch (e) {
    console.error("ERROR: could not open the API tunnel:", e.message);
    cleanup();
    process.exit(1);
  }
  await sleep(5000); // let Cloudflare's edge make the URL routable
  console.log(`API tunnel ready: ${apiUrl}`);

  // 3. point the app at the tunneled API at RUNTIME (no bundle rebuild)
  const apiBase = `${apiUrl}/api`;
  console.log("\n======================================================================");
  console.log(` App will call the API at: ${apiBase}`);
  console.log(" Starting Expo in tunnel mode. Scan the QR with Expo Go on your phone.");
  console.log(" Press Ctrl+C here when you're done to close the tunnels.");
  console.log("======================================================================\n");

  // 4. start Expo in tunnel mode, retrying the flaky ngrok connection.
  // A tunnel failure exits within ~60s; a real session lasts minutes — so if Expo
  // ran past the threshold, the exit was an intentional Ctrl+C, not a failure.
  const MIN_UPTIME_MS = 90_000;
  const MAX_TRIES = 4;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    if (attempt > 1) console.log(`>> ngrok tunnel was slow; retrying Expo (${attempt}/${MAX_TRIES})...`);
    // Clear any stale Metro on OUR port only so `expo start` never hits the "port
    // in use" prompt (which, with no interactive terminal, aborts the dev server).
    // Scoped to METRO_PORT — freeing 8081 unconditionally would kill the customer
    // app's Metro.
    const cleared = freePort(METRO_PORT);
    if (cleared) console.log(`(freed a stale process on port ${METRO_PORT})`);
    // Snapshot ngrok BEFORE we spawn Expo, so on failure we kill only the tunnel
    // this attempt created — never an ngrok owned by the other app's start:remote.
    const ngrokBefore = listPids("ngrok.exe");
    const started = Date.now();
    await new Promise((resolve) => {
      const expo = spawn("npx", ["expo", "start", "--tunnel", "--port", String(METRO_PORT)], {
        cwd: APP_DIR,
        shell: true,
        stdio: "inherit",
        env: { ...process.env, EXPO_TUNNEL_API_BASE: apiBase },
      });
      expo.on("exit", () => resolve());
    });
    if (Date.now() - started >= MIN_UPTIME_MS) break; // real session -> user quit
    killNewPids("ngrok.exe", ngrokBefore);
    if (attempt === MAX_TRIES) {
      console.error("ERROR: the Expo tunnel would not connect after several tries.");
      console.error("This is intermittent — just run 'npm run start:remote' again.");
      cleanup();
      process.exit(1);
    }
    await sleep(3000);
  }

  cleanup();
}

main().catch((e) => {
  console.error("start:remote failed:", e.message);
  cleanup();
  process.exit(1);
});
