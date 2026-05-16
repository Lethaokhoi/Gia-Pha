import { sanitizeAnhFocus } from "./photo-focus.js";

/** @typedef {{ id: string, hoTen: string, gioiTinh: string, ngaySinh: string, thangSinh: string, namSinh: string, namMat: string, chaId: string, meId: string, voChongId: string, ghiChu: string, anhUrl?: string, anhFocus?: string }} Member */

function byId(members) {
  const m = new Map();
  for (const p of members) m.set(p.id, p);
  return m;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBirthShort(p) {
  if (!p) return "";
  const d = (p.ngaySinh || "").trim();
  const mo = (p.thangSinh || "").trim();
  const y = (p.namSinh || "").trim();
  const dateStr = [d, mo, y].filter(Boolean).join("/");
  const bits = [];
  if (dateStr) bits.push(dateStr);
  if (p.namMat) bits.push(`†${p.namMat}`);
  return bits.join(" · ");
}

function initials(hoTen) {
  const parts = (hoTen || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  const a = parts[0][0] || "";
  const b = parts[parts.length - 1][0] || "";
  return (a + b).toUpperCase();
}

/** @param {Member | undefined} p @returns {[number, number, number]} */
function birthSortTuple(p) {
  if (!p) return [9999, 99, 99];
  const y = parseInt(String(p.namSinh || "").trim(), 10);
  const mo = parseInt(String(p.thangSinh || "").trim(), 10);
  const d = parseInt(String(p.ngaySinh || "").trim(), 10);
  return [
    Number.isFinite(y) ? y : 9999,
    Number.isFinite(mo) ? mo : 99,
    Number.isFinite(d) ? d : 99,
  ];
}

/** @param {[number, number, number]} ta @param {[number, number, number]} tb */
function compareBirthTuples(ta, tb) {
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return 0;
}

/** Sinh trước đứng trước (trái); thiếu ngày sinh xếp sau. */
function compareMemberBirthAsc(idA, idB, map) {
  const c = compareBirthTuples(birthSortTuple(map.get(idA)), birthSortTuple(map.get(idB)));
  if (c !== 0) return c;
  return (map.get(idA)?.hoTen || "").localeCompare(map.get(idB)?.hoTen || "", "vi");
}

/** @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} u */
function unitBirthTuple(u, map) {
  if (u.type === "single") return birthSortTuple(map.get(u.a));
  const ta = birthSortTuple(map.get(u.a));
  const tb = birthSortTuple(map.get(u.b));
  return compareBirthTuples(ta, tb) <= 0 ? ta : tb;
}

/** @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} uA @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} uB */
function compareUnitBirthAsc(uA, uB, map) {
  const c = compareBirthTuples(unitBirthTuple(uA, map), unitBirthTuple(uB, map));
  if (c !== 0) return c;
  const na =
    uA.type === "single"
      ? map.get(uA.a)?.hoTen || ""
      : `${map.get(uA.a)?.hoTen || ""} & ${map.get(uA.b)?.hoTen || ""}`;
  const nb =
    uB.type === "single"
      ? map.get(uB.a)?.hoTen || ""
      : `${map.get(uB.a)?.hoTen || ""} & ${map.get(uB.b)?.hoTen || ""}`;
  return na.localeCompare(nb, "vi");
}

/** @param {string[]} ids @param {Map<string, Member>} map */
function sortMemberIdsByBirth(ids, map) {
  return [...ids].sort((a, b) => compareMemberBirthAsc(a, b, map));
}

/** @param {'ca_hai' | 'noi' | 'ngoai'} s */
function normalizeTreeScope(s) {
  return s === "noi" || s === "ngoai" ? s : "ca_hai";
}

/**
 * Tập người hiển thị trên cây — theo phạm vi họ.
 * - **ca_hai**: tổ tiên (lên tối đa 7 bậc) cả cha lẫn mẹ, anh chị em đủ cả hai nhà, cô chú hai bên,
 *   vợ/chồng của mọi người trong tập, con cháu xuống 5 thế hệ.
 * - **noi**: chỉ nhánh **cha** (ông bà nội, họ nội, anh chị em cùng cha), không gồm mẹ và họ mẹ;
 *   vẫn gồm người gốc, vợ/chồng người gốc, con cháu trong tập.
 * - **ngoai**: đối xứng qua **mẹ** (không gồm cha và họ cha).
 * @param {Member[]} members
 * @param {string} focalId
 * @param {'ca_hai' | 'noi' | 'ngoai'} [treeScope]
 */
export function collectChartMembers(members, focalId, treeScope = "ca_hai") {
  const map = byId(members);
  const focal = map.get(focalId);
  if (!focal) return new Set();

  const scope = normalizeTreeScope(treeScope);
  const set = new Set();

  /** @param {string} [excludeSpouseId] không thêm người này làm vợ/chồng khi leo cây (ví dụ mẹ trong phạm vi nội). */
  function walkUp(id, depth, excludeSpouseId = "") {
    if (!id || depth > 7 || !map.get(id)) return;
    if (set.has(id)) return;
    set.add(id);
    const p = map.get(id);
    if (p.chaId) walkUp(p.chaId, depth + 1, excludeSpouseId);
    if (p.meId) walkUp(p.meId, depth + 1, excludeSpouseId);
    const spid = p.voChongId;
    if (spid && map.get(spid) && spid !== excludeSpouseId) set.add(spid);
  }

  /** @param {string} [excludeSpouseId] không kéo người này vào tập qua liên kết vợ/chồng. */
  function addSpouseClosure(excludeSpouseId = "") {
    let sp = true;
    while (sp) {
      sp = false;
      for (const id of [...set]) {
        const sid = map.get(id)?.voChongId;
        if (!sid || !map.get(sid) || sid === excludeSpouseId) continue;
        if (!set.has(sid)) {
          set.add(sid);
          sp = true;
        }
      }
    }
  }

  /** @param {string} [excludeSpouseId] */
  function addDescendantsFiveGen(excludeSpouseId = "") {
    let frontier = [...set];
    let depth = 0;
    while (depth < 5 && frontier.length) {
      const nf = [];
      for (const id of frontier) {
        for (const m of members) {
          if (!set.has(m.id) && (m.chaId === id || m.meId === id)) {
            set.add(m.id);
            nf.push(m.id);
          }
        }
      }
      for (const id of nf) {
        const sid = map.get(id)?.voChongId;
        if (sid && map.get(sid) && sid !== excludeSpouseId) set.add(sid);
      }
      frontier = nf;
      depth++;
    }
  }

  if (scope === "ca_hai") {
    walkUp(focalId, 0);

    for (const m of members) {
      if (m.id === focalId) continue;
      if (focal.chaId && m.chaId === focal.chaId) set.add(m.id);
      if (focal.meId && m.meId === focal.meId) set.add(m.id);
    }

    for (const pid of [focal.chaId, focal.meId]) {
      if (!pid || !map.get(pid)) continue;
      const par = map.get(pid);
      for (const m of members) {
        if (m.id === pid) continue;
        if (par.chaId && m.chaId === par.chaId) set.add(m.id);
        if (par.meId && m.meId === par.meId) set.add(m.id);
      }
    }
  } else if (scope === "noi") {
    const ex = focal.meId || "";
    set.add(focalId);
    if (focal.chaId && map.get(focal.chaId)) walkUp(focal.chaId, 0, ex);

    for (const m of members) {
      if (m.id === focalId) continue;
      if (focal.chaId && m.chaId === focal.chaId) set.add(m.id);
    }

    if (focal.chaId && map.get(focal.chaId)) {
      const par = map.get(focal.chaId);
      for (const m of members) {
        if (m.id === focal.chaId) continue;
        if (par.chaId && m.chaId === par.chaId) set.add(m.id);
        if (par.meId && m.meId === par.meId) set.add(m.id);
      }
    }
    addSpouseClosure(ex);
    addDescendantsFiveGen(ex);
  } else {
    /* ngoai */
    const ex = focal.chaId || "";
    set.add(focalId);
    if (focal.meId && map.get(focal.meId)) walkUp(focal.meId, 0, ex);

    for (const m of members) {
      if (m.id === focalId) continue;
      if (focal.meId && m.meId === focal.meId) set.add(m.id);
    }

    if (focal.meId && map.get(focal.meId)) {
      const par = map.get(focal.meId);
      for (const m of members) {
        if (m.id === focal.meId) continue;
        if (par.chaId && m.chaId === par.chaId) set.add(m.id);
        if (par.meId && m.meId === par.meId) set.add(m.id);
      }
    }
    addSpouseClosure(ex);
    addDescendantsFiveGen(ex);
  }

  if (scope === "ca_hai") {
    addSpouseClosure();
    addDescendantsFiveGen();
  }

  if (set.size > 200) {
    const arr = [...set];
    return new Set(arr.slice(0, 200));
  }

  return set;
}

/**
 * Thế hệ BFS từ người gốc: vợ/chồng cùng số, cha/mẹ -1, con +1.
 * @param {Set<string>} set
 * @param {string} focalId
 * @param {Map<string, Member>} map
 * @param {Member[]} members
 */
function computeGenerations(set, focalId, map, members) {
  const gen = new Map();
  const q = [focalId];
  gen.set(focalId, 0);

  for (let i = 0; i < q.length; i++) {
    const id = q[i];
    const g = gen.get(id);
    const p = map.get(id);
    if (!p) continue;

    const add = (nid, ng) => {
      if (!nid || !set.has(nid) || !map.get(nid)) return;
      if (!gen.has(nid)) {
        gen.set(nid, ng);
        q.push(nid);
      }
    };

    add(p.voChongId, g);
    add(p.chaId, g - 1);
    add(p.meId, g - 1);
    for (const m of members) {
      if (!set.has(m.id)) continue;
      if (m.chaId === id || m.meId === id) add(m.id, g + 1);
    }
  }

  for (const id of set) {
    if (!gen.has(id)) gen.set(id, 0);
  }
  return gen;
}

/** @param {Member[]} members @param {Member | undefined} p @param {boolean} isFocal */
function pedigreeCardHtml(members, p, isFocal) {
  if (!p) return "";
  const g = p.gioiTinh;
  let cls = "pedigree-card";
  if (g === "nu") cls += " pedigree-card--nu";
  else if (g === "nam") cls += " pedigree-card--nam";
  if (isFocal) cls += " pedigree-card--focal";

  const url = (p.anhUrl || "").trim();
  const pos = url ? sanitizeAnhFocus(p.anhFocus) : "";
  const posAttr = pos ? ` style="${escapeHtml(`--gp-photo-pos:${pos};`)}"` : "";
  const avatar = url
    ? `<div class="pedigree-photo-wrap"${posAttr}><img class="pedigree-photo" src="${escapeHtml(url)}" alt="${escapeHtml(
        p.hoTen || "Ảnh đại diện"
      )}" loading="lazy" decoding="async"></div>`
    : `<div class="pedigree-avatar" aria-hidden="true">${escapeHtml(initials(p.hoTen))}</div>`;

  const meta = escapeHtml(formatBirthShort(p));
  return `<article class="${cls}" data-id="${escapeHtml(p.id)}">${avatar}<div class="pedigree-card-body"><h5 class="pedigree-name">${escapeHtml(p.hoTen || "—")}</h5><p class="pedigree-meta">${meta}</p></div></article>`;
}

/**
 * @param {string[]} idsInGen
 * @param {Map<string, Member>} map
 */
/** Nam trước, nữ sau; còn lại theo id — để vợ chồng luôn kề nhau và thứ tự ổn định. */
function orderedCoupleIds(id1, id2, map) {
  const rank = (id) => {
    const g = map.get(id)?.gioiTinh;
    if (g === "nam") return 0;
    if (g === "nu") return 1;
    return 2;
  };
  const r1 = rank(id1);
  const r2 = rank(id2);
  if (r1 !== r2) return r1 < r2 ? [id1, id2] : [id2, id1];
  return id1 < id2 ? [id1, id2] : [id2, id1];
}

function buildUnitsForGen(idsInGen, map) {
  const sorted = sortMemberIdsByBirth(idsInGen, map);
  const used = new Set();
  /** @type {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }}[] */
  const units = [];

  for (const id of sorted) {
    if (used.has(id)) continue;
    const p = map.get(id);
    const sid = p?.voChongId;
    if (sid && sorted.includes(sid) && map.get(sid)) {
      used.add(id);
      used.add(sid);
      const [a, b] = orderedCoupleIds(id, sid, map);
      units.push({ type: "couple", a, b });
    } else {
      used.add(id);
      units.push({ type: "single", a: id });
    }
  }
  return units.sort((ua, ub) => compareUnitBirthAsc(ua, ub, map));
}

/** Khóa nhóm con: cùng cha+mẹ (hoặc chỉ một người). */
function parentClusterKeyForChild(child) {
  const c = (child.chaId || "").trim();
  const m = (child.meId || "").trim();
  if (c && m) return `pair:${[c, m].sort().join("|")}`;
  if (c) return `one:${c}`;
  if (m) return `one:${m}`;
  return "none";
}

/**
 * Gộp hai nhóm `one:A` và `one:B` khi A — B là vợ chồng (con chỉ gán cha hoặc chỉ mẹ).
 * @param {Map<string, string[]>} buckets
 * @param {Map<string, Member>} map
 */
function mergeSpouseOneParentBuckets(buckets, map) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [k, arr] of buckets) out.set(k, [...arr]);

  let changed = true;
  while (changed) {
    changed = false;
    const oneKeys = [...out.keys()].filter((k) => k.startsWith("one:"));
    for (const k1 of oneKeys) {
      if (!out.has(k1)) continue;
      const id1 = k1.slice(4);
      const sp = (map.get(id1)?.voChongId || "").trim();
      if (!sp || !map.get(sp)) continue;
      const k2 = `one:${sp}`;
      if (k1 === k2 || !out.has(k2)) continue;
      const pairKey = `pair:${[id1, sp].sort().join("|")}`;
      const combined = [...new Set([...(out.get(k1) || []), ...(out.get(k2) || [])])];
      out.delete(k1);
      out.delete(k2);
      if (out.has(pairKey)) {
        out.set(pairKey, [...new Set([...(out.get(pairKey) || []), ...combined])]);
      } else {
        out.set(pairKey, combined);
      }
      changed = true;
      break;
    }
  }
  return out;
}

/** Thứ tự cột sau khi gộp bucket (bám hàng thế hệ cha mẹ, rồi nhánh còn lại). */
function orderedBucketKeysForTier(buckets, parentUnits, map) {
  /** @type {string[]} */
  const order = [];
  const seen = new Set();
  for (const u of parentUnits) {
    const pk = parentKeyFromUnit(u);
    if ((buckets.get(pk) || []).length) {
      order.push(pk);
      seen.add(pk);
    }
  }
  const rest = [...buckets.keys()]
    .filter((k) => !seen.has(k) && (buckets.get(k) || []).length)
    .sort((a, b) => {
      const idsA = buckets.get(a) || [];
      const idsB = buckets.get(b) || [];
      const ea = sortMemberIdsByBirth(idsA, map)[0];
      const eb = sortMemberIdsByBirth(idsB, map)[0];
      if (!ea && !eb) return a.localeCompare(b, "vi");
      if (!ea) return 1;
      if (!eb) return -1;
      return compareMemberBirthAsc(ea, eb, map);
    });
  return [...order, ...rest];
}

function branchCaptionFromKey(key, map) {
  if (key === "none") return "Chưa gán cha/mẹ";
  if (key.startsWith("one:")) {
    const id = key.slice(4);
    const n = map.get(id)?.hoTen || id;
    return `Con của ${n}`;
  }
  if (key.startsWith("pair:")) {
    const [a, b] = key.slice(5).split("|");
    const na = map.get(a)?.hoTen || a;
    const nb = map.get(b)?.hoTen || b;
    return `Con của ${na} & ${nb}`;
  }
  return "";
}

function parentKeyFromUnit(u) {
  if (u.type === "couple") return `pair:${[u.a, u.b].sort().join("|")}`;
  return `one:${u.a}`;
}

/** Nhãn hàng thế hệ cha (khớp cột với hàng con bên dưới). */
function stripLabelForParentGen(parentG) {
  if (parentG === 0) return "Thế hệ người gốc (và vợ/chồng)";
  if (parentG < 0) return `Thế hệ ông bà (${-parentG} đời trên)`;
  return `Thế hệ con cháu (+${parentG})`;
}

function renderPedigreeUnitHtml(members, map, focalId, u) {
  if (u.type === "single") {
    return `<div class="pedigree-unit pedigree-unit--single">${pedigreeCardHtml(members, map.get(u.a), u.a === focalId)}</div>`;
  }
  return `<div class="pedigree-unit pedigree-unit--couple pedigree-couple-frame"><div class="pedigree-couple-inner">`
    + pedigreeCardHtml(members, map.get(u.a), u.a === focalId)
    + pedigreeCardHtml(members, map.get(u.b), u.b === focalId)
    + `</div></div>`;
}

function renderChildCardsRow(members, map, focalId, childIds) {
  let kidsInner = "";
  const units = buildUnitsForGen(childIds, map);
  for (const u of units) {
    kidsInner += renderPedigreeUnitHtml(members, map, focalId, u);
  }
  return kidsInner;
}

/** Chỉ nét nhóm anh em (gạch ngang trên + xuống), không vẽ “bố mẹ” trong khối thế hệ con. */
function svgChildGroupConnector(slotCount) {
  const stroke = "#5c4030";
  const sw = 1.15;
  const topY = 2;
  const bot = 22;
  if (slotCount <= 0) return "";
  if (slotCount === 1) {
    return `<svg class="pedigree-classic-tee pedigree-child-connector" viewBox="0 0 100 ${bot}" preserveAspectRatio="xMidYMin meet" aria-hidden="true"><line x1="50" y1="0" x2="50" y2="${bot}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
  }
  const xs = [];
  for (let i = 0; i < slotCount; i++) xs.push(((2 * i + 1) / (2 * slotCount)) * 100);
  let inner = `<line x1="${Math.min(...xs)}" y1="${topY}" x2="${Math.max(...xs)}" y2="${topY}" stroke="${stroke}" stroke-width="${sw}"/>`;
  for (const x of xs) {
    inner += `<line x1="${x}" y1="${topY}" x2="${x}" y2="${bot}" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  return `<svg class="pedigree-classic-tee pedigree-child-connector" viewBox="0 0 100 ${bot}" preserveAspectRatio="xMidYMin meet" aria-hidden="true">${inner}</svg>`;
}

/** Khối con: chú thích + nối nhóm + hàng thẻ (bố mẹ chỉ ở khối thế hệ trên / dòng vợ chồng). */
function offspringClassicBlock(members, map, focalId, ids, capEscaped) {
  if (!ids.length) return `<p class="pedigree-tier-empty">Chưa có con trong phần cây này</p>`;
  const units = buildUnitsForGen(ids, map);
  const slots = units.length;
  return `<p class="pedigree-branch-caption">${capEscaped}</p>`
    + `<div class="pedigree-classic-under">`
    + svgChildGroupConnector(slots)
    + `<div class="pedigree-branch-kids pedigree-branch-kids--classic">${renderChildCardsRow(members, map, focalId, ids)}</div>`
    + `</div>`;
}

/**
 * Dòng chú thích: các cặp vợ chồng (hoặc nhánh) ở thế hệ cha mẹ có con ở bậc này.
 * @param {Map<string, Member>} map
 * @param {string[]} parentIds
 * @param {string[]} childIds
 * @param {number} parentG số + của thế hệ cha mẹ (luôn >= 1 khi gọi)
 */
function spouseCouplesBridgeNote(map, parentIds, childIds, parentG) {
  /** @type {Map<string, string[]>} */
  const rawBuckets = new Map();
  for (const id of childIds) {
    const k = parentClusterKeyForChild(map.get(id) || {});
    if (!rawBuckets.has(k)) rawBuckets.set(k, [id]);
    else rawBuckets.get(k).push(id);
  }
  const merged = mergeSpouseOneParentBuckets(rawBuckets, map);
  const childKeys = new Set(merged.keys());
  if (!childKeys.size) return "";

  const parentUnits = buildUnitsForGen(parentIds, map);
  const usedKeys = new Set();
  /** @type {string[]} */
  const parts = [];

  for (const u of parentUnits) {
    const pk = parentKeyFromUnit(u);
    if (!childKeys.has(pk)) continue;
    usedKeys.add(pk);
    if (u.type === "couple") {
      const na = map.get(u.a)?.hoTen || "…";
      const nb = map.get(u.b)?.hoTen || "…";
      parts.push(`${na} & ${nb}`);
    } else {
      const p = map.get(u.a);
      if (!p) continue;
      const sid = (p.voChongId || "").trim();
      const sp = sid && parentIds.includes(sid) ? map.get(sid) : null;
      if (sp) {
        const na = p.hoTen || "…";
        const nb = sp.hoTen || "…";
        parts.push(`${na} & ${nb}`);
      } else {
        parts.push(p.hoTen || "…");
      }
    }
  }

  for (const key of childKeys) {
    if (usedKeys.has(key)) continue;
    parts.push(branchCaptionFromKey(key, map));
  }

  if (!parts.length) return "";
  const introHtml = `Bậc này nối xuống từ các cặp <strong>vợ chồng</strong> ở thế hệ con cháu (+${parentG}):`;
  const body = parts.map((t) => escapeHtml(t)).join(" · ");
  return `<p class="pedigree-tier-spouse-note"><span class="pedigree-tier-spouse-intro">${introHtml}</span> ${body}</p>`;
}

/**
 * Một bước xuống: hàng thế hệ cha (vợ chồng kề nhau) và hàng con (+N) dùng cùng lưới cột để khớp vị trí.
 * @param {Member[]} members
 * @param {Map<string, Member>} map
 * @param {string} focalId
 * @param {number} parentG
 * @param {number} childG
 * @param {Map<number, string[]>} byGen
 */
function renderDescentTier(members, map, focalId, parentG, childG, byGen) {
  const parentIds = byGen.get(parentG) || [];
  const childIds = byGen.get(childG) || [];
  if (!childIds.length) return "";

  const parentUnits = buildUnitsForGen(parentIds, map);
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  for (const id of childIds) {
    const k = parentClusterKeyForChild(map.get(id) || {});
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => compareMemberBirthAsc(a, b, map));
  }

  const mergedBuckets = mergeSpouseOneParentBuckets(buckets, map);
  const keys = orderedBucketKeysForTier(mergedBuckets, parentUnits, map);

  const covered = new Set();
  let cols = "";
  let parentCells = "";

  for (const u of parentUnits) {
    const pk = parentKeyFromUnit(u);
    covered.add(pk);
    const ids = mergedBuckets.get(pk) || [];
    const cap = escapeHtml(branchCaptionFromKey(pk, map));
    const kidsRow = offspringClassicBlock(members, map, focalId, ids, cap);
    parentCells += `<div class="pedigree-descent-pcell">${renderPedigreeUnitHtml(members, map, focalId, u)}</div>`;
    cols += `<div class="pedigree-tier-col" data-parent-key="${escapeHtml(pk)}">`;
    cols += `<div class="pedigree-tier-offspring">${kidsRow}</div>`;
    cols += `</div>`;
  }

  for (const key of keys) {
    if (covered.has(key)) continue;
    const ids = mergedBuckets.get(key) || [];
    if (!ids.length) continue;
    const cap = escapeHtml(branchCaptionFromKey(key, map));
    const kidsRow = offspringClassicBlock(members, map, focalId, ids, cap);
    parentCells += `<div class="pedigree-descent-pcell pedigree-descent-pcell--orphan" data-parent-key="${escapeHtml(key)}"><p class="pedigree-descent-orphan-cap">${cap}</p></div>`;
    cols += `<div class="pedigree-tier-col pedigree-tier-col--orphan" data-parent-key="${escapeHtml(key)}">`;
    cols += `<div class="pedigree-tier-offspring">${kidsRow}</div>`;
    cols += `</div>`;
  }

  let colCount = parentUnits.length;
  for (const key of keys) {
    if (covered.has(key)) continue;
    if (!(mergedBuckets.get(key) || []).length) continue;
    colCount++;
  }
  const nCols = Math.max(1, colCount);

  const childLabel = `Thế hệ con cháu (+${childG})`;
  const bridgeHtml =
    childG >= 2 && parentG >= 1 ? spouseCouplesBridgeNote(map, parentIds, childIds, parentG) : "";

  const tierBlock = `<div class="pedigree-tier-block" data-tier="${parentG}-to-${childG}">
    <div class="pedigree-tier-block-inner">
      <div class="pedigree-tier-gen-badge" title="Thế hệ con cháu (+${childG})">${childG}</div>
      <div class="pedigree-tier-block-body">
        <p class="pedigree-tier-block-label">${escapeHtml(childLabel)}</p>
        ${bridgeHtml}
        <div class="pedigree-tier pedigree-tier--aligned">${cols}</div>
      </div>
    </div>
  </div>`;

  const showParentStrip = parentG < 1;
  const stripBlock = showParentStrip
    ? `<div class="pedigree-descent-parent-strip">
    <p class="pedigree-descent-parent-label">${escapeHtml(stripLabelForParentGen(parentG))}</p>
    <div class="pedigree-descent-parent-grid">${parentCells}</div>
  </div>
  <div class="pedigree-descent-vbar" aria-hidden="true"></div>`
    : "";

  return `<div class="pedigree-descent-step" style="--ped-cols:${nCols}" data-tier-step="${parentG}-to-${childG}">
    ${stripBlock}
    ${tierBlock}
  </div>`;
}

/** Một khối thế hệ (ông bà / người gốc) — chỉ hàng thẻ. */
function renderGenRowOnly(members, map, focalId, ids) {
  const units = buildUnitsForGen(ids, map);
  let inner = "";
  for (const u of units) {
    inner += renderPedigreeUnitHtml(members, map, focalId, u);
  }
  return `<div class="pedigree-gen-row">${inner}</div>`;
}

/**
 * @param {Member[]} members
 * @param {string | null} focalId
 * @param {'ca_hai' | 'noi' | 'ngoai'} [treeScope]
 */
export function buildPedigreeHtml(members, focalId, treeScope = "ca_hai") {
  const map = byId(members);
  if (!focalId || !map.get(focalId)) {
    return "<p class=\"meta\">Chưa chọn người gốc.</p>";
  }

  const focal = map.get(focalId);
  const set = collectChartMembers(members, focalId, treeScope);
  const genMap = computeGenerations(set, focalId, map, members);

  let minG = 0;
  let maxG = 0;
  for (const id of set) {
    const g = genMap.get(id) ?? 0;
    minG = Math.min(minG, g);
    maxG = Math.max(maxG, g);
  }

  /** @type {Map<number, string[]>} */
  const byGen = new Map();
  for (let g = minG; g <= maxG; g++) byGen.set(g, []);
  for (const id of set) {
    const g = genMap.get(id) ?? 0;
    byGen.get(g).push(id);
  }

  /** @type {number[]} */
  const gensOrder = [];
  for (let g = minG; g <= maxG; g++) {
    const ids = byGen.get(g) || [];
    if (ids.length) gensOrder.push(g);
  }

  const hasPositiveDesc = gensOrder.some((x) => x >= 1);

  let rows = "";
  for (const g of gensOrder) {
    if (g >= 1) break;
    if (g === 0 && hasPositiveDesc) continue;
    const ids = byGen.get(g) || [];
    if (!ids.length) continue;
    const label =
      g === 0
        ? "Thế hệ người gốc (và vợ/chồng)"
        : `Thế hệ ông bà (${-g} đời trên)`;
    rows += `<div class="pedigree-gen" data-gen="${g}"><p class="pedigree-gen-label">${escapeHtml(label)}</p>${renderGenRowOnly(members, map, focalId, ids)}</div>`;
    rows += `<div class="pedigree-gen-connector" aria-hidden="true"></div>`;
  }

  if (hasPositiveDesc) {
    for (let childG = 1; childG <= maxG; childG++) {
      const cids = byGen.get(childG) || [];
      if (!cids.length) continue;
      const pG = childG - 1;
      const pids = byGen.get(pG) || [];
      if (pids.length) {
        rows += renderDescentTier(members, map, focalId, pG, childG, byGen);
      } else {
        const label = `Thế hệ con cháu (+${childG})`;
        rows += `<div class="pedigree-gen" data-gen="${childG}"><p class="pedigree-gen-label">${escapeHtml(label)}</p>${renderGenRowOnly(members, map, focalId, cids)}</div>`;
      }
      rows += `<div class="pedigree-gen-connector" aria-hidden="true"></div>`;
    }
  }

  while (/\s*<div class="pedigree-gen-connector"[^>]*><\/div>\s*$/m.test(rows)) {
    rows = rows.replace(/\s*<div class="pedigree-gen-connector"[^>]*><\/div>\s*$/m, "");
  }

  const bannerName = (focal.hoTen || "Gia đình").toUpperCase();
  const sc = normalizeTreeScope(treeScope);
  const scopeHint =
    sc === "noi"
      ? `<p class="meta pedigree-scope-hint">Phạm vi: <strong>nhà nội</strong> — tổ tiên theo cha, anh chị em cùng cha; không gồm mẹ và họ mẹ (vẫn có vợ/chồng của người trong tập).</p>`
      : sc === "ngoai"
        ? `<p class="meta pedigree-scope-hint">Phạm vi: <strong>nhà ngoại</strong> — tổ tiên theo mẹ, anh chị em cùng mẹ; không gồm cha và họ cha.</p>`
        : "";

  return `
<section class="pedigree-chart" aria-label="Cây gia phả">
  <header class="pedigree-banner">
    <div class="pedigree-banner-ornament pedigree-banner-ornament--left" aria-hidden="true"></div>
    <div class="pedigree-banner-center">
      <span class="pedigree-banner-kicker">Đại gia đình</span>
      <span class="pedigree-banner-title">${escapeHtml(bannerName)}</span>
    </div>
    <div class="pedigree-banner-ornament pedigree-banner-ornament--right" aria-hidden="true"></div>
  </header>
  <p class="pedigree-lead">Mỗi bậc <strong>chỉ</strong> ghi <strong>Thế hệ con cháu (+1), (+2)…</strong>; trong khối đó <strong>chỉ có con</strong> đúng bậc. Hàng thẻ cha mẹ <strong>khớp cột</strong> chỉ ở bước từ <strong>người gốc / ông bà</strong> xuống <strong>+1</strong>; từ <strong>+2</strong> có thêm dòng <strong>vợ chồng</strong> ở thế trên, không lặp thẻ cha mẹ phía trên khối. Con cùng cha hoặc cùng mẹ nhưng cha–mẹ là vợ chồng được gộp <strong>một cột</strong>. Thêm <strong>Ảnh URL</strong> nếu cần.</p>
  ${scopeHint}
  <div class="pedigree-rows-wrap">${rows}</div>
</section>`;
}

/** @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} u */
function unitKeyPrint(u) {
  if (u.type === "single") return `s:${u.a}`;
  return `c:${[u.a, u.b].sort().join("|")}`;
}

/** @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} u */
function parentIdSetFromUnit(u) {
  const s = new Set();
  if (u.type === "single") s.add(u.a);
  else {
    s.add(u.a);
    s.add(u.b);
  }
  return s;
}

function collectChildIdsForUnit(u, members, allowed, map) {
  const ps = parentIdSetFromUnit(u);
  const out = [];
  for (const m of members) {
    if (!allowed.has(m.id)) continue;
    if (ps.has(m.chaId) || ps.has(m.meId)) out.push(m.id);
  }
  return sortMemberIdsByBirth([...new Set(out)], map);
}

function printDiaCardHtml(map, id, focalId = "") {
  const p = map.get(id);
  if (!p) return "";
  const g = p.gioiTinh;
  let cls = "print-dia-card";
  if (g === "nu") cls += " print-dia-card--nu";
  else if (g === "nam") cls += " print-dia-card--nam";
  if (focalId && id === focalId) cls += " print-dia-card--focal";
  const url = (p.anhUrl || "").trim();
  const pos = url ? sanitizeAnhFocus(p.anhFocus) : "";
  const posAttr = pos ? ` style="${escapeHtml(`--gp-photo-pos:${pos};`)}"` : "";
  const photo = url
    ? `<div class="print-dia-photo"${posAttr}><img class="print-dia-photo-img" src="${escapeHtml(url)}" alt=""></div>`
    : `<div class="print-dia-photo print-dia-photo--ph">${escapeHtml(initials(p.hoTen))}</div>`;
  const meta = formatBirthShort(p);
  const metaHtml = meta ? `<p class="print-dia-meta">${escapeHtml(meta)}</p>` : "";
  return `<article class="${cls}" data-id="${escapeHtml(id)}">${photo}<p class="print-dia-name">${escapeHtml(p.hoTen || "—")}</p>${metaHtml}</article>`;
}

/** Cặp vợ chồng đầy đủ khi in: nếu chỉ một thẻ nhưng có voChongId thì vẫn vẽ hai thẻ. */
function printUnitRowWithSpouse(map, u, focalId = "") {
  if (u.type === "couple") return printUnitRowHtml(map, u, focalId);
  const p = map.get(u.a);
  const sid = (p?.voChongId || "").trim();
  if (sid && map.get(sid)) {
    const [a, b] = orderedCoupleIds(u.a, sid, map);
    return printUnitRowHtml(map, { type: "couple", a, b }, focalId);
  }
  return printUnitRowHtml(map, u, focalId);
}

/** @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} u */
function printUnitRowHtml(map, u, focalId = "") {
  if (u.type === "single") {
    return `<div class="print-dia-couple print-dia-couple--single">${printDiaCardHtml(map, u.a, focalId)}</div>`;
  }
  return `<div class="print-dia-couple">
    ${printDiaCardHtml(map, u.a, focalId)}
    ${printDiaCardHtml(map, u.b, focalId)}
  </div>`;
}

/**
 * @param {{ type: 'couple', a: string, b: string } | { type: 'single', a: string }} u
 * @param {Set<string>} visited
 */
function renderPrintSubtree(u, map, members, allowed, visited, focalId = "") {
  const key = unitKeyPrint(u);
  if (visited.has(key)) return "";
  visited.add(key);

  const row = `<div class="print-dia-row">${printUnitRowWithSpouse(map, u, focalId)}</div>`;

  const childIds = collectChildIdsForUnit(u, members, allowed, map);
  if (!childIds.length) {
    return `<div class="print-dia-node print-dia-node--leaf">${row}</div>`;
  }

  const childUnits = buildUnitsForGen(childIds, map);
  let cols = "";
  for (const cu of childUnits) {
    cols += `<div class="print-dia-col">${renderPrintSubtree(cu, map, members, allowed, visited, focalId)}</div>`;
  }

  return `<div class="print-dia-node">
    ${row}
    <div class="print-dia-descent">
      <div class="print-dia-parent-link" aria-hidden="true"><span class="print-dia-parent-vline"></span></div>
      <div class="print-dia-bridge" aria-hidden="true"><span class="print-dia-bar"></span></div>
      <div class="print-dia-children-scroll">
        <div class="print-dia-children">${cols}</div>
      </div>
    </div>
  </div>`;
}

/** @param {Member} focal @param {Map<string, Member>} map @param {Set<string>} allowed */
function focalAsStartUnit(focal, map) {
  const sid = (focal.voChongId || "").trim();
  if (sid && map.get(sid)) {
    const [a, b] = orderedCoupleIds(focal.id, sid, map);
    return { type: "couple", a, b };
  }
  return { type: "single", a: focal.id };
}

/**
 * Sơ đồ in dạng phả đứng: banner, thẻ ảnh + họ tên, nét đỏ từ cặp vợ chồng, nét ngang xuống từng nhánh con.
 * @param {Member[]} members
 * @param {string} focalId
 * @param {'ca_hai' | 'noi' | 'ngoai'} [treeScope]
 */
export function buildPrintDiagramHtml(members, focalId, treeScope = "ca_hai") {
  const map = byId(members);
  const focal = map.get(focalId);
  if (!focalId || !focal) return "";

  const allowed = collectChartMembers(members, focalId, treeScope);
  const genMap = computeGenerations(allowed, focalId, map, members);
  let minG = 0;
  let maxG = 0;
  for (const id of allowed) {
    const g = genMap.get(id) ?? 0;
    minG = Math.min(minG, g);
    maxG = Math.max(maxG, g);
  }

  /** @type {Map<number, string[]>} */
  const byGen = new Map();
  for (let g = minG; g <= maxG; g++) byGen.set(g, []);
  for (const id of allowed) {
    const g = genMap.get(id) ?? 0;
    byGen.get(g).push(id);
  }

  const title = (focal.hoTen || "Gia đình").toUpperCase();
  const sc = normalizeTreeScope(treeScope);
  const scopeLine =
    sc === "noi"
      ? "Phạm vi in: nhà nội (+ vợ/chồng trong tập)."
      : sc === "ngoai"
        ? "Phạm vi in: nhà ngoại (+ vợ/chồng trong tập)."
        : "Phạm vi in: cả hai họ.";

  let ancestorBlock = "";
  if (minG < 0) {
    ancestorBlock += `<div class="print-dia-ancestors" aria-label="Tổ tiên các đời trên">`;
    for (let g = minG; g <= -1; g++) {
      const ids = byGen.get(g) || [];
      if (!ids.length) continue;
      const units = buildUnitsForGen(ids, map);
      const label = `Ông bà (${-g} đời trên)`;
      let cells = "";
      for (const u of units) cells += printUnitRowWithSpouse(map, u, focalId);
      ancestorBlock += `<div class="print-dia-anc-tier"><p class="print-dia-tier-label">${escapeHtml(label)}</p><div class="print-dia-anc-row">${cells}</div></div>`;
      ancestorBlock += `<div class="print-dia-anc-gap" aria-hidden="true"></div>`;
    }
    ancestorBlock += `<div class="print-dia-anc-to-root" aria-hidden="true"></div>`;
    ancestorBlock += `</div>`;
  }

  const visited = new Set();
  const start = focalAsStartUnit(focal, map);
  const mainTree = renderPrintSubtree(start, map, members, allowed, visited, focalId);

  const g0 = byGen.get(0) || [];
  const focalPair = new Set([focal.id, (focal.voChongId || "").trim()].filter(Boolean));
  const peer0 = g0.filter((id) => !focalPair.has(id));
  let peerBlock = "";
  if (peer0.length) {
    const units = buildUnitsForGen(peer0, map);
    let cells = "";
    for (const u of units) cells += printUnitRowWithSpouse(map, u, focalId);
    peerBlock = `<div class="print-dia-peers"><p class="print-dia-tier-label">Cùng thế hệ với người gốc</p><div class="print-dia-anc-row">${cells}</div></div>`;
  }

  return `<article class="print-dia" lang="vi" aria-label="Sơ đồ gia phả in">
    <header class="print-dia-banner">
      <div class="print-dia-banner-deco" aria-hidden="true"></div>
      <div class="print-dia-banner-text">
        <span class="print-dia-banner-kicker">Đại gia đình</span>
        <span class="print-dia-banner-title">${escapeHtml(title)}</span>
      </div>
      <div class="print-dia-banner-deco print-dia-banner-deco--rev" aria-hidden="true"></div>
    </header>
    <p class="print-dia-sub">${escapeHtml(scopeLine)} Nhánh chính: người gốc và con cháu (mỗi cặp vợ chồng một cột xuống).</p>
    ${ancestorBlock}
    <div class="print-dia-main">${mainTree}</div>
    ${peerBlock}
  </article>`;
}
