/**
 * HTML Workbench DSH plugin — Host half (function body).
 *
 * This file is the plain-JavaScript function body consumed by DeepSeek
 * Harness's dynamic Cordis plugin loader: pass this exact text as `code.host`
 * to `cordis_define`. The static host entry `src/index.js` evaluates this same
 * body via `new Function` and re-exports it, so it runs unchanged in both
 * modes. `harness` usage is guarded (`typeof harness !== 'undefined'`) so the
 * body also runs as a static bundle where that symbol does not exist.
 *
 * Responsibilities (runs in the DSH Node.js process):
 *  - Start / reuse the local `html-workbench` Python service on registration
 *    and stop the process it started when the plugin unloads (side-effect
 *    lifecycle via ctx.effect).
 *  - Track HTML files produced by the `write` / `edit` tools via `tools/result`.
 *  - Expose the same three operations through two transports:
 *      * dynamic: `harness.handle` Package-private RPC (Client `host.call`);
 *      * static:  `webServer.register` HTTP routes under `/html-workbench/*`.
 */

return {
  inject: ['shell', 'timer', 'webServer'],
  apply(ctx, config) {
    // 静态/NPM 装载时由 src/index.js 相对插件自身解析 scripts/workbench.py 并注入 config.script；
    // 动态装载（cordis_define）无 config → script 为空，服务不自动拉起（仅注册传输层）。
    // editorRoot 可选：缺省不传 --editor-root，由 workbench.py 自行回退到用户家目录。
    const opts = config || {}
    const PORT = opts.port || 4317
    const SCRIPT = opts.script || null
    const EDITOR_ROOT = opts.editorRoot || null
    // Static packages inject the runtime directory resolved (and probed) by
    // src/index.js. Keep a dynamic-loader fallback too: TEMP/TMPDIR cover
    // Windows/macOS/Linux; only the final fallback is POSIX because dynamic
    // runners may not expose Node's `os` module. The folder name matches
    // RUNTIME_DIR_NAME in workbench.py so both halves agree on one location.
    const tempRoot = typeof process !== 'undefined' && process.env
      ? (process.env.TEMP || process.env.TMP || process.env.TMPDIR)
      : null
    const RUNTIME_DIR = opts.runtimeDir || (tempRoot ? tempRoot.replace(/[\\/]$/, '') + '/.html-workbench' : '/tmp/.html-workbench')

    // These are REQUESTS, not guarantees. The service runs as a DSH sandboxed
    // child that may write only the session workspace and a private temp folder
    // the sandbox hands it — the ambient %TEMP% root seen by this parent is
    // denied, so a folder the parent can create is not necessarily one the child
    // can use. workbench.py therefore re-probes in-process, falls back on its
    // own, and advertises the directories it settled on; `adoptResolvedPaths`
    // below surfaces those, so the panel describes where the service really
    // writes instead of echoing the path we merely asked for. Both are disposable
    // cache/log data either way.
    const LOG_DIR = RUNTIME_DIR + '/logs'
    const VENDOR_CACHE = RUNTIME_DIR + '/vendor'

    // Directories the running service reported; null until it says so.
    let resolvedPaths = null

    let assets = []
    let seq = 0
    let ownedProcess = null
    let serviceRunning = false
    let startError = null
    let disposed = false

    const shell = ctx.get('shell')

    // ── Diagnostics journal ──────────────────────────────────────────────────
    //
    // A failed start used to surface as nothing but a red dot: the only signal
    // was `running: false`, while the actual cause (a Python traceback, a busy
    // port, a missing interpreter) stayed inside this Node process. Every
    // subprocess outcome now lands in this ring buffer, which `status` returns
    // and the panel renders, so the failure is readable where it is observed.
    const JOURNAL_LIMIT = 40
    let journal = []

    const note = (level, message, detail) => {
      journal.push({
        at: Date.now(),
        level: level,
        message: String(message || ''),
        detail: detail ? String(detail).slice(0, 4000) : null,
      })
      if (journal.length > JOURNAL_LIMIT) journal = journal.slice(-JOURNAL_LIMIT)
      if (level === 'error') console.error('[html-workbench] ' + message, detail || '')
    }

    // `CollectedOutput` carries more than text (truncation flags, spill paths);
    // reduce it to the part a human reads, and say so when bytes were dropped.
    const outputText = (collected) => {
      if (!collected) return ''
      const text = typeof collected === 'string' ? collected : (collected.text || '')
      const trimmed = String(text).trim()
      if (collected && collected.truncated) return trimmed + '\n…（输出被截断）'
      return trimmed
    }

    const describeRun = (result) => {
      if (!result) return 'shell.run threw'
      const parts = []
      if (result.timedOut) parts.push('超时（' + result.timeoutMs + 'ms）')
      if (result.aborted) parts.push('被取消')
      if (result.signal) parts.push('信号 ' + result.signal)
      parts.push('exit=' + String(result.exitCode))
      const streams = [outputText(result.stderr), outputText(result.stdout)].filter(Boolean)
      return parts.join(' ') + (streams.length ? '\n' + streams.join('\n') : '')
    }

    const runCli = async (args, timeoutMs) => {
      if (!shell) { note('error', 'shell 服务不可用，无法执行 workbench.py'); return null }
      if (!SCRIPT) { note('error', 'workbench.py 路径未配置'); return null }
      const command = 'python3 "' + SCRIPT + '" ' + args
      try {
        const spec = shell.resolve({ command: command, timeoutMs: timeoutMs || 15000, stdoutMaxBytes: 64 * 1024 })
        const result = await shell.run(spec)
        // A non-zero exit is the interesting case and used to be discarded: the
        // CLI prints a structured `{ok:false,error:{code,message}}` on stdout.
        if (!result || result.exitCode !== 0) note('error', 'workbench.py ' + args.split(' ')[0] + ' 执行失败', describeRun(result))
        return result
      } catch (e) {
        note('error', 'workbench.py ' + args.split(' ')[0] + ' 无法执行', (e && e.message) || String(e))
        return null
      }
    }

    // `health` runs on a timer, so its failures are expected and must not flood
    // the journal — poll quietly and let the caller decide what is worth noting.
    const probeHealth = async () => {
      if (!shell || !SCRIPT) return null
      try {
        const spec = shell.resolve({
          command: 'python3 "' + SCRIPT + '" health --port ' + PORT,
          timeoutMs: 8000,
          stdoutMaxBytes: 64 * 1024,
        })
        const result = await shell.run(spec)
        if (!result || result.exitCode !== 0) return { ok: false, result: result }
        try {
          const payload = JSON.parse(outputText(result.stdout) || '')
          return payload && payload.ok === true ? { ok: true, payload: payload } : { ok: false, result: result }
        } catch (e) {
          return { ok: false, result: result }
        }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    }

    // `/api/health` advertises the directories the service really writes to. The
    // paths it was ASKED for may be exactly what the sandbox refused, so adopting
    // the reported ones is what lets the panel stay truthful — for a service we
    // started and for one we merely reused (a reused service leaves us no startup
    // output to read them from).
    const adoptResolvedPaths = (payload) => {
      if (!payload) return
      const logDir = typeof payload.logDir === 'string' ? payload.logDir : null
      const vendorCache = typeof payload.vendorCache === 'string' ? payload.vendorCache : null
      if (logDir || vendorCache) resolvedPaths = { logDir: logDir, vendorCache: vendorCache }
    }

    const health = async () => {
      const probe = await probeHealth()
      if (!probe || !probe.ok) return null
      adoptResolvedPaths(probe.payload)
      return probe.payload
    }

    // `workbench.py` reports failures as one structured JSON line on stderr. Turn
    // the machine code into the sentence a person can act on; keep the raw line
    // in the detail so nothing is lost when the code is one we do not know.
    const CLI_HINTS = {
      PORT_IN_USE: '端口已被占用。可能有别的进程（或旧版服务）占着它 —— 点「重启服务」会先退役占用者。',
      ASSET_NOT_FOUND: '前端资源缺失，插件安装目录不完整（缺 assets/workbench.html）。',
      PYTHON_TOO_OLD: '需要 Python 3.9 或更高版本。',
      SERVER_OUTDATED: '端口上有旧版服务且无法自动停止，请手动结束该进程。',
      FILE_NOT_FOUND: '找不到文件。',
      VENDOR_DOWNLOAD_FAILED: '首次启动需要联网下载 GrapesJS，下载失败了。',
    }

    const explainOutput = (text) => {
      if (!text) return null
      for (const line of String(text).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const payload = JSON.parse(trimmed)
          if (payload && payload.ok === false && payload.error) {
            const hint = CLI_HINTS[payload.error]
            return (hint || payload.message || payload.error) + '（' + payload.error + '）'
          }
        } catch (e) { /* not the JSON line; keep scanning */ }
      }
      return null
    }

    // Everything the started process wrote since the last read. DSH settles a
    // spawn failure as `killed` with the error on stderr, so this is the only
    // place a "python3: command not found" or a traceback can be observed.
    const drain = (proc) => {
      try {
        const read = proc.readOutput()
        if (!read) return ''
        let text = String(read.delta || '').trim()
        if (read.lossy) text += '\n…（部分输出丢失）'
        if (read.stderrSpillPath) text += '\n完整 stderr: ' + read.stderrSpillPath
        return text
      } catch (e) {
        return ''
      }
    }

    const startService = async () => {
      if (disposed) return null
      if (serviceRunning) return health()
      const existing = await health()
      if (existing) {
        serviceRunning = true
        startError = null
        healthConfirmedAt = Date.now()
        // Record the reuse too, so the journal always explains the CURRENT state
        // rather than only the failures.
        note('info', '复用已在运行的服务：版本 ' + (existing.version || '未知') + '，端口 ' + PORT)
        return existing
      }
      if (!shell) { startError = 'shell 服务不可用（DSH 未提供 shell，插件无法拉起本地服务）'; note('error', startError); return null }
      if (!SCRIPT) { startError = 'workbench.py 路径未配置（请用静态装载并随包分发 scripts/workbench.py）'; note('error', startError); return null }
      let proc = null
      const command = 'python3 "' + SCRIPT + '" serve --port ' + PORT
        + ' --log-dir "' + LOG_DIR + '"'
        + ' --vendor-cache "' + VENDOR_CACHE + '"'
        + (EDITOR_ROOT ? ' --editor-root "' + EDITOR_ROOT + '"' : '')
      try {
        note('info', '启动本地服务：端口 ' + PORT, command)
        proc = shell.start(shell.resolve({ command: command, stdoutMaxBytes: 64 * 1024 }))
        if (disposed) { try { proc.kill() } catch (e) {} return null }
        ownedProcess = proc
        let transcript = ''
        for (let i = 0; i < 240; i += 1) {
          const chunk = drain(proc)
          if (chunk) transcript += (transcript ? '\n' : '') + chunk
          const probe = await probeHealth()
          if (probe && probe.ok) {
            serviceRunning = true
            startError = null
            healthConfirmedAt = Date.now()
            adoptResolvedPaths(probe.payload)
            note('info', '本地服务就绪：版本 ' + (probe.payload.version || '未知') + '，端口 ' + PORT)
            return probe.payload
          }
          // Stop waiting the moment the process is gone. Polling health for the
          // full 60s after `serve` already exited hides the reason and makes a
          // fast, loud failure look like a hang.
          if (proc.status !== 'running') {
            const tail = drain(proc)
            if (tail) transcript += (transcript ? '\n' : '') + tail
            // Lead with the CLI's own diagnosis when it gave one — "端口已被占用"
            // is actionable, "exit=1" is not.
            const explained = explainOutput(transcript)
            startError = explained || ('serve 进程已退出（exit=' + String(proc.exitCode) + (proc.signal ? ', 信号 ' + proc.signal : '') + '）')
            note('error', startError, transcript || '进程没有任何输出。命令：' + command)
            ownedProcess = null
            return null
          }
          await ctx.timeout(250)
        }
        startError = '服务在 60 秒内没有就绪（端口 ' + PORT + ' 未通过健康检查）'
        note('error', startError, transcript || '进程仍在运行但健康检查一直失败。命令：' + command)
        return null
      } catch (e) {
        startError = 'serve 进程启动失败：' + ((e && e.message) || String(e))
        note('error', startError, command)
        if (proc) { try { proc.kill() } catch (e2) {} }
        ownedProcess = null
        return null
      }
    }

    // A service that dies AFTER a successful start used to leave the plugin
    // frozen: nothing ever re-checked the process, so the panel kept showing a
    // stale dot while every open failed with no explanation. Reading
    // `ownedProcess.status` costs nothing (no subprocess), so the panel's
    // existing poll can supervise the process for free.
    const superviseOwnedProcess = () => {
      const proc = ownedProcess
      if (!proc || proc.status === 'running') return
      const tail = drain(proc)
      const explained = explainOutput(tail)
      ownedProcess = null
      serviceRunning = false
      startError = explained || ('服务进程已退出（exit=' + String(proc.exitCode) + (proc.signal ? ', 信号 ' + proc.signal : '') + '）')
      note('error', '服务进程意外退出', tail || '进程没有留下输出。可用「重启服务」重新拉起。')
    }

    // A REUSED service has no process handle, so its death is invisible to the
    // check above. Revalidate with a real health call — throttled, because this
    // spawns a subprocess and the panel polls every few seconds. The window is
    // seeded when the service is confirmed up, so a freshly verified service is
    // not immediately re-checked.
    const REVALIDATE_MS = 10000
    let healthConfirmedAt = 0
    let revalidating = false

    const revalidateService = () => {
      if (revalidating || ownedProcess || !serviceRunning) return
      if (Date.now() - healthConfirmedAt < REVALIDATE_MS) return
      revalidating = true
      void (async () => {
        try {
          if (await health()) { healthConfirmedAt = Date.now(); return }
          serviceRunning = false
          startError = '之前复用的服务已经不再响应（端口 ' + PORT + '）。'
          note('error', '复用的服务失去响应', '健康检查失败。可用「重启服务」重新拉起。')
        } finally {
          revalidating = false
        }
      })()
    }

    // Everything the panel needs to explain a red dot without opening a terminal.
    // Reaping first means a process that died since the last call is reported as
    // dead here, instead of leaving a stale "running" dot behind.
    const diagnostics = () => {
      superviseOwnedProcess()
      revalidateService()
      return {
        ok: true,
        running: serviceRunning,
        owned: !!ownedProcess,
        port: PORT,
        script: SCRIPT,
        editorRoot: EDITOR_ROOT,
        runtimeDir: RUNTIME_DIR,
        // Where the service really writes, once it has told us. The requested
        // paths stand in only until then: they may be exactly what the sandbox
        // refused, and showing them after the fact is what made a working service
        // look broken.
        logDir: (resolvedPaths && resolvedPaths.logDir) || LOG_DIR,
        vendorCache: (resolvedPaths && resolvedPaths.vendorCache) || VENDOR_CACHE,
        hasShell: !!shell,
        processStatus: ownedProcess ? ownedProcess.status : null,
        exitCode: ownedProcess ? ownedProcess.exitCode : null,
        startError: startError,
        journal: journal.slice().reverse(),
      }
    }

    // 生命周期副作用：卸载时停掉本插件自己启动的服务进程。
    ctx.effect(() => () => {
      disposed = true
      const proc = ownedProcess
      ownedProcess = null
      serviceRunning = false
      if (proc) { try { proc.kill() } catch (e) { console.error('[html-workbench] stop failed', e) } }
    })

    const recordAsset = (path, kind) => {
      const existing = assets.find((a) => a.path === path)
      if (existing) {
        existing.kind = kind
        existing.at = Date.now()
        existing.seq = ++seq
      } else {
        assets.push({ id: 'w' + (++seq), path: path, kind: kind, at: Date.now(), seq: seq })
        if (assets.length > 500) assets = assets.slice(-500)
      }
    }

    ctx.on('tools/result', (exec, result) => {
      try {
        if (!exec || !result || result.isError === true) return
        if (exec.name !== 'write' && exec.name !== 'edit') return
        const args = exec.arguments || {}
        const path = args.file_path
        if (typeof path !== 'string' || !path) return
        if (!/\.html?$/i.test(path)) return
        recordAsset(path, exec.name === 'write' ? 'create' : 'edit')
      } catch (e) {
        console.error('[html-workbench] track failed', e)
      }
    })

    const snapshot = () => assets.slice().sort((a, b) => b.seq - a.seq)

    const openFile = async (file) => {
      if (typeof file !== 'string' || !file) return { ok: false, error: '请填写文件路径' }
      if (!/\.html?$/i.test(file)) return { ok: false, error: '只支持 .html / .htm 文件' }
      if (!SCRIPT) return { ok: false, error: startError || 'workbench.py 路径未配置', diagnostics: diagnostics() }
      const wasUp = await health()
      if (!wasUp) await startService()
      const h = await health()
      // Carry the diagnostics WITH the failure: the panel can then show the real
      // cause instead of a generic "unavailable" that sends the user hunting.
      if (!h) return { ok: false, error: startError || '本地服务未就绪', diagnostics: diagnostics() }
      return {
        ok: true,
        url: 'http://127.0.0.1:' + PORT + '/?file=' + encodeURIComponent(file),
        reused: !!wasUp,
        port: PORT,
        version: h.version || null,
      }
    }

    const restartService = async () => {
      const proc = ownedProcess
      ownedProcess = null
      serviceRunning = false
      startError = null
      if (proc) { try { proc.kill() } catch (e) {} }
      note('info', '手动重启本地服务')
      // Killing our own handle is not enough when the port is held by a process
      // we do not own (a leftover from a previous DSH run, or an outdated
      // version) — the spawn would then die with PORT_IN_USE. Clear the port
      // first; `stop` is a no-op when nothing is listening.
      const stopped = await runCli('stop --port ' + PORT, 20000)
      if (stopped && stopped.exitCode !== 0) {
        return { ok: false, error: '端口 ' + PORT + ' 上的旧进程无法停止，请手动结束后重试。', diagnostics: diagnostics() }
      }
      const h = await startService()
      return h ? { ok: true, info: h, diagnostics: diagnostics() } : { ok: false, error: startError || '重启失败', diagnostics: diagnostics() }
    }

    // Browser address bars yield file:///… URLs while the CLI expects a native
    // path. Normalize only for the local existence probe; the Python service
    // repeats this normalization authoritatively for every request.
    const normalizeFileReference = (value) => {
      const raw = String(value || '').trim()
      if (!/^file:/i.test(raw)) return raw
      try {
        const url = new URL(raw)
        if (url.protocol !== 'file:' || url.search || url.hash) return raw
        let path = decodeURIComponent(url.pathname)
        const isWindows = typeof process !== 'undefined' && process.platform === 'win32'
        if (isWindows && /^[\\/][A-Za-z]:\//.test(path)) path = path.slice(1)
        if (isWindows && url.hostname && url.hostname !== 'localhost') path = '//' + url.hostname + path
        return path
      } catch (e) {
        return raw
      }
    }

    const resolvePath = async (file) => {
      if (typeof file !== 'string') return { ok: false, error: 'file is required' }
      const trimmed = file.trim()
      if (!trimmed) return { ok: true, empty: true, isHtml: false, exists: false }
      const normalized = normalizeFileReference(trimmed)
      if (!/\.html?$/i.test(normalized)) return { ok: true, isHtml: false, exists: false }
      if (!shell) return { ok: true, isHtml: true, exists: null }
      const arg = JSON.stringify(normalized)
      const spec = shell.resolve({ command: 'python3 -c "import os,sys; sys.exit(0 if os.path.isfile(sys.argv[1]) else 1)" ' + arg, timeoutMs: 5000, stdoutMaxBytes: 1024 })
      try {
        const r = await shell.run(spec)
        return { ok: true, isHtml: true, exists: !!(r && r.exitCode === 0), normalized: normalized }
      } catch (e) {
        return { ok: true, isHtml: true, exists: null, normalized: normalized }
      }
    }

    const listPayload = () => {
      const base = diagnostics()
      base.assets = snapshot()
      return base
    }

    // 动态传输：Package-private RPC（仅动态运行时存在 harness）。
    if (typeof harness !== 'undefined') {
      harness.handle('list', () => listPayload())
      harness.handle('status', async () => { const h = await health(); const out = diagnostics(); out.ok = !!h; out.running = !!h; out.info = h || null; return out })
      harness.handle('open', async (args) => openFile(args && args.file))
      harness.handle('resolve', async (args) => resolvePath(args && args.file))
      harness.handle('diagnostics', () => diagnostics())
      harness.handle('restart', async () => restartService())
    }

    // 静态传输：HTTP 路由，供静态 client bundle（fetch）与直接浏览器访问使用。
    const webServer = ctx.get('webServer')
    if (webServer) {
      const sendJson = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const parseQuery = (req) => {
        const qs = (req.url || '').split('?')[1] || ''
        const out = {}
        qs.split('&').forEach((pair) => {
          if (!pair) return
          const eq = pair.indexOf('=')
          const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
          const v = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1))
          out[k] = v
        })
        return out
      }
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/list',
        handler: (req, res) => sendJson(res, 200, listPayload()),
      }), 'html-workbench: list route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/status',
        handler: async (req, res) => {
          const h = await health()
          const out = diagnostics()
          out.ok = !!h
          out.running = !!h
          out.info = h || null
          sendJson(res, 200, out)
        },
      }), 'html-workbench: status route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/open',
        handler: async (req, res) => {
          const file = parseQuery(req).file
          const out = await openFile(file)
          sendJson(res, out.ok ? 200 : 400, out)
        },
      }), 'html-workbench: open route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/resolve',
        handler: async (req, res) => {
          const out = await resolvePath(parseQuery(req).file)
          sendJson(res, out.ok ? 200 : 400, out)
        },
      }), 'html-workbench: resolve route')
      // Readable straight from a browser tab — the fastest path from "red dot"
      // to "here is the traceback" without any UI in the way.
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/diagnostics',
        handler: (req, res) => sendJson(res, 200, diagnostics()),
      }), 'html-workbench: diagnostics route')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/html-workbench/restart',
        handler: async (req, res) => {
          const out = await restartService()
          sendJson(res, out.ok ? 200 : 500, out)
        },
      }), 'html-workbench: restart route')
    }

    // 注册时主动拉起服务（异步，不阻塞 apply）。
    void startService()
  },
}
