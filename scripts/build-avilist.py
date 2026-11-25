#!/usr/bin/env python3
"""Build the AviList v2026 workbench pack from official inputs.

Inputs (local files, not invented):
  --avilist   explore.avilist.org/data/avilist-2026.json
              (Checklist Explorer extract of AviList v2026 extended sheet)
  --ebird-zh  eBird taxonomy locale zh_SIM (Chinese SIM)
  --previous  current IOC 15.2 pack.b64
  --anhui     republication of 国家重点保护野生动物名录（2021）
  --shanghai  second republication, used as a cross-check

Writes pack.b64, china-recordable-sci.json, protection-ranks.json,
scientific-name-remap.json, and the migration report.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

PUBLISHED_ORDER_COUNTS = {
    "Struthioniformes": 2,
    "Casuariiformes": 4,
    "Apterygiformes": 5,
    "Rheiformes": 2,
    "Tinamiformes": 47,
    "Anseriformes": 176,
    "Galliformes": 307,
    "Phoenicopteriformes": 6,
    "Podicipediformes": 22,
    "Musophagiformes": 23,
    "Otidiformes": 26,
    "Cuculiformes": 157,
    "Mesitornithiformes": 3,
    "Pterocliformes": 16,
    "Columbiformes": 351,
    "Opisthocomiformes": 1,
    "Gruiformes": 185,
    "Charadriiformes": 393,
    "Eurypygiformes": 2,
    "Phaethontiformes": 3,
    "Gaviiformes": 5,
    "Sphenisciformes": 19,
    "Procellariiformes": 146,
    "Ciconiiformes": 20,
    "Suliformes": 54,
    "Pelecaniformes": 120,
    "Caprimulgiformes": 98,
    "Steatornithiformes": 1,
    "Nyctibiiformes": 7,
    "Podargiformes": 16,
    "Aegotheliformes": 10,
    "Apodiformes": 470,
    "Strigiformes": 246,
    "Cathartiformes": 7,
    "Accipitriformes": 252,
    "Coliiformes": 6,
    "Leptosomiformes": 1,
    "Trogoniformes": 47,
    "Bucerotiformes": 75,
    "Coraciiformes": 192,
    "Piciformes": 440,
    "Cariamiformes": 2,
    "Falconiformes": 65,
    "Psittaciformes": 407,
    "Passeriformes": 6735,
}

IUCN_OK = {"EX", "EW", "CR", "CR (PE)", "CR (PEW)", "EN", "VU", "NT", "LC", "DD"}
COLS = [
    "sequence", "rank", "order", "family", "familyEn", "sciName", "authority",
    "citation", "name", "nameClements", "nameBirdLife", "proposalNumber",
    "decisionSummary", "range", "extinct", "iucn", "birdLifeUrl", "cornellCode",
    "bowUrl", "avibaseId", "genusGender", "typeSpecies", "typeLocality",
    "originalDescriptionTitle", "originalDescriptionUrl", "protonym",
]


def load_previous(path: Path):
    raw = path.read_text().replace("\n", "").replace("\r", "")
    pack = json.loads(gzip.decompress(base64.b64decode(raw)))
    species = []
    for line in pack["r"].split("\n"):
        if not line:
            continue
        p = line.split("\t")
        genus = pack["g"][int(p[5])]
        species.append({
            "sci": genus + " " + p[0],
            "epithet": p[0],
            "genus": genus,
            "en": p[1],
            "zh": p[2],
            "order": pack["o"][int(p[3])],
            "orderZh": pack["oz"][int(p[3])],
            "family": pack["f"][int(p[4])],
            "familyZh": pack["fz"][int(p[4])],
            "familyEn": pack["fe"][int(p[4])],
            "index": len(species),
        })
    aliases = defaultdict(list)
    for line in (pack.get("al") or "").split("\n"):
        if not line.strip():
            continue
        idx, rest = line.split("\t", 1)
        aliases[int(idx)] = [part for part in rest.split("|") if part]
    syn = defaultdict(list)
    for line in (pack.get("sy") or "").split("\n"):
        if not line.strip():
            continue
        current, older = line.split("\t", 1)
        syn[current].append(older)
    return pack, species, aliases, syn


def load_avilist(path: Path):
    blob = path.read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    data = json.loads(blob)
    rows = []
    for raw in data:
        row = {COLS[i]: raw[i] if i < len(raw) else None for i in range(len(COLS))}
        rows.append(row)
    return rows, digest


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if abs(len(a) - len(b)) > 2:
        return 3
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def epithet_compatible(a: str, b: str) -> bool:
    if a == b:
        return True
    if levenshtein(a, b) <= 1:
        return True

    def stems(ep: str):
        found = {ep}
        for suf in ("us", "um", "a", "is", "e", "er"):
            if ep.endswith(suf) and len(ep) - len(suf) >= 4:
                found.add(ep[: -len(suf)])
        return found

    return bool(stems(a) & stems(b))


def classify(ioc, avi_by, subs):
    ioc_by = {s["sci"]: s for s in ioc}
    ioc_set = set(ioc_by)
    en_ioc = defaultdict(list)
    en_avi = defaultdict(list)
    for s in ioc:
        en_ioc[s["en"]].append(s["sci"])
    for sci, row in avi_by.items():
        en_avi[row["name"] or ""].append(sci)

    # same-genus subspecies epithet -> parents
    ssp_parents = defaultdict(set)
    for genus, parent_epithet, ssp_epithet, parent in subs:
        ssp_parents[(genus, ssp_epithet)].add(parent)

    renames = {}  # ioc sci -> avi sci
    lumps = {}  # ioc sci -> parent avi sci
    ambiguous = {}
    unmatched = []

    for s in ioc:
        sci = s["sci"]
        if sci in avi_by:
            continue
        en = s["en"]
        en_targets = en_avi.get(en, [])
        unique_en = len(en_ioc[en]) == 1 and len(en_targets) == 1
        en_target = en_targets[0] if unique_en else None
        en_ok = False
        if en_target and en_target not in ioc_set:
            old_ep = s["epithet"]
            new_ep = en_target.split()[-1]
            if epithet_compatible(old_ep, new_ep):
                en_ok = True
        parents = sorted(ssp_parents.get((s["genus"], s["epithet"]), []))
        lump_parent = parents[0] if len(parents) == 1 and parents[0] in avi_by else None
        if len(parents) > 1:
            ambiguous[sci] = {
                "kind": "subspecies-epithet-ambiguous",
                "en": en,
                "zh": s["zh"],
                "parents": parents,
            }
            continue
        if en_ok and lump_parent and lump_parent != en_target:
            ambiguous[sci] = {
                "kind": "rename-and-lump-disagree",
                "en": en,
                "zh": s["zh"],
                "rename": en_target,
                "lump": lump_parent,
            }
            continue
        if en_ok:
            renames[sci] = en_target
            continue
        if unique_en and en_target in ioc_set:
            # English name moved onto a species that already existed in IOC.
            # Treat as a lump only when the same-genus subspecies also says so.
            if lump_parent == en_target or lump_parent is None and en_target:
                if lump_parent:
                    lumps[sci] = lump_parent
                    continue
            ambiguous[sci] = {
                "kind": "english-name-moved-onto-existing-species",
                "en": en,
                "zh": s["zh"],
                "onto": en_target,
                "lump": lump_parent,
            }
            continue
        if lump_parent:
            lumps[sci] = lump_parent
            continue
        if unique_en and en_target and en_target not in ioc_set:
            ambiguous[sci] = {
                "kind": "english-match-but-epithet-not-compatible",
                "en": en,
                "zh": s["zh"],
                "candidate": en_target,
                "candidateEn": avi_by[en_target]["name"],
                "candidateEpithet": en_target.split()[-1],
            }
            continue
        unmatched.append({
            "sci": sci,
            "en": en,
            "zh": s["zh"],
            "englishTargets": en_targets,
            "subspeciesParents": parents,
        })
    return renames, lumps, ambiguous, unmatched


def clean_zh(text: str) -> str:
    text = (text or "").lstrip("*").strip()
    text = re.sub(r"[（(].*?[）)]", "", text).strip()
    return text


def parse_china_2021(anhui_path: Path, shanghai_path: Path):
    anhui = anhui_path.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(anhui) if "鸟纲" in line)
    end = next(i for i, line in enumerate(anhui) if "爬行纲" in line)
    anhui_rows = []
    for line in anhui[start:end]:
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) > 1 and re.fullmatch(r"[A-Z]{4,}", cells[1]):
            continue
        match = re.search(r"\b([A-Z][a-z]+ [a-z]+)\b", line)
        if not match:
            continue
        if "一级" in line and "二级" not in line:
            rank = "I"
        elif "二级" in line and "一级" not in line:
            rank = "II"
        else:
            continue
        anhui_rows.append({"zh": clean_zh(cells[0]), "sci": match.group(1), "rank": rank})

    shanghai = shanghai_path.read_text(encoding="utf-8").splitlines()
    sh_rows = []
    for line in shanghai:
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue
        sci = cells[2]
        if not re.fullmatch(r"[A-Z][a-z]+ [a-z]+", sci):
            continue
        if cells[4].startswith("Ⅰ") or cells[4].startswith("I"):
            rank = "I"
        elif cells[4].startswith("Ⅱ") or cells[4].startswith("II"):
            rank = "II"
        else:
            continue
        group = cells[3]
        order = re.match(r"(.+?目)", group)
        sh_rows.append({
            "zh": clean_zh(cells[1]),
            "sci": sci,
            "rank": rank,
            "order": order.group(1) if order else group,
            "group": group,
        })

    anhui_sci = {row["sci"] for row in anhui_rows}
    anhui_zh = {row["zh"] for row in anhui_rows}
    orders = set()
    for row in sh_rows:
        if row["sci"] in anhui_sci or row["zh"] in anhui_zh:
            orders.add(row["order"])
    birds = [row for row in sh_rows if row["order"] in orders]
    by_zh_a = {row["zh"]: row for row in anhui_rows}
    by_zh_s = {row["zh"]: row for row in birds}
    # Prefer Shanghai Chinese (the Anhui page lost 鵟). Scientific names must agree
    # or both spellings are kept as candidates.
    entries = []
    spelling = []
    for zh, sh in by_zh_s.items():
        other = by_zh_a.get(zh)
        names = [sh["sci"]]
        if other and other["sci"] != sh["sci"]:
            names.append(other["sci"])
            spelling.append({
                "zh": zh,
                "shanghai": sh["sci"],
                "anhui": other["sci"],
                "rank": sh["rank"],
                "anhuiRank": other["rank"],
            })
            if other["rank"] != sh["rank"]:
                sh = dict(sh)
                sh["rankConflict"] = True
        entries.append({
            "zh": zh,
            "scientificNames": names,
            "rank": sh["rank"],
            "rankConflict": bool(sh.get("rankConflict")),
            "order": sh["order"],
        })
    anhui_only = [row for row in anhui_rows if row["zh"] not in by_zh_s and row["sci"] not in {e["scientificNames"][0] for e in entries}]
    return entries, spelling, anhui_only, sorted(orders)


def match_protection(entries, avi_by, renames, zh_of, zh_alias, syn_to_ioc):
    """Return matched ranks and omitted entries. Never collapse a subspecies onto its parent."""
    zh_index = defaultdict(set)
    for sci, zh in zh_of.items():
        if zh:
            zh_index[zh].add(sci)
    for sci, aliases in zh_alias.items():
        for alias in aliases:
            if alias:
                zh_index[alias].add(sci)

    matched = defaultdict(list)
    omitted = []
    for entry in entries:
        if entry.get("rankConflict"):
            omitted.append({**entry, "reason": "the two republications disagree on the rank"})
            continue
        hits = []
        for name in entry["scientificNames"]:
            if name in avi_by:
                hits.append(("exact", name))
            elif name in renames:
                hits.append(("rename", renames[name]))
            else:
                currents = syn_to_ioc.get(name, [])
                mapped = []
                for current in currents:
                    if current in avi_by:
                        mapped.append(current)
                    elif current in renames:
                        mapped.append(renames[current])
                mapped = sorted(set(mapped))
                if len(mapped) == 1:
                    hits.append(("ioc-synonym", mapped[0]))
                elif len(mapped) > 1:
                    hits.append(("ioc-synonym-ambiguous", ""))
        targets = sorted({hit[1] for hit in hits if hit[1]})
        if any(hit[0] == "ioc-synonym-ambiguous" for hit in hits):
            omitted.append({**entry, "reason": "IOC synonym points at more than one AviList species"})
            continue
        if len(targets) > 1:
            omitted.append({**entry, "reason": "candidate scientific names hit different AviList species", "targets": targets})
            continue
        if len(targets) == 1:
            matched[targets[0]].append({
                "zh": entry["zh"],
                "listed": entry["scientificNames"],
                "rank": entry["rank"],
                "via": hits[0][0],
            })
            continue
        epithets = {name.split()[-1] for name in entry["scientificNames"]}
        genera = {name.split()[0] for name in entry["scientificNames"]}
        zh_hits = sorted(zh_index.get(entry["zh"], []))
        compatible = []
        orthographic = []
        for sci in zh_hits:
            genus, epithet = sci.split()
            if any(epithet_compatible(epithet, ep) for ep in epithets):
                compatible.append(sci)
            elif genus in genera and any(levenshtein(epithet, ep) <= 2 for ep in epithets):
                orthographic.append(sci)
        if len(compatible) == 1 and not orthographic:
            matched[compatible[0]].append({
                "zh": entry["zh"],
                "listed": entry["scientificNames"],
                "rank": entry["rank"],
                "via": "unique-chinese-and-epithet",
            })
            continue
        if len(orthographic) == 1 and not compatible:
            matched[orthographic[0]].append({
                "zh": entry["zh"],
                "listed": entry["scientificNames"],
                "rank": entry["rank"],
                "via": "same-genus orthographic epithet plus unique Chinese name",
            })
            continue
        omitted.append({
            **entry,
            "reason": "no AviList species match; omitted rather than applied to a parent or lookalike",
            "chineseHits": zh_hits,
        })

    ranks = {}
    conflicts = []
    for sci, hits in matched.items():
        rank_set = sorted({hit["rank"] for hit in hits})
        if len(rank_set) != 1:
            conflicts.append({"sci": sci, "hits": hits, "reason": "two 2021 entries of different ranks landed on one AviList species"})
            continue
        ranks[sci] = {"cn": rank_set[0], "hits": hits}
    return ranks, omitted, conflicts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--avilist", required=True)
    parser.add_argument("--ebird-zh", required=True)
    parser.add_argument("--previous", required=True)
    parser.add_argument("--anhui", required=True)
    parser.add_argument("--shanghai", required=True)
    parser.add_argument("--china-list", required=True)
    parser.add_argument("--observations", required=True)
    parser.add_argument("--morning", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    rows, avilist_sha = load_avilist(Path(args.avilist))
    by_order = defaultdict(int)
    species_rows = []
    families = {}
    orders = {}
    subs = []
    for row in rows:
        if row["rank"] == "order":
            orders[row["sciName"]] = row["name"] or ""
        elif row["rank"] == "family":
            families[row["sciName"]] = row["name"] or row["familyEn"] or ""
        elif row["rank"] == "species":
            species_rows.append(row)
            by_order[row["order"]] += 1
        elif row["rank"] == "subspecies":
            parts = (row["sciName"] or "").split()
            if len(parts) == 3:
                subs.append((parts[0], parts[1], parts[2], parts[0] + " " + parts[1]))

    mismatches = []
    for order, count in PUBLISHED_ORDER_COUNTS.items():
        if by_order.get(order) != count:
            mismatches.append((order, count, by_order.get(order)))
    if mismatches or sum(by_order.values()) != 11172 or len(by_order) != 45:
        raise SystemExit("AviList JSON does not match the published v2026 order totals: " + str(mismatches))

    avi_by = {}
    for row in species_rows:
        if row["sciName"] in avi_by:
            raise SystemExit("duplicate scientific name " + row["sciName"])
        avi_by[row["sciName"]] = row

    previous, ioc, prev_alias, prev_syn = load_previous(Path(args.previous))
    ioc_by = {s["sci"]: s for s in ioc}
    order_zh = {}
    family_zh = {}
    for s in ioc:
        order_zh.setdefault(s["order"], s["orderZh"])
        family_zh.setdefault(s["family"], s["familyZh"])

    renames, lumps, ambiguous, unmatched = classify(ioc, avi_by, subs)
    rename_targets = set(renames.values())
    # A rename target must not also be an IOC species. classify already enforces that.
    for src, dest in renames.items():
        if dest in ioc_by:
            raise SystemExit("rename target still in IOC: " + src + " -> " + dest)

    ebird = json.loads(Path(args.ebird_zh).read_text())
    zh_by_code = {row["speciesCode"]: row for row in ebird if row.get("speciesCode")}

    # Chinese names
    zh_choice = {}
    zh_source = {}
    zh_alias = defaultdict(list)
    conflicts = []
    carried = []
    parenthetical = []
    for row in species_rows:
        sci = row["sciName"]
        eb = None
        eb_record = zh_by_code.get(row["cornellCode"]) if row["cornellCode"] else None
        if eb_record and eb_record.get("comName"):
            eb = eb_record["comName"].strip()
        prev = ioc_by.get(sci)
        prev_zh = prev["zh"] if prev else ""
        if not prev_zh and sci not in ioc_by:
            # 1:1 rename: the IOC species that maps here
            sources = [src for src, dest in renames.items() if dest == sci]
            if len(sources) == 1:
                prev_zh = ioc_by[sources[0]]["zh"]
                prev = ioc_by[sources[0]]
        chosen = ""
        source = ""
        if eb:
            chosen = eb
            source = "ebird-zh_SIM via AviList Cornell species code"
            if prev_zh and prev_zh != eb:
                conflicts.append({
                    "sci": sci,
                    "avilistEn": row["name"] or "",
                    "previousZh": prev_zh,
                    "previousSci": prev["sci"] if prev else sci,
                    "ebirdZh": eb,
                    "kept": eb,
                })
                zh_alias[sci].append(prev_zh)
        elif prev_zh and sci in ioc_by:
            chosen = prev_zh
            source = "previous checklist, 1:1 scientific name, no eBird zh_SIM name"
        elif prev_zh:
            chosen = prev_zh
            source = "previous Chinese name carried across a 1:1 rename; no eBird zh_SIM name"
            carried.append({"from": prev["sci"], "to": sci, "zh": prev_zh, "en": row["name"] or ""})
        zh_choice[sci] = chosen
        zh_source[sci] = source
        if prev and sci in ioc_by:
            for alias in prev_alias.get(prev["index"], []):
                if alias and alias != chosen and alias not in zh_alias[sci]:
                    zh_alias[sci].append(alias)
        # Keep a parenthetical eBird alternate searchable, without replacing the source string.
        match = re.fullmatch(r"(.+?) \(([^()]*)\)", chosen)
        if match and re.search(r"[\u4e00-\u9fff]", match.group(2)):
            alt = match.group(2).strip()
            if alt and alt != chosen and alt not in zh_alias[sci]:
                zh_alias[sci].append(alt)
                parenthetical.append({"sci": sci, "shown": chosen, "also": alt})

    # Scientific synonyms
    syn_map = defaultdict(set)
    for src, dest in renames.items():
        syn_map[dest].add(src)
    for current, olds in prev_syn.items():
        if current in avi_by:
            target = current
        elif current in renames:
            target = renames[current]
        else:
            continue
        for older in olds:
            if older in avi_by or older in renames or older == target:
                continue
            syn_map[target].add(older)
    owner = defaultdict(list)
    for dest, olds in syn_map.items():
        for older in olds:
            owner[older].append(dest)
    dropped_syn = []
    for older, dests in owner.items():
        if len(dests) > 1:
            dropped_syn.append({"name": older, "targets": sorted(dests)})
            for dest in dests:
                syn_map[dest].discard(older)

    # China filter
    china_doc = json.loads(Path(args.china_list).read_text())
    original_china = set(china_doc["scientificNames"])
    china_out = set()
    china_same = []
    china_renamed = []
    china_lumps = []
    china_unmatched = []
    china_ambiguous = []
    for sci in china_doc["scientificNames"]:
        if sci in avi_by:
            china_out.add(sci)
            china_same.append(sci)
        elif sci in renames:
            china_out.add(renames[sci])
            china_renamed.append({"from": sci, "to": renames[sci], "zh": ioc_by[sci]["zh"], "en": ioc_by[sci]["en"]})
        elif sci in lumps:
            parent = lumps[sci]
            parent_in_original = parent in original_china or parent in renames.values() and any(
                src in original_china and renames[src] == parent for src in renames
            )
            china_out.add(parent)
            china_lumps.append({
                "from": sci,
                "to": parent,
                "zh": ioc_by[sci]["zh"],
                "en": ioc_by[sci]["en"],
                "parentInOriginalChinaList": parent in original_china,
            })
        elif sci in ambiguous:
            china_ambiguous.append({"sci": sci, "zh": ioc_by[sci]["zh"], "en": ioc_by[sci]["en"], **ambiguous[sci]})
        else:
            info = next(item for item in unmatched if item["sci"] == sci)
            china_unmatched.append(info)

    # Protection
    entries, spelling, anhui_only, bird_orders = parse_china_2021(Path(args.anhui), Path(args.shanghai))
    if anhui_only:
        raise SystemExit("Anhui bird rows missing from the Shanghai cross-check: " + str(anhui_only[:8]))
    syn_to_ioc = defaultdict(list)
    for current, olds in prev_syn.items():
        for older in olds:
            syn_to_ioc[older].append(current)
    ranks, omitted_ranks, rank_conflicts = match_protection(
        entries, avi_by, renames, zh_choice, zh_alias, syn_to_ioc
    )

    # Highlight the two subspecies the previous list could not apply.
    spotlight = []
    for wanted_zh, wanted_sci in (("四川林鸮", "Strix davidi"), ("海南画眉", "Garrulax owstoni")):
        hit = next((entry for entry in entries if wanted_sci in entry["scientificNames"] or entry["zh"] == wanted_zh), None)
        species_hit = wanted_sci in avi_by
        ssp = [parent for genus, parent_ep, ssp_ep, parent in subs if f"{genus} {ssp_ep}" == wanted_sci or ssp_ep == wanted_sci.split()[-1] and genus == wanted_sci.split()[0]]
        applied = [sci for sci, info in ranks.items() if any(wanted_sci in h["listed"] or h["zh"] == wanted_zh for h in info["hits"])]
        spotlight.append({
            "zh": wanted_zh,
            "listed": wanted_sci,
            "rank2021": hit["rank"] if hit else None,
            "avilistSpecies": species_hit,
            "avilistSubspeciesOf": sorted(set(ssp)),
            "appliedToAviListSpecies": applied,
        })

    by_sci_out = {}
    iucn_kept = 0
    lc_only_with_cn = 0
    lc_omitted = 0
    for row in species_rows:
        sci = row["sciName"]
        iucn = row["iucn"] if row["iucn"] in IUCN_OK else ""
        cn = ranks.get(sci, {}).get("cn")
        entry = {}
        if cn:
            entry["cn"] = cn
        if iucn == "LC":
            if cn:
                entry["iucn"] = "LC"
                lc_only_with_cn += 1
            else:
                lc_omitted += 1
        elif iucn:
            entry["iucn"] = iucn
            iucn_kept += 1
        if entry:
            by_sci_out[sci] = entry

    # Build pack in AviList sequence.
    order_index = {}
    family_index = {}
    genus_index = {}
    order_names = []
    order_zhs = []
    family_names = []
    family_ens = []
    family_zhs = []
    genera = []
    authorities = []
    authority_index = {}
    lines = []
    alias_lines = []
    blank = []
    family_of_species = []
    order_of_species = []
    for row in species_rows:
        sci = row["sciName"]
        order = row["order"]
        family = row["family"]
        genus = sci.split()[0]
        epithet = sci.split()[-1]
        if order not in order_index:
            order_index[order] = len(order_names)
            order_names.append(order)
            order_zhs.append(order_zh.get(order, ""))
        if family not in family_index:
            family_index[family] = len(family_names)
            family_names.append(family)
            family_ens.append(families.get(family) or "")
            family_zhs.append(family_zh.get(family, ""))
        if genus not in genus_index:
            genus_index[genus] = len(genera)
            genera.append(genus)
        authority = row["authority"] or ""
        if authority not in authority_index:
            authority_index[authority] = len(authorities)
            authorities.append(authority)
        zh = zh_choice[sci]
        if not zh:
            blank.append(sci)
        china_flag = "1" if sci in china_out else "0"
        lines.append("\t".join([
            epithet,
            row["name"] or "",
            zh,
            str(order_index[order]),
            str(family_index[family]),
            str(genus_index[genus]),
            str(authority_index[authority]),
            china_flag,
        ]))
        if zh_alias[sci]:
            alias_lines.append(str(len(lines) - 1) + "\t" + "|".join(zh_alias[sci]))
        family_of_species.append(family)
        order_of_species.append(order)

    syn_lines = []
    for dest in sorted(syn_map):
        for older in sorted(syn_map[dest]):
            syn_lines.append(dest + "\t" + older)

    pack = {
        "tax": "AviList v2026",
        "n": len(lines),
        "o": order_names,
        "oz": order_zhs,
        "f": family_names,
        "fe": family_ens,
        "fz": family_zhs,
        "g": genera,
        "au": authorities,
        "r": "\n".join(lines),
        "al": "\n".join(alias_lines),
        "sy": "\n".join(syn_lines),
        "mz": blank,
    }
    raw = gzip.compress(json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0)
    (out / "pack.b64").write_text(base64.b64encode(raw).decode("ascii") + "\n")

    china_names = sorted(china_out)
    china_json = {
        "source": "Previous 中国可记录 filter (CBR v10.0 (2022) × IOC v15.2, 1491 names) remapped onto AviList v2026. Kept on an unchanged scientific name or a 1:1 rename. A lumped IOC species adds its AviList parent and is listed in the migration report. Unmatched and ambiguous names are omitted. This is a filter, not a second taxonomy.",
        "count": len(china_names),
        "scientificNames": china_names,
    }
    (out / "china-recordable-sci.json").write_text(json.dumps(china_json, ensure_ascii=False, indent=2) + "\n")

    protection = {
        "iucnSource": "AviList v2026 column IUCN RED LIST CATEGORY, on that AviList species. LC is stored only when the species is also on the 2021 China national key protected list. Empty categories are omitted. No IOC crosswalk.",
        "chinaSource": "国家重点保护野生动物名录（2021年调整），国家林业和草原局、农业农村部公告2021年第3号. Bird entries were read from two public republications (上海市绿化和市容管理局; 安徽省野生动植物保护协会) that agree on 394 bird names except five orthographic variants, which were matched only when both spellings pointed at one AviList species. Matched by exact AviList scientific name, a 1:1 rename of that name, or one Chinese name plus the same epithet. Subspecies that AviList does not treat as species are omitted, including 四川林鸮 Strix davidi and 海南画眉 Garrulax owstoni. Unmatched names are omitted.",
        "byScientificName": {sci: by_sci_out[sci] for sci in sorted(by_sci_out)},
    }
    (out / "protection-ranks.json").write_text(json.dumps(protection, ensure_ascii=False, indent=2) + "\n")

    additions = []
    for row in species_rows:
        sci = row["sciName"]
        if sci in ioc_by or sci in rename_targets:
            continue
        additions.append({"sci": sci, "en": row["name"] or "", "order": row["order"], "family": row["family"]})

    obs = json.loads(Path(args.observations).read_text())
    obs_map = []
    obs_hold = []
    for sci in sorted({rec["scientificName"] for rec in obs["records"]}):
        if sci in avi_by:
            obs_map.append({"from": sci, "to": sci, "relation": "same"})
        elif sci in renames:
            obs_map.append({"from": sci, "to": renames[sci], "relation": "rename", "en": ioc_by[sci]["en"], "zh": ioc_by[sci]["zh"]})
        else:
            relation = "lump" if sci in lumps else "ambiguous" if sci in ambiguous else "unmatched"
            obs_hold.append({"from": sci, "relation": relation, "to": lumps.get(sci), "zh": ioc_by.get(sci, {}).get("zh", "")})
    open_questions = []
    for rec in obs["records"]:
        oq = rec.get("openQuestion") or {}
        name = oq.get("scientificName")
        if name:
            open_questions.append({
                "id": rec["id"],
                "scientificName": name,
                "relation": "same" if name in avi_by else "rename" if name in renames else "hold",
                "to": name if name in avi_by else renames.get(name),
            })

    morning = json.loads(Path(args.morning).read_text())
    morning_changes = []
    for card in morning:
        sci = card["scientificName"]
        if sci in renames:
            morning_changes.append({"id": card["id"], "from": sci, "to": renames[sci]})
            card["scientificName"] = renames[sci]
        elif sci not in avi_by:
            morning_changes.append({"id": card["id"], "from": sci, "to": None, "unresolved": True})
    (out / "morning-cards.json").write_text(json.dumps(morning, ensure_ascii=False, indent=2) + "\n")

    remap = {
        "taxonomy": "AviList v2026",
        "citation": "AviList Core Team. 2026. AviList: The Global Avian Checklist, v2026. https://doi.org/10.2173/avilist.v2026",
        "avilistSha256": avilist_sha,
        "rule": "Update a stored scientific name only when it is a 1:1 rename below. Do not update lumps, splits, unmatched names, or ambiguous names. Do not change photo paths, loggedChinese, loggedEnglish, or legacy_json.",
        "renames": [
            {
                "from": src,
                "to": dest,
                "en": ioc_by[src]["en"],
                "zh": ioc_by[src]["zh"],
                "basis": "unique English name in IOC 15.2 and AviList v2026, epithet equal or a one-letter/gender variant, and the AviList name is not an IOC species",
            }
            for src, dest in sorted(renames.items())
        ],
        "doNotReassign": {
            "lumps": [
                {"from": src, "parent": dest, "en": ioc_by[src]["en"], "zh": ioc_by[src]["zh"]}
                for src, dest in sorted(lumps.items())
            ],
            "ambiguous": [{"sci": sci, **ambiguous[sci]} for sci in sorted(ambiguous)],
            "unmatched": unmatched,
        },
    }
    (out / "scientific-name-remap.json").write_text(json.dumps(remap, ensure_ascii=False, indent=2) + "\n")

    blank_orders = [name for name, zh in zip(order_names, order_zhs) if not zh]
    blank_families = [name for name, zh in zip(family_names, family_zhs) if not zh]
    en_changed = 0
    for sci, prev in ioc_by.items():
        if sci in avi_by and (avi_by[sci]["name"] or "") != prev["en"]:
            en_changed += 1

    report = {
        "citation": remap["citation"],
        "source": {
            "checklistPage": "https://www.avilist.org/checklist/v2026/",
            "explorerJson": "https://explore.avilist.org/data/avilist-2026.json",
            "explorerVersion": "https://explore.avilist.org/versions.json",
            "publishedXlsx": "https://www.avilist.org/wp-content/uploads/2026/10/AviList-v2026-20Oct2026-extended-version.xlsx",
            "note": "The official XLSX is published on avilist.org. Direct download returned Cloudflare 403 from this environment. The Checklist Explorer JSON is AviList's own extract of the extended v2026 sheet (26 columns, sheet AviList v2026). Its per-order species totals match the counts published on the v2026 checklist page, including 11,172 species and 45 orders.",
            "avilistSha256": avilist_sha,
            "chineseNames": "eBird taxonomy common names, locale zh_SIM (Chinese SIM), Cornell Lab of Ornithology, joined only on the Cornell species code AviList v2026 publishes when the species concept matches. Retrieved for this build. Where that name is absent, the previous Chinese name is kept on a 1:1 scientific-name match, or carried across a 1:1 rename.",
            "china2021": "国家林业和草原局、农业农村部公告2021年第3号. Read from https://lhsr.sh.gov.cn/gjzdbhysdwml/ and http://www.ahwca.org.cn/News/detial.aspx?category_id=120&id=220",
        },
        "counts": {
            "iocSpecies": len(ioc),
            "avilistSpecies": len(species_rows),
            "avilistOrders": len(order_names),
            "avilistFamilies": len(family_names),
            "avilistGenera": len(genera),
            "sameScientificName": sum(1 for s in ioc if s["sci"] in avi_by),
            "renames": len(renames),
            "lumps": len(lumps),
            "ambiguous": len(ambiguous),
            "unmatchedIocSpecies": len(unmatched),
            "avilistAdditions": len(additions),
            "englishNamesChangedOnSameScientificName": en_changed,
            "chineseConflicts": len(conflicts),
            "chineseCarriedAcrossRename": len(carried),
            "chineseBlank": len(blank),
            "ebirdParentheticalAliases": len(parenthetical),
            "chinaIn": 1491,
            "chinaOut": len(china_names),
            "chinaSame": len(china_same),
            "chinaRenamed": len(china_renamed),
            "chinaLumps": len(china_lumps),
            "chinaUnmatched": len(china_unmatched),
            "chinaAmbiguous": len(china_ambiguous),
            "china2021Entries": len(entries),
            "chinaRanksApplied": len(ranks),
            "chinaRanksOmitted": len(omitted_ranks),
            "chinaRankConflicts": len(rank_conflicts),
            "iucnStoredNonLc": iucn_kept,
            "iucnLcWithNationalProtection": lc_only_with_cn,
            "iucnLcOmitted": lc_omitted,
            "blankOrderChinese": blank_orders,
            "blankFamilyChinese": blank_families,
            "droppedAmbiguousSynonyms": dropped_syn,
        },
        "observationRemap": obs_map,
        "observationDoNotReassign": obs_hold,
        "openQuestions": open_questions,
        "morningCardScientificNames": morning_changes,
        "chinaRenames": china_renamed,
        "chinaLumps": china_lumps,
        "chinaUnmatched": china_unmatched,
        "chinaAmbiguous": china_ambiguous,
        "china2021Matched": [
            {
                "sci": sci,
                "cn": info["cn"],
                "zh": [hit["zh"] for hit in info["hits"]],
                "listed": [hit["listed"] for hit in info["hits"]],
                "via": sorted({hit["via"] for hit in info["hits"]}),
            }
            for sci, info in sorted(ranks.items())
        ],
        "sichuanWoodOwlAndHainanHwamei": spotlight,
        "china2021SpellingVariants": spelling,
        "china2021Omitted": omitted_ranks,
        "china2021RankConflicts": rank_conflicts,
        "chineseConflicts": conflicts,
        "chineseCarried": carried,
        "chineseBlank": blank,
        "iocUnmatched": unmatched,
        "iocAmbiguous": [{"sci": sci, **ambiguous[sci]} for sci in sorted(ambiguous)],
        "iocLumps": remap["doNotReassign"]["lumps"],
        "additions": additions,
        "renames": remap["renames"],
        "weekly": {
            "edited": False,
            "note": "Issue 1 says 黑脸琵鹭（EN）. That species is Platalea minor. AviList v2026 IUCN category is VU, and the rebuilt rank file stores VU. The published weekly sentence was left as written.",
        },
    }
    (out / "avilist-v2026-migration.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    # Human summary
    lines_out = []
    lines_out.append("# AviList v2026 migration")
    lines_out.append("")
    lines_out.append(remap["citation"])
    lines_out.append("")
    lines_out.append("The world list is AviList v2026 only. The China list is a filter on that list.")
    lines_out.append("")
    lines_out.append("## Counts")
    lines_out.append("")
    for key, value in report["counts"].items():
        if isinstance(value, list):
            lines_out.append(f"- {key}: {', '.join(value) if value else '(none)'}")
        else:
            lines_out.append(f"- {key}: {value}")
    lines_out.append("")
    lines_out.append("## 四川林鸮 and 海南画眉")
    lines_out.append("")
    lines_out.append("The 2021 list uses 四川林鸮, not 林鸨. AviList v2026 still treats both named taxa as subspecies, so their ranks are not copied onto the parent species.")
    lines_out.append("")
    for item in spotlight:
        lines_out.append(f"- {item['zh']} `{item['listed']}` 2021 class {item['rank2021']}. AviList species: {item['avilistSpecies']}. Subspecies of: {', '.join(item['avilistSubspeciesOf']) or '(none found)'}. Applied to: {', '.join(item['appliedToAviListSpecies']) or '(not applied)'}.")
    lines_out.append("")
    lines_out.append("## Observation remap")
    lines_out.append("")
    lines_out.append("Git `data/observations.json` is left as the backup. Live D1 is not modified by this change. A later deploy applies only the 1:1 renames in `data/scientific-name-remap.json`. Lumps, additions, and the two omitted China ranks are not written onto another species.")
    lines_out.append("")
    lines_out.append("Backup records that change name:")
    for item in obs_map:
        if item["relation"] != "same":
            lines_out.append(f"- `{item['from']}` -> `{item['to']}` ({item.get('zh') or ''} / {item.get('en') or ''})")
    if obs_hold:
        lines_out.append("")
        lines_out.append("Held back:")
        for item in obs_hold:
            lines_out.append(f"- {item['relation']} `{item['from']}`")
    else:
        lines_out.append("- No backup observation is a split, lump, or unmatched name. `Phylloscopus proregulus` is still the open-question name.")
    lines_out.append("")
    lines_out.append("Until that deploy, the page resolves a stored 1:1 old scientific name through the checklist synonym list, so those records still open on the AviList species. Names in the do-not-reassign lists are not synonyms and are not moved.")
    lines_out.append("")
    lines_out.append("Later, from the project root, after reading `data/scientific-name-remap.json`:")
    lines_out.append("")
    lines_out.append("```bash")
    lines_out.append("node scripts/remap-taxonomy.mjs")
    lines_out.append("node scripts/remap-taxonomy.mjs --local")
    lines_out.append("node scripts/remap-taxonomy.mjs --remote --confirm-remote")
    lines_out.append("```")
    lines_out.append("")
    lines_out.append("The first command only prints the plan. `--local` writes the local D1. `--remote` is refused unless `--confirm-remote` is also present. The script updates `observations.scientific_name`, `notes.scientific_name`, and an open-question scientific name. It does not change photo paths, logged names, `legacy_json`, and it does not run `migrate.mjs --replace`.")
    lines_out.append("")
    lines_out.append("## China filter lumps")
    lines_out.append("")
    lines_out.append("These IOC species are subspecies in AviList. The parent is the China-filter species. Records are not moved.")
    lines_out.append("")
    for item in china_lumps:
        flag = "parent already in the filter" if item["parentInOriginalChinaList"] else "parent added because this China species was lumped into it"
        lines_out.append(f"- `{item['from']}` {item['zh']} -> `{item['to']}` ({flag})")
    lines_out.append("")
    lines_out.append("## China filter held back")
    lines_out.append("")
    if not china_unmatched and not china_ambiguous:
        lines_out.append("Every previous China-filter name was an unchanged scientific name, a 1:1 rename, or one of the lumps above.")
    for item in china_unmatched:
        lines_out.append(f"- unmatched `{item['sci']}` {item.get('zh') or ''} {item.get('en') or ''}")
    for item in china_ambiguous:
        lines_out.append(f"- ambiguous `{item['sci']}` {item.get('zh') or ''} ({item.get('kind')})")
    lines_out.append("")
    lines_out.append("## 2021 China ranks omitted")
    lines_out.append("")
    for item in omitted_ranks:
        lines_out.append(f"- {item.get('zh')} `{', '.join(item.get('scientificNames') or [])}` class {item.get('rank')}: {item.get('reason')}")
    lines_out.append("")
    lines_out.append("## Weekly report")
    lines_out.append("")
    lines_out.append(report["weekly"]["note"])
    lines_out.append("")
    lines_out.append("## Chinese names")
    lines_out.append("")
    lines_out.append(f"{len(conflicts)} species keep the eBird zh_SIM name where it differs from the previous checklist. Every conflict is in `data/avilist-v2026-migration.json` under `chineseConflicts`. The previous name is kept as a search alias. {len(blank)} species has no Chinese name from either source and is left blank: {', '.join(blank) or '(none)'}.")
    lines_out.append("")
    (out / "avilist-v2026-migration.md").write_text("\n".join(lines_out) + "\n", encoding="utf-8")

    summary = {
        "species": len(lines),
        "orders": len(order_names),
        "families": len(family_names),
        "genera": len(genera),
        "blankZh": len(blank),
        "renames": len(renames),
        "lumps": len(lumps),
        "ambiguous": len(ambiguous),
        "unmatched": len(unmatched),
        "additions": len(additions),
        "zhConflicts": len(conflicts),
        "china": len(china_names),
        "chinaUnmatched": [item["sci"] for item in china_unmatched],
        "chinaAmbiguous": [item["sci"] for item in china_ambiguous],
        "obs": obs_map,
        "obsHold": obs_hold,
        "openQuestions": open_questions,
        "morning": morning_changes,
        "spotlight": spotlight,
        "blankOrders": blank_orders,
        "blankFamilies": blank_families,
        "ranks": len(ranks),
        "omittedRanks": len(omitted_ranks),
        "rankConflicts": rank_conflicts,
        "spelling": spelling,
        "platalea": by_sci_out.get("Platalea minor"),
        "uralensis": by_sci_out.get("Strix uralensis"),
        "canorus": by_sci_out.get("Garrulax canorus"),
        "davidiSpecies": "Strix davidi" in avi_by,
        "owstoniSpecies": "Garrulax owstoni" in avi_by,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
