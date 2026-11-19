// Checks the backup mapping and the list-status rules. No network, no secrets.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapDetection, mapRecord, mapSuspicious } from "./record-map.mjs";
import { recordFrom } from "../worker/index.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WBRecords = require(join(root, "js/records.js"));
const WBJpeg = require(join(root, "js/jpegmark.js"));

let failed = 0;
function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL " + message);
  }
}

const rawText = readFileSync(join(root, "data/observations.json"), "utf8");
const raw = JSON.parse(rawText);
const notes = JSON.parse(readFileSync(join(root, "data/notes.json"), "utf8"));
const mapped = raw.records.map(mapRecord);

assert(mapped.length === raw.records.length, "record count changed");
assert(Object.keys(notes).length === 0, "notes backup is not empty; migration must keep it");
assert("鸲".codePointAt(0) === 0x9e32, "鸲 code point");
assert("鹛".codePointAt(0) === 0x9e5b, "鹛 code point");
assert(rawText.includes("蓝额红尾鸲"), "backup is missing 蓝额红尾鸲");
assert(rawText.includes("红头穗鹛"), "backup is missing 红头穗鹛");
assert(!rawText.includes("蓝额红尾鸪"), "backup contains the wrong 鸪 character");
assert(!rawText.includes("红头穗鸳"), "backup contains the wrong 鸳 character");

const packBytes = Buffer.from(readFileSync(join(root, "data/pack.b64"), "utf8").replace(/\s+/g, ""), "base64");
const packText = gunzipSync(packBytes).toString("utf8");
assert(packText.includes("蓝额红尾鸲"), "checklist is missing 蓝额红尾鸲");
assert(packText.includes("红头穗鹛"), "checklist is missing 红头穗鹛");
assert(!packText.includes("蓝额红尾鸪"), "checklist contains the wrong 鸪 character");

assert(mapDetection("seen") === "seen", "seen");
assert(mapDetection("seen_heard") === "seen", "seen_heard must become 看到");
assert(mapDetection("heard_only") === "heard", "heard_only must become 听到");
assert(mapSuspicious({ tentative: true, confidence: "high" }) === true, "tentative true");
assert(mapSuspicious({ tentative: false, confidence: "medium-high" }) === false, "confidence must not imply 可疑");
assert(mapSuspicious({ confidence: "tentative" }) === false, "confidence string alone is not 可疑");

const suspiciousIds = mapped.filter((record) => record.suspicious).map((record) => record.id).sort();
assert(JSON.stringify(suspiciousIds) === JSON.stringify([
  "obs-2026-11-10-001",
  "obs-2026-11-11-007",
  "obs-2026-11-11-008",
]), "可疑 ids: " + suspiciousIds.join(", "));

for (const record of mapped) {
  const original = raw.records.find((item) => item.id === record.id);
  assert(record.suspicious === (original.tentative === true), "suspicious drift " + record.id);
  assert(record.detection === "seen" || record.detection === "heard", "detection " + record.id);
  assert(!("confidence" in record) || record.confidence == null, "public shape still has confidence " + record.id);
  const when = WBRecords.displayWhen(record);
  assert(when.time === "" || /^\d{2}:\d{2}$/.test(when.time), "time is not hour:minute " + record.id + " " + when.time);
  assert(!WBRecords.whenLine(record).includes("钟点未记"), "钟点未记 " + record.id);
  assert(!WBRecords.whenLine(record).includes("Asia/Shanghai"), "zone label " + record.id);
  assert(!WBRecords.phraseLine({ ...record }).includes("置信"), "置信 " + record.id);
  assert(!WBRecords.phraseLine(record).includes("看到+听到"), "看到+听到 " + record.id);
  assert(record.legacy.datetime === original.datetime, "legacy datetime dropped " + record.id);
  assert(record.legacy.confidence === original.confidence, "legacy confidence dropped " + record.id);
}

const dated = WBRecords.displayWhen({ datetime: "2026-11-11T14:37:06" });
assert(dated.date === "2026-11-11" && dated.time === "14:37", "seconds hidden");
const dateless = WBRecords.displayWhen({ datetime: "2026-11-11" });
assert(dateless.date === "2026-11-11" && dateless.time === "", "blank clock");
assert(WBRecords.phraseLine({ detection: "seen", suspicious: true, sex: "female" }) === "雌鸟 · 看到 · 可疑", "phrase");
assert(WBRecords.phraseLine({ detection: "heard", suspicious: true }) === "听到 · 可疑", "heard phrase");

const bySci = new Map();
for (const record of mapped) {
  if (!bySci.has(record.scientificName)) bySci.set(record.scientificName, []);
  bySci.get(record.scientificName).push(record);
}
const heardSpecies = [];
const seenSpecies = [];
for (const [sci, records] of bySci) {
  const status = WBRecords.statusForRecords(records);
  if (status === "heard") heardSpecies.push(sci);
  if (status === "seen") seenSpecies.push(sci);
}
assert(JSON.stringify(heardSpecies) === JSON.stringify(["Cyanoderma ruficeps"]), "仅听到 species " + heardSpecies.join(", "));
assert(seenSpecies.includes("Phoenicurus frontalis"), "蓝额红尾鸲 has a later 看到 record, so the species is 已发现");
assert(seenSpecies.includes("Struthio camelus"), "ostrich");
assert(seenSpecies.includes("Ploceus castaneiceps"), "Taveta weaver");
assert(seenSpecies.includes("Ploceus spekei"), "Speke weaver");
assert(WBRecords.statusForRecords(bySci.get("Phoenicurus frontalis").filter((record) => record.detection !== "seen")) === "heard", "deleting the last 看到 leaves 仅听到");
assert(WBRecords.statusForRecords([]) === "unseen", "no records is 未发现");
assert(WBRecords.statusForRecords([{ detection: "seen" }, { detection: "heard" }]) === "seen", "one 看到 is 已发现");

const frontalis = bySci.get("Phoenicurus frontalis");
assert(frontalis.some((record) => record.detection === "heard" && record.suspicious), "heard frontalis is 可疑");
assert(frontalis.some((record) => record.detection === "seen" && !record.suspicious), "later frontalis sighting is not 可疑");

const species = [
  { sci: "A" },
  { sci: "B" },
  { sci: "C" },
  { sci: "D" },
];
const sample = new Map([
  ["A", [{ detection: "seen" }]],
  ["B", [{ detection: "heard" }]],
  ["C", [{ detection: "seen" }, { detection: "heard" }]],
]);
const filtered = WBRecords.tally([species[0], species[1]], sample);
assert(filtered.seen === 1 && filtered.heard === 1 && filtered.unseen === 0, "filtered census");
const world = WBRecords.tally(species, sample);
assert(world.seen === 2 && world.heard === 1 && world.unseen === 1, "unfiltered census");

const recent = WBRecords.recentSpecies([
  { id: "old", scientificName: "A", datetime: "2026-11-18T10:00:00" },
  { id: "mid", scientificName: "B", datetime: "2026-11-18T09:00:00", uploadedAt: "2026-11-19T00:00:00.000Z" },
  { id: "dup", scientificName: "A", datetime: "2026-11-01", uploadedAt: "2026-11-19T03:00:00.000Z" },
  { id: "c", scientificName: "C", datetime: "2026-11-17" },
  { id: "d", scientificName: "D", datetime: "2026-11-16" },
  { id: "e", scientificName: "E", datetime: "2026-11-15" },
  { id: "f", scientificName: "F", datetime: "2026-11-14" },
], 5);
assert(recent.map((record) => record.scientificName).join(",") === "A,B,C,D,E", "recent five uploads " + recent.map((record) => record.id).join(","));

const favorites = raw.favorites.slice();
const gallery = WBRecords.galleryEntries({ records: mapped, favorites });
assert(gallery.length === favorites.length, "favorite dropped " + gallery.length + " vs " + favorites.length);
for (let i = 1; i < gallery.length; i++) {
  assert(gallery[i - 1].sort >= gallery[i].sort, "gallery not newest observation first");
}
const shuffled = favorites.map((item, index) => ({ ...item, at: "2000-01-01T00:00:0" + (index % 9) + ".000Z" }));
const again = WBRecords.galleryEntries({ records: mapped, favorites: shuffled });
assert(again.map((item) => item.path).join("|") === gallery.map((item) => item.path).join("|"), "gallery follows observation time, not favorite time");

const files = readdirSync(join(root, "photos"));
const referenced = new Set(mapped.flatMap((record) => record.photos));
assert(files.length === referenced.size, "photo file count");
for (const file of files) {
  const bytes = readFileSync(join(root, "photos", file));
  assert(WBJpeg.hasMarker(bytes), "missing WBWM marker " + file);
  assert(referenced.has("photos/" + file), "unreferenced " + file);
}

const d1Row = {
  id: "obs-test",
  scientific_name: "Phoenicurus frontalis",
  datetime: "2026-11-11",
  timezone: "Asia/Shanghai",
  detection: "heard",
  suspicious: 1,
  place: "石门子村（霍比特徒步线）",
  location_json: JSON.stringify({ place: "石门子村（霍比特徒步线）", province: "四川省" }),
  notes: "heard only",
  habitat: "霍比特徒步线途中听见",
  weather_light: "白天徒步途中（具体时段未记）",
  source_group: "雀形目 Passeriformes · 鹟科 Muscicapidae",
  logged_chinese: "蓝额红尾鸲",
  logged_english: "Blue-fronted Redstart",
  open_question_json: JSON.stringify({ text: "尚未完全排除", scientificName: "Phylloscopus proregulus" }),
  uploaded_at: null,
};
assert(!Object.prototype.hasOwnProperty.call(d1Row, "weatherLight"), "fixture is a D1 row, not a camelCase object");
const fromRow = recordFrom(d1Row, [
  { path: "photos/b.jpg", sort_index: 1, watermark: "@SerinS" },
  { path: "photos/a.jpg", sort_index: 0, watermark: "@SerinS" },
]);
assert(fromRow.weatherLight === "白天徒步途中（具体时段未记）", "weather_light must surface as weatherLight, got " + fromRow.weatherLight);
assert(fromRow.habitat === d1Row.habitat, "habitat");
assert(fromRow.sourceGroup === d1Row.source_group, "source_group");
assert(fromRow.loggedChinese === "蓝额红尾鸲" && "鸲".codePointAt(0) === 0x9e32, "logged_chinese");
assert(fromRow.loggedEnglish === d1Row.logged_english, "logged_english");
assert(fromRow.openQuestion && fromRow.openQuestion.scientificName === "Phylloscopus proregulus", "open_question_json");
assert(fromRow.scientificName === d1Row.scientific_name, "scientific_name");
assert(fromRow.location.province === "四川省" && fromRow.location.place === d1Row.place, "location_json");
assert(fromRow.photos.join(",") === "photos/a.jpg,photos/b.jpg", "sort_index");
assert(fromRow.suspicious === true, "suspicious flag");
assert(!fromRow.uploadedAt, "null uploaded_at stays unset");
assert(!recordFrom({ ...d1Row, weather_light: "" }).weatherLight, "blank weather_light stays hidden");

const uiFiles = ["index.html", "js/app.js", "js/api.js", "js/crop.js", "js/config.js", "css/site.css"];
const banned = ["钟点未记", "已观察", "仓库", "看到+听到", "看到或听到", "中文名空缺", "置信", "GitHub", "oauth", "Ov23li", "client_secret", "GITHUB_CLIENT"];
for (const file of uiFiles) {
  const text = readFileSync(join(root, file), "utf8");
  for (const word of banned) assert(!text.includes(word), file + " contains " + word);
}
assert(readFileSync(join(root, "js/config.js"), "utf8").includes('apiOrigin: ""'), "public config");
assert(!readFileSync(join(root, "worker/index.js"), "utf8").includes("Ov23li"), "worker still has the old client id");
assert(!existsSyncSafe(join(root, "oauth/worker.js")), "oauth worker should be gone");
assert(!existsSyncSafe(join(root, "js/github.js")), "github client should be gone");

function existsSyncSafe(path) {
  try {
    readFileSync(path);
    return true;
  } catch (err) {
    return false;
  }
}

console.log("records", mapped.length);
console.log("已发现", seenSpecies.length);
console.log("仅听到", heardSpecies.join(", ") || "(none)");
console.log("favorites", favorites.length);
console.log("photos", files.length);
console.log("suspicious", suspiciousIds.join(", "));
if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("ok");
