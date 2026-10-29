/*
 * Postflare support chat widget (docs/support-spec.md). Embed with:
 *   <script src="https://<your Postflare>/support/widget.js" async></script>
 * Any element with a `data-support-open` attribute opens the chat; `window.PostflareSupport.open()` does too.
 * No dependencies, everything lives in a shadow root. Polls only while the chat is open and the tab is visible.
 */
(() => {
  if (window.PostflareSupport) return;
  const script = document.currentScript;
  const server = script ? new URL(script.src).origin : location.origin;
  const api = (path) => `${server}/api/support${path}`;
  const sameOrigin = server === location.origin;
  const KEY = "pf_support_visitor";
  const OPEN_POLL_MS = 5000;
  const IDLE_POLL_MS = 60000;

  const visitorToken = (() => {
    try {
      let t = localStorage.getItem(KEY);
      if (!t || !/^[A-Za-z0-9_-]{32,128}$/.test(t)) {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        t = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        localStorage.setItem(KEY, t);
      }
      return t;
    } catch {
      // Storage blocked: a token for this page view only.
      return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
    }
  })();

  async function call(method, path, body) {
    const res = await fetch(api(path), {
      method,
      headers: { "x-support-visitor": visitorToken, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: sameOrigin ? "same-origin" : "omit",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const state = {
    config: null,
    open: false,
    view: "home", // home | thread | new
    conversations: [],
    current: null, // conversation
    messages: [],
    sending: false,
    error: "",
    pollTimer: null,
    idleTimer: null,
  };

  // ---------- DOM ----------

  const host = document.createElement("div");
  host.setAttribute("data-postflare-support", "");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .wrap { --brand: #f97316; --bg: #fff; --fg: #18181b; --muted: #71717a; --line: #e4e4e7; --soft: #f4f4f5; --mine-fg: #fff;
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; color: var(--fg); }
    @media (prefers-color-scheme: dark) { .wrap { --bg: #18181b; --fg: #f4f4f5; --muted: #a1a1aa; --line: #3f3f46; --soft: #27272a; } }
    .bubble { width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: pointer; background: var(--brand); color: #fff;
      box-shadow: 0 6px 24px rgba(0,0,0,.18); display: flex; align-items: center; justify-content: center; transition: transform .15s; position: relative; }
    .bubble:hover { transform: scale(1.06); }
    .bubble svg { width: 26px; height: 26px; }
    .dot { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; border-radius: 10px; background: #ef4444; color: #fff;
      font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; padding: 0 5px; border: 2px solid #fff; }
    .panel { position: absolute; right: 0; bottom: 72px; width: 370px; height: min(600px, calc(100vh - 110px)); background: var(--bg);
      border-radius: 18px; box-shadow: 0 12px 48px rgba(0,0,0,.22); border: 1px solid var(--line); display: flex; flex-direction: column; overflow: hidden; }
    @media (max-width: 480px) { .wrap.is-open { right: 0; bottom: 0; left: 0; top: 0; }
      .wrap.is-open .panel { position: fixed; inset: 0; width: 100%; height: 100%; border-radius: 0; border: 0; }
      .wrap.is-open .bubble { display: none; } }
    .head { background: var(--brand); color: #fff; padding: 16px 16px 18px; display: flex; gap: 10px; align-items: flex-start; }
    .head h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .head p { margin: 4px 0 0; font-size: 13px; opacity: .92; line-height: 1.4; }
    .head .grow { flex: 1; min-width: 0; }
    .icon-btn { background: rgba(255,255,255,.18); border: 0; color: #fff; width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .icon-btn:hover { background: rgba(255,255,255,.3); }
    .icon-btn svg { width: 16px; height: 16px; }
    .body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; }
    .primary { background: var(--brand); color: #fff; border: 0; border-radius: 10px; padding: 11px 14px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
    .primary:disabled { opacity: .6; cursor: default; }
    .label { font-size: 12px; font-weight: 600; color: var(--muted); margin: 10px 2px 2px; text-transform: uppercase; letter-spacing: .03em; }
    .conv { text-align: left; background: var(--soft); border: 0; border-radius: 12px; padding: 10px 12px; cursor: pointer; color: var(--fg); display: block; width: 100%; }
    .conv:hover { filter: brightness(.97); }
    .conv .top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; }
    .conv .sub { font-size: 13px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badge { background: #ef4444; color: #fff; border-radius: 9px; font-size: 11px; padding: 1px 6px; font-weight: 700; }
    .msg { max-width: 82%; padding: 8px 12px; border-radius: 16px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
    .msg a { color: inherit; text-decoration: underline; }
    .row { display: flex; flex-direction: column; }
    .row.mine { align-items: flex-end; }
    .row.mine .msg { background: var(--brand); color: var(--mine-fg); border-bottom-right-radius: 5px; }
    .row.theirs .msg { background: var(--soft); border-bottom-left-radius: 5px; }
    .meta { font-size: 11px; color: var(--muted); margin: 2px 6px 4px; }
    .note { font-size: 12px; color: var(--muted); text-align: center; padding: 6px; }
    .card { background: var(--soft); border-radius: 12px; padding: 10px 12px; font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
    .compose { border-top: 1px solid var(--line); padding: 10px; display: flex; flex-direction: column; gap: 8px; background: var(--bg); }
    .fields { display: flex; gap: 6px; }
    input, textarea { width: 100%; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 10px; padding: 9px 11px;
      font-size: 14px; outline: none; resize: none; }
    input:focus, textarea:focus { border-color: var(--brand); }
    .send-row { display: flex; gap: 8px; align-items: flex-end; }
    .send { background: var(--brand); color: #fff; border: 0; width: 40px; height: 40px; border-radius: 10px; cursor: pointer; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; }
    .send:disabled { opacity: .5; cursor: default; }
    .send svg { width: 18px; height: 18px; }
    .error { color: #dc2626; font-size: 12px; }
    .hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
    .foot { font-size: 11px; color: var(--muted); text-align: center; padding: 0 0 8px; }
    .foot a { color: inherit; }
    @media print { .wrap { display: none; } }
  </style><div class="wrap" part="wrap"></div>`;
  const wrap = root.querySelector(".wrap");

  const ICON = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
  };

  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v; // only our own icon markup
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
    return n;
  };

  /** Text with clickable links, built from text nodes (never HTML). */
  function linkified(text) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
      const url = m[0].replace(/[.,!?;:)\]]+$/, "");
      frag.append(text.slice(last, m.index));
      frag.append(el("a", { href: url, target: "_blank", rel: "noopener noreferrer nofollow" }, url));
      last = m.index + url.length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  const time = (t) => {
    const d = new Date(t);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const unreadTotal = () => state.conversations.reduce((n, c) => n + (c.unread || 0), 0);

  function render() {
    wrap.classList.toggle("is-open", state.open);
    wrap.replaceChildren();
    if (state.open) wrap.append(panel());
    const unread = unreadTotal();
    wrap.append(
      el(
        "button",
        { class: "bubble", "aria-label": state.open ? "Close chat" : "Open chat", onclick: () => (state.open ? close() : open()) },
        el("span", { html: state.open ? ICON.close : ICON.chat, style: "display:flex" }),
        !state.open && unread ? el("span", { class: "dot" }, String(unread)) : null,
      ),
    );
  }

  function header(withBack) {
    const c = state.config;
    return el(
      "div",
      { class: "head" },
      withBack ? el("button", { class: "icon-btn", "aria-label": "Back", html: ICON.back, onclick: () => goHome() }) : null,
      el(
        "div",
        { class: "grow" },
        el("h2", {}, state.view === "thread" && state.current ? `${c.teamName} · #${state.current.number}` : c.teamName),
        state.view === "home" ? el("p", {}, c.greeting) : null,
      ),
      el("button", { class: "icon-btn", "aria-label": "Close", html: ICON.close, onclick: () => close() }),
    );
  }

  function panel() {
    const p = el("div", { class: "panel", role: "dialog", "aria-label": `${state.config.teamName} chat` });
    if (state.view === "home") {
      p.append(header(false));
      const body = el("div", { class: "body" });
      body.append(el("button", { class: "primary", onclick: () => newConversation() }, "Send us a message"));
      if (state.conversations.length) {
        body.append(el("div", { class: "label" }, "Your conversations"));
        for (const c of state.conversations) {
          body.append(
            el(
              "button",
              { class: "conv", onclick: () => openConversation(c) },
              el("div", { class: "top" }, el("span", {}, c.subject || `#${c.number}`), c.unread ? el("span", { class: "badge" }, String(c.unread)) : el("span", { class: "meta" }, time(c.lastMessageAt))),
              el("div", { class: "sub" }, `${c.lastAuthor === "staff" ? `${state.config.teamName}: ` : "You: "}${c.lastMessagePreview || ""}`),
            ),
          );
        }
      }
      p.append(body);
    } else {
      p.append(header(true));
      const body = el("div", { class: "body" });
      if (state.view === "new") body.append(el("div", { class: "note" }, state.config.greeting));
      for (const m of state.messages) {
        const mine = m.author === "customer";
        body.append(
          el(
            "div",
            { class: `row ${mine ? "mine" : "theirs"}` },
            el("div", { class: "msg" }, linkified(m.body)),
            el("div", { class: "meta" }, `${mine ? "" : `${(m.authorName || state.config.teamName).split(" ")[0]} · `}${time(m.createdAt)}`),
          ),
        );
      }
      const c = state.current;
      if (c && !state.config.signedIn && !c.email && state.messages.length) body.append(emailCard());
      if (c && c.status === "closed") body.append(el("div", { class: "note" }, "This conversation is closed. Write again to reopen it."));
      p.append(body, composer());
      requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
    }
    p.append(el("div", { class: "foot" }, "Powered by ", el("a", { href: "https://postflare.ferdi.app", target: "_blank", rel: "noopener" }, "Postflare")));
    return p;
  }

  function emailCard() {
    const input = el("input", { type: "email", placeholder: "you@example.com", autocomplete: "email", "aria-label": "Email" });
    const msg = el("div", {}, "Leave your email so we can reply if you're away.");
    const save = el("button", { class: "primary", style: "padding:8px" }, "Notify me by email");
    save.addEventListener("click", async () => {
      if (!input.value.trim()) return;
      save.disabled = true;
      try {
        const r = await call("PATCH", `/conversations/${state.current.id}`, { email: input.value.trim() });
        state.current = r.conversation;
        render();
      } catch (err) {
        msg.textContent = err.message;
        save.disabled = false;
      }
    });
    return el("div", { class: "card" }, msg, input, save);
  }

  function composer() {
    const ask = state.view === "new" && !state.config.signedIn;
    const name = ask ? el("input", { placeholder: "Name (optional)", autocomplete: "name", "aria-label": "Name" }) : null;
    const email = ask ? el("input", { type: "email", placeholder: "Email (optional)", autocomplete: "email", "aria-label": "Email" }) : null;
    const hp = el("input", { class: "hp", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", name: "website" });
    const text = el("textarea", { rows: "2", placeholder: "Write a message…", "aria-label": "Message", maxlength: "5000" });
    const send = el("button", { class: "send", "aria-label": "Send", html: ICON.send });
    const submit = async () => {
      const body = text.value.trim();
      if (!body || state.sending) return;
      state.sending = true;
      send.disabled = true;
      state.error = "";
      try {
        if (state.view === "new") {
          const r = await call("POST", "/conversations", {
            body,
            name: name?.value.trim() || undefined,
            email: email?.value.trim() || undefined,
            pageUrl: location.href,
            website: hp.value,
            source: sameOrigin && state.config.signedIn ? "app" : "widget",
          });
          state.current = r.conversation;
          state.messages = r.messages;
          state.view = "thread";
          state.conversations = [r.conversation, ...state.conversations];
        } else {
          const r = await call("POST", `/conversations/${state.current.id}/messages`, { body });
          state.current = r.conversation;
          if (!state.messages.some((m) => m.id === r.message.id)) state.messages.push(r.message);
        }
        text.value = "";
      } catch (err) {
        state.error = err.message;
      } finally {
        state.sending = false;
      }
      render();
      startPolling();
    };
    send.addEventListener("click", submit);
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    requestAnimationFrame(() => text.focus());
    return el(
      "div",
      { class: "compose" },
      ask ? el("div", { class: "fields" }, name, email) : null,
      hp,
      el("div", { class: "send-row" }, text, send),
      state.error ? el("div", { class: "error" }, state.error) : null,
    );
  }

  // ---------- behaviour ----------

  function goHome() {
    state.view = "home";
    state.current = null;
    state.messages = [];
    state.error = "";
    stopPolling();
    render();
    void refreshList();
  }

  function newConversation() {
    state.view = "new";
    state.current = null;
    state.messages = [];
    state.error = "";
    render();
  }

  async function openConversation(c) {
    state.view = "thread";
    state.current = c;
    state.messages = [];
    render();
    await poll(true);
    startPolling();
  }

  async function poll(full) {
    if (!state.current) return;
    const last = full || !state.messages.length ? 0 : state.messages[state.messages.length - 1].createdAt - 1;
    try {
      const r = await call("GET", `/conversations/${state.current.id}?after=${last}`);
      const known = new Set(state.messages.map((m) => m.id));
      const fresh = r.messages.filter((m) => !known.has(m.id));
      const changed = fresh.length || r.conversation.status !== state.current.status;
      state.current = r.conversation;
      state.conversations = state.conversations.map((c) => (c.id === r.conversation.id ? r.conversation : c));
      if (fresh.length) state.messages = [...state.messages, ...fresh];
      // Keep the composer's text: only redraw when something arrived.
      if (changed || full) rerenderKeepingDraft();
    } catch {
      /* offline or the conversation is gone: try again on the next tick */
    }
  }

  /** Redraw without losing what the visitor is typing. */
  function rerenderKeepingDraft() {
    const ta = root.querySelector("textarea");
    const draft = ta ? ta.value : "";
    const focused = ta && root.activeElement === ta;
    render();
    const next = root.querySelector("textarea");
    if (next) {
      next.value = draft;
      if (!focused) next.blur();
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.open || state.view !== "thread") return;
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") void poll(false);
    }, OPEN_POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function refreshList() {
    try {
      const r = await call("GET", "/conversations");
      state.conversations = r.items;
    } catch {
      return;
    }
    if (!state.open || state.view === "home") render();
    scheduleIdle();
  }

  /** While closed: look for replies now and then, only once there is a conversation. */
  function scheduleIdle() {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (!state.conversations.length) return;
    state.idleTimer = setTimeout(() => {
      if (!state.open && document.visibilityState === "visible") void refreshList();
      else scheduleIdle();
    }, IDLE_POLL_MS);
  }

  function open() {
    if (!state.config) return;
    state.open = true;
    const unreadConv = state.conversations.find((c) => c.unread);
    if (unreadConv) return void openConversation(unreadConv);
    if (state.view === "home" && !state.conversations.length) state.view = "new";
    render();
    startPolling();
  }

  function close() {
    state.open = false;
    stopPolling();
    render();
    scheduleIdle();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.open && state.view === "thread") void poll(false);
  });
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-support-open]") : null;
    if (t) {
      e.preventDefault();
      open();
    }
  });

  window.PostflareSupport = { open: () => open(), close: () => close() };

  async function init() {
    try {
      const cfg = await call("GET", "/widget");
      if (!cfg.enabled || cfg.staff) return;
      state.config = cfg;
    } catch {
      return;
    }
    document.body.append(host);
    render();
    void refreshList();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else void init();
})();
