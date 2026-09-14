/**
 * Host diagnostics — regression tests for observable start failures.
 *
 * The bug these pin: a service that failed to start showed up as nothing but a
 * red dot. The cause (a Python traceback, a busy port, a missing interpreter)
 * lived inside the DSH Node process and was never read, because `shell.start()`
 * output was discarded and a dead process was still polled for the full 60s.
 *
 * These tests drive the real `src/host.js` body against a stubbed `shell`, so
 * they assert on the exact payload the panel renders.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_BODY = readFileSync(resolve(HERE, '..', 'dsh-plugin', 'src', 'host.js'), 'utf8')

// The body is a bare `return { ... }`; wrap and call it exactly like the loader.
const loadPlugin = () => new Function(HOST_BODY)()

const collected = (text) => ({ text, truncated: false })

/** A Cordis-ish context that records the routes the plugin registers. */
const makeContext = (shell) => {
  const routes = new Map()
  const webServer = { register: ({ path, handler }) => (routes.set(path, handler), () => routes.delete(path)) }
  return {
    routes,
    get: (name) => (name === 'shell' ? shell : name === 'webServer' ? webServer : undefined),
    on: () => {},
    effect: (fn) => fn(),
    // Collapse the poll interval so a 240-iteration wait cannot slow the suite.
    timeout: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 1))),
    interval: () => () => {},
  }
}

const callRoute = async (ctx, path) => {
  const handler = ctx.routes.get(path.split('?')[0])
  assert.ok(handler, `route not registered: ${path}`)
  let body = null
  await handler({ url: path }, { writeHead() {}, end(payload) { body = JSON.parse(payload) } })
  return body
}

/** A shell whose `serve` dies immediately, reporting `output` once. */
const dyingShell = (output, exitCode = 1) => ({
  resolve: (spec) => spec,
  run: async () => ({ exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 8000, stdout: collected(''), stderr: collected('') }),
  start: () => {
    let drained = false
    return {
      status: 'completed',
      exitCode,
      signal: null,
      readOutput: () => (drained ? { delta: '', lossy: false } : ((drained = true), { delta: output, lossy: false })),
      kill: () => true,
    }
  },
})

const healthyShell = (version = '2.1.0') => ({
  resolve: (spec) => spec,
  run: async () => ({ exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version })), stderr: collected('') }),
  start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
})

const boot = async (shell, config) => {
  const ctx = makeContext(shell)
  loadPlugin().apply(ctx, { script: '/tmp/fake/workbench.py', ...config })
  // `apply` kicks off startService without awaiting; give it room to settle.
  await new Promise((done) => setTimeout(done, 150))
  return ctx
}

// Silence the deliberate console.error from failure paths under test.
const quiet = (fn) => async () => {
  const original = console.error
  console.error = () => {}
  try { await fn() } finally { console.error = original }
}

test('a Python traceback reaches the diagnostics payload verbatim', quiet(async () => {
  const traceback = 'Traceback (most recent call last):\n  File "workbench.py", line 1\n  ModuleNotFoundError: No module named \'http\''
  const ctx = await boot(dyingShell(traceback), { port: 4901 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, false)
  assert.match(diag.startError, /serve 进程已退出/)
  const detail = diag.journal.map((entry) => entry.detail || '').join('\n')
  assert.ok(detail.includes("No module named 'http'"), 'the traceback must be readable in the journal')
}))

test("the CLI's structured error becomes the headline, raw line kept as detail", quiet(async () => {
  // This is the exact stderr line workbench.py emits when the port is taken.
  const line = '{"ok": false, "error": "PORT_IN_USE", "message": "[Errno 48] Address already in use"}'
  const ctx = await boot(dyingShell(line), { port: 4902 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.match(diag.startError, /端口已被占用/, 'a person must be able to act on the headline')
  assert.match(diag.startError, /PORT_IN_USE/, 'the machine code stays for searchability')
  const detail = diag.journal.map((entry) => entry.detail || '').join('\n')
  assert.ok(detail.includes('Errno 48'), 'the original line must survive translation')
}))

test('an exited process is not polled for the full timeout', quiet(async () => {
  const started = Date.now()
  const ctx = await boot(dyingShell('boom'), { port: 4903 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, false)
  assert.ok(diag.startError, 'the failure must be recorded, not silently retried')
  // The old code polled 240 times regardless; noticing the exit must be prompt.
  assert.ok(Date.now() - started < 2000, 'a dead process must not look like a hang')
}))

test('diagnostics carry the facts needed to reproduce by hand', quiet(async () => {
  const ctx = await boot(dyingShell('boom'), { port: 4904, editorRoot: '/tmp/root' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.port, 4904)
  assert.equal(diag.script, '/tmp/fake/workbench.py')
  assert.equal(diag.editorRoot, '/tmp/root')
  assert.equal(diag.hasShell, true)
}))

test('a missing shell service is named, not swallowed', quiet(async () => {
  const ctx = await boot(undefined, { port: 4905 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.hasShell, false)
  assert.match(diag.startError, /shell 服务不可用/)
}))

test('a failed open carries the diagnostics with it', quiet(async () => {
  const ctx = await boot(dyingShell('boom'), { port: 4906 })
  const body = await callRoute(ctx, '/html-workbench/open?file=%2Ftmp%2Fpage.html')

  assert.equal(body.ok, false)
  assert.ok(body.diagnostics, 'the panel must be able to explain the failure in place')
  assert.ok(body.diagnostics.journal.length > 0)
}))

test('the journal also explains a HEALTHY service, not just failures', async () => {
  const ctx = await boot(healthyShell('2.1.0'), { port: 4907 })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.running, true)
  assert.equal(diag.startError, null)
  assert.ok(diag.journal.length > 0, 'the current state must be traceable too')
  assert.match(diag.journal[0].message, /2\.1\.0/)
})

test('restart clears the port before spawning, and reports success', async () => {
  const commands = []
  let healthy = false
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => {
      commands.push(spec.command)
      if (spec.command.includes(' stop ')) return { exitCode: 0, stdout: collected('{"ok": true}'), stderr: collected('') }
      if (healthy && spec.command.includes(' health ')) {
        return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      }
      return { exitCode: 1, stdout: collected(''), stderr: collected('') }
    },
    start: () => { healthy = true; return { status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true } },
  }
  const ctx = await boot(shell, { port: 4908 })
  const body = await callRoute(ctx, '/html-workbench/restart')

  assert.equal(body.ok, true)
  // Without this, a restart into a port held by a process we do not own would
  // simply fail again with PORT_IN_USE.
  assert.ok(commands.some((c) => c.includes('stop --port 4908')), 'restart must free the port first')
})

test('restart refuses when the port cannot be freed', quiet(async () => {
  const shell = {
    resolve: (spec) => spec,
    run: async (spec) => (spec.command.includes(' stop ')
      ? { exitCode: 1, stdout: collected(''), stderr: collected('{"ok": false, "error": "SERVER_OUTDATED"}') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => { throw new Error('must not spawn while the port is busy') },
  }
  const ctx = await boot(shell, { port: 4909 })
  const body = await callRoute(ctx, '/html-workbench/restart')

  assert.equal(body.ok, false)
  assert.match(body.error, /无法停止/)
}))

test('a service that dies AFTER starting is reported, not left stale', quiet(async () => {
  // The exact state the live plugin got stuck in: it reported a running service
  // while every open failed, because nothing ever re-checked. Covers the reused
  // path (no process handle) — the harder of the two.
  let healthy = true
  const shell = {
    resolve: (spec) => spec,
    run: async () => (healthy
      ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4910 })
  assert.equal((await callRoute(ctx, '/html-workbench/diagnostics')).running, true, 'sanity: healthy first')

  // The service dies underneath us. Revalidation is throttled to spare
  // subprocesses, so advance the clock rather than sleeping through the window.
  healthy = false
  const realNow = Date.now
  Date.now = () => realNow() + 11000
  try {
    await callRoute(ctx, '/html-workbench/diagnostics')
    await new Promise((done) => setTimeout(done, 80))
  } finally {
    Date.now = realNow
  }
  const after = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(after.running, false, 'the dot must go red on its own')
  assert.ok(after.startError, 'the death must be explained')
  assert.ok(
    after.journal.some((entry) => entry.message.includes('失去响应')),
    'the loss must be journalled where the user looks',
  )
}))

test('a healthy reused service is not re-checked on every poll', async () => {
  // The panel polls every few seconds; revalidation spawns a subprocess. Without
  // throttling this would fork python3 continuously in the background.
  let healthCalls = 0
  const shell = {
    resolve: (spec) => spec,
    run: async () => {
      healthCalls += 1
      return { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
    },
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4912 })
  const baseline = healthCalls
  for (let i = 0; i < 5; i += 1) await callRoute(ctx, '/html-workbench/diagnostics')
  await new Promise((done) => setTimeout(done, 50))

  assert.equal(healthCalls, baseline, 'five polls inside the window must cost zero subprocesses')
})

test('an owned process that exits is reaped without a subprocess call', quiet(async () => {
  const handle = {
    status: 'running',
    exitCode: null,
    signal: null,
    readOutput: () => ({ delta: handle.status === 'running' ? '' : 'KeyboardInterrupt' }),
    kill: () => true,
  }
  let healthy = false
  const shell = {
    resolve: (spec) => spec,
    run: async () => (healthy
      ? { exitCode: 0, stdout: collected(JSON.stringify({ ok: true, service: 'html-workbench', version: '2.1.0' })), stderr: collected('') }
      : { exitCode: 1, stdout: collected(''), stderr: collected('') }),
    start: () => { healthy = true; return handle },
  }
  const ctx = await boot(shell, { port: 4911 })
  const before = await callRoute(ctx, '/html-workbench/diagnostics')
  assert.equal(before.owned, true, 'sanity: the plugin owns the process')

  handle.status = 'completed'
  handle.exitCode = 1
  const after = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(after.running, false)
  assert.equal(after.owned, false, 'a dead handle must be released')
  assert.ok(after.journal.some((entry) => entry.message.includes('意外退出')))
}))

test('the panel reports the directories the service really uses', async () => {
  // The service re-probes in-process and falls back, because the runtime paths it
  // is handed may be exactly what the sandbox refuses (DSH grants only the
  // workspace and a private temp folder). Echoing the REQUESTED paths afterwards
  // is what made a perfectly healthy service look broken to its own user.
  const shell = {
    resolve: (spec) => spec,
    run: async () => ({
      exitCode: 0,
      stdout: collected(JSON.stringify({
        ok: true,
        service: 'html-workbench',
        version: '2.1.0',
        logDir: 'C:\\ws\\.html-workbench\\logs',
        vendorCache: 'C:\\ws\\.html-workbench\\vendor',
      })),
      stderr: collected(''),
    }),
    start: () => ({ status: 'running', exitCode: null, signal: null, readOutput: () => ({ delta: '' }), kill: () => true }),
  }
  const ctx = await boot(shell, { port: 4913, runtimeDir: 'C:/Temp/.html-workbench' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.logDir, 'C:\\ws\\.html-workbench\\logs')
  assert.equal(diag.vendorCache, 'C:\\ws\\.html-workbench\\vendor')
})

test('a service that advertises no directories keeps the requested ones', async () => {
  // Backwards compatibility: an already-running 0.3.0-era service cannot report
  // them, and the panel must still say something rather than nothing.
  const ctx = await boot(healthyShell('2.1.0'), { port: 4914, runtimeDir: 'C:/Temp/.html-workbench' })
  const diag = await callRoute(ctx, '/html-workbench/diagnostics')

  assert.equal(diag.logDir, 'C:/Temp/.html-workbench/logs')
  assert.equal(diag.vendorCache, 'C:/Temp/.html-workbench/vendor')
})

test('host and service agree on one runtime folder name', () => {
  // Two different names would scatter two directories through the user's
  // workspace: the host's first guess and the service's own fallback must match.
  const service = readFileSync(resolve(HERE, '..', 'service', 'server', 'workbench.py'), 'utf8')
  const declared = /^RUNTIME_DIR_NAME = "([^"]+)"/m.exec(service)
  assert.ok(declared, 'workbench.py must declare RUNTIME_DIR_NAME')

  for (const name of ['dsh-plugin/src/host.js', 'dsh-plugin/src/index.js']) {
    const source = readFileSync(resolve(HERE, '..', name), 'utf8')
    assert.ok(source.includes(declared[1]), `${name} must reference ${declared[1]}`)
  }
})
