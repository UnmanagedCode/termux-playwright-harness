# termux-playwright-harness

A small Playwright setup for driving a webapp through the **system Chromium** installed via Termux. Useful for visually verifying changes — screenshots, DOM assertions, console inspection — from an Android phone or any other host without a desktop browser.

Generic infrastructure only. Feature-specific scripts go in the consuming project (or stay as throwaway one-liners in the shell). The goal is reusable pieces for any current or future webapp running on Termux.

```
termux-playwright-harness/
├── browser.mjs       launchBrowser / withPage / waitForServer / findFreePort / bootServer
│                     + startSession / connectSession / withActivePage (multi-turn)
├── snap.mjs          generic screenshot CLI (single-shot)
├── session.mjs       multi-turn session CLI (start / stop / status / goto / snap / eval)
└── package.json      playwright-core only
```

## Growing the harness while debugging

Every debug session is also a chance to make the *next* one cheaper. While you're driving the harness for a specific feature, watch for code with a high probability of being useful across unrelated future debug sessions — and lift it into the harness rather than letting it live in a throwaway script.

Good signals that something belongs here:

- You found yourself **copy-pasting it from a previous session** (mkdtemp + ephemeral roots, REST helper, waiting for a status, killing a subprocess by pid).
- It's **state setup that any feature would need**, not just yours (sandboxing, pre-populating disk fixtures, snapshotting WS traffic, dumping the page console).
- It would be **annoying to rediscover** the next time (CLI flags, env vars, encoding rules, selectors for stable UI landmarks).

Anti-signals — keep these *out* of here:

- Specific to one bug, ticket, or PR (`verify-session-delete.mjs`, `repro-issue-42.mjs`).
- Hard-coded against a particular fixture, project name, scenario, or selector tied to one feature's markup.
- Single-use scripts whose value is the *session*, not the *tool* — those belong in `$TMPDIR/` (or your shell history).

When in doubt, ask: *"Would a teammate debugging a totally different feature next month want this?"* If yes, generalise the API, drop the feature-specific bits, document briefly, and commit it. If no, leave it ephemeral.

## Prereqs

- **Termux Chromium** (provides both the browser binary and the launcher):
  ```bash
  pkg install chromium
  which chromium-browser
  # → /data/data/com.termux/files/usr/bin/chromium-browser
  ```
- **Node 22+**.

> `playwright-core` is intentionally used instead of `playwright`. The full `playwright` package downloads its own Chromium build on install, and those builds aren't published for Android ARM. `playwright-core` exposes the same API minus the auto-download — we point `executablePath` at the system Chromium.

## Install

```bash
cd ~/project/termux-playwright-harness
npm install
```

## Using from a sibling project

This package is consumed via direct relative import — no submodule, no npm publish. Clone it as a sibling of your project:

```bash
git clone git@github.com:UnmanagedCode/termux-playwright-harness.git ~/project/termux-playwright-harness
```

```
~/project/
├── termux-playwright-harness/    # this repo
├── my-webapp/                    # your project
│   └── debug/
│       ├── boot-myapp.mjs        # optional thin wrapper for app-specific defaults
│       └── snap.mjs              # optional app-specific CLI
└── ...
```

Then import directly:

```js
import { withPage, bootServer } from '../../termux-playwright-harness/browser.mjs';
```

Because `playwright-core` is installed under `~/project/termux-playwright-harness/node_modules/`, Node's module resolution finds it relative to `browser.mjs` regardless of where the importer lives.

## Quick smoke test

Snap an already-running URL:

```bash
node snap.mjs http://127.0.0.1:8787 ./home.png
```

Open `home.png` to confirm the page rendered. If you see a blank or chrome-error image, see [Troubleshooting](#troubleshooting).

## Building blocks

### `browser.mjs`

Wraps `playwright-core`'s `chromium.launch()` with the executable path and Termux-specific flags (`--no-sandbox`, `--disable-dev-shm-usage`, etc.).

```js
import { withPage, waitForServer } from '../../termux-playwright-harness/browser.mjs';

await waitForServer('http://127.0.0.1:8787');
await withPage(async (page) => {
  await page.goto('http://127.0.0.1:8787');
  await page.screenshot({ path: 'whatever.png' });
}, { headless: true, viewport: { width: 1440, height: 900 } });
```

- `launchBrowser(opts)` — lower-level: returns the `Browser` directly if you need multi-context / multi-page setups.
- `withPage(fn, opts)` — boots browser + context + page, pipes page console errors/warnings to the terminal, runs `fn(page, { browser, context })`, tears down on return or throw.
- `waitForServer(url, { timeoutMs })` — polls until the URL responds (any non-5xx).
- `findFreePort()` — asks the kernel for an unused TCP port on the loopback. Useful if you're booting your own child process.
- `bootServer({ cwd, entry, port?, env?, sandbox?, silent? })` — spawns an arbitrary node server as a child process on a free ephemeral port (override with `port`), waits for it to bind, and returns `{ url, port, child, sandbox?, close() }`. Cleanup is wired to parent `exit` / `SIGINT` / `SIGTERM` so a Ctrl+C'd script never leaks a server.

```js
import { bootServer, withPage } from '../../termux-playwright-harness/browser.mjs';

const srv = await bootServer({
  cwd: '/path/to/my-app',
  entry: 'server.js',
});
try {
  await withPage(async (page) => {
    await page.goto(srv.url);
    await page.screenshot({ path: 'home.png' });
  });
} finally {
  await srv.close();
}
```

**Sandbox helper.** Most debug sessions want isolated on-disk state, not the real working dirs. Pass a `sandbox` to have `bootServer` create a tmpdir, populate it with named subdirs, and expose each as an env var:

```js
const srv = await bootServer({
  cwd: '/path/to/my-app',
  entry: 'server.js',
  sandbox: {
    dirs: { DATA_ROOT: 'data', LOG_ROOT: 'logs' },
    env:  { NODE_ENV: 'test' },
  },
});
// srv.sandbox.tmpHome              → /tmp/termux-pw-XXXXXX/
// srv.sandbox.dirs.DATA_ROOT       → /tmp/termux-pw-XXXXXX/data
// srv.sandbox.dirs.LOG_ROOT        → /tmp/termux-pw-XXXXXX/logs
// child process sees DATA_ROOT, LOG_ROOT, NODE_ENV in its env
```

`srv.close()` wipes the tmpdir. Multiple concurrent `bootServer({ sandbox: … })` calls each get their own port + tmpdir, so several agents debugging in parallel from their own worktrees stay isolated.

The child receives `PORT=<chosen-port>` in its env — your `entry` script should honour `process.env.PORT`.

Override the chromium path with `PLAYWRIGHT_CHROMIUM_BIN=/some/path` if your install lives elsewhere.

### `snap.mjs`

CLI: load a URL, save a PNG.

```bash
node snap.mjs <url> [outputPath]
```

- Default output: `screenshots/<ISO-timestamp>.png` (the directory is gitignored).
- Waits up to 5 s for the URL to be reachable before navigating.
- Useful env vars:
  | Var | Effect | Example |
  |---|---|---|
  | `SNAP_VIEWPORT` | Override viewport | `SNAP_VIEWPORT=375x812` (iPhone-ish) |
  | `SNAP_WAIT` | CSS selector to wait for before snapping | `SNAP_WAIT='.sidebar .session-row'` |
  | `SNAP_FULL_PAGE` | `1` → capture full scroll height | `SNAP_FULL_PAGE=1` |
  | `PLAYWRIGHT_CHROMIUM_BIN` | Override chromium binary path | `…/chrome` |

For "boot + snap + tear down" in a single command, write a small consumer CLI in your own project — `bootServer` + `withPage` is two imports and ~15 lines.

## Multi-turn sessions

`withPage` and `snap.mjs` are single-shot — every call launches chromium and tears it down on exit. For agent-style multi-turn workflows (turn 1 navigates, turn 2 inspects, turn 3 acts) page state would be lost between turns. The `session.mjs` CLI fixes that by keeping a long-lived chromium running in a daemon process; each per-turn CLI invocation attaches via CDP, acts on the first context's first page, and detaches without killing the browser. URL, cookies, DOM, scroll position, focused element, and form input all persist between turns.

### CLI

```
node session.mjs start    [--session NAME] [--headless 0|1] [--force]
node session.mjs status   [--session NAME]
node session.mjs goto     <url> [--session NAME] [--wait load|domcontentloaded|networkidle|commit]
node session.mjs snap     [outPath] [--session NAME] [--full-page]
node session.mjs eval     <node-snippet> [--session NAME]
node session.mjs stop     [--session NAME]
```

Default session name is `default`; override with `--session <name>` or `PW_SESSION=<name>`. Multiple named sessions run side-by-side with their own chromium / port / user-data-dir.

Behaviour worth knowing:

- `start` **refuses** if a session of that name is already running (exit 1). Pass `--force` to stop-then-start (drops all page state). Stale metadata (PID gone) is cleaned up silently.
- Per-turn commands (`goto`/`snap`/`eval`) **never auto-start** a daemon — they fail with a clear error if none exists.
- `eval` runs a JS snippet in the **daemon's Node process** with `page`, `context`, and `browser` Playwright handles in scope. Use it to batch multiple Playwright actions in one turn. Use `page.evaluate("…")` *from inside* the snippet when you need browser-side JS — that's why there's no separate in-page-eval command. The return value is JSON-printed to stdout.

### Example: navigate → inspect → act

```bash
node session.mjs start
node session.mjs goto https://example.com
node session.mjs eval 'return page.evaluate("document.title")'    # "Example Domain"
node session.mjs snap /tmp/t1.png
node session.mjs eval 'await page.click("text=Learn more"); await page.waitForLoadState("load"); return page.url()'
node session.mjs eval 'return page.url()'                          # iana.org — state persists across processes
node session.mjs snap /tmp/t2.png
node session.mjs stop
```

### Where things live

- Session metadata: `~/.cache/termux-playwright-harness/session-<name>.json` (cdpEndpoint, daemon pid, chromium pid, user-data-dir, startedAt). Created by `start`, removed on graceful `stop`.
- Daemon log: `~/.cache/termux-playwright-harness/session-<name>.log` — chromium stdout/stderr + daemon-side messages. Check here if `start` reports the daemon failed to come up.
- Chromium user-data-dir: a fresh `mkdtemp` per `start`, wiped on `stop`.

### Programmatic API

```js
import { withActivePage } from '../../termux-playwright-harness/browser.mjs';

await withActivePage(async (page, { context, browser }) => {
  await page.goto('https://example.com');
  return page.title();
}, { name: 'default' });
```

Lower-level helpers: `startSession`, `connectSession`, `readSessionMeta`, `isPidAlive`, `clearStaleSessionMeta`.

## Writing your own debug script

```js
// /tmp/check-foo.mjs
import { withPage, waitForServer } from '../../termux-playwright-harness/browser.mjs';

await waitForServer('http://127.0.0.1:8787');
await withPage(async (page) => {
  await page.goto('http://127.0.0.1:8787');
  await page.click('text=Login');
  // assert, screenshot, dump page.content(), etc.
});
```

Useful Playwright APIs for visual debugging:

- `page.waitForSelector('.some-row')` — wait for an element.
- `page.locator('header .mode-select')` — query a specific element.
- `page.on('websocket', ws => ws.on('framereceived', f => console.log(f.payload)))` — eavesdrop on WebSocket traffic.
- `await page.evaluate(() => window.someGlobal)` — peek at the frontend state.

## Troubleshooting

**Snap produces a blank/black image.** Termux Chromium can fail silently without `--no-sandbox`; `browser.mjs` already passes it. If you ever override `extraArgs` from a custom script, keep the defaults in.

**`Failed to launch chromium because executable doesn't exist`.** Either Chromium isn't installed (`pkg install chromium`) or your install isn't at the default path; set `PLAYWRIGHT_CHROMIUM_BIN`.

**`Target page, context or browser has been closed`.** Usually a page-side JS error crashed the renderer. Page errors are already piped to the terminal via the `console` / `weberror` listeners in `withPage` — scroll up.

## Why no Playwright test runner?

This harness exists for *visual* verification — eyes on a screenshot, or interactive scripting — which a headless test runner doesn't help with. If a Playwright assertion is ever worth committing, fold it into your project's existing test setup rather than growing a second runner here.
