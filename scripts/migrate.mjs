// One-shot copy of the git backup into D1 and R2.
// Does not rewrite photos. Requires wrangler auth for --remote.
//
//   node scripts/migrate.mjs
//   node scripts/migrate.mjs --local
//   node scripts/migrate.mjs --remote
//   node scripts/migrate.mjs --local --replace

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapRecord } from "./record-map.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const remote = args.has("--remote");
const replace = args.has("--replace");

if (local && remote) {
  console.error("Choose either --local or --remote.");
  process.exit(1);
}

function sqlString(value) {
  if (value == null) return "NULL";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function load() {
  const observations = JSON.parse(readFileSync(join(root, "data/observations.json"), "utf8"));
  const notes = JSON.parse(readFileSync(join(root, "data/notes.json"), "utf8"));
  const records = (observations.records || []).map(mapRecord);
  const favorites = Array.isArray(observations.favorites) ? observations.favorites : [];
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const fav of favorites) {
    const record = byId.get(fav.observationId);
    if (!record || !record.photos.includes(fav.path)) {
      throw new Error("收藏对不上记录：" + (fav && fav.path));
    }
  }
  const photoPaths = new Set();
  for (const record of records) {
    if (!record.place) throw new Error("缺少地点：" + record.id);
    for (const path of record.photos) {
      photoPaths.add(path);
      if (!existsSync(join(root, path))) throw new Error("缺少照片文件：" + path);
    }
  }
  return { records, favorites, notes, photoPaths };
}

function seedSql(bundle) {
  const lines = ["BEGIN TRANSACTION;", "DELETE FROM favorites;", "DELETE FROM photos;", "DELETE FROM notes;", "DELETE FROM observations;"];
  for (const record of bundle.records) {
    lines.push(
      "INSERT INTO observations (id, scientific_name, datetime, timezone, detection, suspicious, sex, place, location_json, notes, habitat, weather_light, source_group, logged_chinese, logged_english, open_question_json, legacy_json, uploaded_at, updated_at) VALUES (" +
        [
          sqlString(record.id),
          sqlString(record.scientificName),
          sqlString(record.datetime),
          sqlString(record.timezone || "Asia/Shanghai"),
          sqlString(record.detection),
          record.suspicious ? "1" : "0",
          sqlString(record.sex),
          sqlString(record.place),
          sqlString(JSON.stringify(record.location)),
          sqlString(record.notes),
          sqlString(record.habitat),
          sqlString(record.weatherLight),
          sqlString(record.sourceGroup),
          sqlString(record.loggedChinese),
          sqlString(record.loggedEnglish),
          record.openQuestion ? sqlString(JSON.stringify(record.openQuestion)) : "NULL",
          sqlString(JSON.stringify(record.legacy)),
          "NULL",
          sqlString(new Date().toISOString()),
        ].join(", ") +
        ");"
    );
    record.photos.forEach((path, index) => {
      const meta = record.photoMeta[path] || {};
      const bytes = statSync(join(root, path)).size;
      lines.push(
        "INSERT INTO photos (path, observation_id, sort_index, watermark, bytes) VALUES (" +
          [sqlString(path), sqlString(record.id), String(index), sqlString(meta.watermark || "@SerinS"), String(bytes)].join(", ") +
          ");"
      );
    });
  }
  for (const fav of bundle.favorites) {
    lines.push(
      "INSERT INTO favorites (observation_id, path, favorited_at) VALUES (" +
        [sqlString(fav.observationId), sqlString(fav.path), sqlString(fav.at || new Date().toISOString())].join(", ") +
        ");"
    );
  }
  const noteEntries = bundle.notes && typeof bundle.notes === "object" ? Object.entries(bundle.notes) : [];
  for (const [sci, note] of noteEntries) {
    const body = typeof note === "string" ? note : note && note.body;
    if (!body) continue;
    const updated = typeof note === "object" && note.updated ? note.updated : new Date().toISOString();
    lines.push(
      "INSERT INTO notes (scientific_name, body, updated_at) VALUES (" +
        [sqlString(sci), sqlString(body), sqlString(updated)].join(", ") +
        ");"
    );
  }
  lines.push(
    "INSERT INTO meta (key, value) VALUES ('migration_records', " + sqlString(String(bundle.records.length)) + ") ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  );
  lines.push(
    "INSERT INTO meta (key, value) VALUES ('migration_photos', " + sqlString(String(bundle.photoPaths.size)) + ") ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  );
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

function wranglerBin() {
  const localBin = join(root, "node_modules", ".bin", "wrangler");
  return existsSync(localBin) ? localBin : "npx";
}

function wrangler(wranglerArgs, capture) {
  const bin = wranglerBin();
  const command = bin === "npx" ? ["wrangler", ...wranglerArgs] : wranglerArgs;
  const result = spawnSync(bin, command, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    if (capture && result.stdout) process.stdout.write(result.stdout);
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error("wrangler failed: " + wranglerArgs.join(" "));
  }
  return result.stdout || "";
}

function targetFlag() {
  return local ? "--local" : "--remote";
}

const bundle = load();
console.log(
  "backup records " + bundle.records.length +
  ", photos " + bundle.photoPaths.size +
  ", favorites " + bundle.favorites.length
);
if (!local && !remote) {
  console.log("Mapping is valid. Pass --local or --remote to copy into D1 and R2. Nothing was written.");
  process.exit(0);
}

const where = targetFlag();
console.log("Applying migrations (" + where + ")…");
wrangler(["d1", "migrations", "apply", "bird-workbench", where]);

const countOut = wrangler([
  "d1", "execute", "bird-workbench", where, "--json",
  "--command", "SELECT COUNT(*) AS n FROM observations",
], true);
let existing = 0;
try {
  const start = countOut.indexOf("[");
  const parsed = JSON.parse(start >= 0 ? countOut.slice(start) : countOut);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  existing = Number(first.results && first.results[0] && first.results[0].n) || 0;
} catch (err) {
  console.error("Could not read the current observation count. Refusing to write.");
  process.exit(1);
}
if (existing > 0 && !replace) {
  console.error("D1 already has " + existing + " observations. Re-run with --replace only to overwrite them from the git backup.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "bird-migrate-"));
const file = join(dir, "seed.sql");
writeFileSync(file, seedSql(bundle));
try {
  console.log("Writing records…");
  wrangler(["d1", "execute", "bird-workbench", where, "--file", file]);
  console.log("Copying photos…");
  for (const path of bundle.photoPaths) {
    wrangler([
      "r2", "object", "put",
      "bird-workbench-photos/" + path,
      "--file", join(root, path),
      "--content-type", "image/jpeg",
      where,
    ]);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("Migration finished (" + where + ").");
