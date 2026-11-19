(function () {
  const FIRST_ISSUE = "2026-11-20";
  const PHOTO_MAX = 25 * 1024 * 1024;
  const TOAST_MS = 4000;

  const state = {
    booted: false,
    libraryOk: false,
    tax: "",
    species: [],
    orders: [],
    families: [],
    genera: [],
    byName: new Map(),
    records: [],
    bySci: new Map(),
    notes: {},
    favorites: [],
    morning: [],
    holdScroll: false,
    filtered: [],
    filterGen: 0,
    filters: { q: "", order: "", family: "", genus: "", seen: "all", china: false },
    user: null,
    shareActive: false,
    loginEmail: "",
    codeSent: false,
    route: { view: "index" },
    editingId: null,
  };

  let lastPaint = "";
  let toastTimer = 0;
  let shareGen = 0;

  function el(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "class") node.className = value;
        else if (key.startsWith("on") && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const kid of kids || []) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function foldLatin(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[-‐‑–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function numOrBlank(value) {
    return value === "" || value == null ? "" : Number(value);
  }

  function comma(n) {
    return Number(n).toLocaleString("en-US");
  }

  function shanghaiDate(date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date || new Date());
  }

  function daysBetween(start, end) {
    const ms = Date.parse(end + "T00:00:00+08:00") - Date.parse(start + "T00:00:00+08:00");
    return Math.round(ms / 86400000);
  }

  function formatStamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type) => {
      const part = parts.find((item) => item.type === type);
      return part ? part.value : "";
    };
    return get("year") + "-" + get("month") + "-" + get("day") + " " + get("hour") + ":" + get("minute");
  }

  function sortKey(rec) {
    return window.WBRecords.sortKey(rec);
  }

  function compareKey(a, b) {
    return window.WBRecords.compare(a, b);
  }

  function dateOnly(rec) {
    return window.WBRecords.displayWhen(rec).date;
  }

  function recordsFor(sci) {
    return (state.bySci.get(sci) || []).slice().sort((a, b) => compareKey(sortKey(a), sortKey(b)));
  }

  function speciesInScope() {
    const filters = state.filters;
    const out = [];
    for (const sp of state.species) {
      if (filters.order !== "" && sp.order !== filters.order) continue;
      if (filters.family !== "" && sp.family !== filters.family) continue;
      if (filters.genus !== "" && sp.genus !== filters.genus) continue;
      if (filters.china && !sp.china) continue;
      if (!matches(sp, filters.q)) continue;
      out.push(sp);
    }
    return out;
  }

  function census() {
    return window.WBRecords.tally(speciesInScope(), state.bySci);
  }

  function reindexRecords() {
    state.bySci = new Map();
    for (const rec of state.records) {
      if (!rec || !rec.scientificName) continue;
      if (!state.bySci.has(rec.scientificName)) state.bySci.set(rec.scientificName, []);
      state.bySci.get(rec.scientificName).push(rec);
    }
  }

  function applyLibrary(data) {
    state.records = Array.isArray(data.records) ? data.records : [];
    state.favorites = Array.isArray(data.favorites) ? data.favorites : [];
    state.notes = data.notes && typeof data.notes === "object" ? data.notes : {};
    state.libraryOk = true;
    reindexRecords();
    renderCounts();
    renderRecent();
    recompute(false);
    syncDataset();
  }

  function noteBody(sci) {
    const note = state.notes[sci];
    if (!note) return "";
    if (typeof note === "string") return note;
    return note.body || "";
  }

  function showNote(text) {
    const node = document.getElementById("login-note");
    node.hidden = !text;
    node.textContent = text || "";
  }

  function clearToast() {
    window.clearTimeout(toastTimer);
    const node = document.getElementById("toast");
    if (!node) return;
    node.hidden = true;
    node.textContent = "";
  }

  function toast(text) {
    const node = document.getElementById("toast");
    window.clearTimeout(toastTimer);
    if (!text) {
      clearToast();
      return;
    }
    node.hidden = false;
    node.textContent = text;
    toastTimer = window.setTimeout(clearToast, TOAST_MS);
  }

  function renderSession() {
    const host = document.getElementById("session");
    host.replaceChildren();
    if (state.user) {
      host.append(
        el("span", { class: "who" }, [state.user.email]),
        el("button", { type: "button", id: "logout" }, ["退出"]),
        el("button", { type: "button", id: "copy-share", class: "text-btn" }, ["复制只读链接"])
      );
      if (state.shareActive) {
        host.append(el("button", { type: "button", id: "revoke-share", class: "text-btn" }, ["停用只读链接"]));
      }
      host.querySelector("#logout").addEventListener("click", logout);
      host.querySelector("#copy-share").addEventListener("click", copyShare);
      const revoke = host.querySelector("#revoke-share");
      if (revoke) revoke.addEventListener("click", revokeShare);
      return;
    }
    const form = el("form", { class: "login-form", id: "login-form" });
    const email = el("input", {
      type: "email",
      name: "email",
      required: "required",
      autocomplete: "email",
      inputmode: "email",
      value: state.loginEmail || "",
    });
    form.append(
      el("label", {}, ["邮箱", email]),
      el("button", { type: "submit" }, [state.codeSent ? "重发登录码" : "发送登录码"])
    );
    if (state.codeSent) {
      form.append(
        el("label", {}, ["登录码", el("input", {
          type: "text",
          name: "code",
          inputmode: "numeric",
          autocomplete: "one-time-code",
          maxlength: "6",
          pattern: "[0-9]{6}",
        })]),
        el("button", { type: "button", id: "verify-code" }, ["登录"])
      );
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const code = form.elements.code && form.elements.code.value.trim();
      if (state.codeSent && code) verifyCode(form);
      else sendCode(form);
    });
    const verify = form.querySelector("#verify-code");
    if (verify) verify.addEventListener("click", () => verifyCode(form));
    host.append(form);
  }

  async function sendCode(form) {
    state.loginEmail = form.elements.email.value.trim();
    showNote("正在发送登录码…");
    try {
      const data = await window.WBApi.post("/api/auth/request", { email: state.loginEmail });
      state.codeSent = true;
      renderSession();
      showNote((data && data.message) || "登录码已发出。");
      const code = document.querySelector('#login-form input[name="code"]');
      if (code) code.focus();
    } catch (err) {
      showNote(err.message || "没有发出登录码。");
    }
  }

  async function verifyCode(form) {
    const code = form.elements.code ? form.elements.code.value.trim() : "";
    showNote("正在登录…");
    try {
      const data = await window.WBApi.post("/api/auth/verify", { email: state.loginEmail, code: code });
      state.user = { email: data.email || state.loginEmail };
      state.codeSent = false;
      await refreshShareFlag();
      showNote("");
      renderSession();
      if (state.booted) refreshView();
    } catch (err) {
      showNote(err.message || "没有登录。");
    }
  }

  async function logout() {
    try { await window.WBApi.post("/api/auth/logout", {}); } catch (err) { /* cookie still cleared locally */ }
    state.user = null;
    state.shareActive = false;
    state.codeSent = false;
    showNote("");
    renderSession();
    if (state.booted) refreshView();
  }

  async function refreshShareFlag() {
    if (!state.user) {
      state.shareActive = false;
      return;
    }
    try {
      const data = await window.WBApi.get("/api/share");
      state.shareActive = !!(data && data.active);
    } catch (err) {
      state.shareActive = false;
    }
  }

  function shareUrl(token) {
    return location.origin + location.pathname + "#/share/" + token;
  }

  async function copyShare() {
    try {
      const data = await window.WBApi.post("/api/share", {});
      state.shareActive = true;
      renderSession();
      const url = shareUrl(data.token);
      try {
        await navigator.clipboard.writeText(url);
        toast("只读链接已复制。");
      } catch (err) {
        showNote(url);
        toast("只读链接已生成。");
      }
    } catch (err) {
      showNote(err.message || "没有生成只读链接。");
    }
  }

  async function revokeShare() {
    try {
      await window.WBApi.del("/api/share");
      state.shareActive = false;
      renderSession();
      toast("只读链接已停用。");
    } catch (err) {
      showNote(err.message || "没有停用。");
    }
  }

  function renderCounts() {
    const seenBtn = document.querySelector('#seen-filter button[data-seen="seen"]');
    const heardBtn = document.querySelector('#seen-filter button[data-seen="heard"]');
    const unseenBtn = document.querySelector('#seen-filter button[data-seen="unseen"]');
    if (!state.libraryOk) {
      document.getElementById("count-total").textContent = "—";
      document.getElementById("count-seen").textContent = "—";
      document.getElementById("count-heard").textContent = "—";
      document.getElementById("count-unseen").textContent = "—";
      if (seenBtn) seenBtn.textContent = "已发现";
      if (heardBtn) heardBtn.textContent = "仅听到";
      if (unseenBtn) unseenBtn.textContent = "未发现";
      return;
    }
    const counts = census();
    const scope = speciesInScope().length;
    document.getElementById("count-total").textContent = comma(scope);
    document.getElementById("count-seen").textContent = comma(counts.seen);
    document.getElementById("count-heard").textContent = comma(counts.heard);
    document.getElementById("count-unseen").textContent = comma(counts.unseen);
    if (seenBtn) seenBtn.textContent = "已发现 " + comma(counts.seen);
    if (heardBtn) heardBtn.textContent = "仅听到 " + comma(counts.heard);
    if (unseenBtn) unseenBtn.textContent = "未发现 " + comma(counts.unseen);
  }

  function renderRecent() {
    const host = document.getElementById("recent");
    const picks = window.WBRecords.recentSpecies(state.records, 5);
    host.replaceChildren();
    if (!picks.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.append(el("span", { class: "recent-label" }, ["最近记下"]));
    for (const rec of picks) {
      const sp = state.byName.get(rec.scientificName);
      const label = sp && sp.zh ? sp.zh : rec.loggedChinese || rec.scientificName;
      if (host.childNodes.length > 1) host.append(el("span", { class: "dotsep", "aria-hidden": "true" }, ["·"]));
      host.append(el("a", { href: "#/species/" + encodeURIComponent(rec.scientificName) }, [label]));
    }
  }

  function matches(sp, query) {
    const raw = query.trim();
    if (!raw) return true;
    if (sp._zh.includes(raw)) return true;
    const folded = foldLatin(raw);
    if (!folded) return false;
    if (sp._lat.includes(folded)) return true;
    const parts = folded.split(" ").filter(Boolean);
    return parts.length > 1 && parts.every((part) => sp._lat.includes(part) || sp._zh.includes(part));
  }

  function rowHeight() {
    const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row"));
    return Number.isFinite(n) ? n : 52;
  }

  function statusWord(status) {
    if (status === "seen") return "已发现";
    if (status === "heard") return "仅听到";
    return "未发现";
  }

  function renderRow(sp) {
    const status = window.WBRecords.statusForRecords(state.bySci.get(sp.sci));
    const zh = sp.zh || "（无中文名）";
    const row = el("a", {
      class: "sp" + (status === "seen" ? " is-seen" : status === "heard" ? " is-heard" : "") + (sp.missingZh ? " is-blank" : ""),
      href: "#/species/" + encodeURIComponent(sp.sci),
    }, [
      el("i", { class: "mark", "aria-hidden": "true" }),
      el("span", { class: "name" }, [
        el("span", { class: "zh" }, [zh]),
        el("span", { class: "la-sub", lang: "la" }, [sp.sci]),
      ]),
      el("span", { class: "en", lang: "en" }, [sp.en]),
      el("span", { class: "la", lang: "la" }, [sp.sci]),
      el("span", { class: "fam" }, [state.families[sp.family].zh]),
      el("span", { class: "status" }, [status === "seen" ? "已发现" : status === "heard" ? "仅听到" : ""]),
    ]);
    row.title = [sp.zh, sp.en, sp.sci, statusWord(status)].filter(Boolean).join(" · ");
    return row;
  }

  function paintRows(force) {
    const view = document.getElementById("index-view");
    const pad = document.getElementById("index-pad");
    const rows = document.getElementById("index-rows");
    const empty = document.getElementById("empty");
    const list = state.filtered;
    if (!list.length) {
      pad.hidden = true;
      empty.hidden = false;
      rows.replaceChildren();
      lastPaint = "empty" + state.filterGen;
      return;
    }
    pad.hidden = false;
    empty.hidden = true;
    const rowH = rowHeight();
    pad.style.height = list.length * rowH + "px";
    const header = document.getElementById("cols");
    const headerH = header && header.offsetParent !== null ? header.offsetHeight : 0;
    const viewH = view.clientHeight || 640;
    const start = Math.max(0, Math.floor((view.scrollTop - headerH) / rowH) - 6);
    const end = Math.min(list.length, Math.ceil((view.scrollTop - headerH + viewH) / rowH) + 8);
    const counts = state.libraryOk ? census() : { seen: 0, heard: 0 };
    const key = state.filterGen + ":" + start + ":" + end + ":" + rowH + ":" + counts.seen + ":" + counts.heard;
    if (!force && key === lastPaint) return;
    lastPaint = key;
    rows.style.transform = "translateY(" + start * rowH + "px)";
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(renderRow(list[i]));
    rows.replaceChildren(frag);
  }

  function recompute(resetScroll) {
    const filters = state.filters;
    const out = [];
    for (const sp of state.species) {
      if (filters.order !== "" && sp.order !== filters.order) continue;
      if (filters.family !== "" && sp.family !== filters.family) continue;
      if (filters.genus !== "" && sp.genus !== filters.genus) continue;
      if (filters.china && !sp.china) continue;
      const status = window.WBRecords.statusForRecords(state.bySci.get(sp.sci));
      if (filters.seen === "seen" && status !== "seen") continue;
      if (filters.seen === "heard" && status !== "heard") continue;
      if (filters.seen === "unseen" && status !== "unseen") continue;
      if (!matches(sp, filters.q)) continue;
      out.push(sp);
    }
    state.filtered = out;
    state.filterGen += 1;
    const view = document.getElementById("index-view");
    if (resetScroll && view) view.scrollTop = 0;
    document.getElementById("result-count").textContent = comma(out.length) + " 种 · " + state.tax;
    const active = filters.q || filters.order !== "" || filters.family !== "" || filters.genus !== "" || filters.seen !== "all" || filters.china;
    document.getElementById("clear").hidden = !active;
    renderCounts();
    paintRows(true);
  }

  function fillSelect(select, options, placeholder) {
    const current = select.value;
    select.replaceChildren();
    select.append(new Option(placeholder, ""));
    for (const option of options) select.append(new Option(option.label, option.value));
    if (options.some((option) => option.value === current)) select.value = current;
  }

  function rebuildFamilies() {
    const select = document.getElementById("family");
    const order = state.filters.order;
    select.disabled = order === "";
    const options = [];
    if (order !== "") {
      for (const family of state.families) {
        if (family.order === order) options.push({ value: String(family.i), label: family.zh + " " + family.la });
      }
    }
    fillSelect(select, options, order === "" ? "先选择目" : "全部科");
  }

  function rebuildGenera() {
    const select = document.getElementById("genus");
    const family = state.filters.family;
    select.disabled = family === "";
    const options = [];
    if (family !== "") {
      for (const genus of state.genera) {
        if (genus.family === family) options.push({ value: String(genus.i), label: genus.la });
      }
    }
    fillSelect(select, options, family === "" ? "先选择科" : "全部属");
  }

  function clearFilters() {
    state.filters = { q: "", order: "", family: "", genus: "", seen: "all", china: false };
    document.getElementById("q").value = "";
    document.getElementById("order").value = "";
    document.getElementById("china-only").checked = false;
    for (const button of document.querySelectorAll("#seen-filter button")) {
      button.setAttribute("aria-pressed", button.dataset.seen === "all" ? "true" : "false");
    }
    rebuildFamilies();
    rebuildGenera();
    recompute(true);
  }

  function bindFilters() {
    document.getElementById("order").addEventListener("change", (event) => {
      state.filters.order = numOrBlank(event.target.value);
      state.filters.family = "";
      state.filters.genus = "";
      rebuildFamilies();
      rebuildGenera();
      recompute(true);
    });
    document.getElementById("family").addEventListener("change", (event) => {
      state.filters.family = numOrBlank(event.target.value);
      state.filters.genus = "";
      rebuildGenera();
      recompute(true);
    });
    document.getElementById("genus").addEventListener("change", (event) => {
      state.filters.genus = numOrBlank(event.target.value);
      recompute(true);
    });
    let timer = 0;
    document.getElementById("q").addEventListener("input", (event) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        state.filters.q = event.target.value;
        recompute(true);
      }, 50);
    });
    document.getElementById("china-only").addEventListener("change", (event) => {
      state.filters.china = event.target.checked;
      recompute(true);
    });
    document.getElementById("seen-filter").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-seen]");
      if (!button) return;
      state.filters.seen = button.dataset.seen;
      for (const item of document.querySelectorAll("#seen-filter button")) {
        item.setAttribute("aria-pressed", item === button ? "true" : "false");
      }
      recompute(true);
    });
    document.getElementById("clear").addEventListener("click", clearFilters);
    const view = document.getElementById("index-view");
    let ticking = false;
    view.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        paintRows(false);
      });
    }, { passive: true });
    window.addEventListener("resize", () => {
      if (state.route.view === "index") paintRows(true);
    });
    document.addEventListener("keydown", (event) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && tag !== "BUTTON") {
        event.preventDefault();
        document.getElementById("q").focus();
      }
    });
  }

  function parseRoute() {
    let hash = location.hash || "#/";
    if (hash.charAt(0) === "#") hash = hash.slice(1);
    let path = hash || "/";
    try { path = decodeURIComponent(path); } catch (err) { /* keep raw */ }
    if (path === "/" || path === "") return { view: "index" };
    if (path === "/weekly") return { view: "weekly" };
    if (path === "/photos") return { view: "photos" };
    if (path.startsWith("/share/")) return { view: "share", token: path.slice("/share/".length).replace(/\/$/, "") };
    if (path.startsWith("/species/")) {
      return { view: "species", sci: path.slice("/species/".length).replace(/\/$/, "") };
    }
    return { view: "index" };
  }

  function setCurrent(id, on) {
    const node = document.getElementById(id);
    if (on) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }

  function renderRoute() {
    const prev = state.route;
    state.route = parseRoute();
    if (!(prev && prev.view === "species" && state.route.view === "species" && prev.sci === state.route.sci)) {
      state.editingId = null;
    }
    document.getElementById("view-index").hidden = state.route.view !== "index";
    document.getElementById("view-species").hidden = state.route.view !== "species";
    document.getElementById("view-photos").hidden = state.route.view !== "photos";
    document.getElementById("view-weekly").hidden = state.route.view !== "weekly";
    document.getElementById("view-share").hidden = state.route.view !== "share";
    setCurrent("nav-index", state.route.view === "index" || state.route.view === "species");
    setCurrent("nav-photos", state.route.view === "photos");
    setCurrent("nav-weekly", state.route.view === "weekly");
    if (state.route.view === "species") renderSpecies();
    else if (state.route.view === "weekly") renderWeekly();
    else if (state.route.view === "photos") renderPhotos();
    else if (state.route.view === "share") renderShare();
    else {
      document.title = "观鸟工作台";
      requestAnimationFrame(() => paintRows(true));
    }
  }

  function safePhoto(path) {
    return typeof path === "string" && /^photos\/[A-Za-z0-9._-]+$/.test(path);
  }

  function photoSrc(path) {
    return window.WBApi.root() + "/media/" + path;
  }

  function speciesLabel(sci, rec) {
    const sp = state.byName.get(sci);
    if (sp && sp.zh) return sp.zh;
    if (rec && rec.loggedChinese) return rec.loggedChinese;
    return sci;
  }

  function sexWord(rec) {
    if (!rec) return "";
    if (rec.sex === "female") return "雌鸟";
    if (rec.sex === "male") return "雄鸟";
    return "";
  }

  function speciesPhotos(sci) {
    const photos = [];
    for (const rec of recordsFor(sci)) {
      const list = (rec.photos || []).filter(safePhoto);
      list.forEach((path, index) => {
        const place = (rec.location && rec.location.place) || "";
        const zh = speciesLabel(sci, rec);
        const sex = sexWord(rec);
        const when = window.WBRecords.whenLine(rec);
        photos.push({
          path: path,
          src: photoSrc(path),
          alt: [zh, sex, place, when, "野外照片"].filter(Boolean).join("，"),
          caption: [when, sex, place].filter(Boolean).join(" · "),
          observationId: rec.id,
          sci: sci,
          zh: zh,
          date: dateOnly(rec),
          place: place,
          sex: sex,
          index: index,
          total: list.length,
        });
      });
    }
    return photos;
  }

  function renderRecordBody(rec) {
    const nodes = [];
    const place = rec.location && rec.location.place;
    if (place) nodes.push(el("p", { class: "place" }, [place]));
    nodes.push(el("p", { class: "when" }, [window.WBRecords.whenLine(rec)]));
    const phrase = window.WBRecords.phraseLine(rec);
    if (phrase) nodes.push(el("p", { class: "phrase" }, [phrase]));
    if (rec.openQuestion && rec.openQuestion.text) {
      const line = el("p", { class: "open-q" }, [rec.openQuestion.text]);
      if (rec.openQuestion.scientificName) {
        line.append("（");
        line.append(el("a", { href: "#/species/" + encodeURIComponent(rec.openQuestion.scientificName) }, [
          el("i", { lang: "la" }, [rec.openQuestion.scientificName]),
        ]));
        line.append("）");
      }
      line.append("。");
      nodes.push(line);
    }
    if (rec.notes) nodes.push(el("p", { class: "notes-body" }, [rec.notes]));
    if (rec.habitat) nodes.push(el("p", { class: "quiet" }, [rec.habitat]));
    if (rec.weatherLight) nodes.push(el("p", { class: "quiet" }, [rec.weatherLight]));
    return nodes;
  }

  function renderRecord(rec) {
    const block = el("article", { class: "record", id: rec.id });
    if (state.user && state.editingId === rec.id) {
      block.append(buildObservationForm({ mode: "edit", record: rec }));
      return block;
    }
    for (const node of renderRecordBody(rec)) block.append(node);
    if (state.user && state.route.view !== "share") {
      const zh = speciesLabel(rec.scientificName, rec);
      block.append(el("div", { class: "record-actions" }, [
        el("button", {
          type: "button",
          class: "quiet-btn",
          onclick: () => {
            state.editingId = rec.id;
            state.holdScroll = true;
            renderSpecies();
          },
        }, ["修改"]),
        el("button", {
          type: "button",
          class: "quiet-btn",
          "aria-label": "删除这条观察：" + zh + " " + dateOnly(rec),
          onclick: () => confirmDeleteRecord(rec),
        }, ["删除"]),
      ]));
    }
    return block;
  }

  function option(value, label, selected) {
    const node = el("option", { value: value }, [label]);
    if (selected) node.selected = true;
    return node;
  }

  function buildObservationForm(spec) {
    const rec = spec.record || {};
    const when = window.WBRecords.displayWhen(rec);
    const form = el("form", { class: "obs-form", autocomplete: "off" });
    form._remove = new Set();
    const detection = rec.detection === "heard" || rec.detection === "heard_only" ? "heard" : (rec.detection ? "seen" : "");
    form.append(
      el("label", {}, ["日期（必填）", el("input", { type: "date", name: "obs-date", required: "required", value: when.date || "" })]),
      el("label", {}, ["时间（可空）", el("input", { type: "time", name: "obs-time", step: "60", value: when.time || "" })]),
      el("label", {}, ["地点（必填）", el("input", { type: "text", name: "obs-place", required: "required", value: (rec.location && rec.location.place) || "" })]),
      el("label", {}, ["性别（可空）", el("select", { name: "obs-sex" }, [
        option("", "未记录", !rec.sex),
        option("female", "雌", rec.sex === "female"),
        option("male", "雄", rec.sex === "male"),
      ])]),
      el("label", {}, ["观察方式（必填）", el("select", { name: "obs-detection", required: "required" }, [
        option("", "请选择", !detection),
        option("seen", "看到", detection === "seen"),
        option("heard", "听到", detection === "heard"),
      ])]),
      el("label", { class: "check-line" }, [
        el("input", { type: "checkbox", name: "obs-suspicious", checked: !!rec.suspicious }),
        "可疑",
      ]),
      el("label", { class: "wide" }, ["备注（可空）", el("textarea", { name: "obs-notes" }, [rec.notes || ""])])
    );
    if (spec.mode === "edit") {
      const photos = el("div", { class: "edit-photos wide" });
      for (const path of (rec.photos || []).filter(safePhoto)) {
        const row = el("div", { class: "edit-photo" }, [
          el("img", { src: photoSrc(path), alt: "" }),
        ]);
        row.append(el("button", {
          type: "button",
          class: "quiet-btn",
          onclick: () => {
            form._remove.add(path);
            row.hidden = true;
          },
        }, ["移出这张"]));
        photos.append(row);
      }
      form.append(photos);
    }
    form.append(el("label", { class: "wide" }, [
      "野外照片（可空）",
      el("input", { type: "file", name: "obs-photos", accept: "image/*", multiple: "multiple" }),
      el("span", { class: "hint" }, ["先裁切，再压到长边 2000 像素以内，并写上 @SerinS。文件里已有 WBWM:@SerinS 的，不再裁切、不再重盖。按文件内容识别，不看扩展名。"]),
    ]));
    const status = el("p", { class: "form-status quiet" });
    const button = el("button", { type: "submit", class: "primary" }, ["保存"]);
    const actions = el("div", { class: "wide form-actions" }, [button, status]);
    if (spec.mode === "edit") {
      actions.append(el("button", {
        type: "button",
        class: "quiet-btn",
        onclick: () => {
          state.editingId = null;
          state.holdScroll = true;
          renderSpecies();
        },
      }, ["取消"]));
    }
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (spec.mode === "edit") saveEdit(form, rec, status, button);
      else saveObservation(form, status, button);
    });
    return form;
  }

  function collectFields(form) {
    const date = form.elements["obs-date"].value;
    let time = form.elements["obs-time"].value;
    if (/^\d{2}:\d{2}:\d{2}$/.test(time)) time = time.slice(0, 5);
    const place = form.elements["obs-place"].value.trim();
    const detection = form.elements["obs-detection"].value;
    const sex = form.elements["obs-sex"].value;
    const suspicious = !!form.elements["obs-suspicious"].checked;
    const notes = form.elements["obs-notes"].value.trim();
    if (!date) return { error: "请填写日期。" };
    if (!place) return { error: "请填写地点。" };
    if (detection !== "seen" && detection !== "heard") return { error: "请选择观察方式。" };
    if (time && !/^\d{2}:\d{2}$/.test(time)) return { error: "时间只记到分钟。" };
    return { date, time, place, detection, sex, suspicious, notes };
  }

  async function processNewPhotos(files, status) {
    const blobs = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > PHOTO_MAX) throw new Error("单张照片请小于 25MB。");
      status.textContent = "正在打开照片 " + (i + 1) + "/" + files.length + "…";
      const loaded = await window.WBMedia.loadOriented(file);
      if (loaded.skipped) {
        status.textContent = "第 " + (i + 1) + " 张已有站点水印，不再裁切。";
        blobs.push(window.WBMedia.packSkipped(loaded.raw).blob);
        continue;
      }
      status.textContent = "请裁切第 " + (i + 1) + " 张，共 " + files.length + " 张。";
      const cropped = await window.WBCrop.cropCanvas(loaded.canvas, "第 " + (i + 1) + " 张，共 " + files.length + " 张");
      if (!cropped) {
        const err = new Error("已取消，没有写入。");
        err.code = "cancel";
        throw err;
      }
      status.textContent = "正在处理照片 " + (i + 1) + "/" + files.length + "…";
      const prepared = await window.WBMedia.finish(cropped);
      blobs.push(prepared.blob);
    }
    return blobs;
  }

  function fieldsToForm(fields, blobs, extra) {
    const body = new FormData();
    if (extra && extra.scientificName) body.set("scientificName", extra.scientificName);
    body.set("date", fields.date);
    body.set("time", fields.time || "");
    body.set("place", fields.place);
    body.set("detection", fields.detection);
    body.set("sex", fields.sex || "");
    body.set("suspicious", fields.suspicious ? "1" : "0");
    body.set("notes", fields.notes || "");
    for (const path of (extra && extra.remove) || []) body.append("remove", path);
    for (const blob of blobs) body.append("photos", blob, "field.jpg");
    return body;
  }

  async function saveObservation(form, status, button) {
    const fields = collectFields(form);
    if (fields.error) {
      status.textContent = fields.error;
      return;
    }
    const sci = state.route.sci;
    if (!state.byName.has(sci)) {
      status.textContent = "名录里没有这个种。";
      return;
    }
    const files = Array.from(form.elements["obs-photos"].files || []);
    button.disabled = true;
    try {
      const blobs = await processNewPhotos(files, status);
      status.textContent = "正在写入";
      const data = await window.WBApi.form("/api/observations", "POST", fieldsToForm(fields, blobs, { scientificName: sci }));
      applyLibrary(data);
      state.editingId = null;
      toast("已保存。");
      renderSpecies();
    } catch (err) {
      status.textContent = err.message || "没有保存。";
      button.disabled = false;
    }
  }

  async function saveEdit(form, rec, status, button) {
    const fields = collectFields(form);
    if (fields.error) {
      status.textContent = fields.error;
      return;
    }
    const files = Array.from(form.elements["obs-photos"].files || []);
    button.disabled = true;
    try {
      const blobs = await processNewPhotos(files, status);
      status.textContent = "正在写入";
      const data = await window.WBApi.form(
        "/api/observations/" + encodeURIComponent(rec.id),
        "PATCH",
        fieldsToForm(fields, blobs, { remove: Array.from(form._remove) })
      );
      applyLibrary(data);
      state.editingId = null;
      toast("已保存。");
      state.holdScroll = true;
      renderSpecies();
    } catch (err) {
      status.textContent = err.message || "没有保存。";
      button.disabled = false;
    }
  }

  async function saveNotes(sci, text, status, button) {
    button.disabled = true;
    status.textContent = "正在写入";
    try {
      const data = await window.WBApi.put("/api/notes", { scientificName: sci, body: text });
      applyLibrary(data);
      toast("已保存。");
      state.holdScroll = true;
      renderSpecies();
    } catch (err) {
      status.textContent = err.message || "没有保存。";
      button.disabled = false;
    }
  }

  function syncDataset() {
    const counts = state.libraryOk ? census() : { seen: 0, heard: 0 };
    const root = document.documentElement;
    root.dataset.records = String(state.records.length);
    root.dataset.observed = String(counts.seen);
    root.dataset.heard = String(counts.heard);
  }

  function refreshView() {
    if (!state.booted) return;
    if (state.route.view === "species") renderSpecies();
    else if (state.route.view === "photos") renderPhotos();
    else if (state.route.view === "weekly") renderWeekly();
    else if (state.route.view === "share") renderShare();
    else requestAnimationFrame(() => paintRows(true));
  }

  function currentDoc() {
    return { records: state.records, favorites: state.favorites || [] };
  }

  function pencilIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "fav-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
    body.setAttribute("d", "M4 16.6 14.9 5.7a1.5 1.5 0 0 1 2.1 0l1.3 1.3a1.5 1.5 0 0 1 0 2.1L7.4 20H4v-3.4Z");
    body.setAttribute("fill", "none");
    body.setAttribute("stroke", "currentColor");
    body.setAttribute("stroke-width", "1.6");
    body.setAttribute("stroke-linejoin", "round");
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tip.setAttribute("d", "M13.2 7.3 16.7 10.8");
    tip.setAttribute("fill", "none");
    tip.setAttribute("stroke", "currentColor");
    tip.setAttribute("stroke-width", "1.6");
    svg.append(body, tip);
    return svg;
  }

  function favoriteButton(photo) {
    const on = window.WBRecords.isFavorite(currentDoc(), photo.observationId, photo.path);
    const button = el("button", {
      type: "button",
      class: "fav",
      "aria-pressed": on ? "true" : "false",
      "aria-label": on ? "取消收藏，从影像记录拿下" : "收藏这张照片，加入影像记录",
    });
    button.append(pencilIcon(), el("span", {}, [on ? "已收藏" : "收藏"]));
    button.addEventListener("click", () => toggleFavorite(photo, button));
    return button;
  }

  async function toggleFavorite(photo, button) {
    if (!state.user) {
      showNote("登录之后才能收藏。");
      return;
    }
    const turningOn = !window.WBRecords.isFavorite(currentDoc(), photo.observationId, photo.path);
    button.disabled = true;
    try {
      const data = await window.WBApi.post("/api/favorites", {
        observationId: photo.observationId,
        path: photo.path,
        on: turningOn,
      });
      applyLibrary(data);
      toast(turningOn ? "已收入影像记录。" : "已从影像记录拿下。");
      state.holdScroll = true;
      refreshView();
    } catch (err) {
      showNote(err.message || "没有保存。");
      button.disabled = false;
    }
  }

  let confirmBusyLock = false;

  function openConfirm(opts) {
    if (confirmBusyLock) return;
    const layer = document.getElementById("confirm-layer");
    const title = document.getElementById("confirm-title");
    const desc = document.getElementById("confirm-desc");
    const error = document.getElementById("confirm-error");
    const cancel = document.getElementById("confirm-cancel");
    const ok = document.getElementById("confirm-ok");
    const shell = document.querySelector(".shell");
    title.textContent = opts.title;
    desc.textContent = opts.description;
    error.hidden = true;
    error.textContent = "";
    ok.textContent = "删除";
    ok.disabled = false;
    cancel.disabled = false;
    let busy = false;
    const previous = document.activeElement;
    layer.hidden = false;
    if (shell) shell.setAttribute("inert", "");
    cancel.focus();

    function close() {
      document.removeEventListener("keydown", onKey);
      cancel.removeEventListener("click", onCancel);
      ok.removeEventListener("click", onOk);
      layer.removeEventListener("click", onBackdrop);
      layer.hidden = true;
      confirmBusyLock = false;
      if (shell) shell.removeAttribute("inert");
      if (previous && previous.focus && document.contains(previous)) previous.focus();
    }

    function onCancel() {
      if (busy) return;
      close();
    }

    async function onOk() {
      if (busy) return;
      busy = true;
      ok.disabled = true;
      cancel.disabled = true;
      ok.textContent = "正在写入";
      error.hidden = true;
      try {
        await opts.onConfirm();
        close();
      } catch (err) {
        busy = false;
        ok.disabled = false;
        cancel.disabled = false;
        ok.textContent = "删除";
        error.hidden = false;
        error.textContent = (err && err.message) || "没有保存。";
      }
    }

    function onBackdrop(event) {
      if (event.target === layer) onCancel();
    }

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = [cancel, ok].filter((node) => !node.disabled);
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    confirmBusyLock = true;
    cancel.addEventListener("click", onCancel);
    ok.addEventListener("click", onOk);
    layer.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  }

  function confirmDeleteRecord(rec) {
    const zh = speciesLabel(rec.scientificName, rec);
    const paths = (rec.photos || []).filter(safePhoto);
    let orphan = 0;
    let shared = 0;
    for (const path of paths) {
      const used = state.records.some((other) => other.id !== rec.id && (other.photos || []).indexOf(path) !== -1);
      if (used) shared += 1;
      else orphan += 1;
    }
    const fav = (state.favorites || []).some((item) => item && item.observationId === rec.id);
    const place = rec.location && rec.location.place;
    let description = "删除观察：" + zh + "（" + rec.scientificName + "）";
    const when = [window.WBRecords.whenLine(rec), place].filter(Boolean).join(" · ");
    if (when) description += " · " + when;
    description += "。这条观察会从记录里去掉。";
    if (!paths.length) description += "这条记录没有照片。";
    else if (orphan && !shared) description += "只属于这条记录的 " + orphan + " 张照片会一起删除。";
    else {
      if (orphan) description += "会删除只属于这条记录的 " + orphan + " 张照片。";
      if (shared) description += "还有 " + shared + " 张仍被其他记录用着，会留下。";
    }
    if (fav) description += "已收入影像记录的照片会离开影像记录。";
    const remaining = (state.bySci.get(rec.scientificName) || []).filter((item) => item.id !== rec.id);
    const next = window.WBRecords.statusForRecords(remaining);
    if (next === "unseen") description += "这是该物种的最后一条记录，观鸟名录里会回到未发现。";
    else if (next === "heard") description += "剩下的记录都是听到的，这个物种会变为仅听到，不再算已发现。";
    else description += "这个物种还有看到的记录，仍是已发现。";
    openConfirm({
      title: "删除这条观察？",
      description: description,
      onConfirm: async () => {
        const data = await window.WBApi.del("/api/observations/" + encodeURIComponent(rec.id));
        applyLibrary(data);
        toast("已删除这条观察。");
        state.holdScroll = true;
        refreshView();
      },
    });
  }

  function renderPlate(photos) {
    const figure = el("figure", { class: "plate" });
    const image = el("img", { id: "hero-img", alt: "" });
    const caption = el("figcaption", { id: "hero-cap" });
    const controls = el("div", { class: "photo-controls" });
    let thumbs = null;
    function show(index) {
      const photo = photos[index];
      image.src = photo.src;
      image.alt = photo.alt;
      caption.textContent = photo.caption;
      controls.replaceChildren();
      if (state.user) controls.append(favoriteButton(photo));
      if (thumbs) {
        thumbs.querySelectorAll("button").forEach((item, itemIndex) => {
          if (itemIndex === index) item.setAttribute("aria-current", "true");
          else item.removeAttribute("aria-current");
        });
      }
    }
    figure.append(image, caption);
    if (state.user) figure.append(controls);
    if (photos.length > 1) {
      thumbs = el("div", { class: "thumbs" });
      photos.forEach((photo, index) => {
        thumbs.append(el("button", {
          type: "button",
          "aria-label": "第 " + (index + 1) + " 张：" + photo.caption,
          onclick: () => show(index),
        }, [el("img", { src: photo.src, alt: "" })]));
      });
      figure.append(thumbs);
    }
    show(0);
    return figure;
  }

  function emptySketch() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "empty-sketch");
    svg.setAttribute("viewBox", "0 0 120 72");
    svg.setAttribute("aria-hidden", "true");
    const frame = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    frame.setAttribute("x", "8");
    frame.setAttribute("y", "8");
    frame.setAttribute("width", "104");
    frame.setAttribute("height", "56");
    frame.setAttribute("rx", "4");
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "#C4B59A");
    frame.setAttribute("stroke-width", "1.4");
    const sun = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    sun.setAttribute("cx", "86");
    sun.setAttribute("cy", "28");
    sun.setAttribute("r", "7");
    sun.setAttribute("fill", "none");
    sun.setAttribute("stroke", "#7A9B76");
    sun.setAttribute("stroke-width", "1.4");
    const hill = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hill.setAttribute("d", "M18 52 C 36 34, 52 48, 102 24");
    hill.setAttribute("fill", "none");
    hill.setAttribute("stroke", "#A8C4C4");
    hill.setAttribute("stroke-width", "1.4");
    hill.setAttribute("stroke-linecap", "round");
    svg.append(frame, sun, hill);
    return svg;
  }

  function renderPhotos() {
    document.title = "影像记录 · 观鸟工作台";
    const root = document.getElementById("view-photos");
    const keep = state.holdScroll ? root.scrollTop : 0;
    state.holdScroll = false;
    root.replaceChildren();
    root.append(el("h1", { class: "gallery-title" }, ["影像记录"]));
    const entries = window.WBRecords.galleryEntries(currentDoc()).filter((item) => safePhoto(item.path));
    if (!entries.length) {
      root.append(el("div", { class: "gallery-empty" }, [
        emptySketch(),
        el("p", {}, ["还没有收入影像记录的野外照片。"]),
        el("p", {}, ["这里按观察时间排列，新的在前。不登录也可以看。"]),
      ]));
      root.scrollTop = keep;
      return;
    }
    root.append(el("p", { class: "quiet" }, ["共 " + entries.length + " 张。"]));
    const grid = el("div", { class: "gallery" });
    for (const entry of entries) {
      const rec = entry.rec;
      const place = (rec.location && rec.location.place) || "";
      const zh = speciesLabel(rec.scientificName, rec);
      const sex = sexWord(rec);
      const when = window.WBRecords.whenLine(rec);
      const alt = [zh, sex, place, when, "野外照片"].filter(Boolean).join("，");
      grid.append(el("article", { class: "tile" }, [
        el("a", { class: "tile-link", href: "#/species/" + encodeURIComponent(rec.scientificName) }, [
          el("span", { class: "tile-frame" }, [el("img", { src: photoSrc(entry.path), alt: alt })]),
          el("span", { class: "tile-name" }, [zh]),
          el("span", { class: "tile-meta" }, [[when, sex, place].filter(Boolean).join(" · ")]),
        ]),
      ]));
    }
    root.append(grid);
    root.scrollTop = keep;
  }

  function renderSpecies() {
    const sci = state.route.sci;
    const sp = state.byName.get(sci);
    const root = document.getElementById("view-species");
    const keep = state.holdScroll ? root.scrollTop : 0;
    state.holdScroll = false;
    root.replaceChildren();
    root.append(el("a", { class: "back", href: "#/" }, ["← 返回观鸟名录"]));
    if (!sp) {
      document.title = "没有这种鸟 · 观鸟工作台";
      root.append(el("p", {}, ["名录里没有 " + sci + "。"]));
      root.scrollTop = 0;
      return;
    }
    const recs = recordsFor(sci);
    const status = window.WBRecords.statusForRecords(recs);
    document.title = (sp.zh || sp.sci) + " · 观鸟工作台";
    const zh = sp.zh || "（无中文名）";
    root.append(el("h2", { class: "sp-zh" + (status === "seen" ? " is-seen" : status === "heard" ? " is-heard" : "") }, [zh]));
    if (sp.missingZh) root.append(el("p", { class: "missing" }, ["名录未给出中文名，这里留空。"]));
    if (sp.en) root.append(el("p", { class: "sp-en", lang: "en" }, [sp.en]));
    root.append(el("p", { class: "binom" }, [
      el("i", { lang: "la" }, [sp.sci]),
      " ",
      el("span", { class: "au" }, [sp.authority]),
    ]));
    if (sp.syn.length) {
      const line = el("p", { class: "syn-line" }, ["曾用学名 "]);
      sp.syn.forEach((name, index) => {
        if (index) line.append("，");
        line.append(el("i", { lang: "la" }, [name]));
      });
      root.append(line);
    }
    const chips = el("ul", { class: "chips" });
    const chipClass = status === "seen" ? "chip seen" : status === "heard" ? "chip heard" : "chip";
    chips.append(el("li", { class: chipClass }, [statusWord(status)]));
    if (sp.china) chips.append(el("li", { class: "chip" }, ["中国可记录"]));
    root.append(chips);
    const family = state.families[sp.family];
    const order = state.orders[sp.order];
    const genus = state.genera[sp.genus];
    const familyName = el("span", {}, [family.zh + " " + family.la]);
    if (family.en) familyName.append(el("span", { class: "en-fam", lang: "en" }, [" · " + family.en]));
    root.append(el("dl", { class: "tax-dl" }, [
      el("dt", {}, ["目"]),
      el("dd", {}, [order.zh + " " + order.la]),
      el("dt", {}, ["科"]),
      el("dd", {}, [familyName]),
      el("dt", {}, ["属"]),
      el("dd", {}, [el("i", { class: "genus", lang: "la" }, [genus.la])]),
    ]));
    const card = state.morning.find((item) => item.scientificName === sci);
    if (card) {
      root.append(el("p", {}, [
        el("a", {
          class: "out",
          href: "https://serinshen.github.io/species-archive/#" + card.id,
          target: "_blank",
          rel: "noopener noreferrer",
        }, ["晨间物种卡 · " + card.zh]),
      ]));
    }
    const photos = speciesPhotos(sci);
    if (photos.length) root.append(renderPlate(photos));
    else {
      const heardOnly = recs.length > 0 && recs.every((rec) => window.WBRecords.isHeardOnly(rec));
      root.append(el("p", { class: "empty-plate" }, [
        heardOnly ? "听到的记录，没有照片。" : "还没有野外照片。",
      ]));
    }
    root.append(el("h3", { class: "section-title" }, ["观察"]));
    if (!recs.length) root.append(el("p", { class: "quiet" }, ["还没有观察记录。"]));
    for (const rec of recs) root.append(renderRecord(rec));

    root.append(el("h3", { class: "section-title" }, ["手记"]));
    const body = noteBody(sci);
    const saved = state.notes[sci];
    if (state.user) {
      const textarea = el("textarea", { class: "note", id: "note-text" }, [body]);
      const status = el("p", { class: "form-status quiet" }, []);
      const button = el("button", {
        type: "button",
        class: "primary",
        onclick: () => {
          if (textarea.value.replace(/\r\n/g, "\n") === body) {
            status.textContent = "手记没有改动。";
            return;
          }
          saveNotes(sci, textarea.value, status, button);
        },
      }, ["保存"]);
      root.append(textarea, el("div", { class: "note-actions" }, [button, status]));
      if (saved && saved.updated) root.append(el("p", { class: "quiet" }, ["上次保存 " + formatStamp(saved.updated)]));
    } else if (body) {
      root.append(el("div", { class: "note-paper" }, [body]));
    } else {
      root.append(el("p", { class: "quiet" }, ["还没有手记。"]));
    }

    root.append(el("h3", { class: "section-title" }, ["添加观察"]));
    if (!state.user) {
      root.append(el("p", { class: "quiet" }, ["登录之后可以添加和修改观察、上传野外照片、收藏，或删除记录。阅读不需要登录。"]));
    } else {
      root.append(buildObservationForm({ mode: "create" }));
    }
    root.scrollTop = keep;
  }

  async function renderShare() {
    const gen = ++shareGen;
    const token = state.route.token || "";
    document.title = "观察记录 · 观鸟工作台";
    const root = document.getElementById("view-share");
    root.replaceChildren(
      el("p", { class: "share-kicker" }, ["只读"]),
      el("h1", { class: "gallery-title" }, ["观察记录"]),
      el("p", { class: "quiet" }, ["可以看全部观察，不能修改、删除、收藏或上传。"])
    );
    if (!token) {
      root.append(el("p", {}, ["这个链接不可用。"]));
      return;
    }
    try {
      await window.WBApi.get("/api/share/" + encodeURIComponent(token));
    } catch (err) {
      if (gen !== shareGen) return;
      root.append(el("p", {}, ["这个链接不可用。"]));
      return;
    }
    if (gen !== shareGen) return;
    if (!state.libraryOk) {
      root.append(el("p", {}, ["观察记录没有载入。"]));
      return;
    }
    const list = state.records.slice().sort((a, b) => compareKey(sortKey(b), sortKey(a)));
    if (!list.length) root.append(el("p", { class: "quiet" }, ["还没有观察记录。"]));
    for (const rec of list) {
      const zh = speciesLabel(rec.scientificName, rec);
      const article = el("article", { class: "record share-record" });
      article.append(el("h2", { class: "share-name" }, [
        el("a", { href: "#/species/" + encodeURIComponent(rec.scientificName) }, [zh]),
      ]));
      article.append(el("p", { class: "binom" }, [el("i", { lang: "la" }, [rec.scientificName])]));
      for (const node of renderRecordBody(rec)) article.append(node);
      for (const path of (rec.photos || []).filter(safePhoto)) {
        article.append(el("img", {
          class: "share-photo",
          src: photoSrc(path),
          alt: [zh, window.WBRecords.whenLine(rec), "野外照片"].filter(Boolean).join("，"),
        }));
      }
      root.append(article);
    }
  }

  function renderWeekly() {
    document.title = "鸟况周报 · 观鸟工作台";
    const today = shanghaiDate();
    const root = document.getElementById("view-weekly");
    root.replaceChildren(
      el("h1", {}, ["鸟况周报"]),
      el("p", { class: "issue-kicker" }, ["第一期 · 尚未刊出"]),
      el("p", { class: "due" }, ["预定刊期 ", el("time", { datetime: FIRST_ISSUE }, [FIRST_ISSUE])])
    );
    let gap;
    if (today < FIRST_ISSUE) {
      gap = "今天是 " + today + "，距第一期还有 " + daysBetween(today, FIRST_ISSUE) + " 天。这段日子没有周报，这里不编造观察综述。";
    } else if (today === FIRST_ISSUE) {
      gap = "今天是预定的第一期刊期（" + FIRST_ISSUE + "），还没有这一期。";
    } else {
      gap = "第一期预定 " + FIRST_ISSUE + "，到今天（" + today + "）仍然没有刊出。这里不补写。";
    }
    root.append(el("p", { class: "gap" }, [gap]));
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  function consumeLoginQuery() {
    const params = new URLSearchParams(location.search);
    const loginState = params.get("login");
    if (!loginState) return;
    history.replaceState({}, "", location.pathname + location.hash);
    const messages = {
      expired: "登录链接已失效。请重新发送登录码。",
      invalid: "登录链接不可用。",
      closed: "现在不能登录。",
    };
    showNote(messages[loginState] || "没有登录。");
  }

  async function init() {
    renderSession();
    consumeLoginQuery();
    window.addEventListener("hashchange", () => {
      clearToast();
      showNote("");
      if (state.booted) renderRoute();
    });
    try {
      const [pack, china, morning, libraryResult, sessionResult] = await Promise.all([
        window.WBChecklist.loadPack("data/pack.b64"),
        getJson("data/china-recordable-sci.json"),
        getJson("data/morning-cards.json"),
        window.WBApi.get("/api/library").then((data) => ({ ok: true, data: data })).catch((err) => ({ ok: false, error: err })),
        window.WBApi.get("/api/session").catch(() => ({ signedIn: false })),
      ]);
      const names = Array.isArray(china.scientificNames) ? china.scientificNames : [];
      const chinaSet = new Set(names);
      for (const sp of pack.species) {
        sp.china = chinaSet.has(sp.sci);
        sp._zh = [sp.zh].concat(sp.aliasZh).filter(Boolean).join("\n");
        sp._lat = foldLatin([sp.en, sp.sci, sp.genusName].concat(sp.syn).join(" "));
      }
      state.tax = pack.tax || "";
      state.species = pack.species;
      state.orders = pack.orders;
      state.families = pack.families;
      state.genera = pack.genera;
      state.byName = new Map(pack.species.map((sp) => [sp.sci, sp]));
      state.morning = Array.isArray(morning) ? morning : [];
      if (libraryResult.ok) applyLibrary(libraryResult.data);
      else {
        state.records = [];
        state.favorites = [];
        state.notes = {};
        state.libraryOk = false;
        reindexRecords();
      }
      if (sessionResult && sessionResult.signedIn && sessionResult.email) {
        state.user = { email: sessionResult.email };
        await refreshShareFlag();
      }
      renderSession();
      document.getElementById("tax-label").textContent = state.tax;
      document.getElementById("count-china").textContent = comma(names.length);
      const problems = [];
      if (pack.n !== 11064 || pack.parsedN !== 11064) problems.push("物种数不是 11,064");
      if (pack.orders.length !== 44) problems.push("目的数量不是 44");
      if (pack.families.length !== 250) problems.push("科的数量不是 250");
      if (pack.genera.length !== 2355) problems.push("属的数量不是 2,355");
      if (pack.blankZh !== 23 || !pack.mzOk) problems.push("缺中文名的 23 种对不上");
      if (names.length !== 1491) problems.push("中国可记录不是 1,491");
      if (!libraryResult.ok) problems.push("观察记录没有载入。名录仍然可以检索。");
      const banner = document.getElementById("banner");
      if (problems.length) {
        banner.hidden = false;
        banner.textContent = problems.join("；") + "。";
      }
      const root = document.documentElement;
      root.dataset.ready = problems.length ? "0" : "1";
      root.dataset.n = String(pack.parsedN);
      root.dataset.tax = state.tax;
      root.dataset.orders = String(pack.orders.length);
      root.dataset.families = String(pack.families.length);
      root.dataset.genera = String(pack.genera.length);
      root.dataset.blank = String(pack.blankZh);
      root.dataset.mz = pack.mzOk ? "1" : "0";
      root.dataset.china = String(names.length);
      syncDataset();
      fillSelect(
        document.getElementById("order"),
        state.orders.map((order) => ({ value: String(order.i), label: order.zh + " " + order.la })),
        "全部目"
      );
      rebuildFamilies();
      rebuildGenera();
      bindFilters();
      renderRecent();
      recompute(true);
      state.booted = true;
      renderRoute();
      const sample = state.records.map((rec) => {
        const sp = state.byName.get(rec.scientificName);
        return (sp && sp.zh) || "";
      }).join("") + "观鸟工作台鸲鹛鹡鸰";
      Promise.all([
        document.fonts.load('600 20px "Noto Serif SC"', sample),
        document.fonts.load('400 44px "Noto Serif SC"', sample),
        document.fonts.load('400 36px "ZCOOL XiaoWei"', "观鸟工作台"),
        document.fonts.load('italic 18px "Source Serif 4"', "Phylloscopus inornatus"),
      ]).catch(() => {});
    } catch (err) {
      document.getElementById("result-count").textContent = "名录没有展开。";
      const banner = document.getElementById("banner");
      banner.hidden = false;
      banner.textContent = err && err.message ? err.message : "名录没有展开。";
      document.documentElement.dataset.ready = "0";
    }
  }

  window.WBApp = { foldLatin: foldLatin, safePhoto: safePhoto, speciesInScope: speciesInScope };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
