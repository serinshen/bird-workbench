// Record edits and list status. Status comes only from observation records.
(function (root) {
  function ensure(doc) {
    if (!doc || typeof doc !== "object") throw new Error("记录格式不对");
    if (!Array.isArray(doc.records)) doc.records = [];
    if (!Array.isArray(doc.favorites)) doc.favorites = [];
    return doc;
  }

  function includesSeen(rec) {
    var detection = rec && rec.detection;
    return detection === "seen" || detection === "seen_heard";
  }

  function isHeardOnly(rec) {
    var detection = rec && rec.detection;
    return detection === "heard" || detection === "heard_only";
  }

  // "seen" 已发现, "heard" 仅听到, "unseen" 未发现.
  function statusForRecords(records) {
    var list = [];
    if (Array.isArray(records)) {
      for (var i = 0; i < records.length; i++) if (records[i]) list.push(records[i]);
    }
    if (!list.length) return "unseen";
    for (var j = 0; j < list.length; j++) {
      if (includesSeen(list[j])) return "seen";
    }
    for (var k = 0; k < list.length; k++) {
      if (!isHeardOnly(list[k])) return "unseen";
    }
    return "heard";
  }

  function tally(species, bySci) {
    var seen = 0;
    var heard = 0;
    var list = species || [];
    for (var i = 0; i < list.length; i++) {
      var sci = list[i] && list[i].sci;
      var recs = bySci && typeof bySci.get === "function" ? bySci.get(sci) : null;
      var status = statusForRecords(recs);
      if (status === "seen") seen += 1;
      else if (status === "heard") heard += 1;
    }
    return { seen: seen, heard: heard, unseen: list.length - seen - heard };
  }

  function compare(a, b) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function sortKey(rec) {
    var match = String((rec && rec.datetime) || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?/);
    if (!match) return "9999-99-99T99:99:99" + ((rec && rec.id) || "");
    // Date-only records sort after clock times on that day.
    var clock = match[2] ? match[2] + ":" + (match[3] || "00") : "99:99:99";
    return match[1] + "T" + clock + ((rec && rec.id) || "");
  }

  function displayWhen(rec) {
    var match = String((rec && rec.datetime) || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!match) return { date: String((rec && rec.datetime) || ""), time: "" };
    return { date: match[1], time: match[2] ? match[2] + ":" + match[3] : "" };
  }

  function whenLine(rec) {
    var parts = displayWhen(rec);
    return parts.time ? parts.date + " " + parts.time : parts.date;
  }

  function phraseLine(rec) {
    var bits = [];
    if (rec && rec.sex === "female") bits.push("雌鸟");
    else if (rec && rec.sex === "male") bits.push("雄鸟");
    if (includesSeen(rec)) bits.push("看到");
    else if (isHeardOnly(rec)) bits.push("听到");
    if (rec && rec.suspicious) bits.push("可疑");
    return bits.filter(Boolean).join(" · ");
  }

  // Newest upload first. Records without an upload time fall back to observation time.
  function recentRank(rec) {
    if (rec && rec.uploadedAt) return "2" + rec.uploadedAt + " " + (rec.id || "");
    return "1" + sortKey(rec);
  }

  function recentSpecies(records, limit) {
    var list = (records || []).slice().sort(function (a, b) {
      return compare(recentRank(b), recentRank(a));
    });
    var seen = {};
    var out = [];
    var cap = limit == null ? 5 : limit;
    for (var i = 0; i < list.length; i++) {
      var sci = list[i] && list[i].scientificName;
      if (!sci || seen[sci]) continue;
      seen[sci] = true;
      out.push(list[i]);
      if (out.length >= cap) break;
    }
    return out;
  }

  function galleryEntries(doc) {
    var ensured = ensure({ records: (doc && doc.records) || [], favorites: (doc && doc.favorites) || [] });
    var byId = {};
    for (var i = 0; i < ensured.records.length; i++) {
      var rec = ensured.records[i];
      if (rec && rec.id) byId[rec.id] = rec;
    }
    var items = [];
    for (var j = 0; j < ensured.favorites.length; j++) {
      var fav = ensured.favorites[j];
      if (!fav || !fav.path) continue;
      var owner = byId[fav.observationId];
      if (!owner || !Array.isArray(owner.photos) || owner.photos.indexOf(fav.path) === -1) continue;
      items.push({
        path: fav.path,
        observationId: fav.observationId,
        at: fav.at || "",
        sort: sortKey(owner),
        rec: owner,
      });
    }
    items.sort(function (a, b) {
      return compare(b.sort, a.sort) || compare(a.path, b.path);
    });
    return items;
  }

  function findRecord(doc, observationId) {
    for (var i = 0; i < doc.records.length; i++) {
      if (doc.records[i] && doc.records[i].id === observationId) return doc.records[i];
    }
    return null;
  }

  function stillReferenced(doc, path, exceptId) {
    for (var i = 0; i < doc.records.length; i++) {
      var rec = doc.records[i];
      if (!rec || rec.id === exceptId || !Array.isArray(rec.photos)) continue;
      if (rec.photos.indexOf(path) !== -1) return true;
    }
    return false;
  }

  function dropFavorite(doc, observationId, path) {
    doc.favorites = doc.favorites.filter(function (item) {
      if (!item) return false;
      if (observationId && item.observationId === observationId && (path == null || item.path === path)) return false;
      if (!observationId && path && item.path === path) return false;
      return true;
    });
  }

  function isFavorite(doc, observationId, path) {
    var list = doc && Array.isArray(doc.favorites) ? doc.favorites : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item && item.observationId === observationId && item.path === path) return true;
    }
    return false;
  }

  function setFavorite(doc, observationId, path, on, at) {
    ensure(doc);
    var rec = findRecord(doc, observationId);
    if (!rec) return { error: "没有这条观察。" };
    var photos = Array.isArray(rec.photos) ? rec.photos : [];
    if (photos.indexOf(path) === -1) return { error: "这条观察里没有这张照片。" };
    var exists = isFavorite(doc, observationId, path);
    if (on) {
      if (exists) return { changed: false };
      doc.favorites.push({
        path: path,
        observationId: observationId,
        at: at || new Date().toISOString(),
      });
      return { changed: true };
    }
    if (!exists) return { changed: false };
    dropFavorite(doc, observationId, path);
    return { changed: true };
  }

  function removePhoto(doc, observationId, path) {
    ensure(doc);
    var rec = findRecord(doc, observationId);
    if (!rec) return { error: "没有这条观察。" };
    var photos = Array.isArray(rec.photos) ? rec.photos : [];
    if (photos.indexOf(path) === -1) return { error: "这条观察里没有这张照片。" };
    rec.photos = photos.filter(function (item) { return item !== path; });
    if (rec.photoMeta && typeof rec.photoMeta === "object") {
      delete rec.photoMeta[path];
      if (!Object.keys(rec.photoMeta).length) delete rec.photoMeta;
    }
    dropFavorite(doc, observationId, path);
    var orphan = !stillReferenced(doc, path, null);
    if (orphan) dropFavorite(doc, null, path);
    return { changed: true, orphanPaths: orphan ? [path] : [] };
  }

  function removeRecord(doc, observationId) {
    ensure(doc);
    var rec = findRecord(doc, observationId);
    if (!rec) return { error: "没有这条观察。" };
    var paths = Array.isArray(rec.photos) ? rec.photos.slice() : [];
    doc.records = doc.records.filter(function (item) { return item && item.id !== observationId; });
    dropFavorite(doc, observationId, null);
    var orphanPaths = [];
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      if (orphanPaths.indexOf(path) !== -1) continue;
      if (!stillReferenced(doc, path, null)) {
        orphanPaths.push(path);
        dropFavorite(doc, null, path);
      }
    }
    return { changed: true, orphanPaths: orphanPaths };
  }

  var api = {
    ensure: ensure,
    includesSeen: includesSeen,
    isHeardOnly: isHeardOnly,
    statusForRecords: statusForRecords,
    tally: tally,
    compare: compare,
    sortKey: sortKey,
    displayWhen: displayWhen,
    whenLine: whenLine,
    phraseLine: phraseLine,
    recentRank: recentRank,
    recentSpecies: recentSpecies,
    galleryEntries: galleryEntries,
    isFavorite: isFavorite,
    setFavorite: setFavorite,
    removePhoto: removePhoto,
    removeRecord: removeRecord,
  };
  root.WBRecords = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
