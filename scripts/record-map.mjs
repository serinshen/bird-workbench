// Map a git-backup observation into the live record shape.
// seen and seen_heard become 看到 (stored as "seen").
// heard_only becomes 听到 (stored as "heard").
// 可疑 is true only when the backup record has tentative === true.

export function mapDetection(value) {
  if (value === "seen" || value === "seen_heard") return "seen";
  if (value === "heard" || value === "heard_only") return "heard";
  throw new Error("未知的观察方式：" + value);
}

export function mapSuspicious(record) {
  return !!(record && record.tentative === true);
}

export function mapRecord(record) {
  const detection = mapDetection(record.detection);
  const location = record.location && typeof record.location === "object" ? record.location : { place: "" };
  return {
    id: record.id,
    scientificName: record.scientificName,
    datetime: record.datetime,
    timezone: record.timezone || "Asia/Shanghai",
    detection,
    suspicious: mapSuspicious(record),
    sex: record.sex || null,
    place: location.place || "",
    location,
    notes: record.notes || null,
    habitat: record.habitat || null,
    weatherLight: record.weatherLight || null,
    sourceGroup: record.sourceGroup || null,
    loggedChinese: record.loggedChinese || null,
    loggedEnglish: record.loggedEnglish || null,
    openQuestion: record.openQuestion || null,
    photos: Array.isArray(record.photos) ? record.photos.slice() : [],
    photoMeta: record.photoMeta && typeof record.photoMeta === "object" ? record.photoMeta : {},
    legacy: record,
  };
}
