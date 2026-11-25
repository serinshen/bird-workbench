// Apply AviList v2026 1:1 scientific-name renames to D1.
// Does not change photo paths, logged names, or legacy_json.
// Does not insert, delete, or replace the observation backup.
//
//   node scripts/remap-taxonomy.mjs
//   node scripts/remap-taxonomy.mjs --local
//   node scripts/remap-taxonomy.mjs --remote --confirm-remote
//
// Without --local or --remote, this only prints the plan.
// --remote is refused unless --confirm-remote is present.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export function heldNames(remap) {
  const held = new Set();
  const groups = remap && remap.doNotReassign;
  if (!groups || typeof groups !== "object") return held;
  for (const items of Object.values(groups)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && item.from) held.add(item.from);
      if (item && item.sci) held.add(item.sci);
    }
  }
  return held;
}

export function assertRemap(remap) {
  if (!remap || !Array.isArray(remap.renames)) throw new Error("remap file has no renames");
  const seen = new Set();
  const targets = new Set();
  const held = heldNames(remap);
  for (const row of remap.renames) {
    if (!row || !row.from || !row.to || row.from === row.to) throw new Error("bad rename row");
    if (seen.has(row.from)) throw new Error("duplicate rename from " + row.from);
    if (held.has(row.from)) throw new Error("rename overlaps a name that must not be reassigned: " + row.from);
    seen.add(row.from);
    targets.add(row.to);
  }
  for (const row of remap.renames) {
    if (seen.has(row.to)) throw new Error("rename chain: " + row.to);
  }
  return { renames: remap.renames, targets };
}

export function buildStatements(remap) {
  const { renames } = assertRemap(remap);
  const lines = ["BEGIN TRANSACTION;"];
  for (const row of renames) {
    const from = sqlString(row.from);
    const to = sqlString(row.to);
    lines.push("UPDATE observations SET scientific_name = " + to + " WHERE scientific_name = " + from + ";");
    lines.push(
      "UPDATE notes SET scientific_name = " + to +
      " WHERE scientific_name = " + from +
      " AND NOT EXISTS (SELECT 1 FROM notes AS existing WHERE existing.scientific_name = " + to + ");"
    );
    lines.push(
      "UPDATE observations SET open_question_json = json_set(open_question_json, '$.scientificName', " + to + ")" +
      " WHERE json_extract(open_question_json, '$.scientificName') = " + from + ";"
    );
  }
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

function loadRemap() {
  return JSON.parse(readFileSync(join(root, "data/scientific-name-remap.json"), "utf8"));
}

function wranglerBin() {
  const localBin = join(root, "node_modules", ".bin", "wrangler");
  return existsSync(localBin) ? localBin : "npx";
}

function wrangler(wranglerArgs) {
  const bin = wranglerBin();
  const command = bin === "npx" ? ["wrangler", ...wranglerArgs] : wranglerArgs;
  const result = spawnSync(bin, command, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) throw new Error("wrangler failed: " + wranglerArgs.join(" "));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const local = args.has("--local");
  const remote = args.has("--remote");
  const confirm = args.has("--confirm-remote");
  if (local && remote) {
    console.error("Choose either --local or --remote.");
    process.exit(1);
  }
  if (remote && !confirm) {
    console.error("Refusing --remote without --confirm-remote.");
    console.error("Read data/avilist-v2026-migration.md first. This command updates production D1 names and does not deploy the Worker.");
    process.exit(2);
  }
  const remap = loadRemap();
  const { renames } = assertRemap(remap);
  const held = heldNames(remap);
  console.log("1:1 renames " + renames.length + "; names left unchanged " + held.size);
  const backupHits = [];
  try {
    const backup = JSON.parse(readFileSync(join(root, "data/observations.json"), "utf8"));
    const names = new Set((backup.records || []).map((record) => record.scientificName));
    for (const row of renames) {
      if (names.has(row.from)) backupHits.push(row.from + " -> " + row.to);
    }
    for (const name of names) {
      if (held.has(name)) console.log("backup record is in the do-not-reassign list: " + name);
    }
  } catch (err) {
    console.error("Could not read the observation backup.");
    process.exit(1);
  }
  console.log("backup renames:");
  for (const line of backupHits) console.log("  " + line);
  if (!backupHits.length) console.log("  (none)");
  if (!local && !remote) {
    console.log("Dry run. Nothing was written. Pass --local, or later --remote --confirm-remote, to apply.");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "bird-remap-"));
  const file = join(dir, "remap.sql");
  writeFileSync(file, buildStatements(remap));
  try {
    const where = local ? "--local" : "--remote";
    console.log("Applying scientific-name renames (" + where + ")…");
    wrangler(["d1", "execute", "bird-workbench", where, "--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("Scientific-name remap finished. Photo paths were not changed.");
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) main();
