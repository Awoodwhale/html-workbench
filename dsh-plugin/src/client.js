/**
 * HTML Workbench DSH plugin — Client half (function body).
 *
 * This file is the plain-JavaScript function body consumed by DeepSeek
 * Harness's dynamic Cordis plugin loader: pass this exact text as `code.client`
 * to `cordis_define`. The static client bundle wraps this same body in
 * `window.__ModuleLoader__.load(...)` at build time.
 *
 * Responsibilities (runs in the browser):
 *  - Register a right-side panel + corner trigger in `shell.overlay`.
 *  - Layout is browser-like: a two-row chrome at the TOP (identity row +
 *    address/toolbar row) and the preview filling everything below. Nothing
 *    sits at the bottom, so the panel never visually competes with the chat
 *    composer on the left.
 *  - Open a file by calling Host `open`, then embed the workbench URL in an
 *    iframe. Left edge is draggable to resize the panel width (persisted).
 *
 * Styling contract: every colour/shadow comes from the host's `--dsw-alias-*`
 * design tokens (see the DSH first-party plugins) so light/dark themes and
 * future re-skins are inherited for free. No hard-coded palette, no magic
 * offsets — all overlays are laid out with flex/grid.
 */

return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ── Styles ───────────────────────────────────────────────────────────────
    // NOTE: both style shims (dynamic runner + static bundle) de-duplicate by a
    // fixed element id and BAIL OUT when it already exists. During iterative
    // development that silently keeps a STALE stylesheet alive — the symptom is
    // "functionality works but the layout is broken" (e.g. an absolutely
    // positioned chevron collapsing into a block below the input). So manage the
    // <style> element here: drop every previous generation, then insert fresh.
    const STYLE_MARK = 'data-hwb-styles'
    const STYLE_VERSION = '5'

    const CSS = `
html #root {
  margin-right: calc(var(--dsh-sidebar-width, 0px) + var(--hwb-panel-width, 0px));
  transition: margin-right var(--ds-transition-duration-slow, 200ms) var(--ds-ease-in-out, ease);
}
body[data-hwb-dragging] #root { transition: none; }
body[data-hwb-dragging] { user-select: none; cursor: col-resize; }

/* Reserve right-side clearance in the session header so the corner trigger
   never overlaps its right-aligned utilities (e.g. "Session log"). The
   clearance relaxes as the panel opens, because the trigger then hides. */
header:has([data-slot="conversation.session.header.utilities"]) {
  padding-right: max(28px, calc(60px - var(--hwb-panel-width, 0px)));
  transition: padding-right var(--ds-transition-duration-slow, 200ms) var(--ds-ease-in-out, ease);
}

.hwb-panel, .hwb-panel * { box-sizing: border-box; }
.hwb-panel {
  position: fixed; top: 0; right: var(--dsh-sidebar-width, 0px); bottom: 0;
  display: flex; flex-direction: column; min-width: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-left: 1px solid var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-shadow-lv2);
  z-index: 9999; pointer-events: auto;
  font-family: var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif);
  font-size: 13px; line-height: 1.5;
  --hwb-mono: var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* Resize handle — a wide invisible hit area with a thin visible rail. */
.hwb-resize { position: absolute; left: -4px; top: 0; bottom: 0; width: 9px; z-index: 5; cursor: col-resize; touch-action: none; border: none; padding: 0; background: transparent; }
.hwb-resize::after { content: ""; position: absolute; left: 4px; top: 0; bottom: 0; width: 2px; border-radius: 2px; background: transparent; transition: background 150ms ease; }
.hwb-resize:hover::after, .hwb-resize:focus-visible::after, .hwb-resize[data-active]::after { background: var(--dsw-alias-interactive-bg-hover-accent); }
.hwb-resize:focus-visible { outline: none; }

/* ── Chrome: identity row + toolbar row ───────────────────────────────────── */
.hwb-chrome { flex: none; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l2); }
.hwb-idrow { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 8px 0 14px; }
.hwb-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hwb-dot { position: relative; width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary)); box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 0%, transparent); }
.hwb-dot[data-on] { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
.hwb-dot[data-off] { background: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
/* The dot is the ONLY signal that a start failed, so make it the way in: it is a
   button that opens the diagnostics log. */
.hwb-statusbtn { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 2px 6px 2px 4px; margin-left: -4px; border: 0; border-radius: 7px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.hwb-statusbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.hwb-statusbtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 1px; }

/* ── Diagnostics ──────────────────────────────────────────────────────────── */
.hwb-diag { flex: none; display: flex; flex-direction: column; max-height: 46vh; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.hwb-diag-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.hwb-diag-title { font-size: 12px; font-weight: 600; }
.hwb-diag-facts { flex: none; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); font-size: 11.5px; }
.hwb-diag-key { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.hwb-diag-val { min-width: 0; font-family: var(--hwb-mono); word-break: break-all; }
.hwb-diag-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px 0; }
.hwb-diag-row { display: grid; grid-template-columns: auto 1fr; gap: 8px; padding: 4px 14px; font-size: 11.5px; line-height: 1.55; }
.hwb-diag-row + .hwb-diag-row { border-top: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 50%, transparent); }
.hwb-diag-time { color: var(--dsw-alias-label-tertiary); font-family: var(--hwb-mono); font-size: 10.5px; padding-top: 1px; }
.hwb-diag-msg { min-width: 0; }
.hwb-diag-row[data-level="error"] .hwb-diag-msg { color: var(--dsw-alias-state-error-primary); }
.hwb-diag-detail { display: block; margin-top: 3px; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font-family: var(--hwb-mono); font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto; }
.hwb-diag-empty { padding: 16px 14px; color: var(--dsw-alias-label-tertiary); font-size: 11.5px; }
.hwb-diag-hint { padding: 8px 14px; border-top: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.6; }
.hwb-diag-hint code { padding: 1px 4px; border-radius: 4px; background: var(--dsw-alias-bg-base); font-family: var(--hwb-mono); font-size: 10.5px; }
.hwb-btn-quiet { background: transparent; border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.hwb-btn-quiet:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.hwb-btn-sm { height: 26px; padding: 0 10px; border-radius: 7px; font-size: 11.5px; }
.hwb-name { font-weight: 600; font-size: 13px; white-space: nowrap; }
.hwb-sep { width: 1px; height: 14px; flex: none; background: var(--dsw-alias-border-l1); }
.hwb-filechip { display: flex; align-items: center; gap: 6px; min-width: 0; height: 22px; padding: 0 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover)); color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.hwb-filechip > svg { flex: none; opacity: .7; }
.hwb-filechip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--hwb-mono); }
.hwb-spacer { flex: 1 1 auto; min-width: 8px; }
.hwb-actions { display: flex; align-items: center; gap: 2px; flex: none; }

.hwb-icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; flex: none; border: none; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.hwb-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hwb-icon:disabled { opacity: .4; cursor: default; }
.hwb-icon:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 1px; }
.hwb-icon[data-spin] > svg { animation: hwb-spin 800ms linear infinite; }

.hwb-toolbar { display: flex; align-items: center; gap: 8px; padding: 0 10px 10px; }

/* Combobox field: input + status + chevron composed with flex — no absolute
   positioning, so nothing can escape the field box. */
.hwb-fieldwrap { position: relative; flex: 1 1 auto; min-width: 0; }
.hwb-field { display: flex; align-items: center; gap: 2px; height: 32px; padding: 0 2px 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: var(--dsw-alias-bg-base); transition: border-color 150ms ease, box-shadow 150ms ease; }
.hwb-field:hover { border-color: var(--dsw-alias-border-l1); }
.hwb-field[data-focus] { border-color: var(--dsw-alias-state-business-primary, #4d6bfe); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 16%, transparent); }
.hwb-input { flex: 1 1 auto; min-width: 0; height: 100%; border: none; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; font-family: var(--hwb-mono); }
.hwb-input::placeholder { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif); }
.hwb-state { display: grid; place-items: center; width: 20px; height: 20px; flex: none; }
.hwb-state[data-state="exists"] { color: var(--dsw-alias-state-success-primary); }
.hwb-state[data-state="missing"] { color: var(--dsw-alias-state-error-primary); }
.hwb-state[data-state="invalid"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-warn-label)); }
.hwb-state[data-state="checking"] { color: var(--dsw-alias-label-tertiary); }
.hwb-state[data-state="checking"] > svg { animation: hwb-spin 800ms linear infinite; }
.hwb-caret { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.hwb-caret:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hwb-caret > svg { transition: transform 180ms ease; }
.hwb-caret[aria-expanded="true"] > svg { transform: rotate(180deg); }

.hwb-btn { flex: none; height: 32px; padding: 0 14px; border-radius: 9px; border: 1px solid transparent; font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; transition: background 120ms ease, opacity 120ms ease; }
.hwb-btn-primary { background: var(--dsw-alias-button-primary-fill, #4d6bfe); color: var(--dsw-alias-button-primary-label, #fff); }
.hwb-btn-primary:hover:not(:disabled) { opacity: .88; }
.hwb-btn:disabled { opacity: .45; cursor: default; }
.hwb-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 2px; }

/* Dropdown opens DOWNWARD (the field lives at the top of the panel). */
.hwb-menu { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 30; display: flex; flex-direction: column; max-height: min(340px, 50vh); overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv2); animation: hwb-pop 140ms var(--ds-ease-in-out, ease); }
.hwb-menu-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.hwb-menu-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px; }
.hwb-menu-empty { padding: 22px 16px; color: var(--dsw-alias-label-tertiary); text-align: center; font-size: 12px; line-height: 1.7; }

.hwb-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; border: none; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.hwb-item:hover, .hwb-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.hwb-item[data-active] { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); }
.hwb-item > svg { flex: none; color: var(--dsw-alias-label-tertiary); }
.hwb-item-main { flex: 1 1 auto; min-width: 0; display: block; }
.hwb-item-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.hwb-item-path { display: block; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-family: var(--hwb-mono); }
.hwb-tag { flex: none; padding: 1px 6px; border-radius: 5px; font-size: 10px; font-weight: 600; }
.hwb-tag[data-kind="create"] { background: var(--dsw-alias-state-success-tertiary, color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)); color: var(--dsw-alias-state-success-primary); }
.hwb-tag[data-kind="edit"] { background: var(--dsw-alias-state-warn-tertiary, color-mix(in srgb, var(--dsw-alias-state-warning-primary, #b7791f) 14%, transparent)); color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warning-primary, #b7791f)); }

/* ── Banner ───────────────────────────────────────────────────────────────── */
.hwb-banner { flex: none; display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px 9px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.hwb-banner > svg { flex: none; margin-top: 1px; }
.hwb-banner-text { flex: 1 1 auto; min-width: 0; word-break: break-word; }

/* ── Body ─────────────────────────────────────────────────────────────────── */
.hwb-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base); }
.hwb-frame { flex: 1 1 auto; width: 100%; border: 0; background: #fff; }

/* ── Visual selection chips (rendered INTO the host composer) ─────────────── */
/* The workbench posts one selection at a time; each becomes a removable chip
   above the chat input, mirroring how file attachments behave. The markdown
   evidence is held in memory and only spliced into the message on send, so the
   user never has to look at a wall of HTML while typing. */
.hwb-chips {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0 14px 8px; padding: 0;
}
.hwb-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 260px;
  padding: 3px 4px 3px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px; line-height: 18px;
}
.hwb-chip > svg { flex: none; color: var(--dsw-alias-state-business-primary, #4d6bfe); }
.hwb-chip-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--hwb-mono); }
.hwb-chip-x {
  flex: none; display: grid; place-items: center; width: 18px; height: 18px; padding: 0;
  border: 0; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
}
.hwb-chip-x:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hwb-chip-note { align-self: center; color: var(--dsw-alias-label-tertiary); font-size: 11px; }

.hwb-center { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; overflow-y: auto; text-align: center; }
.hwb-blank { display: grid; place-items: center; width: 46px; height: 46px; border-radius: 14px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-tertiary); }
.hwb-blank-title { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.hwb-blank-desc { max-width: 320px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.7; }
.hwb-recent { width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 4px; margin-top: 2px; text-align: left; }
.hwb-recent-label { padding: 0 8px 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.hwb-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l1); border-top-color: var(--dsw-alias-state-business-primary, #4d6bfe); animation: hwb-spin 700ms linear infinite; }

/* ── Corner trigger ───────────────────────────────────────────────────────── */
.hwb-trigger {
  position: fixed; top: 8px;
  right: calc(var(--dsh-sidebar-width, 0px) + var(--hwb-panel-width, 0px) + 12px);
  z-index: 10000; display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: none; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; pointer-events: auto;
  transition: right var(--ds-transition-duration-slow, 200ms) var(--ds-ease-in-out, ease), background 120ms ease, color 120ms ease;
}
.hwb-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hwb-trigger:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 1px; }

@keyframes hwb-spin { to { transform: rotate(360deg); } }
@keyframes hwb-pop { from { opacity: 0; transform: translateY(-4px); } }
@media (prefers-reduced-motion: reduce) {
  html #root, .hwb-trigger, header:has([data-slot="conversation.session.header.utilities"]) { transition: none; }
  .hwb-menu { animation: none; }
}
`

    const applyStyles = () => {
      if (typeof document === 'undefined') { try { styles.insert(CSS) } catch (e) {} return () => {} }
      const stale = document.querySelectorAll('style[' + STYLE_MARK + '], style#html-workbench-dsh-plugin-styles')
      for (let i = 0; i < stale.length; i += 1) {
        const node = stale[i]
        if (node.parentNode) node.parentNode.removeChild(node)
      }
      const el = document.createElement('style')
      el.setAttribute(STYLE_MARK, STYLE_VERSION)
      el.textContent = CSS
      document.head.appendChild(el)
      return () => { if (el.parentNode) el.parentNode.removeChild(el) }
    }

    if (typeof ctx.effect === 'function') ctx.effect(applyStyles, 'html-workbench: styles')
    else applyStyles()

    // ── Store ────────────────────────────────────────────────────────────────
    const DEFAULT_WIDTH = 820
    const MIN_WIDTH = 460
    const WIDTH_KEY = 'hwb:panel-width'

    const readWidth = () => {
      try {
        const raw = window.localStorage.getItem(WIDTH_KEY)
        const n = raw == null ? NaN : parseInt(raw, 10)
        return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH
      } catch (e) { return DEFAULT_WIDTH }
    }
    const writeWidth = (w) => { try { window.localStorage.setItem(WIDTH_KEY, String(w)) } catch (e) {} }

    let resolveTimer = null

    const store = {
      open: false,
      panelWidth: readWidth(),
      assets: [],
      running: false,
      current: null,
      nonce: 0,
      loading: false,
      refreshing: false,
      error: null,
      pathInput: '',
      resolveState: 'idle',
      context: null,
      diag: null,
      diagOpen: false,
      restarting: false,
      listeners: [],
      subscribe(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn) } },
      set(patch) {
        // Only notify when something actually changed: the panel polls `list`
        // every few seconds, and blindly re-rendering on every tick makes the
        // input feel laggy and needlessly churns the preview subtree.
        let dirty = false
        const keys = Object.keys(patch)
        for (let i = 0; i < keys.length; i += 1) {
          const k = keys[i]
          if (this[k] !== patch[k]) { this[k] = patch[k]; dirty = true }
        }
        if (dirty) this.listeners.forEach((fn) => { try { fn() } catch (e) {} })
      },
    }

    const useStore = () => {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((x) => x + 1)), [])
      return store
    }

    const basename = (p) => {
      const parts = String(p || '').split('/')
      return parts[parts.length - 1] || String(p || '')
    }

    const dirname = (p) => {
      const s = String(p || '')
      const i = s.lastIndexOf('/')
      return i <= 0 ? '/' : s.slice(0, i)
    }

    // Paths are long and their INFORMATIVE half is the tail, so clip the head
    // (CSS ellipsis would eat the tail). The CSS ellipsis stays as a backstop
    // for narrow panels.
    const clipHead = (s, max) => {
      const str = String(s || '')
      return str.length <= max ? str : '…' + str.slice(str.length - max + 1)
    }

    const sameAssets = (a, b) => {
      if (a === b) return true
      if (!a || !b || a.length !== b.length) return false
      for (let i = 0; i < a.length; i += 1) {
        if (a[i].path !== b[i].path || a[i].kind !== b[i].kind || a[i].seq !== b[i].seq) return false
      }
      return true
    }

    // The panel polls `list` every few seconds and the payload now carries the
    // whole diagnostics journal — a fresh object every tick. Compare by the
    // facts that actually change so polling does not re-render continuously.
    const sameDiag = (a, b) => {
      if (a === b) return true
      if (!a || !b) return false
      const ja = a.journal || []
      const jb = b.journal || []
      if (ja.length !== jb.length) return false
      if (ja.length && (ja[0].at !== jb[0].at || ja[0].message !== jb[0].message)) return false
      return a.running === b.running && a.startError === b.startError
        && a.processStatus === b.processStatus && a.exitCode === b.exitCode
    }

    const refresh = (explicit) => {
      if (explicit) store.set({ refreshing: true })
      return host.call('list').then((res) => {
        if (res && res.ok) {
          const next = res.assets || []
          store.set({
            assets: sameAssets(store.assets, next) ? store.assets : next,
            running: !!res.running,
            diag: sameDiag(store.diag, res) ? store.diag : res,
          })
        } else {
          store.set({ error: (res && res.error) || 'list failed' })
        }
      }).catch((e) => store.set({ error: String(e && e.message ? e.message : e) }))
        .then(() => { if (explicit) store.set({ refreshing: false }) })
    }

    // Killing and re-spawning is the one action that fixes most start failures,
    // so it belongs next to the log that reports them.
    const restartService = () => {
      store.set({ restarting: true, error: null })
      return host.call('restart').then((res) => {
        store.set({
          restarting: false,
          running: !!(res && res.ok),
          diag: (res && res.diagnostics) || store.diag,
          error: res && res.ok ? null : (res && res.error) || '重启失败',
        })
        if (res && res.ok) refresh()
      }).catch((e) => store.set({ restarting: false, error: String(e && e.message ? e.message : e) }))
    }

    const openFile = (path) => {
      const file = String(path || '').trim()
      if (!file) return
      store.set({ loading: true, error: null, pathInput: file })
      host.call('open', { file: file }).then((res) => {
        if (res && res.ok) {
          // Bump the nonce so re-opening the SAME file remounts the iframe:
          // with an unchanged `src` the browser would otherwise keep the old
          // document and "打开" would look like a no-op.
          store.set({
            loading: false,
            running: true,
            resolveState: 'exists',
            current: { path: file, url: res.url },
            nonce: store.nonce + 1,
          })
        } else {
          // A failed open used to collapse into one opaque line. The host now
          // sends the journal along, so open the log on failure: the cause is
          // one glance away instead of a terminal session away.
          store.set({
            loading: false,
            error: (res && res.error) || 'open failed',
            diag: (res && res.diagnostics) || store.diag,
            diagOpen: !!(res && res.diagnostics),
          })
        }
      }).catch((e) => store.set({ loading: false, error: String(e && e.message ? e.message : e) }))
    }

    const STATE_TITLE = {
      exists: '文件存在',
      missing: '未找到该文件',
      invalid: '仅支持 .html / .htm 文件',
      checking: '检测中…',
    }

    // ── Visual selection → composer chips ────────────────────────────────────
    //
    // The workbench posts one selection per click. Each becomes a removable chip
    // above the chat input, and the bulky markdown evidence stays in memory
    // until the user actually sends — so they compose against a short list of
    // labels instead of a wall of HTML.
    //
    // Two deliberate choices:
    //  1. Chips are plain DOM appended into the host's composer card, not a
    //     React portal. The card is a flex column owned by the host's React
    //     tree; React leaves DOM nodes it never created alone, but it may
    //     `insertBefore` around them, so a MutationObserver re-asserts position.
    //  2. The evidence is spliced in during the CAPTURE phase of send. React 18
    //     dispatches discrete events synchronously, so writing the value through
    //     the native setter + `input` event during capture means React state is
    //     already updated by the time the host's own handler reads it.

    const CHIP_HOST = '.hwb-chips'
    const pendingSelections = []
    let chipRow = null
    let composerObserver = null

    const findComposer = () => {
      const nodes = document.querySelectorAll('textarea')
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        // The panel's own inputs are inside `.hwb-panel`; never target those.
        if (node.closest('.hwb-panel')) continue
        const box = node.getBoundingClientRect()
        if (box.width >= 120 && box.height > 0) return node
      }
      return null
    }

    // The card is the flex column holding the textarea and the tool row. Walking
    // up from the textarea keeps this working if the host renames its classes.
    const findComposerCard = (textarea) => {
      let node = textarea && textarea.parentElement
      let depth = 0
      while (node && depth < 6) {
        const style = window.getComputedStyle(node)
        if (style.display === 'flex' && style.flexDirection === 'column' && node.querySelector('button')) return node
        node = node.parentElement
        depth += 1
      }
      return textarea ? textarea.parentElement : null
    }

    const setComposerValue = (node, next) => {
      const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')
      const setter = descriptor && descriptor.set
      if (setter) setter.call(node, next)
      else node.value = next
      node.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const evidenceBlock = () => {
      if (!pendingSelections.length) return ''
      return pendingSelections.map((item) => item.markdown).join('\n')
    }

    const clearSelections = () => {
      pendingSelections.length = 0
      renderChips()
    }

    const removeSelection = (key) => {
      const index = pendingSelections.findIndex((item) => item.key === key)
      if (index >= 0) pendingSelections.splice(index, 1)
      renderChips()
    }

    const chipIcon = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5v-3A1.5 1.5 0 0 1 4.5 3h3M16.5 3h3A1.5 1.5 0 0 1 21 4.5v3M21 16.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M7.5 21h-3A1.5 1.5 0 0 1 3 19.5v-3"/></svg>'

    const renderChips = () => {
      const textarea = findComposer()
      const card = findComposerCard(textarea)
      if (!card) return
      if (!pendingSelections.length) {
        if (chipRow && chipRow.parentNode) chipRow.parentNode.removeChild(chipRow)
        chipRow = null
        return
      }
      if (!chipRow) {
        chipRow = document.createElement('div')
        chipRow.className = CHIP_HOST.slice(1)
      }
      chipRow.textContent = ''
      pendingSelections.forEach((item) => {
        const chip = document.createElement('span')
        chip.className = 'hwb-chip'
        chip.title = item.textHint ? item.label + ' — ' + item.textHint : item.label
        chip.innerHTML = chipIcon
        const label = document.createElement('span')
        label.className = 'hwb-chip-label'
        label.textContent = item.label
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'hwb-chip-x'
        close.setAttribute('aria-label', '移除 ' + item.label)
        close.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>'
        close.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          removeSelection(item.key)
        })
        chip.appendChild(label)
        chip.appendChild(close)
        chipRow.appendChild(chip)
      })
      const note = document.createElement('span')
      note.className = 'hwb-chip-note'
      note.textContent = '发送时会自动附上选区源码'
      chipRow.appendChild(note)

      // Sit directly above the tool row (the last flex child), which puts the
      // chips between the text input and the model/send controls.
      const anchor = card.lastElementChild
      if (chipRow.parentNode !== card || chipRow.nextElementSibling !== anchor) {
        card.insertBefore(chipRow, anchor)
      }
      observeComposer(card)
    }

    const observeComposer = (card) => {
      if (composerObserver) return
      composerObserver = new MutationObserver(() => {
        if (!pendingSelections.length) return
        if (!chipRow || chipRow.parentNode !== card) renderChips()
      })
      composerObserver.observe(card, { childList: true })
      ctx.effect(() => () => {
        if (composerObserver) composerObserver.disconnect()
        composerObserver = null
      })
    }

    const receiveContext = (packet) => {
      const key = packet.key || packet.label
      const existing = pendingSelections.findIndex((item) => item.key === key)
      const entry = {
        key: key,
        label: packet.label || 'element',
        textHint: packet.textHint || '',
        markdown: packet.markdown,
        fileName: packet.fileName,
      }
      // Re-adding the same element refreshes its evidence rather than stacking a
      // duplicate: the file may have changed since the first click.
      if (existing >= 0) pendingSelections[existing] = entry
      else pendingSelections.push(entry)
      renderChips()
      const textarea = findComposer()
      if (textarea) textarea.focus()
      store.set({ context: { count: pendingSelections.length, label: entry.label, at: Date.now() } })
    }

    // Splice the evidence in just before the host reads the composer, then drop
    // the chips: the message now carries the context, so keeping them would
    // silently re-attach the same source to the next turn.
    const spliceEvidenceIntoMessage = () => {
      if (!pendingSelections.length) return
      const textarea = findComposer()
      if (!textarea) return
      const typed = (textarea.value || '').trim()
      if (!typed) return
      setComposerValue(textarea, evidenceBlock() + '\n' + typed)
      clearSelections()
    }

    const bindSendInterception = () => {
      const onClick = (event) => {
        if (!pendingSelections.length) return
        const target = event.target instanceof Element ? event.target : null
        const button = target && target.closest('button')
        if (!button || button.closest('.hwb-panel')) return
        const label = button.getAttribute('aria-label') || ''
        if (!/发送|send/i.test(label)) return
        spliceEvidenceIntoMessage()
      }
      const onKeyDown = (event) => {
        if (!pendingSelections.length) return
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
        const target = event.target
        if (!(target instanceof HTMLTextAreaElement) || target.closest('.hwb-panel')) return
        spliceEvidenceIntoMessage()
      }
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKeyDown, true)
      ctx.effect(() => () => {
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('keydown', onKeyDown, true)
      })
    }

    bindSendInterception()


    const checkPath = (value) => {
      const trimmed = (value || '').trim()
      if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null }
      if (!trimmed) { store.set({ resolveState: 'idle' }); return }
      store.set({ resolveState: 'checking' })
      resolveTimer = setTimeout(() => {
        resolveTimer = null
        host.call('resolve', { file: trimmed }).then((res) => {
          if (!res || res.ok === false) { store.set({ resolveState: 'idle' }); return }
          if (!res.isHtml) store.set({ resolveState: 'invalid' })
          else if (res.exists === true) store.set({ resolveState: 'exists' })
          else if (res.exists === false) store.set({ resolveState: 'missing' })
          else store.set({ resolveState: 'idle' })
        }).catch(() => store.set({ resolveState: 'idle' }))
      }, 300)
    }

    // ── Icons ────────────────────────────────────────────────────────────────
    const icon = (size, children, extra) => {
      const props = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true,
      }
      if (extra) Object.assign(props, extra)
      return React.createElement('svg', props, children)
    }
    const path = (d, key) => React.createElement('path', { d: d, key: key })

    const I_CLOSE = icon(15, [path('M18 6 6 18', 'a'), path('m6 6 12 12', 'b')])
    const I_REFRESH = icon(15, [path('M21 12a9 9 0 1 1-3.2-6.9', 'a'), path('M21 4v5h-5', 'b')])
    const I_EXTERNAL = icon(15, [path('M15 3h6v6', 'a'), path('M10 14 21 3', 'b'), path('M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5', 'c')])
    const I_CARET = icon(14, [path('m6 9 6 6 6-6', 'a')])
    const I_CHECK = icon(14, [path('M20 6 9 17l-5-5', 'a')], { strokeWidth: 2.2 })
    const I_MISSING = icon(14, [path('M18 6 6 18', 'a'), path('m6 6 12 12', 'b')], { strokeWidth: 2.2 })
    const I_WARN = icon(14, [path('M12 9v4', 'a'), path('M12 17h.01', 'b'), path('M10.3 3.9 2.4 17.5A1.8 1.8 0 0 0 4 20.2h16a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0Z', 'c')])
    const I_LOADING = icon(14, [React.createElement('circle', { cx: 12, cy: 12, r: 9, strokeOpacity: .25, key: 'a' }), path('M21 12a9 9 0 0 0-9-9', 'b')], { strokeWidth: 2.2 })
    const I_FILE = icon(14, [path('M14 3v5h5', 'a'), path('M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z', 'b')])
    const I_ALERT = icon(14, [React.createElement('circle', { cx: 12, cy: 12, r: 9, key: 'a' }), path('M12 8v4', 'b'), path('M12 16h.01', 'c')])
    const I_BLANK = icon(22, [path('M14 3v5h5', 'a'), path('M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z', 'b'), path('m9 15 1.8-2.2L12.4 15l1.4-1.8', 'c')])
    const I_TRIGGER = icon(17, [
      React.createElement('rect', { x: 2.5, y: 4, width: 19, height: 14, rx: 2.4, key: 'a' }),
      path('M2.5 8.4h19', 'b'),
      path('M8 21h8', 'c'),
      path('M12 18v3', 'd'),
    ])
    const I_LOGS = icon(15, [path('M8 6h10', 'a'), path('M8 12h10', 'b'), path('M8 18h6', 'c'), path('M4 6h.01', 'd'), path('M4 12h.01', 'e'), path('M4 18h.01', 'f')])

    // ── Diagnostics view ─────────────────────────────────────────────────────
    //
    // A start failure has exactly one visible symptom by default: a red dot. The
    // cause lives in a Python traceback or a spawn error inside the host process,
    // so surface it verbatim here — plus the facts needed to reproduce by hand
    // (port, script path, exit code). That turns "服务起不来" into a fixable
    // report without leaving the panel.

    const clockTime = (at) => {
      try {
        return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
      } catch (e) { return '' }
    }

    const Diagnostics = () => {
      const s = useStore()
      const d = s.diag
      const journal = (d && d.journal) || []

      const fact = (key, value) => value == null || value === ''
        ? null
        : [
          React.createElement('span', { className: 'hwb-diag-key', key: key + '-k' }, key),
          React.createElement('span', { className: 'hwb-diag-val', key: key + '-v' }, String(value)),
        ]

      return React.createElement('div', { className: 'hwb-diag' },
        React.createElement('div', { className: 'hwb-diag-head' },
          React.createElement('span', { className: 'hwb-diag-title' }, '服务诊断'),
          React.createElement('span', { className: 'hwb-spacer' }),
          React.createElement('button', {
            type: 'button', className: 'hwb-btn hwb-btn-quiet hwb-btn-sm',
            disabled: s.restarting, onClick: restartService,
          }, s.restarting ? '重启中…' : '重启服务'),
          React.createElement('button', {
            type: 'button', className: 'hwb-icon', title: '收起诊断', 'aria-label': '收起诊断',
            onClick: () => store.set({ diagOpen: false }),
          }, I_CLOSE),
        ),
        d
          ? React.createElement('div', { className: 'hwb-diag-facts' },
            fact('状态', d.running ? '运行中' : (d.processStatus === 'running' ? '启动中' : '未就绪')),
            fact('端口', d.port),
            fact('进程', d.processStatus ? d.processStatus + (d.exitCode == null ? '' : '（exit=' + d.exitCode + '）') : '未由本插件启动'),
            fact('失败原因', d.startError),
            fact('脚本', d.script),
            d.hasShell === false ? fact('shell', '不可用') : null,
          )
          : null,
        React.createElement('div', { className: 'hwb-diag-body' },
          journal.length
            ? journal.map((entry, i) => React.createElement('div', {
              className: 'hwb-diag-row', 'data-level': entry.level, key: String(entry.at) + '-' + i,
            },
              React.createElement('span', { className: 'hwb-diag-time' }, clockTime(entry.at)),
              React.createElement('span', { className: 'hwb-diag-msg' },
                entry.message,
                entry.detail ? React.createElement('span', { className: 'hwb-diag-detail' }, entry.detail) : null,
              ),
            ))
            : React.createElement('div', { className: 'hwb-diag-empty' }, '暂无日志。点「重启服务」可重新拉起并记录完整过程。'),
        ),
        React.createElement('div', { className: 'hwb-diag-hint' },
          '服务自身日志：',
          React.createElement('code', null, (d && d.logDir) || '/tmp/.html-workbench/logs/'),
          '；也可直接访问 ',
          React.createElement('code', null, '/html-workbench/diagnostics'),
          ' 查看原始 JSON。',
        ),
      )
    }

    const STATE_ICON = { exists: I_CHECK, missing: I_MISSING, invalid: I_WARN, checking: I_LOADING }

    // ── Resize ───────────────────────────────────────────────────────────────
    const startResize = (e) => {
      if (e.button !== undefined && e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget
      handle.setAttribute('data-active', '')
      document.body.setAttribute('data-hwb-dragging', '')
      const maxW = () => Math.max(MIN_WIDTH, window.innerWidth - 80)
      const onMove = (ev) => {
        const w = Math.round(window.innerWidth - ev.clientX)
        store.set({ panelWidth: Math.max(MIN_WIDTH, Math.min(w, maxW())) })
      }
      const onUp = () => {
        handle.removeAttribute('data-active')
        document.body.removeAttribute('data-hwb-dragging')
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        writeWidth(store.panelWidth)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    const nudgeWidth = (delta) => {
      const maxW = Math.max(MIN_WIDTH, window.innerWidth - 80)
      const w = Math.max(MIN_WIDTH, Math.min(store.panelWidth + delta, maxW))
      store.set({ panelWidth: w })
      writeWidth(w)
    }

    // ── Panel ────────────────────────────────────────────────────────────────
    const Panel = () => {
      const s = useStore()
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [focused, setFocused] = React.useState(false)
      const fieldRef = React.useRef(null)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        const root = document.documentElement
        root.style.setProperty('--hwb-panel-width', s.open ? s.panelWidth + 'px' : '0px')
        return () => { root.style.setProperty('--hwb-panel-width', '0px') }
      }, [s.open, s.panelWidth])

      React.useEffect(() => {
        if (!s.open) return undefined
        refresh()
        const dispose = ctx.interval(refresh, 4000)
        return () => { if (dispose) dispose() }
      }, [s.open])

      // The workbench runs in an iframe, so its selections arrive as messages.
      // Bind while the panel is mounted, regardless of which file is open.
      React.useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.type !== 'html-workbench:context') return
          if (!data.markdown) return
          receiveContext(data)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      // Drop any in-flight path check when the panel closes.
      React.useEffect(() => () => { if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null } }, [])

      React.useEffect(() => {
        if (!menuOpen) return undefined
        const onDown = (e) => { if (fieldRef.current && !fieldRef.current.contains(e.target)) setMenuOpen(false) }
        const onKey = (e) => { if (e.key === 'Escape') { setMenuOpen(false); if (inputRef.current) inputRef.current.focus() } }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
      }, [menuOpen])

      if (!s.open) return null

      const assets = s.assets || []
      const trimmed = (s.pathInput || '').trim()
      const currentPath = s.current ? s.current.path : null
      const submit = () => { if (trimmed) { setMenuOpen(false); openFile(trimmed) } }
      const pick = (p) => { setMenuOpen(false); store.set({ pathInput: p }); openFile(p) }

      const assetRow = (a, inMenu) => React.createElement('button', {
        key: a.id || a.path,
        type: 'button',
        className: 'hwb-item',
        'data-active': a.path === currentPath ? '' : undefined,
        title: a.path,
        onClick: () => pick(a.path),
      },
        I_FILE,
        React.createElement('span', { className: 'hwb-item-main' },
          React.createElement('span', { className: 'hwb-item-name' }, basename(a.path)),
          React.createElement('span', { className: 'hwb-item-path' }, clipHead(dirname(a.path), 52)),
        ),
        inMenu && a.kind ? React.createElement('span', { className: 'hwb-tag', 'data-kind': a.kind }, a.kind === 'create' ? '新建' : '编辑') : null,
      )

      // A dead service makes "填入路径开始编辑" a lie — every open will fail.
      // Say what is actually wrong and offer the two things that help.
      const serviceDown = !s.running && !!s.diag && !s.loading
      const body = s.loading
        ? React.createElement('div', { className: 'hwb-center' },
          React.createElement('div', { className: 'hwb-spinner' }),
          React.createElement('div', { className: 'hwb-blank-desc' }, '正在启动 Workbench 服务…'),
        )
        : s.current && s.current.url
          ? React.createElement('iframe', {
            key: 'frame-' + s.nonce,
            className: 'hwb-frame',
            src: s.current.url,
            title: 'HTML Workbench — ' + basename(s.current.path),
          })
          : serviceDown
            ? React.createElement('div', { className: 'hwb-center' },
              React.createElement('div', { className: 'hwb-blank' }, I_ALERT),
              React.createElement('div', null,
                React.createElement('div', { className: 'hwb-blank-title' }, '本地服务未就绪'),
                React.createElement('div', { className: 'hwb-blank-desc' },
                  s.diag.startError || '服务进程没有响应健康检查，暂时无法打开文件。'),
              ),
              React.createElement('div', { style: { display: 'flex', gap: '8px' } },
                React.createElement('button', {
                  type: 'button', className: 'hwb-btn hwb-btn-primary hwb-btn-sm',
                  disabled: s.restarting, onClick: restartService,
                }, s.restarting ? '重启中…' : '重启服务'),
                React.createElement('button', {
                  type: 'button', className: 'hwb-btn hwb-btn-quiet hwb-btn-sm',
                  onClick: () => store.set({ diagOpen: true }),
                }, '查看诊断日志'),
              ),
            )
            : React.createElement('div', { className: 'hwb-center' },
            React.createElement('div', { className: 'hwb-blank' }, I_BLANK),
            React.createElement('div', null,
              React.createElement('div', { className: 'hwb-blank-title' }, '还没有打开文件'),
              React.createElement('div', { className: 'hwb-blank-desc' }, assets.length
                ? '在上方地址栏填入 .html 的绝对路径，或从下面的产物里挑一个开始可视化编辑。'
                : '在上方地址栏填入 .html 的绝对路径开始可视化编辑。代理 write / edit 过的 .html 之后也会自动出现在这里。'),
            ),
            assets.length
              ? React.createElement('div', { className: 'hwb-recent' },
                React.createElement('div', { className: 'hwb-recent-label' }, '最近的 HTML 产物'),
                assets.slice(0, 6).map((a) => assetRow(a, false)),
              )
              : null,
          )

      return React.createElement('div', {
        className: 'hwb-panel',
        style: { width: s.panelWidth + 'px', maxWidth: 'calc(100vw - 24px)' },
        role: 'complementary',
        'aria-label': 'HTML Workbench',
      },
        React.createElement('div', {
          className: 'hwb-resize',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '调整面板宽度',
          tabIndex: 0,
          title: '拖动调整宽度（双击复位）',
          onMouseDown: startResize,
          onDoubleClick: () => { store.set({ panelWidth: DEFAULT_WIDTH }); writeWidth(DEFAULT_WIDTH) },
          onKeyDown: (e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeWidth(32) }
            else if (e.key === 'ArrowRight') { e.preventDefault(); nudgeWidth(-32) }
          },
        }),

        React.createElement('div', { className: 'hwb-chrome' },
          React.createElement('div', { className: 'hwb-idrow' },
            React.createElement('button', {
              type: 'button',
              className: 'hwb-statusbtn',
              'aria-expanded': !!s.diagOpen,
              title: s.running ? '本地服务运行中 — 点击查看诊断' : '本地服务未就绪 — 点击查看原因',
              onClick: () => store.set({ diagOpen: !s.diagOpen }),
            },
              React.createElement('span', {
                className: 'hwb-dot',
                'data-on': s.running ? '' : undefined,
                'data-off': !s.running ? '' : undefined,
              }),
              React.createElement('span', { className: 'hwb-name' }, 'HTML Workbench'),
            ),
            currentPath ? React.createElement('span', { className: 'hwb-sep' }) : null,
            currentPath
              ? React.createElement('span', { className: 'hwb-filechip', title: currentPath }, I_FILE, React.createElement('span', null, basename(currentPath)))
              : null,
            React.createElement('span', { className: 'hwb-spacer' }),
            React.createElement('div', { className: 'hwb-actions' },
              React.createElement('button', {
                type: 'button', className: 'hwb-icon', title: '服务诊断',
                'aria-label': '服务诊断', 'aria-expanded': !!s.diagOpen,
                onClick: () => store.set({ diagOpen: !s.diagOpen }),
              }, I_LOGS),
              React.createElement('button', {
                type: 'button', className: 'hwb-icon', title: '刷新产物列表',
                'aria-label': '刷新产物列表', 'data-spin': s.refreshing ? '' : undefined,
                onClick: () => refresh(true),
              }, I_REFRESH),
              React.createElement('button', {
                type: 'button', className: 'hwb-icon', title: '在浏览器标签页中打开',
                'aria-label': '在浏览器标签页中打开', disabled: !(s.current && s.current.url),
                onClick: () => { if (s.current && s.current.url) window.open(s.current.url, '_blank', 'noopener') },
              }, I_EXTERNAL),
              React.createElement('button', {
                type: 'button', className: 'hwb-icon', title: '关闭面板',
                'aria-label': '关闭面板', onClick: () => store.set({ open: false }),
              }, I_CLOSE),
            ),
          ),

          React.createElement('div', { className: 'hwb-toolbar' },
            React.createElement('div', { className: 'hwb-fieldwrap', ref: fieldRef },
              React.createElement('div', { className: 'hwb-field', 'data-focus': focused ? '' : undefined },
                React.createElement('input', {
                  ref: inputRef,
                  className: 'hwb-input',
                  type: 'text',
                  placeholder: '/absolute/path/page.html',
                  value: s.pathInput,
                  spellCheck: false,
                  autoComplete: 'off',
                  'aria-label': 'HTML 文件绝对路径',
                  onChange: (e) => { const v = e.target.value; store.set({ pathInput: v }); checkPath(v) },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') submit()
                    else if (e.key === 'ArrowDown' && assets.length) { e.preventDefault(); setMenuOpen(true) }
                  },
                  onFocus: () => { setFocused(true); if (assets.length && !trimmed) setMenuOpen(true) },
                  onBlur: () => setFocused(false),
                }),
                s.resolveState !== 'idle'
                  ? React.createElement('span', {
                    className: 'hwb-state',
                    'data-state': s.resolveState,
                    title: STATE_TITLE[s.resolveState] || '',
                  }, STATE_ICON[s.resolveState] || null)
                  : null,
                React.createElement('button', {
                  type: 'button',
                  className: 'hwb-caret',
                  'aria-expanded': menuOpen,
                  'aria-haspopup': 'listbox',
                  title: '历史 HTML 产物' + (assets.length ? '（' + assets.length + '）' : ''),
                  onClick: () => setMenuOpen((v) => !v),
                }, I_CARET),
              ),
              menuOpen
                ? React.createElement('div', { className: 'hwb-menu', role: 'listbox' },
                  React.createElement('div', { className: 'hwb-menu-head' },
                    React.createElement('span', null, 'HTML 产物'),
                    React.createElement('span', null, assets.length ? assets.length + ' 个' : '空'),
                  ),
                  assets.length
                    ? React.createElement('div', { className: 'hwb-menu-body' }, assets.map((a) => assetRow(a, true)))
                    : React.createElement('div', { className: 'hwb-menu-empty' }, '暂无产物', React.createElement('br'), '代理 write / edit 过的 .html 会出现在这里'),
                )
                : null,
            ),
            React.createElement('button', {
              type: 'button', className: 'hwb-btn hwb-btn-primary',
              disabled: !trimmed || s.loading, onClick: submit,
            }, '打开'),
          ),
        ),

        s.error
          ? React.createElement('div', { className: 'hwb-banner', role: 'alert' },
            I_ALERT,
            React.createElement('span', { className: 'hwb-banner-text' }, s.error),
            React.createElement('button', {
              type: 'button', className: 'hwb-icon', title: '查看诊断', 'aria-label': '查看诊断',
              onClick: () => store.set({ diagOpen: true }),
            }, I_LOGS),
            React.createElement('button', {
              type: 'button', className: 'hwb-icon', title: '忽略', 'aria-label': '忽略',
              onClick: () => store.set({ error: null }),
            }, I_CLOSE),
          )
          : null,

        s.diagOpen ? React.createElement(Diagnostics) : null,

        React.createElement('div', { className: 'hwb-body' }, body),
      )
    }

    const Trigger = () => {
      const s = useStore()
      if (s.open) return null
      return React.createElement('button', {
        type: 'button',
        className: 'hwb-trigger',
        title: 'HTML Workbench',
        'aria-label': '打开 HTML Workbench',
        'aria-expanded': false,
        onClick: () => { store.set({ open: true }); refresh() },
      }, I_TRIGGER)
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'html-workbench-panel', order: 60, label: 'HTML Workbench' },
      () => React.createElement(Panel),
    ))

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'html-workbench-trigger', order: 59, label: 'HTML Workbench 入口' },
      () => React.createElement(Trigger),
    ))
  },
}
