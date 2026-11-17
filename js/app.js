(function () {
  const FIRST_ISSUE = "2026-11-20";
  const PHOTO_MAX = 25 * 1024 * 1024;

  const state = {
    booted: false,
    localPhotos: new Map(),
    tax: "",
    species: [],
    orders: [],
    families: [],
    genera: [],
    byName: new Map(),
    records: [],
    bySci: new Map(),
    notes: {},
    morning: [],
    filtered: [],
    filterGen: 0,
    filters: { q: "", order: "", family: "", genus: "", seen: "all", china: false },
    token: null,
    user: null,
    route: { view: "index" },
    flash: null,
    heroPhotos: [],
  };

  let lastPaint = "";

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
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }

  function sortKey(rec) {
    const match = String(rec.datetime || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/);
    if (!match) return "9999-99-99T99:99:99" + (rec.id || "");
    // Date-only records sort after clock times on that day. The imported
    // heard-only notes say they were logged after earlier same-day records,
    // and no clock time was written down.
    return match[1] + "T" + (match[2] || "99:99:99") + (rec.id || "");
  }

  function compareKey(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function confidenceBits(rec) {
    if (rec.detection === "heard_only") {
      const bits = ["听到", "仅听见、未见"];
      if (rec.confidence === "high") bits.push("高");
      else if (rec.confidence === "medium-high") bits.push("中等偏高", "tentative");
      else bits.push("tentative");
      if (rec.independentlyVerified === false) bits.push("尚未独立核对");
      return bits;
    }
    const bits = [];
    if (rec.detection === "seen") bits.push("看到");
    if (rec.confidence === "medium-high") bits.push("中等偏高", "tentative");
    else if (rec.confidence === "high") bits.push("高");
    else if (rec.confidence === "tentative" || rec.confidence === "as-reported") bits.push("tentative");
    else if (rec.confidence) bits.push(rec.confidence);
    return bits;
  }

  function phraseLine(rec) {
    const bits = [];
    if (rec.sex === "female") bits.push("雌鸟");
    else if (rec.sex === "male") bits.push("雄鸟");
    bits.push.apply(bits, confidenceBits(rec));
    return bits.filter(Boolean).join(" · ");
  }

  function whenLine(rec) {
    const tz = rec.timezone || "Asia/Shanghai";
    const match = String(rec.datetime || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/);
    if (!match) return (rec.datetime || "") + " · " + tz;
    if (!match[2]) return match[1] + " · " + tz + " · 钟点未记";
    return match[1] + " " + match[2] + " · " + tz;
  }

  function dateOnly(rec) {
    const match = String(rec.datetime || "").match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }

  function recordsFor(sci) {
    return (state.bySci.get(sci) || []).slice().sort((a, b) => compareKey(sortKey(a), sortKey(b)));
  }

  function observedCount() {
    let n = 0;
    for (const sci of state.bySci.keys()) if (state.byName.has(sci)) n += 1;
    return n;
  }

  function reindexRecords() {
    state.bySci = new Map();
    for (const rec of state.records) {
      if (!rec || !rec.scientificName) continue;
      if (!state.bySci.has(rec.scientificName)) state.bySci.set(rec.scientificName, []);
      state.bySci.get(rec.scientificName).push(rec);
    }
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

  function renderSession() {
    const host = document.getElementById("session");
    host.replaceChildren();
    if (state.user) {
      host.append(
        el("span", { class: "who" }, [state.user.login]),
        el("button", { type: "button", id: "logout" }, ["退出"])
      );
    } else {
      host.append(el("button", { type: "button", id: "login" }, ["登录"]));
    }
  }

  function renderCounts() {
    const total = state.species.length;
    const seen = observedCount();
    document.getElementById("count-total").textContent = comma(total);
    document.getElementById("count-seen").textContent = comma(seen);
    document.getElementById("count-unseen").textContent = comma(total - seen);
    const seenBtn = document.querySelector('#seen-filter button[data-seen="seen"]');
    const unseenBtn = document.querySelector('#seen-filter button[data-seen="unseen"]');
    if (seenBtn) seenBtn.textContent = "已观察 " + comma(seen);
    if (unseenBtn) unseenBtn.textContent = "未发现 " + comma(total - seen);
  }

  function renderRecent() {
    const host = document.getElementById("recent");
    const recs = state.records.slice().sort((a, b) => compareKey(sortKey(b), sortKey(a)));
    const seen = new Set();
    host.replaceChildren();
    if (!recs.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.append(el("span", { class: "recent-label" }, ["最近记下"]));
    for (const rec of recs) {
      if (seen.has(rec.scientificName)) continue;
      if (seen.size >= 8) break;
      seen.add(rec.scientificName);
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

  function renderRow(sp) {
    const seen = (state.bySci.get(sp.sci) || []).length > 0;
    const zh = sp.zh || "（无中文名）";
    const row = el("a", {
      class: "sp" + (seen ? " is-seen" : "") + (sp.missingZh ? " is-blank" : ""),
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
      el("span", { class: "status" }, [seen ? "已观察" : ""]),
    ]);
    row.title = [sp.zh, sp.en, sp.sci].filter(Boolean).join(" · ");
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
    const key = state.filterGen + ":" + start + ":" + end + ":" + rowH + ":" + observedCount();
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
      const count = (state.bySci.get(sp.sci) || []).length;
      if (filters.seen === "seen" && count < 1) continue;
      if (filters.seen === "unseen" && count >= 1) continue;
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
      if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
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
    state.route = parseRoute();
    document.getElementById("view-index").hidden = state.route.view !== "index";
    document.getElementById("view-species").hidden = state.route.view !== "species";
    document.getElementById("view-weekly").hidden = state.route.view !== "weekly";
    setCurrent("nav-index", state.route.view !== "weekly");
    setCurrent("nav-weekly", state.route.view === "weekly");
    if (state.route.view === "species") renderSpecies();
    else if (state.route.view === "weekly") renderWeekly();
    else {
      document.title = "观鸟工作台";
      requestAnimationFrame(() => paintRows(true));
    }
  }

  function appendLinkified(parent, text) {
    const re = /https?:\/\/[^\s)]+/g;
    let last = 0;
    let match;
    const source = String(text || "");
    while ((match = re.exec(source))) {
      parent.append(source.slice(last, match.index));
      parent.append(el("a", { href: match[0], target: "_blank", rel: "noopener noreferrer" }, [match[0]]));
      last = match.index + match[0].length;
    }
    parent.append(source.slice(last));
  }

  function safePhoto(path) {
    return typeof path === "string" && /^photos\/[A-Za-z0-9._-]+$/.test(path);
  }

  function speciesPhotos(sci) {
    const photos = [];
    for (const rec of recordsFor(sci)) {
      for (const path of rec.photos || []) {
        if (!safePhoto(path)) continue;
        const place = (rec.location && rec.location.place) || "";
        const zh = (state.byName.get(sci) || {}).zh || rec.loggedChinese || sci;
        photos.push({
          src: state.localPhotos.get(path) || path,
          alt: [zh, place, dateOnly(rec), "野外照片"].filter(Boolean).join("，"),
          caption: [dateOnly(rec), place, "野外照片"].filter(Boolean).join(" · "),
        });
      }
    }
    return photos;
  }

  function renderRecord(rec) {
    const block = el("article", { class: "record", id: rec.id });
    block.append(el("p", { class: "when" }, [whenLine(rec)]));
    const place = rec.location && rec.location.place;
    if (place) block.append(el("p", {}, [place]));
    block.append(el("p", { class: "phrase" }, [phraseLine(rec)]));
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
      block.append(line);
    }
    if (rec.notes) block.append(el("p", { class: "notes-body" }, [rec.notes]));
    if (rec.habitat) block.append(el("p", { class: "quiet" }, [rec.habitat]));
    if (rec.weatherLight) block.append(el("p", { class: "quiet" }, [rec.weatherLight]));
    const photoCount = (rec.photos || []).filter(safePhoto).length;
    block.append(el("p", { class: "quiet" }, [
      photoCount ? "野外照片 " + photoCount + " 张，在上方。" : "没有照片。",
    ]));
    const loc = rec.location || {};
    const extra = [];
    if (loc.township || loc.county || loc.city || loc.province) {
      extra.push([loc.township, loc.county, loc.city, loc.province, loc.country].filter(Boolean).join(" · "));
    }
    if (loc.lat != null && loc.lon != null) extra.push(String(loc.lat) + ", " + String(loc.lon));
    if (loc.altitudeM != null) extra.push(String(loc.altitudeM) + " m");
    if (loc.gpsRaw) extra.push(loc.gpsRaw);
    if (rec.datetimeNote || loc.note || extra.length) {
      const details = el("details", {}, [el("summary", {}, ["地点与时间的原记"])]);
      const body = el("div", { class: "quiet" });
      if (rec.datetimeNote) body.append(el("p", {}, [rec.datetimeNote]));
      for (const line of extra) body.append(el("p", {}, [line]));
      if (loc.note) {
        const note = el("p", {});
        appendLinkified(note, loc.note);
        body.append(note);
      }
      details.append(body);
      block.append(details);
    }
    return block;
  }

  function utf8ToB64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      const slice = bytes.subarray(i, i + 0x8000);
      let part = "";
      for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j]);
      binary += part;
    }
    return btoa(binary);
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || "");
        const commaAt = value.indexOf(",");
        resolve(commaAt >= 0 ? value.slice(commaAt + 1) : value);
      };
      reader.onerror = () => reject(reader.error || new Error("没有读到照片"));
      reader.readAsDataURL(file);
    });
  }

  function photoPath(sci, date, file) {
    const slug = sci.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
    const rawExt = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
    const ext = rawExt || "jpg";
    const rand = Math.random().toString(36).slice(2, 6);
    return "photos/" + date + "-" + slug + "-" + rand + "." + ext;
  }

  function uniqueId(date) {
    const ids = new Set(state.records.map((rec) => rec.id));
    let id = "";
    do {
      id = "obs-" + date + "-" + Math.random().toString(36).slice(2, 6);
    } while (ids.has(id));
    return id;
  }

  async function saveNotes(sci, text, status, button) {
    button.disabled = true;
    status.textContent = "正在写入仓库…";
    try {
      const current = await window.WBGitHub.readText(state.token, "data/notes.json");
      const doc = current ? JSON.parse(current) : {};
      const body = text.replace(/\r\n/g, "\n");
      if (!body.trim()) delete doc[sci];
      else doc[sci] = { body: body, updated: new Date().toISOString() };
      const sp = state.byName.get(sci);
      const label = (sp && sp.zh) || sci;
      const message = body.trim() ? "手记：" + label : "清空手记：" + label;
      const commit = await window.WBGitHub.commitFiles(state.token, [{
        path: "data/notes.json",
        base64: utf8ToB64(JSON.stringify(doc, null, 2) + "\n"),
      }], message);
      state.notes = doc;
      state.flash = { text: "手记已写入仓库。", url: commit.url };
      renderSpecies();
    } catch (err) {
      status.textContent = err.message || "手记没有写进仓库。";
      button.disabled = false;
    }
  }

  async function saveObservation(form) {
    const status = form.querySelector(".form-status");
    const button = form.querySelector("button[type=submit]");
    const date = form.elements["obs-date"].value;
    const place = form.elements["obs-place"].value.trim();
    const detection = form.elements["obs-detection"].value;
    if (!date) {
      status.textContent = "请填写日期。";
      return;
    }
    if (!place) {
      status.textContent = "请填写地点。";
      return;
    }
    if (detection !== "seen" && detection !== "heard_only") {
      status.textContent = "请选择看到或听到。";
      return;
    }
    const files = Array.from(form.elements["obs-photos"].files || []);
    for (const file of files) {
      const named = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name);
      if (!/^image\//.test(file.type) && !named) {
        status.textContent = "只能上传图片。";
        return;
      }
      if (file.size > PHOTO_MAX) {
        status.textContent = "单张照片请小于 25MB。";
        return;
      }
    }
    button.disabled = true;
    try {
      const sci = state.route.sci;
      const uploads = [];
      const paths = [];
      for (let i = 0; i < files.length; i++) {
        status.textContent = "正在读取照片 " + (i + 1) + "/" + files.length + "…";
        const path = photoPath(sci, date, files[i]);
        paths.push(path);
        state.localPhotos.set(path, URL.createObjectURL(files[i]));
        uploads.push({ path: path, base64: await fileToBase64(files[i]) });
      }
      status.textContent = "正在读取仓库里的记录…";
      const current = await window.WBGitHub.readText(state.token, "data/observations.json");
      const doc = current ? JSON.parse(current) : { records: [] };
      if (!Array.isArray(doc.records)) doc.records = [];
      const time = form.elements["obs-time"].value;
      const confidence = form.elements["obs-confidence"].value;
      const sex = form.elements["obs-sex"].value;
      const notes = form.elements["obs-notes"].value.trim();
      const rec = {
        id: uniqueId(date),
        scientificName: sci,
        datetime: time ? date + "T" + (time.length === 5 ? time + ":00" : time) : date,
        timezone: "Asia/Shanghai",
        detection: detection,
        confidence: confidence,
        tentative: confidence !== "high" || detection === "heard_only",
        location: { place: place },
        photos: paths,
      };
      if (!time) rec.datetimeNote = "钟点未记";
      if (sex) rec.sex = sex;
      if (notes) rec.notes = notes;
      doc.records.push(rec);
      uploads.push({
        path: "data/observations.json",
        base64: utf8ToB64(JSON.stringify(doc, null, 2) + "\n"),
      });
      const sp = state.byName.get(sci);
      const label = (sp && sp.zh) || sci;
      status.textContent = "正在写入仓库…";
      const commit = await window.WBGitHub.commitFiles(
        state.token,
        uploads,
        "记录观察：" + label + " · " + date
      );
      state.records = doc.records;
      reindexRecords();
      renderCounts();
      renderRecent();
      recompute(false);
      state.flash = { text: "这条观察已写入仓库。", url: commit.url };
      renderSpecies();
    } catch (err) {
      status.textContent = err.message || "没有写进仓库。";
      button.disabled = false;
    }
  }

  function renderSpecies() {
    const sci = state.route.sci;
    const sp = state.byName.get(sci);
    const root = document.getElementById("view-species");
    root.replaceChildren();
    root.append(el("a", { class: "back", href: "#/" }, ["← 返回名录"]));
    if (state.flash) {
      const flash = el("p", { class: "flash" }, [state.flash.text + " "]);
      if (state.flash.url) flash.append(el("a", { href: state.flash.url, target: "_blank", rel: "noopener noreferrer" }, ["查看这次提交"]));
      root.append(flash);
      state.flash = null;
    }
    if (!sp) {
      document.title = "没有这种鸟 · 观鸟工作台";
      root.append(el("p", {}, ["名录里没有 " + sci + "。"]));
      return;
    }
    const recs = recordsFor(sci);
    const seen = recs.length > 0;
    document.title = (sp.zh || sp.sci) + " · 观鸟工作台";
    const zh = sp.zh || "（无中文名）";
    root.append(el("h2", { class: "sp-zh" + (seen ? " is-seen" : "") }, [zh]));
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
    chips.append(el("li", { class: seen ? "chip seen" : "chip" }, [seen ? "已观察" : "未发现"]));
    if (sp.china) chips.append(el("li", { class: "chip" }, ["中国可记录"]));
    if (sp.missingZh) chips.append(el("li", { class: "chip" }, ["中文名空缺"]));
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
    state.heroPhotos = photos;
    if (photos.length) {
      const figure = el("figure", { class: "plate" });
      const image = el("img", { id: "hero-img", src: photos[0].src, alt: photos[0].alt });
      const caption = el("figcaption", { id: "hero-cap" }, [photos[0].caption]);
      figure.append(image, caption);
      if (photos.length > 1) {
        const thumbs = el("div", { class: "thumbs" });
        photos.forEach((photo, index) => {
          const button = el("button", {
            type: "button",
            "aria-label": "第 " + (index + 1) + " 张",
            onclick: () => {
              image.src = photo.src;
              image.alt = photo.alt;
              caption.textContent = photo.caption;
              thumbs.querySelectorAll("button").forEach((item, itemIndex) => {
                if (itemIndex === index) item.setAttribute("aria-current", "true");
                else item.removeAttribute("aria-current");
              });
            },
          }, [el("img", { src: photo.src, alt: "" })]);
          if (index === 0) button.setAttribute("aria-current", "true");
          thumbs.append(button);
        });
        figure.append(thumbs);
      }
      root.append(figure);
    } else {
      const heardOnly = recs.length > 0 && recs.every((rec) => rec.detection === "heard_only");
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
      }, ["写入仓库"]);
      root.append(textarea, el("div", { class: "note-actions" }, [button, status]));
      if (saved && saved.updated) {
        root.append(el("p", { class: "quiet" }, ["上次写入 " + formatStamp(saved.updated) + "（Asia/Shanghai）"]));
      }
    } else if (body) {
      root.append(el("div", { class: "note-paper" }, [body]));
    } else {
      root.append(el("p", { class: "quiet" }, ["还没有手记。"]));
    }

    root.append(el("h3", { class: "section-title" }, ["添加观察"]));
    if (!state.user) {
      root.append(el("p", { class: "quiet" }, ["登录自己的 GitHub 账号之后，可以在这里添加观察、上传野外照片。记录会写进这个仓库。"]));
    } else {
      if (state.user.login !== window.WORKBENCH_CONFIG.owner) {
        root.append(el("p", { class: "quiet" }, [
          "当前登录的是 " + state.user.login + "。写入需要这个账号能推送 " + window.WORKBENCH_CONFIG.owner + "/" + window.WORKBENCH_CONFIG.repo + "。",
        ]));
      }
      const form = el("form", { class: "obs-form", autocomplete: "off" });
      form.append(
        el("label", {}, ["日期", el("input", { type: "date", name: "obs-date", required: "required" })]),
        el("label", {}, ["时间（可空，Asia/Shanghai）", el("input", { type: "time", name: "obs-time", step: "1" })]),
        el("label", {}, ["地点", el("input", { type: "text", name: "obs-place", required: "required" })]),
        el("label", {}, ["性别", el("select", { name: "obs-sex" }, [
          el("option", { value: "" }, ["未记录"]),
          el("option", { value: "female" }, ["雌"]),
          el("option", { value: "male" }, ["雄"]),
        ])]),
        el("label", {}, ["看到或听到", el("select", { name: "obs-detection" }, [
          el("option", { value: "seen" }, ["看到"]),
          el("option", { value: "heard_only" }, ["听到"]),
        ])]),
        el("label", {}, ["置信", el("select", { name: "obs-confidence" }, [
          el("option", { value: "high" }, ["高"]),
          el("option", { value: "medium-high" }, ["中等偏高"]),
          el("option", { value: "tentative" }, ["tentative"]),
        ])]),
        el("label", { class: "wide" }, ["备注", el("textarea", { name: "obs-notes" })]),
        el("label", { class: "wide" }, [
          "照片",
          el("input", { type: "file", name: "obs-photos", accept: "image/*", multiple: "multiple" }),
          el("span", { class: "hint" }, ["只上传你自己拍的。不要用图库、维基或生成的图。"]),
        ])
      );
      const status = el("p", { class: "form-status quiet" });
      form.append(el("div", { class: "wide form-actions" }, [
        el("button", { type: "submit", class: "primary" }, ["记下这条观察"]),
        status,
      ]));
      form.elements["obs-detection"].addEventListener("change", () => {
        const confidence = form.elements["obs-confidence"];
        if (form.elements["obs-detection"].value === "heard_only" && confidence.value === "high") {
          confidence.value = "tentative";
        }
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        saveObservation(form);
      });
      root.append(form);
    }
    root.scrollTop = 0;
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

  function base64url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function pkcePair() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const verifier = base64url(bytes);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier: verifier, challenge: base64url(new Uint8Array(digest)) };
  }

  function exchangeUrl(kind) {
    const base = String(window.WORKBENCH_CONFIG.tokenExchangeUrl || "").replace(/\/$/, "");
    return base + (kind === "refresh" ? "/refresh" : "/exchange");
  }

  async function login() {
    const config = window.WORKBENCH_CONFIG;
    if (!config.oauthClientId) {
      showNote("还不能登录。这个站点还没有接上 GitHub 登录，所以不会假装已经登录。");
      return;
    }
    const pair = await pkcePair();
    const oauthState = base64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem("wb_verifier", pair.verifier);
    sessionStorage.setItem("wb_state", oauthState);
    const params = new URLSearchParams({
      client_id: config.oauthClientId,
      redirect_uri: config.redirectUri,
      scope: config.scope || "public_repo",
      state: oauthState,
      code_challenge: pair.challenge,
      code_challenge_method: "S256",
      login: config.owner || "serinshen",
    });
    location.assign("https://github.com/login/oauth/authorize?" + params.toString());
  }

  function logout() {
    sessionStorage.removeItem("wb_token");
    sessionStorage.removeItem("wb_refresh");
    state.token = null;
    state.user = null;
    showNote("");
    renderSession();
    if (state.booted && state.route.view === "species") renderSpecies();
  }

  async function tryRefresh() {
    const refresh = sessionStorage.getItem("wb_refresh");
    const config = window.WORKBENCH_CONFIG;
    if (!refresh || !config.tokenExchangeUrl) return false;
    const res = await fetch(exchangeUrl("refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) return false;
    sessionStorage.setItem("wb_token", data.access_token);
    if (data.refresh_token) sessionStorage.setItem("wb_refresh", data.refresh_token);
    return true;
  }

  async function loadUser(token, allowRefresh) {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (res.status === 401 && allowRefresh && await tryRefresh()) {
      return loadUser(sessionStorage.getItem("wb_token"), false);
    }
    if (!res.ok) {
      sessionStorage.removeItem("wb_token");
      state.token = null;
      state.user = null;
      renderSession();
      if (res.status === 401) showNote("登录已失效。没有保持登录。");
      return;
    }
    state.token = token;
    state.user = await res.json();
    showNote("");
    renderSession();
    if (state.booted && state.route.view === "species") renderSpecies();
  }

  async function consumeOAuthRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const returned = params.get("state");
    const error = params.get("error");
    if (!code && !error) return;
    history.replaceState({}, "", location.pathname + location.hash);
    if (error) {
      showNote("GitHub 没有完成授权（" + error + "）。没有登录。");
      return;
    }
    const expected = sessionStorage.getItem("wb_state");
    const verifier = sessionStorage.getItem("wb_verifier");
    sessionStorage.removeItem("wb_state");
    sessionStorage.removeItem("wb_verifier");
    if (!returned || returned !== expected || !verifier) {
      showNote("登录校验没有对上，已中止。没有登录。");
      return;
    }
    if (!window.WORKBENCH_CONFIG.tokenExchangeUrl) {
      showNote("GitHub 退回了授权码，但令牌交换地址还是空的，所以没有登录。");
      return;
    }
    showNote("正在换取 GitHub 身份…");
    try {
      const res = await fetch(exchangeUrl("exchange"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: code,
          redirect_uri: window.WORKBENCH_CONFIG.redirectUri,
          code_verifier: verifier,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) {
        const why = data.error_description || data.error || "";
        showNote("没有换成访问令牌。" + (why ? " " + why : "") + " 没有登录。");
        return;
      }
      sessionStorage.setItem("wb_token", data.access_token);
      if (data.refresh_token) sessionStorage.setItem("wb_refresh", data.refresh_token);
      await loadUser(data.access_token, false);
    } catch (err) {
      showNote("令牌交换没有完成。没有登录。");
    }
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  async function init() {
    renderSession();
    document.getElementById("session").addEventListener("click", (event) => {
      if (event.target.id === "login") login();
      if (event.target.id === "logout") logout();
    });
    window.addEventListener("hashchange", () => {
      if (state.booted) renderRoute();
    });
    await consumeOAuthRedirect();
    try {
      const [pack, china, observations, notes, morning] = await Promise.all([
        window.WBChecklist.loadPack("data/pack.b64"),
        getJson("data/china-recordable-sci.json"),
        getJson("data/observations.json"),
        getJson("data/notes.json"),
        getJson("data/morning-cards.json"),
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
      state.records = Array.isArray(observations.records) ? observations.records : [];
      state.notes = notes && typeof notes === "object" ? notes : {};
      state.morning = Array.isArray(morning) ? morning : [];
      reindexRecords();
      document.getElementById("tax-label").textContent = state.tax;
      document.getElementById("count-china").textContent = comma(names.length);
      document.getElementById("count-blank").textContent = comma(pack.blankZh);
      const problems = [];
      if (pack.n !== 11064 || pack.parsedN !== 11064) problems.push("物种数不是 11,064");
      if (pack.orders.length !== 44) problems.push("目的数量不是 44");
      if (pack.families.length !== 250) problems.push("科的数量不是 250");
      if (pack.genera.length !== 2355) problems.push("属的数量不是 2,355");
      if (pack.blankZh !== 23 || !pack.mzOk) problems.push("缺中文名的 23 种对不上");
      if (names.length !== 1491) problems.push("中国可记录不是 1,491");
      const banner = document.getElementById("banner");
      if (problems.length) {
        banner.hidden = false;
        banner.textContent = "名录校验没有通过：" + problems.join("；") + "。";
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
      root.dataset.records = String(state.records.length);
      root.dataset.observed = String(observedCount());
      fillSelect(
        document.getElementById("order"),
        state.orders.map((order) => ({ value: String(order.i), label: order.zh + " " + order.la })),
        "全部目"
      );
      rebuildFamilies();
      rebuildGenera();
      bindFilters();
      renderCounts();
      renderRecent();
      recompute(true);
      const token = sessionStorage.getItem("wb_token");
      if (token && !state.user) await loadUser(token, true);
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

  window.WBApp = { confidenceBits, phraseLine, sortKey, foldLatin, safePhoto };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
