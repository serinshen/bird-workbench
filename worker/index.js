// One Worker: JSON API, photo bytes from R2, static files from the asset binding.
// Secrets (wrangler secret / .dev.vars only, never the repo):
//   SESSION_SECRET, ALLOWED_EMAIL, RESEND_API_KEY, RESEND_FROM
// An empty ALLOWED_EMAIL fails closed: the login form still renders, sign-in does not.

const SESSION_DAYS = 400;
const CODE_MINUTES = 15;
const MAX_PHOTO_BYTES = 7_000_000;
const MAX_PHOTOS = 12;
const MARKER = "WBWM:@SerinS";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(data, status, extra) {
  const headers = new Headers(extra || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function text(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  const len = Math.max(left.length, right.length);
  let out = left.length ^ right.length;
  for (let i = 0; i < len; i++) out |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return out === 0;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToHex(sig);
}

async function digest(secret, value) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret + "\n" + value));
  return bytesToHex(buf);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function cookieHeader(value, request, maxAge) {
  const parts = [`wb_session=${value}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (new URL(request.url).protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

function assertSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw fail(403, "来源不对。");
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") throw fail(403, "来源不对。");
}

function requireStore(env) {
  if (!env.DB || !env.PHOTOS) throw fail(500, "记录库还没有接上。");
}

function allowlist(env) {
  return String(env.ALLOWED_EMAIL || "")
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return "";
  return email;
}

function nowIso() {
  return new Date().toISOString();
}

function plusMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function plusDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function readJson(request, limit) {
  const textBody = await request.text();
  if (textBody.length > (limit || 200000)) throw fail(413, "内容太长。");
  try {
    return JSON.parse(textBody || "{}");
  } catch (err) {
    throw fail(400, "没有读懂提交的内容。");
  }
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function sessionFrom(request, env) {
  if (!env.SESSION_SECRET || !env.DB) return null;
  const raw = parseCookies(request.headers.get("Cookie"))["wb_session"];
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^[a-f0-9]{32,128}$/.test(id)) return null;
  const expected = await hmacHex(env.SESSION_SECRET, id);
  if (!timingSafeEqual(sig, expected)) return null;
  const row = await env.DB.prepare("SELECT id, email, expires_at FROM sessions WHERE id = ?").bind(id).first();
  if (!row || row.expires_at <= nowIso()) return null;
  return row;
}

async function requireUser(request, env) {
  const session = await sessionFrom(request, env);
  if (!session || !allowlist(env).includes(session.email)) throw fail(401, "请先登录。");
  return session;
}

async function createSession(env, email) {
  if (!env.SESSION_SECRET) throw fail(500, "登录还没有接上。");
  const id = randomHex(32);
  const sig = await hmacHex(env.SESSION_SECRET, id);
  const created = nowIso();
  await env.DB.prepare("INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
    id,
    email,
    created,
    plusDays(SESSION_DAYS)
  ).run();
  return `${id}.${sig}`;
}

function hasMarker(bytes) {
  const needle = new TextEncoder().encode(MARKER);
  if (bytes.length < needle.length) return false;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function isJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw fail(400, "时间请写成小时和分钟。");
  return `${match[1]}:${match[2]}`;
}

function composeDatetime(date, time) {
  if (!validDate(date)) throw fail(400, "请填写日期。");
  const clock = normalizeTime(time);
  return clock ? `${date}T${clock}` : date;
}

function validSci(value) {
  return /^[A-Z][A-Za-z-]{1,40} [a-z][a-z-]{1,40}$/.test(String(value || ""));
}

function validPhotoPath(value) {
  return typeof value === "string" && /^photos\/[A-Za-z0-9._-]+\.jpe?g$/.test(value);
}

function parseLocation(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (err) {
    return {};
  }
}

export function recordFrom(row, photos) {
  const location = parseLocation(row.location_json);
  if (row.place) location.place = row.place;
  const list = (photos || []).slice().sort((a, b) => a.sort_index - b.sort_index);
  const rec = {
    id: row.id,
    scientificName: row.scientific_name,
    datetime: row.datetime,
    timezone: row.timezone || "Asia/Shanghai",
    detection: row.detection,
    suspicious: row.suspicious === 1,
    location,
    photos: list.map((photo) => photo.path),
  };
  if (row.sex) rec.sex = row.sex;
  if (row.notes) rec.notes = row.notes;
  if (row.habitat) rec.habitat = row.habitat;
  if (row.weather_light) rec.weatherLight = row.weather_light;
  if (row.source_group) rec.sourceGroup = row.source_group;
  if (row.logged_chinese) rec.loggedChinese = row.logged_chinese;
  if (row.logged_english) rec.loggedEnglish = row.logged_english;
  if (row.open_question_json) {
    try { rec.openQuestion = JSON.parse(row.open_question_json); } catch (err) { /* keep the row */ }
  }
  if (row.uploaded_at) rec.uploadedAt = row.uploaded_at;
  const meta = {};
  for (const photo of list) {
    if (photo.watermark) meta[photo.path] = { processed: true, watermarked: true, watermark: photo.watermark };
  }
  if (Object.keys(meta).length) rec.photoMeta = meta;
  return rec;
}

async function library(env) {
  requireStore(env);
  const [observations, photos, favorites, notes] = await Promise.all([
    env.DB.prepare("SELECT * FROM observations").all(),
    env.DB.prepare("SELECT * FROM photos").all(),
    env.DB.prepare("SELECT * FROM favorites").all(),
    env.DB.prepare("SELECT * FROM notes").all(),
  ]);
  const grouped = new Map();
  for (const photo of photos.results || []) {
    if (!grouped.has(photo.observation_id)) grouped.set(photo.observation_id, []);
    grouped.get(photo.observation_id).push(photo);
  }
  const noteMap = {};
  for (const note of notes.results || []) {
    noteMap[note.scientific_name] = { body: note.body, updated: note.updated_at };
  }
  return {
    records: (observations.results || []).map((row) => recordFrom(row, grouped.get(row.id) || [])),
    favorites: (favorites.results || []).map((row) => ({
      path: row.path,
      observationId: row.observation_id,
      at: row.favorited_at,
    })),
    notes: noteMap,
  };
}

function readFields(form) {
  const date = String(form.get("date") || "").trim();
  const time = String(form.get("time") || "").trim();
  const place = String(form.get("place") || "").trim();
  const detection = String(form.get("detection") || "").trim();
  const sex = String(form.get("sex") || "").trim();
  const suspicious = String(form.get("suspicious") || "") === "1" || String(form.get("suspicious") || "") === "true";
  const notes = String(form.get("notes") || "").trim();
  if (!place || place.length > 200) throw fail(400, "请填写地点。");
  if (detection !== "seen" && detection !== "heard") throw fail(400, "请选择观察方式。");
  if (sex && sex !== "female" && sex !== "male") throw fail(400, "性别无法保存。");
  if (notes.length > 4000) throw fail(400, "备注太长。");
  return {
    datetime: composeDatetime(date, time),
    place,
    detection,
    sex: sex || null,
    suspicious: suspicious ? 1 : 0,
    notes: notes || null,
  };
}

async function photoBytes(file) {
  if (!file || typeof file.arrayBuffer !== "function" || !file.size) return null;
  if (file.size > MAX_PHOTO_BYTES) throw fail(400, "照片太大，没有保存。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isJpeg(bytes) || !hasMarker(bytes)) throw fail(400, "照片还没有写上站点水印，没有保存。");
  return bytes;
}

async function uniquePhotoPath(env, date, sci, reserved) {
  const slug = sci.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "") || "bird";
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = `photos/${date}-${slug}-${randomHex(3).slice(0, 4)}.jpg`;
    if (reserved && reserved.has(path)) continue;
    const row = await env.DB.prepare("SELECT path FROM photos WHERE path = ?").bind(path).first();
    if (!row) {
      if (reserved) reserved.add(path);
      return path;
    }
  }
  throw fail(500, "没有排开照片的文件名。");
}

async function loadObservation(env, id) {
  const row = await env.DB.prepare("SELECT * FROM observations WHERE id = ?").bind(id).first();
  if (!row) throw fail(404, "没有这条观察。");
  const photos = await env.DB.prepare("SELECT * FROM photos WHERE observation_id = ? ORDER BY sort_index").bind(id).all();
  return { row, photos: photos.results || [] };
}

async function handleSession(request, env) {
  const session = await sessionFrom(request, env);
  if (!session || !allowlist(env).includes(session.email)) return json({ signedIn: false });
  return json({ signedIn: true, email: session.email });
}

async function handleAuthRequest(request, env) {
  assertSameOrigin(request);
  requireStore(env);
  const body = await readJson(request, 4000);
  const email = normalizeEmail(body.email);
  if (!email) throw fail(400, "请填写邮箱。");
  if (!allowlist(env).includes(email)) throw fail(403, "现在不能登录。");
  if (!env.RESEND_API_KEY || !env.RESEND_FROM || !env.SESSION_SECRET) throw fail(500, "登录信还没有接上。");
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const ip = clientIp(request);
  const byEmail = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_challenges WHERE email = ? AND created_at > ?"
  ).bind(email, since).first();
  const byIp = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_challenges WHERE request_ip = ? AND created_at > ?"
  ).bind(ip, since).first();
  if ((byEmail && byEmail.n >= 5) || (byIp && byIp.n >= 20)) throw fail(429, "登录码发得太勤，请稍后再试。");
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const magic = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = randomHex(16);
  const created = nowIso();
  const expires = plusMinutes(CODE_MINUTES);
  await env.DB.prepare(
    "INSERT INTO login_challenges (id, email, code_hash, magic_hash, created_at, expires_at, attempts, request_ip) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
  ).bind(id, email, await digest(env.SESSION_SECRET, code), await digest(env.SESSION_SECRET, magic), created, expires, ip).run();
  const link = new URL("/api/auth/magic", request.url);
  link.searchParams.set("token", magic);
  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [email],
      subject: "观鸟工作台登录码",
      text: [
        "登录码：" + code,
        "",
        "也可以打开这个链接，十五分钟内、只能用一次：",
        link.toString(),
        "",
        "如果不是你在登录，忽略这封信即可。",
      ].join("\n"),
    }),
  });
  if (!sent.ok) {
    await env.DB.prepare("DELETE FROM login_challenges WHERE id = ?").bind(id).run();
    throw fail(502, "登录信没有发出。");
  }
  return json({ ok: true, message: "登录码已发出。十五分钟内有效。" });
}

async function openSession(env, request, email) {
  const token = await createSession(env, email);
  return { token, email };
}

async function handleVerify(request, env) {
  assertSameOrigin(request);
  requireStore(env);
  if (!env.SESSION_SECRET) throw fail(500, "登录还没有接上。");
  const body = await readJson(request, 4000);
  const email = normalizeEmail(body.email);
  const code = String(body.code || "").trim();
  if (!email || !/^\d{6}$/.test(code)) throw fail(400, "请填写登录码。");
  if (!allowlist(env).includes(email)) throw fail(403, "现在不能登录。");
  const row = await env.DB.prepare(
    "SELECT * FROM login_challenges WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
  ).bind(email, nowIso()).first();
  if (!row) throw fail(400, "登录码不对，或已经过期。");
  const actual = await digest(env.SESSION_SECRET, code);
  if (!timingSafeEqual(actual, row.code_hash)) {
    const attempts = Number(row.attempts || 0) + 1;
    if (attempts >= 5) {
      await env.DB.prepare("UPDATE login_challenges SET attempts = ?, used_at = ? WHERE id = ?").bind(attempts, nowIso(), row.id).run();
    } else {
      await env.DB.prepare("UPDATE login_challenges SET attempts = ? WHERE id = ?").bind(attempts, row.id).run();
    }
    throw fail(400, "登录码不对，或已经过期。");
  }
  await env.DB.prepare("UPDATE login_challenges SET used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  const opened = await openSession(env, request, email);
  return json({ ok: true, email: opened.email }, 200, {
    "Set-Cookie": cookieHeader(opened.token, request, SESSION_DAYS * 24 * 60 * 60),
  });
}

async function handleMagic(request, env) {
  requireStore(env);
  const token = new URL(request.url).searchParams.get("token") || "";
  const back = (reason) => Response.redirect(new URL("/?login=" + reason + "#/", request.url), 302);
  if (!env.SESSION_SECRET || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return back("invalid");
  const hash = await digest(env.SESSION_SECRET, token);
  const row = await env.DB.prepare(
    "SELECT * FROM login_challenges WHERE magic_hash = ? AND used_at IS NULL AND expires_at > ?"
  ).bind(hash, nowIso()).first();
  if (!row) return back("expired");
  if (!allowlist(env).includes(row.email)) return back("closed");
  await env.DB.prepare("UPDATE login_challenges SET used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  const opened = await openSession(env, request, row.email);
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL("/#/", request.url).toString(),
      "Set-Cookie": cookieHeader(opened.token, request, SESSION_DAYS * 24 * 60 * 60),
      "Cache-Control": "no-store",
    },
  });
}

async function handleLogout(request, env) {
  assertSameOrigin(request);
  const session = await sessionFrom(request, env);
  if (session && env.DB) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id).run();
  return json({ ok: true }, 200, { "Set-Cookie": cookieHeader("", request, 0) });
}

async function incomingPhotos(form) {
  const files = form.getAll("photos").filter((item) => item && typeof item.arrayBuffer === "function" && item.size);
  if (files.length > MAX_PHOTOS) throw fail(400, "一次照片太多。");
  const ready = [];
  for (const file of files) ready.push(await photoBytes(file));
  return ready.filter(Boolean);
}

async function handleCreate(request, env) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  const form = await request.formData();
  const sci = String(form.get("scientificName") || "").trim();
  if (!validSci(sci)) throw fail(400, "名录学名无法保存。");
  const fields = readFields(form);
  const photos = await incomingPhotos(form);
  const date = fields.datetime.slice(0, 10);
  const id = "obs-" + date + "-" + randomHex(3).slice(0, 4);
  const stamp = nowIso();
  const uploaded = [];
  const reserved = new Set();
  try {
    const paths = [];
    for (const bytes of photos) {
      const path = await uniquePhotoPath(env, date, sci, reserved);
      await env.PHOTOS.put(path, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      uploaded.push(path);
      paths.push({ path, bytes: bytes.length });
    }
    const statements = [
      env.DB.prepare(
        `INSERT INTO observations (
          id, scientific_name, datetime, timezone, detection, suspicious, sex, place,
          location_json, notes, legacy_json, uploaded_at, updated_at
        ) VALUES (?, ?, ?, 'Asia/Shanghai', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).bind(
        id,
        sci,
        fields.datetime,
        fields.detection,
        fields.suspicious,
        fields.sex,
        fields.place,
        JSON.stringify({ place: fields.place }),
        fields.notes,
        stamp,
        stamp
      ),
    ];
    paths.forEach((photo, index) => {
      statements.push(env.DB.prepare(
        "INSERT INTO photos (path, observation_id, sort_index, watermark, bytes) VALUES (?, ?, ?, ?, ?)"
      ).bind(photo.path, id, index, "@SerinS", photo.bytes));
    });
    await env.DB.batch(statements);
  } catch (err) {
    await Promise.all(uploaded.map((path) => env.PHOTOS.delete(path).catch(() => {})));
    throw err;
  }
  return json(await library(env));
}

async function handleUpdate(request, env, id) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  if (!/^obs-[A-Za-z0-9-]+$/.test(id)) throw fail(400, "没有这条观察。");
  const current = await loadObservation(env, id);
  const form = await request.formData();
  const fields = readFields(form);
  const remove = form.getAll("remove").map(String).filter(Boolean);
  const known = new Set(current.photos.map((photo) => photo.path));
  for (const path of remove) {
    if (!known.has(path)) throw fail(400, "这条观察里没有这张照片。");
  }
  const adding = await incomingPhotos(form);
  const kept = current.photos.filter((photo) => !remove.includes(photo.path));
  const date = fields.datetime.slice(0, 10);
  const stamp = nowIso();
  const uploaded = [];
  const reserved = new Set(current.photos.map((photo) => photo.path));
  try {
    const fresh = [];
    for (const bytes of adding) {
      const path = await uniquePhotoPath(env, date, current.row.scientific_name, reserved);
      await env.PHOTOS.put(path, bytes, { httpMetadata: { contentType: "image/jpeg" } });
      uploaded.push(path);
      fresh.push({ path, bytes: bytes.length });
    }
    const location = parseLocation(current.row.location_json);
    location.place = fields.place;
    const statements = [
      env.DB.prepare(
        `UPDATE observations SET datetime = ?, detection = ?, suspicious = ?, sex = ?, place = ?,
          location_json = ?, notes = ?, updated_at = ? WHERE id = ?`
      ).bind(
        fields.datetime,
        fields.detection,
        fields.suspicious,
        fields.sex,
        fields.place,
        JSON.stringify(location),
        fields.notes,
        stamp,
        id
      ),
    ];
    for (const path of remove) {
      statements.push(env.DB.prepare("DELETE FROM photos WHERE observation_id = ? AND path = ?").bind(id, path));
      statements.push(env.DB.prepare("DELETE FROM favorites WHERE observation_id = ? AND path = ?").bind(id, path));
    }
    fresh.forEach((photo, index) => {
      statements.push(env.DB.prepare(
        "INSERT INTO photos (path, observation_id, sort_index, watermark, bytes) VALUES (?, ?, ?, ?, ?)"
      ).bind(photo.path, id, kept.length + index, "@SerinS", photo.bytes));
    });
    kept.forEach((photo, index) => {
      statements.push(env.DB.prepare("UPDATE photos SET sort_index = ? WHERE path = ?").bind(index, photo.path));
    });
    await env.DB.batch(statements);
  } catch (err) {
    await Promise.all(uploaded.map((path) => env.PHOTOS.delete(path).catch(() => {})));
    throw err;
  }
  for (const path of remove) {
    const still = await env.DB.prepare("SELECT path FROM photos WHERE path = ?").bind(path).first();
    if (!still) {
      await env.DB.prepare("DELETE FROM favorites WHERE path = ?").bind(path).run();
      await env.PHOTOS.delete(path).catch(() => {});
    }
  }
  return json(await library(env));
}

async function handleDelete(request, env, id) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  if (!/^obs-[A-Za-z0-9-]+$/.test(id)) throw fail(400, "没有这条观察。");
  const current = await loadObservation(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM favorites WHERE observation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM photos WHERE observation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM observations WHERE id = ?").bind(id),
  ]);
  for (const photo of current.photos) {
    const still = await env.DB.prepare("SELECT path FROM photos WHERE path = ?").bind(photo.path).first();
    if (!still) {
      await env.DB.prepare("DELETE FROM favorites WHERE path = ?").bind(photo.path).run();
      await env.PHOTOS.delete(photo.path);
    }
  }
  return json(await library(env));
}

async function handleFavorite(request, env) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  const body = await readJson(request, 4000);
  const id = String(body.observationId || "");
  const path = String(body.path || "");
  if (!/^obs-[A-Za-z0-9-]+$/.test(id) || !validPhotoPath(path)) throw fail(400, "没有这张照片。");
  const photo = await env.DB.prepare("SELECT path FROM photos WHERE observation_id = ? AND path = ?").bind(id, path).first();
  if (!photo) throw fail(404, "这条观察里没有这张照片。");
  if (body.on) {
    await env.DB.prepare(
      "INSERT INTO favorites (observation_id, path, favorited_at) VALUES (?, ?, ?) ON CONFLICT(observation_id, path) DO NOTHING"
    ).bind(id, path, nowIso()).run();
  } else {
    await env.DB.prepare("DELETE FROM favorites WHERE observation_id = ? AND path = ?").bind(id, path).run();
  }
  return json(await library(env));
}

async function handleNotes(request, env) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  const body = await readJson(request, 200000);
  const sci = String(body.scientificName || "").trim();
  if (!validSci(sci)) throw fail(400, "名录学名无法保存。");
  const noteBody = String(body.body || "").replace(/\r\n/g, "\n");
  if (noteBody.length > 20000) throw fail(400, "手记太长。");
  if (!noteBody.trim()) {
    await env.DB.prepare("DELETE FROM notes WHERE scientific_name = ?").bind(sci).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO notes (scientific_name, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(scientific_name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at"
    ).bind(sci, noteBody, nowIso()).run();
  }
  return json(await library(env));
}

async function activeShare(env) {
  return env.DB.prepare("SELECT id, token, created_at FROM share_links WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").first();
}

async function handleShareCreate(request, env) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  let row = await activeShare(env);
  if (!row) {
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const id = randomHex(16);
    await env.DB.prepare("INSERT INTO share_links (id, token, created_at) VALUES (?, ?, ?)").bind(id, token, nowIso()).run();
    row = { id, token };
  }
  return json({ active: true, token: row.token });
}

async function handleShareRevoke(request, env) {
  assertSameOrigin(request);
  await requireUser(request, env);
  requireStore(env);
  await env.DB.prepare("UPDATE share_links SET revoked_at = ? WHERE revoked_at IS NULL").bind(nowIso()).run();
  return json({ active: false });
}

async function handleShareRead(request, env) {
  await requireUser(request, env);
  requireStore(env);
  const row = await activeShare(env);
  if (!row) return json({ active: false });
  return json({ active: true, token: row.token });
}

async function handleShareOpen(env, token) {
  requireStore(env);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw fail(404, "这个链接不可用。");
  const row = await env.DB.prepare("SELECT id FROM share_links WHERE token = ? AND revoked_at IS NULL").bind(token).first();
  if (!row) throw fail(404, "这个链接不可用。");
  return json({ ok: true });
}

async function handleMedia(env, path) {
  requireStore(env);
  if (!validPhotoPath(path)) return text("没有这张照片。", 404);
  const row = await env.DB.prepare("SELECT path FROM photos WHERE path = ?").bind(path).first();
  if (!row) return text("没有这张照片。", 404);
  const object = await env.PHOTOS.get(path);
  if (!object) return text("没有这张照片。", 404);
  const headers = new Headers();
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(object.body, { headers });
}

async function handleHealth(env) {
  return json({
    ok: true,
    store: !!(env.DB && env.PHOTOS),
    session: !!env.SESSION_SECRET,
    mail: !!(env.RESEND_API_KEY && env.RESEND_FROM),
    allowlist: allowlist(env).length > 0,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health" && request.method === "GET") return await handleHealth(env);
      if (url.pathname === "/api/session" && request.method === "GET") return await handleSession(request, env);
      if (url.pathname === "/api/auth/request" && request.method === "POST") return await handleAuthRequest(request, env);
      if (url.pathname === "/api/auth/verify" && request.method === "POST") return await handleVerify(request, env);
      if (url.pathname === "/api/auth/magic" && request.method === "GET") return await handleMagic(request, env);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return await handleLogout(request, env);
      if (url.pathname === "/api/library" && request.method === "GET") return json(await library(env));
      if (url.pathname === "/api/observations" && request.method === "POST") return await handleCreate(request, env);
      const observation = url.pathname.match(/^\/api\/observations\/([^/]+)$/);
      if (observation && request.method === "PATCH") return await handleUpdate(request, env, decodeURIComponent(observation[1]));
      if (observation && request.method === "DELETE") return await handleDelete(request, env, decodeURIComponent(observation[1]));
      if (url.pathname === "/api/favorites" && request.method === "POST") return await handleFavorite(request, env);
      if (url.pathname === "/api/notes" && request.method === "PUT") return await handleNotes(request, env);
      if (url.pathname === "/api/share" && request.method === "GET") return await handleShareRead(request, env);
      if (url.pathname === "/api/share" && request.method === "POST") return await handleShareCreate(request, env);
      if (url.pathname === "/api/share" && request.method === "DELETE") return await handleShareRevoke(request, env);
      const share = url.pathname.match(/^\/api\/share\/([^/]+)$/);
      if (share && request.method === "GET") return await handleShareOpen(env, decodeURIComponent(share[1]));
      if (url.pathname.startsWith("/media/") && request.method === "GET") {
        return await handleMedia(env, decodeURIComponent(url.pathname.slice("/media/".length)));
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      return json({ message: "没有这个接口。" }, 404);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const raw = String((err && err.message) || "");
      const missingTable = /no such table/i.test(raw);
      const message = status === 500
        ? (missingTable ? "记录库还没有建好。" : "没有完成。")
        : raw || "没有完成。";
      if (status === 500) console.error(err && err.stack ? err.stack : err);
      return json({ message }, status);
    }
  },
};
