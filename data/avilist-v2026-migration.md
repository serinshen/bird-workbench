# AviList v2026 migration

AviList Core Team. 2026. AviList: The Global Avian Checklist, v2026. https://doi.org/10.2173/avilist.v2026

The world list is AviList v2026 only. The China list is a filter on that list.

## Counts

- iocSpecies: 11064
- avilistSpecies: 11172
- avilistOrders: 45
- avilistFamilies: 250
- avilistGenera: 2379
- sameScientificName: 10891
- renames: 82
- lumps: 91
- ambiguous: 0
- unmatchedIocSpecies: 0
- avilistAdditions: 199
- englishNamesChangedOnSameScientificName: 77
- chineseConflicts: 468
- chineseCarriedAcrossRename: 0
- chineseBlank: 1
- ebirdParentheticalAliases: 38
- chinaIn: 1491
- chinaOut: 1482
- chinaSame: 1460
- chinaRenamed: 19
- chinaLumps: 12
- chinaUnmatched: 0
- chinaAmbiguous: 0
- china2021Entries: 394
- chinaRanksApplied: 392
- chinaRanksOmitted: 2
- chinaRankConflicts: 0
- iucnStoredNonLc: 2295
- iucnLcWithNationalProtection: 254
- iucnLcOmitted: 7748
- blankOrderChinese: Cathartiformes
- blankFamilyChinese: Mohoidae
- droppedAmbiguousSynonyms: (none)

## 四川林鸮 and 海南画眉

The 2021 list uses 四川林鸮, not 林鸨. AviList v2026 still treats both named taxa as subspecies, so their ranks are not copied onto the parent species.

- 四川林鸮 `Strix davidi` 2021 class I. AviList species: False. Subspecies of: Strix uralensis. Applied to: (not applied).
- 海南画眉 `Garrulax owstoni` 2021 class II. AviList species: False. Subspecies of: Garrulax canorus. Applied to: (not applied).

## Observation remap

Git `data/observations.json` is left as the backup. Live D1 is not modified by this change. A later deploy applies only the 1:1 renames in `data/scientific-name-remap.json`. Lumps, additions, and the two omitted China ranks are not written onto another species.

Backup records that change name:
- `Emberiza siemsseni` -> `Schoeniclus siemsseni` (蓝鹀 / Slaty Bunting)
- `Emberiza spodocephala` -> `Schoeniclus spodocephalus` (灰头鹀 / Black-faced Bunting)

No backup observation is a split, lump, or unmatched name. `Phylloscopus proregulus` is still the open-question name.

Until that deploy, the page resolves a stored 1:1 old scientific name through the checklist synonym list, so those records still open on the AviList species. Names in the do-not-reassign lists are not synonyms and are not moved.

Later, from the project root, after reading `data/scientific-name-remap.json`:

```bash
node scripts/remap-taxonomy.mjs
node scripts/remap-taxonomy.mjs --local
node scripts/remap-taxonomy.mjs --remote --confirm-remote
```

The first command only prints the plan. `--local` writes the local D1. `--remote` is refused unless `--confirm-remote` is also present. The script updates `observations.scientific_name`, `notes.scientific_name`, and an open-question scientific name. It does not change photo paths, logged names, `legacy_json`, and it does not run `migrate.mjs --replace`.

## China filter lumps

These IOC species are subspecies in AviList. The parent is the China-filter species. Records are not moved.

- `Anas carolinensis` 美洲绿翅鸭 -> `Anas crecca` (parent already in the filter)
- `Apus cooki` 印支白腰雨燕 -> `Apus pacificus` (parent already in the filter)
- `Apus nipalensis` 小白腰雨燕 -> `Apus affinis` (parent added because this China species was lumped into it)
- `Porphyrio indicus` 黑背紫水鸡 -> `Porphyrio porphyrio` (parent added because this China species was lumped into it)
- `Porphyrio melanotus` 澳洲紫水鸡 -> `Porphyrio porphyrio` (parent added because this China species was lumped into it)
- `Porphyrio poliocephalus` 紫水鸡 -> `Porphyrio porphyrio` (parent added because this China species was lumped into it)
- `Aegithalos bonvaloti` 黑眉长尾山雀 -> `Aegithalos iouschistos` (parent already in the filter)
- `Pericrocotus speciosus` 赤红山椒鸟 -> `Pericrocotus flammeus` (parent added because this China species was lumped into it)
- `Corvus cornix` 冠小嘴乌鸦 -> `Corvus corone` (parent already in the filter)
- `Corvus levaillantii` 丛林鸦 -> `Corvus macrorhynchos` (parent already in the filter)
- `Carpodacus lepidus` 中华长尾雀 -> `Carpodacus sibiricus` (parent already in the filter)
- `Saxicola stejnegeri` 东亚石䳭 -> `Saxicola maurus` (parent already in the filter)

## China filter held back

Every previous China-filter name was an unchanged scientific name, a 1:1 rename, or one of the lumps above.

## 2021 China ranks omitted

- 四川林鸮 `Strix davidi` class I: no AviList species match; omitted rather than applied to a parent or lookalike
- 海南画眉 `Garrulax owstoni` class II: no AviList species match; omitted rather than applied to a parent or lookalike

## Weekly report

Issue 1 says 黑脸琵鹭（EN）. That species is Platalea minor. AviList v2026 IUCN category is VU, and the rebuilt rank file stores VU. The published weekly sentence was left as written.

## Chinese names

468 species keep the eBird zh_SIM name where it differs from the previous checklist. Every conflict is in `data/avilist-v2026-migration.json` under `chineseConflicts`. The previous name is kept as a search alias. 1 species has no Chinese name from either source and is left blank: Sakesphorus pulchellus.

