#!/usr/bin/env node
// Multi-turn interactive browser session CLI.
//
//   node session.mjs start    [--session NAME] [--headless 0|1] [--force]
//   node session.mjs status   [--session NAME]
//   node session.mjs goto     <url> [--session NAME] [--wait load|domcontentloaded|networkidle|commit]
//   node session.mjs snap     [outPath] [--session NAME] [--full-page]
//   node session.mjs eval     <node-snippet> [--session NAME]
//   node session.mjs stop     [--session NAME]
//
// A daemon process owns a long-lived chromium (spawned with a CDP debug
// port). Per-turn CLI invocations attach via `chromium.connectOverCDP`,
// act on the first context's first page, and detach without killing it.
// Page URL / cookies / DOM / scroll state persist between turns.
//
// `eval` runs a JS snippet in the daemon's Node process with `page`,
// `context`, and `browser` Playwright handles in scope — e.g.
//   node session.mjs eval 'await page.click("text=Login"); return page.url()'
// Use `page.evaluate("…")` from inside the snippet when you really need
// browser-side JS. The return value is JSON-printed to stdout.
//
// Session metadata lives at ~/.cache/termux-playwright-harness/session-<name>.json.
// Default session name is 'default'; override with --session or PW_SESSION env.

import { existsSync, promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startSession, withActivePage,
  readSessionMeta, sessionMetaPath, sessionLogPath,
  isPidAlive, clearStaleSessionMeta, SESSION_DIR,
} from './browser.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const sub = process.argv[2];
const { flags, positional } = parseFlags(process.argv.slice(3));
const name = flags.session ?? process.env.PW_SESSION ?? 'default';

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// Truthy-ish flag interpretation: --headless (no value) → true,
// --headless 1/true/yes → true, --headless 0/false/no → false.
function flagBool(v, dflt) {
  if (v === undefined) return dflt;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return dflt;
}

// --- start ---------------------------------------------------------------

async function spawnDaemon() {
  await fsp.mkdir(SESSION_DIR, { recursive: true });
  const logFh = await fsp.open(sessionLogPath(name), 'a');
  const args = [SCRIPT_PATH, 'start', '--session', name];
  if (flags.headless !== undefined) args.push('--headless', String(flags.headless));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: { ...process.env, __TPW_DAEMON: '1' },
  });
  child.unref();
  await logFh.close();

  // Poll for the metadata file to confirm the daemon came up.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const meta = await readSessionMeta(name);
    if (meta) {
      console.log(`session '${name}' started: cdp=${meta.cdpEndpoint} daemon-pid=${meta.pid} chromium-pid=${meta.chromiumPid}`);
      return;
    }
    // If the spawned process already exited, surface the log.
    await new Promise((r) => setTimeout(r, 150));
  }
  die(`daemon failed to come up within 25s — see ${sessionLogPath(name)}`);
}

async function runDaemon() {
  // Inside the daemon: spawn chromium, write metadata, park.
  const headless = flagBool(flags.headless, true);
  let session;
  try {
    session = await startSession({ name, headless });
  } catch (e) {
    console.error(`[daemon] startSession failed: ${e?.stack ?? e}`);
    process.exit(1);
  }
  console.log(`[daemon] chromium pid=${session.child.pid} userDataDir=${session.userDataDir}`);

  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] shutting down (${reason})`);
    try { session.child.kill('SIGTERM'); } catch {}
    // Give chromium a moment; force-kill if it lingers.
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try { session.child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      session.child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    await fsp.unlink(sessionMetaPath(name)).catch(() => {});
    // Best-effort cleanup of the chromium user-data-dir.
    await fsp.rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  session.child.once('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[daemon] chromium exited unexpectedly code=${code} signal=${signal}`);
      shutdown('chromium-exit');
    }
  });

  // Park forever.
  setInterval(() => {}, 1 << 30);
}

async function cmdStart() {
  if (process.env.__TPW_DAEMON === '1') return runDaemon();

  await clearStaleSessionMeta(name);
  const existing = await readSessionMeta(name);
  if (existing) {
    if (!flags.force) {
      die(
        `session '${name}' already running (daemon pid ${existing.pid}) — ` +
        `run \`node session.mjs stop\` first, or pass --force to restart`,
      );
    }
    console.log(`session '${name}' already running — restarting (--force)`);
    await stopSession();
  }
  await spawnDaemon();
}

// --- stop ----------------------------------------------------------------

async function stopSession() {
  const meta = await readSessionMeta(name);
  if (!meta) return false;
  if (!isPidAlive(meta.pid)) {
    await fsp.unlink(sessionMetaPath(name)).catch(() => {});
    return true;
  }
  try { process.kill(meta.pid, 'SIGTERM'); } catch {}
  // Wait for the daemon's own SIGTERM handler to unlink the metadata.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await readSessionMeta(name))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Daemon didn't tidy up — force it.
  try { process.kill(meta.pid, 'SIGKILL'); } catch {}
  await fsp.unlink(sessionMetaPath(name)).catch(() => {});
  return true;
}

async function cmdStop() {
  const stopped = await stopSession();
  console.log(stopped ? `session '${name}' stopped` : `no active session '${name}'`);
}

// --- status --------------------------------------------------------------

async function cmdStatus() {
  await clearStaleSessionMeta(name);
  const meta = await readSessionMeta(name);
  if (!meta) {
    console.log(`no active session '${name}'`);
    process.exit(1);
  }
  console.log(JSON.stringify(meta, null, 2));
}

// --- goto / snap / eval --------------------------------------------------

async function cmdGoto() {
  const url = positional[0];
  if (!url) die('usage: node session.mjs goto <url> [--wait load|domcontentloaded|networkidle|commit]', 2);
  const waitUntil = flags.wait ?? 'load';
  await withActivePage(async (page) => {
    await page.goto(url, { waitUntil });
    console.log(page.url());
  }, { name });
}

async function cmdSnap() {
  const outArg = positional[0];
  const outPath = outArg
    ? path.resolve(outArg)
    : path.resolve('screenshots', `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await withActivePage(async (page) => {
    await page.screenshot({ path: outPath, fullPage: flags['full-page'] === true });
    console.log(outPath);
  }, { name });
}

async function cmdEval() {
  const snippet = positional.join(' ');
  if (!snippet) die('usage: node session.mjs eval <node-snippet>', 2);
  await withActivePage(async (page, { context, browser }) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('page', 'context', 'browser', snippet);
    const result = await fn(page, context, browser);
    if (result === undefined) return;
    try {
      console.log(JSON.stringify(result, null, 2));
    } catch {
      console.log(String(result));
    }
  }, { name });
}

// --- dispatch ------------------------------------------------------------

const commands = {
  start: cmdStart,
  stop: cmdStop,
  status: cmdStatus,
  goto: cmdGoto,
  snap: cmdSnap,
  eval: cmdEval,
};

if (!sub || !commands[sub]) {
  die('usage: node session.mjs <start|stop|status|goto|snap|eval> [...args]', 2);
}

try {
  await commands[sub]();
} catch (e) {
  console.error(e?.stack ?? String(e));
  process.exit(1);
}
