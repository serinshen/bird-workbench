(function () {
  function parsePack(pack) {
    if (!pack || typeof pack.r !== "string" || !Array.isArray(pack.o)) {
      throw new Error("名录格式不对");
    }
    const alias = new Map();
    if (pack.al) {
      for (const line of String(pack.al).split("\n")) {
        if (!line) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        alias.set(Number(line.slice(0, tab)), line.slice(tab + 1).split("|").filter(Boolean));
      }
    }
    const synByCurrent = new Map();
    if (pack.sy) {
      for (const line of String(pack.sy).split("\n")) {
        if (!line.trim()) continue;
        const tab = line.indexOf("\t");
        const current = line.slice(0, tab);
        const older = line.slice(tab + 1);
        if (!synByCurrent.has(current)) synByCurrent.set(current, []);
        synByCurrent.get(current).push(older);
      }
    }
    const lines = pack.r.split("\n").filter(Boolean);
    const species = lines.map((line, i) => {
      const p = line.split("\t");
      const order = Number(p[3]);
      const family = Number(p[4]);
      const genus = Number(p[5]);
      const authority = Number(p[6]);
      const genusName = pack.g[genus];
      const sci = genusName + " " + p[0];
      const zh = p[2] || "";
      return {
        i,
        epithet: p[0],
        sci,
        en: p[1] || "",
        zh,
        missingZh: zh === "",
        order,
        family,
        genus,
        genusName,
        authority: pack.au[authority] || "",
        aliasZh: alias.get(i) || [],
        syn: synByCurrent.get(sci) || [],
      };
    });
    const orders = pack.o.map((la, i) => ({ i, la, zh: pack.oz[i] || "" }));
    const families = pack.f.map((la, i) => ({
      i,
      la,
      en: pack.fe[i] || "",
      zh: pack.fz[i] || "",
      order: null,
    }));
    const genera = pack.g.map((la, i) => ({ i, la, family: null, order: null }));
    for (const sp of species) {
      if (families[sp.family].order == null) families[sp.family].order = sp.order;
      if (genera[sp.genus].family == null) {
        genera[sp.genus].family = sp.family;
        genera[sp.genus].order = sp.order;
      }
    }
    const mz = new Set(pack.mz || []);
    const blank = species.filter((sp) => sp.missingZh).map((sp) => sp.sci);
    const blankSet = new Set(blank);
    const mzOk = mz.size === blankSet.size && [...mz].every((name) => blankSet.has(name));
    return {
      tax: pack.tax,
      n: pack.n,
      parsedN: species.length,
      orders,
      families,
      genera,
      species,
      blankZh: blank.length,
      mzOk,
    };
  }

  async function loadPack(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("名录没有载入");
    const clean = (await res.text()).replace(/\s+/g, "");
    const raw = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));
    const pack = JSON.parse(await new Response(stream).text());
    return parsePack(pack);
  }

  window.WBChecklist = { parsePack, loadPack };
})();
