// MailPulse content script for mail.google.com.
//  1. Adds a "Track" toggle next to every compose window's Send button.
//  2. Just before a tracked message is sent, inserts a 1x1 pixel, rewrites links for click tracking,
//     and registers the message with the backend (through the background worker).
//  3. Tells the backend when *you* are looking at a tracked message, so your own views are not counted.
(() => {
  const SEND_BUTTON = 'div[role="button"].aoO, div[role="button"][data-tooltip^="Send"]';
  const EDITOR = 'div[g_editable="true"], div[contenteditable="true"][role="textbox"]';

  let settings = {};
  let emails = [];
  let pixelRe = null;

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function applySettings(next) {
    settings = next ?? {};
    pixelRe = null;
    try {
      const u = new URL(settings.backendUrl);
      pixelRe = new RegExp(`${escapeRe(u.host + u.pathname.replace(/\/+$/, ""))}/o/([A-Za-z0-9_-]{16,64})`);
    } catch {
      /* not configured */
    }
    document.querySelectorAll(".mp-toggle").forEach(renderToggle);
  }

  chrome.storage.local.get(["settings", "emails"]).then((s) => {
    emails = s.emails ?? [];
    applySettings(s.settings);
    schedule();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.settings) applySettings(changes.settings.newValue);
    if (changes.emails) emails = changes.emails.newValue ?? [];
  });

  const configured = () => Boolean(settings.backendUrl && settings.secret);

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      return Promise.resolve(); // extension was reloaded; this page needs a refresh
    }
  }

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function account() {
    const m = document.title.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
    return m ? m[0].toLowerCase() : null;
  }

  // ---------- compose windows ----------

  /** Smallest ancestor of the Send button that also contains the message editor. */
  function composeRoot(fromEl) {
    for (let el = fromEl.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.querySelector(EDITOR) && el.querySelector(SEND_BUTTON)) return el;
    }
    return null;
  }

  function recipients(root) {
    const me = account();
    const found = new Map();
    // Look in the compose root first, then widen a little (inline replies keep chips a few levels up).
    for (let el = root, i = 0; el && i < 4 && !found.size; el = el.parentElement, i++) {
      el.querySelectorAll("[data-hovercard-id], [email]").forEach((chip) => {
        if (chip.closest(EDITOR)) return;
        const email = (chip.getAttribute("data-hovercard-id") || chip.getAttribute("email") || "").toLowerCase();
        if (!email.includes("@") || email === me || found.has(email)) return;
        const name = chip.getAttribute("data-name") || chip.getAttribute("name") || "";
        found.set(email, { email, name: name.includes("@") ? "" : name.trim() });
      });
      el.querySelectorAll('input[name="to"], input[name="cc"], input[name="bcc"]').forEach((input) => {
        for (const email of input.value.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
          const e = email.toLowerCase();
          if (e !== me && !found.has(e)) found.set(e, { email: e, name: "" });
        }
      });
    }
    return [...found.values()];
  }

  function subject(root) {
    for (let el = root, i = 0; el && i < 4; el = el.parentElement, i++) {
      const input = el.querySelector('input[name="subjectbox"], input[name="subject"]');
      if (input?.value) return input.value;
    }
    return document.querySelector("h2.hP")?.textContent?.trim() ?? "";
  }

  const EYE =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"/></svg>';

  function renderToggle(toggle) {
    const on = toggle.dataset.on === "1";
    const ready = configured();
    toggle.classList.toggle("mp-on", on && ready);
    toggle.classList.toggle("mp-disabled", !ready);
    toggle.setAttribute("aria-checked", String(on && ready));
    toggle.title = !ready
      ? "MailPulse is not set up yet. Open the extension's Settings."
      : on
        ? "Tracking opens and link clicks for this message. Click to turn off."
        : "Not tracking this message. Click to track opens and link clicks.";
    toggle.querySelector(".mp-label").textContent = on && ready ? "Tracked" : "Track";
  }

  function decorate(button) {
    if (button.dataset.mpDecorated) return;
    button.dataset.mpDecorated = "1";
    const root = composeRoot(button);
    if (!root || root.querySelector(".mp-toggle")) return;

    const toggle = document.createElement("div");
    toggle.className = "mp-toggle";
    toggle.setAttribute("role", "switch");
    toggle.tabIndex = 0;
    toggle.dataset.on = settings.trackByDefault === false ? "0" : "1";
    toggle.innerHTML = `${EYE}<span class="mp-label"></span>`;
    const flip = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!configured()) return send({ type: "openOptions" });
      toggle.dataset.on = toggle.dataset.on === "1" ? "0" : "1";
      renderToggle(toggle);
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && flip(e));
    renderToggle(toggle);

    const holder = button.parentElement;
    if (holder.tagName === "TD") holder.appendChild(toggle);
    else holder.insertAdjacentElement("afterend", toggle);
  }

  // ---------- just before sending ----------

  function prepareSend(root) {
    if (!configured()) return;
    const toggle = root.querySelector(".mp-toggle");
    const enabled = toggle ? toggle.dataset.on === "1" : settings.trackByDefault !== false;
    const body = root.querySelector(EDITOR);
    if (!enabled || !body) return;

    // Gmail may fire several of the events we listen to for one send; do the work once.
    if (body.dataset.mpPreparedAt && Date.now() - Number(body.dataset.mpPreparedAt) < 3000) return;
    body.dataset.mpPreparedAt = String(Date.now());

    const base = settings.backendUrl;
    const id = body.dataset.mpId || newId();
    body.dataset.mpId = id;
    const links = JSON.parse(body.dataset.mpLinks || "[]");

    // Pixels of earlier tracked messages inside quoted text would report false opens for those messages.
    body.querySelectorAll("img").forEach((img) => {
      const m = pixelRe && img.src.match(pixelRe);
      if (m && m[1] !== id) img.remove();
    });

    if (settings.trackClicks !== false) {
      body.querySelectorAll("a[href]").forEach((a) => {
        if (a.closest(".gmail_quote")) return;
        const href = a.getAttribute("href") || "";
        if (!/^https?:\/\//i.test(href) || href.startsWith(base)) return;
        const n = links.push(href) - 1;
        a.setAttribute("href", `${base}/c/${id}/${n}`);
      });
      body.dataset.mpLinks = JSON.stringify(links);
    }

    if (!body.querySelector(`img[src*="/o/${id}"]`)) {
      const img = document.createElement("img");
      img.src = `${base}/o/${id}.gif`;
      img.width = 1;
      img.height = 1;
      img.alt = "";
      img.setAttribute("style", "width:1px;height:1px;border:0;max-width:1px;max-height:1px");
      const quote = body.querySelector(":scope > .gmail_quote, :scope > div > .gmail_quote");
      if (quote) quote.parentElement.insertBefore(img, quote);
      else body.appendChild(img);
    }

    send({
      type: "register",
      email: {
        id,
        account: account(),
        subject: subject(root),
        recipients: recipients(root),
        links,
        sent_at: new Date().toISOString(),
      },
    });
  }

  function onPointer(e) {
    const button = e.target.closest?.(SEND_BUTTON);
    if (!button) return;
    const root = composeRoot(button);
    if (root) prepareSend(root);
  }

  function onKey(e) {
    const isSendShortcut = (e.ctrlKey || e.metaKey) && e.key === "Enter";
    const onSendButton = (e.key === "Enter" || e.key === " ") && e.target.closest?.(SEND_BUTTON);
    if (!isSendShortcut && !onSendButton) return;
    for (let el = e.target; el && el !== document.body; el = el.parentElement) {
      if (el.querySelector?.(SEND_BUTTON) && el.querySelector(EDITOR)) return prepareSend(el);
    }
  }

  // Capture phase, so this runs before Gmail's own handlers send the message.
  document.addEventListener("mousedown", onPointer, true);
  document.addEventListener("click", onPointer, true);
  document.addEventListener("keydown", onKey, true);

  // ---------- your own views of tracked messages ----------

  let visible = new Set();

  function scanSelfViews() {
    const now = new Set();
    if (pixelRe) {
      for (const img of document.images) {
        if (img.closest(EDITOR)) continue;
        const m = img.src.match(pixelRe);
        if (m) now.add(m[1]);
      }
    }
    // Fallback when Gmail's image proxy hides the original URL: the open conversation's thread id.
    const thread = document.querySelector("h2[data-legacy-thread-id]")?.getAttribute("data-legacy-thread-id");
    if (thread) for (const e of emails) if (e.thread_id === thread) now.add(e.id);

    for (const id of now) if (!visible.has(id)) send({ type: "selfView", id });
    visible = now;
  }

  // ---------- watch Gmail's DOM ----------

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      document.querySelectorAll(SEND_BUTTON).forEach(decorate);
      if (configured()) scanSelfViews();
    }, 250);
  }
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
})();
