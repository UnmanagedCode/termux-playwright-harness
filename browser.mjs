// Thin wrapper around playwright-core that launches the Termux-installed
// system Chromium instead of Playwright's bundled binary (which doesn't
// ship for Android ARM). Use this from ad-hoc debug scripts so they don't
// all have to repeat the executablePath / flags dance.
//
//   import { withPage } from 'termux-playwright-harness/browser.mjs';   // or relative path
//   await withPage(async (page) => {
//     await page.goto('http://127.0.0.1:8787');
//     await page.screenshot({ path: 'screenshots/home.png' });
//   });

import { chromium } from 'playwright-core';
import { existsSync, promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Default to the Termux chromium-browser launcher. Override with
// PLAYWRIGHT_CHROMIUM_BIN if you've installed Chrome elsewhere.
const DEFAULT_BIN = process.env.PLAYWRIGHT_CHROMIUM_BIN
  || '/data/data/com.termux/files/usr/bin/chromium-browser';

// Termux chromium needs --no-sandbox (no setuid sandbox helper on Android)
// and --disable-dev-shm-usage (no /dev/shm mount). The other flags reduce
// memory pressure and skip features that don't matter for visual debugging.
const TERMUX_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
];

export async function launchBrowser({
  headless = true,
  executablePath = DEFAULT_BIN,
  extraArgs = [],
} = {}) {
  if (!existsSync(executablePath)) {
    throw new Error(
      `Chromium binary not found at ${executablePath}. ` +
      `Install with \`pkg install chromium\` or set PLAYWRIGHT_CHROMIUM_BIN.`,
    );
  }
  return chromium.launch({
    headless,
    executablePath,
    args: [...TERMUX_CHROMIUM_ARGS, ...extraArgs],
  });
}

// Convenience: spin up a browser + context + page, run `fn`, tear down
// cleanly even on throw. Returns whatever `fn` returns.
export async function withPage(fn, opts = {}) {
  const browser = await launchBrowser(opts);
  try {
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    });
    // Surface page console / errors to the terminal — most of the value of
    // a visual debug session is catching things you wouldn't see in a
    // headless screenshot otherwise.
    context.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) {
        console.log(`[page ${msg.type()}] ${msg.text()}`);
      }
    });
    context.on('weberror', (e) => console.log(`[page error] ${e.error()}`));
    const page = await context.newPage();
    return await fn(page, { browser, context });
  } finally {
    await browser.close();
  }
}

// For scripts that want to wait until a server is reachable (e.g. you just
// `npm start`ed it in another shell or are about to).
export async function waitForServer(url, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok || r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms`);
}

// --- Multi-turn session support ---------------------------------------
//
// `withPage` is single-shot: each invocation launches a fresh chromium and
// tears it down on exit. For agent-style multi-turn workflows (turn 1
// navigates, turn 2 inspects, turn 3 clicks) we need a long-lived chromium
// that persists across separate node processes.
//
// Design: a daemon process spawns chromium directly with
// --remote-debugging-port=<port>, writes a metadata file, and parks. Each
// per-turn CLI invocation reads the metadata and connects over CDP via
// `chromium.connectOverCDP`. CDP-mode contexts live on the chromium side,
// so page URL / cookies / DOM / scroll state survive disconnects.
//
// (launchServer + connect would seem natural but tears down contexts on
// disconnect, which breaks state-across-turns.)

export const SESSION_DIR = path.join(
  os.homedir(), '.cache', 'termux-playwright-harness',
);

export function sessionMetaPath(name = 'default') {
  return path.join(SESSION_DIR, `session-${name}.json`);
}

export function sessionLogPath(name = 'default') {
  return path.join(SESSION_DIR, `session-${name}.log`);
}

export async function readSessionMeta(name = 'default') {
  try {
    return JSON.parse(await fsp.readFile(sessionMetaPath(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// If the metadata file exists but the daemon PID is gone, remove the stale
// file. Returns true if it cleared something.
export async function clearStaleSessionMeta(name = 'default') {
  const meta = await readSessionMeta(name);
  if (meta && !isPidAlive(meta.pid)) {
    await fsp.unlink(sessionMetaPath(name)).catch(() => {});
    return true;
  }
  return false;
}

// Spawn chromium with a remote debugging port + a fresh user-data-dir,
// wait for CDP to come up, write the session metadata file. Returns the
// child handle so the caller can wire it to the daemon process lifecycle.
//
// The caller (the daemon) is responsible for keeping the child alive
// (parking) and tearing it down on SIGTERM.
export async function startSession({
  name = 'default',
  headless = true,
  executablePath = DEFAULT_BIN,
  extraArgs = [],
} = {}) {
  if (!existsSync(executablePath)) {
    throw new Error(
      `Chromium binary not found at ${executablePath}. ` +
      `Install with \`pkg install chromium\` or set PLAYWRIGHT_CHROMIUM_BIN.`,
    );
  }
  await fsp.mkdir(SESSION_DIR, { recursive: true });

  const cdpPort = await findFreePort();
  const userDataDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `tpw-session-${name}-`),
  );

  const args = [
    ...TERMUX_CHROMIUM_ARGS,
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(executablePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => process.stdout.write(`[chromium] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[chromium] ${b}`));

  const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
  // /json/version is the canonical CDP discovery endpoint.
  await waitForServer(`${cdpEndpoint}/json/version`, { timeoutMs: 20_000 });

  const meta = {
    name,
    pid: process.pid,           // daemon node pid (what `stop` SIGTERMs)
    chromiumPid: child.pid,
    cdpEndpoint,
    userDataDir,
    headless,
    startedAt: new Date().toISOString(),
  };
  await fsp.writeFile(sessionMetaPath(name), JSON.stringify(meta, null, 2));

  return { child, meta, userDataDir };
}

// Read the session metadata and open a CDP connection to the running
// chromium. Returns a Playwright Browser handle and the metadata.
export async function connectSession({ name = 'default' } = {}) {
  const meta = await readSessionMeta(name);
  if (!meta) {
    throw new Error(
      `no active session for '${name}' — run \`node session.mjs start\` first`,
    );
  }
  if (!isPidAlive(meta.pid)) {
    throw new Error(
      `session '${name}' is dead (daemon pid ${meta.pid} gone) — run ` +
      `\`node session.mjs start\` to restart`,
    );
  }
  const browser = await chromium.connectOverCDP(meta.cdpEndpoint);
  return { browser, meta };
}

// Per-turn primitive: connect, pick the active context+page (the first
// of each — create if absent), run `fn`, then disconnect (which on CDP
// just detaches the client — chromium and its pages stay alive).
export async function withActivePage(fn, { name = 'default' } = {}) {
  const { browser, meta } = await connectSession({ name });
  try {
    let context = browser.contexts()[0];
    if (!context) context = await browser.newContext();
    // Surface page console errors/warnings for the duration of this turn.
    // These listeners only fire while we're connected.
    context.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) {
        console.error(`[page ${msg.type()}] ${msg.text()}`);
      }
    });
    context.on('weberror', (e) => console.error(`[page error] ${e.error()}`));
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    return await fn(page, { browser, context, meta });
  } finally {
    // On a CDP-connected browser this disconnects the client without
    // closing chromium — exactly what we want for multi-turn.
    await browser.close();
  }
}

// Ask the kernel for an unused TCP port on the loopback. Concurrent
// debug sessions each get their own — no shared fixed port to collide on.
// There's a tiny TOCTOU between releasing here and the caller binding,
// but in practice the kernel doesn't recycle that fast.
export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Boot an arbitrary node server as a child process on a free ephemeral
// port and wait for it to start serving. Returns `{ url, port, child,
// sandbox?, close() }`. Cleanup is wired to parent exit / SIGINT so a
// Ctrl+C'd debug script doesn't leave a stray server running.
//
// Required:
//   cwd    — directory to spawn from (typically your app's repo root)
//   entry  — script path relative to `cwd` (e.g. 'server.js')
//
// Optional:
//   port    — fixed port; default is an ephemeral free port
//   env     — extra env vars; explicit env wins over sandbox-derived env
//   silent  — if true, suppress piping the child's stdout/stderr
//   sandbox — generic mkdtemp helper. Shape:
//             { dirs: { ENV_NAME: 'relative/subpath', ... },
//               env:  { OTHER_VAR: 'value', ... } }
//             Each `dirs` entry is created under a unique tmp root; the
//             env var is set to its absolute path. Any `env` entries are
//             merged in. The tmp root is wiped on `close()`.
//
// Example:
//   const srv = await bootServer({
//     cwd: '/path/to/my-app',
//     entry: 'server.js',
//     sandbox: {
//       dirs: { DATA_ROOT: 'data', LOG_ROOT: 'logs' },
//       env:  { NODE_ENV: 'test' },
//     },
//   });
//   try { /* ... */ } finally { await srv.close(); }
//
// The orchestrator passes PORT to the child; entrypoint scripts should
// read process.env.PORT to honour the chosen port.
export async function bootServer({
  cwd,
  entry,
  port,
  env = {},
  sandbox,
  silent = false,
} = {}) {
  if (!cwd) throw new Error('bootServer: `cwd` is required');
  if (!entry) throw new Error('bootServer: `entry` is required');

  let sandboxState = null;
  if (sandbox) {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'termux-pw-'));
    const dirs = {};
    const sandboxEnv = {};
    for (const [varName, subPath] of Object.entries(sandbox.dirs ?? {})) {
      const abs = path.join(tmpHome, subPath);
      await fsp.mkdir(abs, { recursive: true });
      dirs[varName] = abs;
      sandboxEnv[varName] = abs;
    }
    Object.assign(sandboxEnv, sandbox.env ?? {});
    sandboxState = { tmpHome, dirs };
    // Explicit caller env wins over sandbox-derived env (current contract).
    env = { ...sandboxEnv, ...env };
  }

  const chosenPort = port ?? await findFreePort();
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env, PORT: String(chosenPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!silent) {
    child.stdout.on('data', (b) => process.stdout.write(`[server] ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  }
  const url = `http://127.0.0.1:${chosenPort}`;

  let exitedEarly = null;
  child.once('exit', (code, signal) => {
    exitedEarly = { code, signal };
  });

  try {
    await waitForServer(url, { timeoutMs: 15_000 });
  } catch (e) {
    if (exitedEarly) {
      throw new Error(
        `child server exited before binding (code=${exitedEarly.code} signal=${exitedEarly.signal})`,
      );
    }
    child.kill('SIGTERM');
    if (sandboxState) {
      await fsp.rm(sandboxState.tmpHome, { recursive: true, force: true });
    }
    throw e;
  }

  const cleanup = () => { if (!child.killed) child.kill('SIGTERM'); };
  process.once('exit', cleanup);
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  return {
    url,
    port: chosenPort,
    child,
    sandbox: sandboxState ?? undefined,
    async close() {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            resolve();
          }, 3000);
          child.once('exit', () => { clearTimeout(t); resolve(); });
        });
      }
      if (sandboxState) {
        await fsp.rm(sandboxState.tmpHome, { recursive: true, force: true });
      }
    },
  };
}
