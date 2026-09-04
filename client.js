// dsh-sidechat — browser half.
//
// Main window: watch text selections that lie fully inside a settled
// assistant "formal answer" (data-chat-flow-kind="assistant-step", outside
// the [data-variant="think"] reasoning disclosure, outside streaming blocks).
// Show a floating "提问" button; on click open a right-side panel hosting a
// same-origin iframe (a second dsh web instance). The inner instance runs the
// same plugin in side mode: it never enables selection-asking (no nesting /
// no matryoshka), creates/opens a temporary session and prefills the
// selection into the composer as an editable draft (not auto-sent).
//
// Temp-session lifecycle (agreed semantics): the row may show while the panel
// is open; on close the session is archived through the public
// workspace.archiveSession RPC when it has real content (blank sessions are
// already invisible and reusable, so they are left alone). Orphan recovery
// archives a still-open side session after a page reload via localStorage.

/* eslint-disable no-restricted-globals */
window.__ModuleLoader__.load({
  id: 'dsh-sidechat',
  factory: (require) => {
    const React = require('react');
    const {
      createElement: h,
      useEffect,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    // ------------------------------------------------------------------ ids --
    const SIDE_PARAM = 'dsh_sidechat=1';
    const IS_SIDE_MODE =
      typeof location !== 'undefined' &&
      (location.search.indexOf(SIDE_PARAM) !== -1 ||
        location.hash.indexOf(SIDE_PARAM) !== -1);
    const STORAGE_KEY = 'dsh-sidechat.active';
    const FRAME_ID = 'dsh-sidechat-frame';
    const STYLE_ID = 'dsh-sidechat-style';

    const ASSISTANT_SEAT = '[data-chat-flow-kind="assistant-step"]';
    const THINK = '[data-variant="think"]';
    const STREAMING = '[data-streaming]';

    // `package.json#dsh.client.inject` names package-level load dependencies.
    // The plugin returned here is mounted by Cordis, whose `inject` field must
    // instead name the runtime services that this implementation reads from
    // `ctx`. Using package names here leaves the entry parked forever because
    // no service is registered under those names.
    const inject = ['slots', 'sessions', 'workspaces', 'conversation'];

    // ------------------------------------------------------------- helpers --
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    function closestFrom(node, sel) {
      if (!node) return null;
      const el = node.nodeType === 1 ? node : node.parentElement;
      return el ? el.closest(sel) : null;
    }

    function postToWindow(win, msg) {
      try {
        win.postMessage(msg, location.origin);
      } catch (e) {
        /* frame gone */
      }
    }

    function sideIframe() {
      return document.getElementById(FRAME_ID);
    }

    function resolveWorkspaceId(ctx) {
      let wl = null;
      let sl = null;
      try {
        wl = ctx.workspaces && ctx.workspaces.list ? ctx.workspaces.list.getSnapshot() : null;
      } catch (e) {}
      try {
        sl = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null;
      } catch (e) {}
      if (wl && sl && sl.current) {
        const cur = sl.byId[sl.current];
        if (cur && cur.cwd) {
          const hit = wl.items.find((w) => w.path === cur.cwd);
          if (hit) return hit.workspaceId;
        }
      }
      if (wl) {
        if (wl.recentWorkspaceId) return wl.recentWorkspaceId;
        if (wl.items.length) return wl.items[0].workspaceId;
      }
      return undefined;
    }

    // ------------------------------------------------ tiny external store ---
    function createStore(init) {
      let state = init;
      const subs = new Set();
      return {
        get: () => state,
        set: (patch) => {
          const next = { ...state, ...patch };
          if (next === state) return;
          state = next;
          subs.forEach((f) => f());
        },
        subscribe: (f) => {
          subs.add(f);
          return () => subs.delete(f);
        },
      };
    }

    // ============================================================ MAIN MODE =
    function selectionInfo() {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      const common = range.commonAncestorContainer;
      if (closestFrom(common, '[data-dsh-sidechat], textarea, [contenteditable="true"], input')) return null;
      const seat = closestFrom(common, ASSISTANT_SEAT);
      if (!seat) return null;
      const a = range.startContainer;
      const b = range.endContainer;
      if (closestFrom(a, THINK) || closestFrom(b, THINK)) return null;
      if (closestFrom(a, STREAMING) || closestFrom(b, STREAMING)) return null;
      const forbidden = Array.from(seat.querySelectorAll(THINK + ',' + STREAMING));
      for (const el of forbidden) {
        if (range.intersectsNode(el)) return null;
      }
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 8000) return null;
      const rect = range.getBoundingClientRect();
      if (!rect || rect.width === 0 && rect.height === 0) return null;
      return {
        text,
        x: Math.min(window.innerWidth - 90, Math.max(16, rect.left + rect.width / 2)),
        y: rect.bottom + 8,
        seatKey: seat.getAttribute('data-chat-anchor-key'),
      };
    }

    function retireSession(ctx, sessionId) {
      if (!sessionId) return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && String(parsed.sessionId) === String(sessionId)) {
            localStorage.removeItem(STORAGE_KEY);
          }
        }
      } catch (e) {}
      // Blank sessions never surface in the directory and stay reusable for
      // New Session; only hide (archive) side sessions with real content.
      let blank = false;
      try {
        const sl = ctx.sessions.list.getSnapshot();
        const row = sl.byId && sl.byId[sessionId];
        blank = !!(row && row.blank);
      } catch (e) {}
      if (blank) return;
      try {
        ctx.workspaces.archiveSession(sessionId).catch(() => {});
      } catch (e) {}
    }

    function recoverOrphan(ctx) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const id = parsed && parsed.sessionId;
        if (!id) return;
        // Give the lists a moment to hydrate so we can tell blank from content.
        setTimeout(() => retireSession(ctx, id), 4000);
      } catch (e) {}
    }

    function applyMain(ctx) {
      const store = createStore({
        ask: null,
        panel: false,
        pending: null,
        ready: false,
        sent: false,
        sessionId: null,
        status: '',
        width: 720,
      });

      recoverOrphan(ctx);

      const showAsk = () => {
        const info = selectionInfo();
        store.set({ ask: info });
      };

      const hideAsk = () => {
        if (store.get().ask) store.set({ ask: null });
      };

      const openPanel = (text) => {
        if (!text) return;
        const width = Math.max(560, Math.min(760, Math.round(window.innerWidth * 0.5)));
        store.set({ panel: true, pending: text, sent: false, ready: false, status: 'opening', width });
      };

      const closePanel = () => {
        const st = store.get();
        if (st.sessionId) retireSession(ctx, st.sessionId);
        store.set({
          panel: false,
          pending: null,
          ready: false,
          sent: false,
          sessionId: null,
          status: '',
        });
      };

      const onMessage = (ev) => {
        if (ev.origin !== location.origin) return;
        const data = ev.data;
        if (!data || typeof data.type !== 'string') return;
        if (data.type === 'dsh-sidechat:ready') {
          store.set({ ready: true });
        } else if (data.type === 'dsh-sidechat:opened') {
          const st = store.get();
          const sessionId = data.sessionId || null;
          if (sessionId) {
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, at: Date.now() }));
            } catch (e) {}
          }
          store.set({ sessionId, status: 'opened', sent: true });
          if (st.pending) store.set({ pending: null });
        } else if (data.type === 'dsh-sidechat:error') {
          store.set({ status: 'error: ' + (data.error || 'unknown') });
        }
      };

      // Global listeners live as long as the plugin fiber (both modes safe).
      ctx.effect(() => {
        window.addEventListener('message', onMessage);
        const onUp = (ev) => {
          if (ev.target && closestFrom(ev.target, '[data-dsh-sidechat]')) return;
          showAsk();
        };
        const onDown = (ev) => {
          // Pressing inside our own UI (the Ask button or the panel) must never
          // dismiss the floating button before the click can register.
          if (ev.target && closestFrom(ev.target, '[data-dsh-sidechat]')) return;
          setTimeout(hideAsk, 0);
        };
        const onScroll = () => hideAsk();
        document.addEventListener('mouseup', onUp);
        document.addEventListener('mousedown', onDown);
        document.addEventListener('scroll', onScroll, true);
        return () => {
          window.removeEventListener('message', onMessage);
          document.removeEventListener('mouseup', onUp);
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('scroll', onScroll, true);
        };
      });

      // One style tag for the whole page (removed on unload).
      ctx.effect(() => {
        const css = `
          [data-dsh-sidechat-root] { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: inherit; }
          [data-dsh-sidechat-root] * { pointer-events: auto; }
          .dshsc-ask {
            position: fixed; border: 1px solid rgba(128,128,128,.35); background: var(--dsw-alias-bg-base, #1f1f1f);
            color: var(--dsw-alias-label-primary, #eee); border-radius: 10px; padding: 5px 12px; font-size: 13px;
            cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.28); display: flex; align-items: center; gap: 6px;
            transform: translate(-50%, 0);
          }
          .dshsc-ask:hover { filter: brightness(1.15); }
          .dshsc-panel {
            position: fixed; top: 0; right: 0; bottom: 0; pointer-events: auto;
            display: flex; flex-direction: column;
            background: var(--dsw-alias-bg-base, #151515);
            border-left: 1px solid rgba(128,128,128,.35);
            box-shadow: -8px 0 30px rgba(0,0,0,.25);
            animation: dshsc-slide-in .18s ease-out;
          }
          @keyframes dshsc-slide-in { from { transform: translateX(24px); opacity: .4; } to { transform: none; opacity: 1; } }
          .dshsc-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 14px;
            border-bottom: 1px solid rgba(128,128,128,.25); min-height: 42px; box-sizing: border-box; }
          .dshsc-title { font-weight: 600; font-size: 13px; color: var(--dsw-alias-label-primary, #eee); flex: 0 0 auto; }
          .dshsc-quote { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            font-size: 12px; opacity: .75; color: var(--dsw-alias-label-secondary, #bbb); direction: rtl; text-align: left; }
          .dshsc-close { flex: 0 0 auto; border: none; background: transparent; color: inherit; font-size: 18px;
            line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: 6px; opacity: .8; }
          .dshsc-close:hover { opacity: 1; background: rgba(128,128,128,.18); }
          .dshsc-body { flex: 1 1 auto; position: relative; min-height: 0; }
          .dshsc-frame { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
          .dshsc-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            color: var(--dsw-alias-label-secondary, #aaa); font-size: 13px; background: var(--dsw-alias-bg-base, #151515); }
        `;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);
        return () => {
          const s = document.getElementById(STYLE_ID);
          if (s) s.remove();
        };
      });

      // Register our overlay seat. shell.overlay is a frame-wide list seat.
      ctx.slots.inject('shell.overlay', function* overlayContribution() {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'dsh-sidechat' }, function SideChatRoot() {
          const state = useSyncExternalStore(store.subscribe, store.get);
          const st = useRef(state);
          st.current = state;
          const sentOnce = useRef(false);

          // Send open when: panel visible, pending text present, iframe ready.
          useEffect(() => {
            const cur = st.current;
            if (!cur.panel || !cur.pending || !cur.ready || cur.sent) return;
            const frame = sideIframe();
            if (!frame || !frame.contentWindow) return;
            sentOnce.current = true;
            postToWindow(frame.contentWindow, { type: 'dsh-sidechat:open', text: cur.pending });
            store.set({ sent: true });
          }, [state.panel, state.pending, state.ready, state.sent]);

          // Ask again while the panel is already open: focus and prefill again.
          const requestAsk = () => {
            const cur = st.current;
            if (!cur.ask) return;
            openPanel(cur.ask.text);
            // Clear the page selection so the button does not linger or retrigger.
            try {
              const sel = window.getSelection();
              if (sel) sel.removeAllRanges();
            } catch (e) {}
            store.set({ ask: null });
          };

          const iframeSrc =
            location.origin + location.pathname + '?' + SIDE_PARAM;

          return h(
            'div',
            { 'data-dsh-sidechat-root': '', 'data-dsh-sidechat': '' },
            state.ask
              ? h(
                  'button',
                  {
                    className: 'dshsc-ask',
                    style: { left: state.ask.x + 'px', top: state.ask.y + 'px' },
                    title: state.ask.text.slice(0, 120),
                    onClick: requestAsk,
                    onMouseDown: (e) => e.preventDefault(),
                  },
                  '\u5728\u4fa7\u8fb9\u804a\u5929\u63d0\u95ee'
                )
              : null,
            state.panel
              ? h(
                  'div',
                  { className: 'dshsc-panel', style: { width: state.width + 'px' } },
                  h(
                    'div',
                    { className: 'dshsc-head' },
                    h('span', { className: 'dshsc-title' }, '\u4fa7\u8fb9\u63d0\u95ee'),
                    state.pending
                      ? h('span', { className: 'dshsc-quote', dir: 'ltr' }, state.pending.slice(0, 160))
                      : null,
                    h('button', { className: 'dshsc-close', title: '\u5173\u95ed', onClick: closePanel }, '\u2715')
                  ),
                  h(
                    'div',
                    { className: 'dshsc-body' },
                    state.status && state.status !== 'opened'
                      ? h('div', { className: 'dshsc-status' }, state.status)
                      : null,
                    h('iframe', {
                      id: FRAME_ID,
                      className: 'dshsc-frame',
                      src: iframeSrc,
                      // A loaded document is not necessarily ready to receive
                      // plugin messages yet. Wait for the side instance's
                      // explicit dsh-sidechat:ready handshake instead.
                      onLoad: () => {
                        if (!store.get().ready) store.set({ status: 'loading' });
                      },
                    })
                  )
                )
              : null
          );
        });
      });

      return () => {};
    }

    // ============================================================ SIDE MODE =
    function applySide(ctx) {
      let ownSessionId = null;

      const post = (msg) => {
        try {
          window.parent.postMessage(msg, location.origin);
        } catch (e) {}
      };

      const prefill = (sessionId, text) => {
        try {
          const binding = ctx.sessions.binding(sessionId);
          if (!binding) return false;
          const input =
            ctx.conversation &&
            ctx.conversation.input &&
            typeof ctx.conversation.input.for === 'function'
              ? ctx.conversation.input.for(binding.ctx)
              : null;
          if (!input || typeof input.setDraft !== 'function') return false;
          input.setDraft(text);
          return true;
        } catch (e) {
          return false;
        }
      };

      const baselinesReady = () => {
        try {
          const wl = ctx.workspaces.list.getSnapshot();
          return !!(wl && wl.baselinesReady);
        } catch (e) {
          return false;
        }
      };

      const handleOpen = async (text) => {
        if (!text) return;
        try {
          // 1) reuse the session this side mode already owns when it is still
          //    healthy, otherwise (re)create one on the host.
          let sessionId = ownSessionId;
          if (sessionId) {
            try {
              const sl = ctx.sessions.list.getSnapshot();
              const row = sl.byId && sl.byId[sessionId];
              if (!row) sessionId = null;
            } catch (e) {}
          }
          if (!sessionId) {
            const workspaceId = resolveWorkspaceId(ctx);
            if (!workspaceId) {
              post({ type: 'dsh-sidechat:error', error: 'no-workspace' });
              return;
            }
            sessionId = await ctx.workspaces.connectWorkspace(workspaceId);
            ownSessionId = sessionId;
          }
          try {
            ctx.sessions.open(sessionId);
          } catch (e) {}
          post({ type: 'dsh-sidechat:opened', sessionId });

          // 2) prefill the composer draft. The per-session input shell is
          //    created while the session is staged; retry briefly until the
          //    conversation.input.for(binding) surface resolves.
          for (let i = 0; i < 12; i++) {
            await delay(150);
            if (prefill(sessionId, text)) break;
          }
        } catch (e) {
          post({ type: 'dsh-sidechat:error', error: String((e && e.message) || e).slice(0, 200) });
        }
      };

      const onMessage = async (ev) => {
        if (ev.origin !== location.origin) return;
        const data = ev.data;
        if (!data || typeof data.type !== 'string') return;
        if (data.type === 'dsh-sidechat:open') {
          await handleOpen(data.text);
        } else if (data.type === 'dsh-sidechat:close') {
          ownSessionId = null;
        }
      };

      ctx.effect(() => {
        window.addEventListener('message', onMessage);
        // Announce readiness once the host baselines settle (or immediately if
        // they already have). The parent only sends `open` after this.
        const announce = () => {
          if (baselinesReady()) {
            post({ type: 'dsh-sidechat:ready' });
            return true;
          }
          return false;
        };
        if (!announce()) {
          const timer = setInterval(() => {
            if (announce()) clearInterval(timer);
          }, 300);
          setTimeout(() => clearInterval(timer), 30000);
        }
        return () => {
          window.removeEventListener('message', onMessage);
        };
      });

      return () => {};
    }

    // ------------------------------------------------------------------ body
    function apply(ctx) {
      if (IS_SIDE_MODE) return applySide(ctx);
      return applyMain(ctx);
    }

    return { inject, apply };
  },
});
