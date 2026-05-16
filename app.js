import { collectChartMembers, buildPrintDiagramHtml } from "./pedigree.js";
import { isCloudConfigured } from "./config.js";
import { saveFamilyState, subscribeFamily, uploadMemberAvatar } from "./cloud.js";
import { initAccountPanel, setSyncStatus } from "./account.js";
import {
  canAddMembers,
  showQuotaBlockedMessage,
  setCurrentBilling,
  getCurrentBilling,
} from "./billing.js";
import { sanitizeAnhFocus, detectFaceObjectPosition } from "./photo-focus.js";

const STORAGE_KEY = "giaPha_v1";
const STORAGE_BACKUP_KEY = "giaPha_v1_backup";

/** @type {string | null} Tài khoản đang đăng nhập — dữ liệu local tách theo user. */
let storageUserId = null;

export function setStorageUserId(userId) {
  storageUserId = userId || null;
}

function storageKey() {
  return storageUserId ? `${STORAGE_KEY}_${storageUserId}` : STORAGE_KEY;
}

function storageBackupKey() {
  return storageUserId ? `${STORAGE_BACKUP_KEY}_${storageUserId}` : STORAGE_BACKUP_KEY;
}

/**
 * @typedef {{
 *   id: string,
 *   hoTen: string,
 *   gioiTinh: string,
 *   ngaySinh: string,
 *   thangSinh: string,
 *   namSinh: string,
 *   namMat: string,
 *   chaId: string,
 *   meId: string,
 *   voChongId: string,
 *   ghiChu: string,
 *   anhUrl: string,
 *   anhFocus?: string
 * }} Member
 */

function uid() {
  return crypto.randomUUID?.() ?? `id_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** @param {any} m */
function normalizeMember(m) {
  const hoTen = String(m.hoTen ?? m.ten ?? "").trim();
  return {
    ...m,
    hoTen,
    id: String(m.id ?? "").trim(),
    ngaySinh: m.ngaySinh != null ? String(m.ngaySinh) : "",
    thangSinh: m.thangSinh != null ? String(m.thangSinh) : "",
    anhUrl: m.anhUrl != null ? String(m.anhUrl) : "",
    chaId: m.chaId != null ? String(m.chaId).trim() : "",
    meId: m.meId != null ? String(m.meId).trim() : "",
    voChongId: m.voChongId != null ? String(m.voChongId).trim() : "",
    anhFocus: sanitizeAnhFocus(m.anhFocus),
  };
}

/** @param {unknown} s @returns {'ca_hai' | 'noi' | 'ngoai'} */
function normalizeTreeScope(s) {
  return s === "noi" || s === "ngoai" ? s : "ca_hai";
}

/** @param {unknown} data */
function parseStoredState(data) {
  if (!data || typeof data !== "object") return null;
  if (!Array.isArray(data.members)) return null;
  return {
    members: data.members.map(normalizeMember),
    focalId: data.focalId ?? null,
    treeScope: normalizeTreeScope(data.treeScope),
  };
}

function loadState() {
  const empty = { members: [], focalId: null, treeScope: "ca_hai" };
  /** @param {string} key */
  const tryKey = (key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return parseStoredState(JSON.parse(raw));
    } catch {
      return null;
    }
  };
  const main = tryKey(storageKey());
  if (main) return main;
  const backup = tryKey(storageBackupKey());
  if (backup) return backup;
  return empty;
}

/** @param {{ members: unknown[], focalId: string | null, treeScope?: string }} data */
export function replaceAppState(data) {
  state = {
    members: Array.isArray(data.members) ? data.members.map(normalizeMember) : [],
    focalId: data.focalId ?? null,
    treeScope: normalizeTreeScope(data.treeScope),
  };
}

/** @type {{ familyId: string | null, updatedAt: string | null, unsub: (() => void) | null }} */
const cloudMeta = { familyId: null, updatedAt: null, unsub: null };

let cloudSaveTimer = null;
let cloudSaveInFlight = false;

function payloadFromState(state) {
  return {
    members: Array.isArray(state.members) ? state.members : [],
    focalId: state.focalId ?? null,
    treeScope: normalizeTreeScope(state.treeScope),
  };
}

function saveStateLocal(state) {
  try {
    const key = storageKey();
    const backupKey = storageBackupKey();
    const prevRaw = localStorage.getItem(key);
    if (prevRaw) {
      try {
        const prev = parseStoredState(JSON.parse(prevRaw));
        if (prev && prev.members.length > 0) {
          localStorage.setItem(backupKey, prevRaw);
        }
      } catch {
        /* bỏ qua bản trước không đọc được */
      }
    }
    localStorage.setItem(key, JSON.stringify(payloadFromState(state)));
    return true;
  } catch (e) {
    console.error("Không lưu được localStorage (hết dung lượng hoặc trình duyệt chặn):", e);
    alert(
      "Không lưu được dữ liệu trên trình duyệt (thường do hết dung lượng hoặc chế độ riêng tư). Thử xuất file JSON ngay. Chi tiết: "
        + (e?.message || e)
    );
    return false;
  }
}

async function pushStateToCloud(state) {
  if (!cloudMeta.familyId || !isCloudConfigured()) return;
  if (cloudSaveInFlight) return;
  cloudSaveInFlight = true;
  setSyncStatus("Đang lưu lên đám mây…", "sync");
  try {
    const result = await saveFamilyState(cloudMeta.familyId, payloadFromState(state), cloudMeta.updatedAt);
    if (result.conflict) {
      setSyncStatus("Có người vừa sửa trước — vào tab Tài khoản → Tải bản mới.", "err");
      return;
    }
    cloudMeta.updatedAt = result.updatedAt;
    setSyncStatus("Đã đồng bộ lên đám mây.", "ok");
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e);
    if (msg.includes("Nâng cấp") || msg.includes("tối đa")) {
      showQuotaBlockedMessage(1);
    }
    setSyncStatus("Lỗi đồng bộ: " + msg, "err");
  } finally {
    cloudSaveInFlight = false;
  }
}

function scheduleCloudSave(state) {
  if (!cloudMeta.familyId || !isCloudConfigured()) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => pushStateToCloud(state), 700);
}

function saveState(state) {
  const ok = saveStateLocal(state);
  if (ok) scheduleCloudSave(state);
  return ok;
}

function setCloudMeta(meta) {
  if (cloudMeta.unsub) {
    cloudMeta.unsub();
    cloudMeta.unsub = null;
  }
  cloudMeta.familyId = meta.familyId;
  cloudMeta.updatedAt = meta.updatedAt;
  if (meta.familyId && isCloudConfigured()) {
    cloudMeta.unsub = subscribeFamily(meta.familyId, ({ state: remote, updatedAt }) => {
      if (updatedAt === cloudMeta.updatedAt) return;
      if (cloudSaveInFlight) return;
      if (isMemberFormDirty()) {
        saveMemberFormDraft();
        cloudMeta.updatedAt = updatedAt;
        return;
      }
      if (!confirm("Gia phả trên máy chủ vừa được cập nhật (người khác đang sửa). Tải bản mới?")) return;
      cloudMeta.updatedAt = updatedAt;
      const parsed = parseStoredState({
        members: remote.members,
        focalId: remote.focalId,
        treeScope: remote.treeScope,
      });
      if (parsed) applyRestoredState(parsed, { skipCloud: true });
    });
  }
}

/** @param {Member[]} members */
function byId(members) {
  const m = new Map();
  for (const p of members) m.set(p.id, p);
  return m;
}

/** @param {Member} a @param {Member} b */
function linkSpouse(a, b) {
  if (!a || !b || a.id === b.id) return;
  a.voChongId = b.id;
  b.voChongId = a.id;
}

/**
 * Nếu cha và mẹ đều có nhưng chưa là vợ/chồng của nhau (và chưa có vợ chồng khác), tự liên kết.
 * @param {Member} child
 * @param {Map<string, Member>} map
 */
function maybeLinkParentsAsSpouseFromChild(child, map) {
  const cid = child.chaId;
  const mid = child.meId;
  if (!cid || !mid) return;
  const cha = map.get(cid);
  const me = map.get(mid);
  if (!cha || !me) return;
  if (cha.voChongId && cha.voChongId !== mid) return;
  if (me.voChongId && me.voChongId !== cid) return;
  linkSpouse(cha, me);
}

/** @param {Member[]} members @param {string} parentId */
function childrenOf(members, parentId) {
  return members.filter((p) => p.chaId === parentId || p.meId === parentId);
}

/**
 * Đi ngược cha/mẹ từ startId: upper có xuất hiện trên chuỗi tổ tiên của startId không.
 * @param {string} upper
 * @param {string} startId
 * @param {Map<string, Member>} map
 */
function isAncestorOf(upper, startId, map) {
  const seen = new Set();
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (cur === upper) return true;
    const p = map.get(cur);
    if (p?.chaId) stack.push(p.chaId);
    if (p?.meId) stack.push(p.meId);
  }
  return false;
}

/**
 * @param {Map<string, Member>} map
 * @param {string} startId
 * @returns {string[][]}
 */
function ancestorGenerations(map, startId) {
  const gens = [];
  let frontier = [startId];
  const seen = new Set(frontier);

  while (frontier.length) {
    const parents = [];
    for (const id of frontier) {
      const p = map.get(id);
      if (!p) continue;
      if (p.chaId && !seen.has(p.chaId)) {
        seen.add(p.chaId);
        parents.push(p.chaId);
      }
      if (p.meId && !seen.has(p.meId)) {
        seen.add(p.meId);
        parents.push(p.meId);
      }
    }
    if (!parents.length) break;
    gens.push(parents);
    frontier = parents;
  }
  return gens;
}

/** @param {Member[]} members @param {string} startId */
function descendantGenerations(members, startId) {
  const map = byId(members);
  const gens = [];
  let frontier = [startId];
  const seen = new Set();

  while (frontier.length) {
    const next = [];
    for (const pid of frontier) {
      for (const c of childrenOf(members, pid)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        next.push(c.id);
      }
    }
    if (!next.length) break;
    gens.push(next);
    frontier = next;
  }
  return gens;
}

/** @param {Member | undefined} p */
function formatBirthLine(p) {
  if (!p) return "";
  const d = (p.ngaySinh || "").trim();
  const mo = (p.thangSinh || "").trim();
  const y = (p.namSinh || "").trim();
  const dateParts = [d, mo, y].filter(Boolean);
  const dateStr = dateParts.length ? dateParts.join("/") : "";
  const parts = [];
  if (p.gioiTinh === "nam") parts.push("Nam");
  else if (p.gioiTinh === "nu") parts.push("Nữ");
  if (dateStr) parts.push(`Sinh ${dateStr}`);
  if (p.namMat) parts.push(`Mất ${p.namMat}`);
  return parts.join(" · ");
}

/** @param {Member | undefined} p */
function formatMeta(p) {
  return formatBirthLine(p);
}

/** @param {Member | undefined} p @param {boolean} focal */
function personHtml(p, focal) {
  if (!p) return "";
  const cls = focal ? "person-node focal" : "person-node";
  const noteText = p.ghiChu
    ? escapeHtml(p.ghiChu.slice(0, 120)).replace(/\n/g, " ") + (p.ghiChu.length > 120 ? "…" : "")
    : "";
  const note = noteText ? `<p class="meta">${noteText}</p>` : "";
  return `<div class="${cls}"><p class="name">${escapeHtml(p.hoTen || "(Không tên)")}</p><p class="meta">${escapeHtml(formatMeta(p))}</p>${note}</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Một cột họ hàng: chỉ các đời **trên** cha hoặc mẹ (không gồm bố/mẹ trực tiếp).
 * @param {Map<string, Member>} map
 * @param {string} colClass
 * @param {string} title
 * @param {string} subtitle
 * @param {string} parentOfFocalId id cha hoặc mẹ của người gốc
 * @param {string} emptyHint
 */
function renderAncestorSideHtml(map, colClass, title, subtitle, parentOfFocalId, emptyHint) {
  let html = `<div class="ancestor-col ${colClass}">`;
  html += `<h4 class="ancestor-col-title">${escapeHtml(title)}</h4>`;
  html += `<p class="ancestor-col-sub">${escapeHtml(subtitle)}</p>`;

  if (!parentOfFocalId) {
    html += `<p class="meta ancestor-col-empty">${escapeHtml(emptyHint)}</p></div>`;
    return html;
  }

  const gens = ancestorGenerations(map, parentOfFocalId);
  if (gens.length) {
    html += `<p class="gen-title gen-title-inner">Đời trên (xa → gần)</p>`;
    for (let i = gens.length - 1; i >= 0; i--) {
      html += `<div class="gen-row">`;
      for (const id of gens[i]) html += personHtml(map.get(id), false);
      html += `</div>`;
    }
  } else {
    const par = map.get(parentOfFocalId);
    const name = par?.hoTen || "cha/mẹ";
    html += `<p class="meta ancestor-col-empty">Chưa ghi thêm tổ tiên phía trên ${escapeHtml(name)} (ông bà, cố…).</p>`;
  }

  html += `</div>`;
  return html;
}

/** Thẻ placeholder khi chưa gán cha/mẹ hoặc ngoài phạm vi cây */
function parentPlaceholderHtml(label, hint = "Chưa gán trong Thành viên") {
  return `<div class="person-node person-placeholder"><p class="name">${escapeHtml(label)}</p><p class="meta">${escapeHtml(hint)}</p></div>`;
}

/** Bản nội/ngoại + cha mẹ + con cháu (in kèm dưới cây thẻ). @param {'ca_hai' | 'noi' | 'ngoai'} treeScope */
function buildLegacyTreeDetailHtml(members, focalId, treeScope = "ca_hai") {
  const map = byId(members);
  const focal = map.get(focalId);
  if (!focal) return "";

  const scope = normalizeTreeScope(treeScope);
  const allowed = collectChartMembers(members, focalId, scope);

  const fatherId = focal.chaId || "";
  const motherId = focal.meId || "";
  const descGensRaw = descendantGenerations(members, focalId);
  const descGens = descGensRaw.map((ids) => ids.filter((id) => allowed.has(id)));

  let html = `<div class="tree-supplement">`;
  html += `<h3 class="tree-supplement-title">Bản chi tiết (in kèm)</h3>`;
  if (scope === "ca_hai") {
    html += `<p class="meta tree-supplement-lead">Họ hàng tổ tiên xa (nội / ngoại), cha mẹ trực tiếp và danh sách con cháu — bổ sung cho cây thẻ phía trên.</p>`;
  } else if (scope === "noi") {
    html += `<p class="meta tree-supplement-lead">Chỉ <strong>nhà nội</strong>: tổ tiên theo cha, anh chị em cùng cha, vợ/chồng của những người trong tập; <strong>không</strong> gồm mẹ và họ mẹ.</p>`;
  } else {
    html += `<p class="meta tree-supplement-lead">Chỉ <strong>nhà ngoại</strong>: tổ tiên theo mẹ, anh chị em cùng mẹ, vợ/chồng của những người trong tập; <strong>không</strong> gồm cha và họ cha.</p>`;
  }

  html += `<div class="gen-block ancestors-split">`;
  if (scope === "ca_hai") {
    html += `<p class="gen-title">Họ hàng (tổ tiên xa) — bên nội / bên ngoại</p>`;
    html += `<p class="meta ancestors-split-note">Chỉ các đời <strong>trên</strong> cha hoặc mẹ. Bố mẹ trực tiếp nằm ở khối <strong>Cha mẹ của người gốc</strong> bên dưới.</p>`;
    html += `<div class="ancestors-two-cols">`;
    html += renderAncestorSideHtml(
      map,
      "ancestor-col--noi",
      "Bên nội",
      "Họ nhà nội: ông bà cố, cố cố… (không gồm cha ruột)",
      fatherId,
      "Chưa gán cha cho người gốc — không thể hiện nhánh nội."
    );
    html += renderAncestorSideHtml(
      map,
      "ancestor-col--ngoai",
      "Bên ngoại",
      "Họ nhà ngoại: ông bà cố, cố cố… (không gồm mẹ ruột)",
      motherId,
      "Chưa gán mẹ cho người gốc — không thể hiện nhánh ngoại."
    );
    html += `</div></div>`;
  } else if (scope === "noi") {
    html += `<p class="gen-title">Họ hàng (tổ tiên xa) — bên nội</p>`;
    html += `<p class="meta ancestors-split-note">Chỉ các đời <strong>trên cha</strong> (không gồm cha ruột trong cột này). Nhà ngoại không hiển thị khi chọn phạm vi này.</p>`;
    html += `<div class="ancestors-two-cols ancestors-two-cols--single">`;
    html += renderAncestorSideHtml(
      map,
      "ancestor-col--noi",
      "Bên nội",
      "Họ nhà nội: ông bà cố, cố cố… (không gồm cha ruột)",
      fatherId,
      "Chưa gán cha cho người gốc — không thể hiện nhánh nội."
    );
    html += `</div></div>`;
  } else {
    html += `<p class="gen-title">Họ hàng (tổ tiên xa) — bên ngoại</p>`;
    html += `<p class="meta ancestors-split-note">Chỉ các đời <strong>trên mẹ</strong> (không gồm mẹ ruột trong cột này). Nhà nội không hiển thị khi chọn phạm vi này.</p>`;
    html += `<div class="ancestors-two-cols ancestors-two-cols--single">`;
    html += renderAncestorSideHtml(
      map,
      "ancestor-col--ngoai",
      "Bên ngoại",
      "Họ nhà ngoại: ông bà cố, cố cố… (không gồm mẹ ruột)",
      motherId,
      "Chưa gán mẹ cho người gốc — không thể hiện nhánh ngoại."
    );
    html += `</div></div>`;
  }

  html += `<div class="gen-block parents-direct">`;
  html += `<p class="gen-title">Cha mẹ của người gốc</p>`;
  if (scope === "ca_hai") {
    html += `<p class="meta parents-direct-hint">Đây là <strong>bố mẹ trực tiếp</strong> của người được chọn làm gốc — tách với họ hàng ở phần trên.</p>`;
    html += `<div class="gen-row pair parents-direct-row">`;
    html += fatherId ? personHtml(map.get(fatherId), false) : parentPlaceholderHtml("Cha");
    html += motherId ? personHtml(map.get(motherId), false) : parentPlaceholderHtml("Mẹ");
    html += `</div></div>`;
  } else if (scope === "noi") {
    html += `<p class="meta parents-direct-hint">Phạm vi <strong>nhà nội</strong>: chỉ hiện <strong>cha</strong>; mẹ và họ mẹ không nằm trong cây này.</p>`;
    html += `<div class="gen-row pair parents-direct-row">`;
    html += fatherId ? personHtml(map.get(fatherId), false) : parentPlaceholderHtml("Cha");
    html += parentPlaceholderHtml("Mẹ (ngoài phạm vi)", "Không nằm trong phạm vi nhà nội");
    html += `</div></div>`;
  } else {
    html += `<p class="meta parents-direct-hint">Phạm vi <strong>nhà ngoại</strong>: chỉ hiện <strong>mẹ</strong>; cha và họ cha không nằm trong cây này.</p>`;
    html += `<div class="gen-row pair parents-direct-row">`;
    html += parentPlaceholderHtml("Cha (ngoài phạm vi)", "Không nằm trong phạm vi nhà ngoại");
    html += motherId ? personHtml(map.get(motherId), false) : parentPlaceholderHtml("Mẹ");
    html += `</div></div>`;
  }

  html += `<div class="gen-block"><p class="gen-title">Người gốc &amp; vợ/chồng</p><div class="gen-row pair">`;
  html += personHtml(focal, true);
  if (focal.voChongId) {
    const s = map.get(focal.voChongId);
    if (s && allowed.has(focal.voChongId)) html += personHtml(s, false);
  }
  html += `</div></div>`;

  const descNonEmpty = descGens.some((ids) => ids.length);
  if (descNonEmpty) {
    html += `<div class="gen-block children-block"><p class="label">Con cháu theo thế hệ (trong phạm vi đã chọn)</p>`;
    descGens.forEach((ids, idx) => {
      if (!ids.length) return;
      html += `<p class="gen-title">Thế hệ ${idx + 1}</p><div class="gen-row">`;
      for (const id of ids) html += personHtml(map.get(id), false);
      html += `</div>`;
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

/** @param {Member[]} members @param {string | null} focalId */
function renderTree(members, focalId) {
  const map = byId(members);
  const el = document.getElementById("tree-display");
  const cap = document.getElementById("print-caption");
  if (!focalId || !map.get(focalId)) {
    el.innerHTML = "<p class=\"meta\">Chưa chọn người gốc hoặc chưa có dữ liệu. Thêm thành viên và chọn \"Gốc xem cây\".</p>";
    cap.textContent = "";
    return;
  }

  const focal = map.get(focalId);
  const scope = normalizeTreeScope(state.treeScope);
  const scopeLabel =
    scope === "noi" ? " — Phạm vi: nhà nội" : scope === "ngoai" ? " — Phạm vi: nhà ngoại" : "";
  cap.textContent = `Gốc: ${focal.hoTen}${scopeLabel} — In ngày ${new Date().toLocaleDateString("vi-VN")}`;

  try {
    el.innerHTML = `<div class="tree-print-diagram">${buildPrintDiagramHtml(members, focalId, scope)}</div><div class="tree-on-screen-pedigree">${buildLegacyTreeDetailHtml(members, focalId, scope)}</div>`;
  } catch (e) {
    console.error(e);
    el.innerHTML = `<p class="meta">Lỗi khi vẽ cây (dữ liệu thành viên vẫn còn trong trình duyệt). Thử tab <strong>Sao lưu</strong> → Khôi phục bản sao, hoặc tải lại trang. Chi tiết: ${escapeHtml(String(e?.message || e))}</p>`;
  }
}

// --- UI ---
/** Bắt đầu trống khi dùng đám mây; tải theo user sau khi đăng nhập. */
let state = isCloudConfigured()
  ? { members: [], focalId: null, treeScope: "ca_hai" }
  : loadState();

const memberList = document.getElementById("member-list");
const form = document.getElementById("member-form");
const focalSelect = document.getElementById("focal-select");
const treeFocal = document.getElementById("tree-focal");
const treeScopeSelect = document.getElementById("tree-scope");
const formTitle = document.getElementById("form-title");

const fId = document.getElementById("f-id");
const fName = document.getElementById("f-name");
const fAvatarUrl = document.getElementById("f-avatar-url");
const fAvatarFocus = document.getElementById("f-avatar-focus");
const btnAvatarAutoFocus = document.getElementById("btn-avatar-auto-focus");
const fAvatarFile = document.getElementById("f-avatar-file");
const fAvatarPreview = document.getElementById("f-avatar-preview");
const btnAvatarUpload = document.getElementById("btn-avatar-upload");
const avatarUploadStatus = document.getElementById("avatar-upload-status");
const fGender = document.getElementById("f-gender");
const fBirthDay = document.getElementById("f-birth-day");
const fBirthMonth = document.getElementById("f-birth-month");
const fBirth = document.getElementById("f-birth");
const fDeath = document.getElementById("f-death");
const fFather = document.getElementById("f-father");
const fMother = document.getElementById("f-mother");
const fSpouse = document.getElementById("f-spouse");
const fNote = document.getElementById("f-note");
const btnDelete = document.getElementById("btn-delete");
const childrenNewRows = document.getElementById("children-new-rows");
const existingChildren = document.getElementById("existing-children");
const existingChildSelect = document.getElementById("existing-child-select");
const pendingExistingList = document.getElementById("pending-existing-children");

let editingId = null;
/** @type {string[]} */
let pendingExistingChildIds = [];
/** Tab ứng dụng đang mở (members | tree | backup) */
let activeAppTab = "members";
let memberFormDraftTimer = 0;

function memberFormDraftKey() {
  const uid = storageUserId || "local";
  const fid = cloudMeta.familyId || "local";
  return `giaPha_formDraft_${uid}_${fid}`;
}

/** @param {ReturnType<typeof captureMemberFormDraft>} draft */
function isDraftMeaningful(draft) {
  if (!draft) return false;
  if ((draft.hoTen || "").trim()) return true;
  if (draft.gioiTinh || draft.ngaySinh || draft.thangSinh || draft.namSinh || draft.namMat) return true;
  if (draft.chaId || draft.meId || draft.voChongId) return true;
  if ((draft.anhUrl || "").trim() || (draft.ghiChu || "").trim()) return true;
  if ((draft.newChildRows || []).length) return true;
  if ((draft.pendingExistingChildIds || []).length) return true;
  return false;
}

function captureMemberFormDraft() {
  return {
    v: 1,
    memberId: fId.value || editingId || "",
    mode: fId.value || editingId ? "edit" : "new",
    hoTen: fName.value,
    gioiTinh: fGender.value,
    ngaySinh: String(fBirthDay.value ?? ""),
    thangSinh: String(fBirthMonth.value ?? ""),
    namSinh: fBirth.value,
    namMat: fDeath.value,
    chaId: fFather.value || "",
    meId: fMother.value || "",
    voChongId: fSpouse.value || "",
    anhUrl: fAvatarUrl?.value || "",
    anhFocus: fAvatarFocus?.value || "",
    ghiChu: fNote.value,
    newChildRows: collectNewChildRows(),
    pendingExistingChildIds: [...pendingExistingChildIds],
    savedAt: Date.now(),
  };
}

/** @param {ReturnType<typeof captureMemberFormDraft>} draft */
function applyMemberFormDraft(draft) {
  if (!draft || draft.v !== 1) return false;

  editingId = draft.mode === "edit" && draft.memberId ? draft.memberId : null;
  fId.value = draft.memberId || "";
  formTitle.textContent = draft.mode === "edit" ? "Sửa thông tin" : "Thêm người";
  btnDelete.disabled = !draft.memberId;

  fName.value = draft.hoTen || "";
  fGender.value = draft.gioiTinh || "";
  fBirthDay.value = draft.ngaySinh || "";
  fBirthMonth.value = draft.thangSinh || "";
  fBirth.value = draft.namSinh || "";
  fDeath.value = draft.namMat || "";
  fNote.value = draft.ghiChu || "";
  if (fAvatarUrl) fAvatarUrl.value = draft.anhUrl || "";
  if (fAvatarFocus) fAvatarFocus.value = sanitizeAnhFocus(draft.anhFocus) || "";
  updateAvatarPreview(draft.anhUrl || "");

  clearNewChildRows();
  const rows = draft.newChildRows || [];
  if (rows.length) {
    for (const row of rows) appendChildRow(row);
  } else if (draft.mode === "new") {
    appendChildRow();
  }

  pendingExistingChildIds = [...(draft.pendingExistingChildIds || [])];

  fillRelationSelects();
  fFather.value = draft.chaId || "";
  fMother.value = draft.meId || "";
  fSpouse.value = draft.voChongId || "";

  renderExistingChildren(editingId);
  fillExistingChildSelect();
  renderPendingExistingChildren();
  renderMemberList();
  return true;
}

function isMemberFormDirty() {
  return isDraftMeaningful(captureMemberFormDraft());
}

function saveMemberFormDraft() {
  if (!isMemberFormDirty()) {
    try {
      sessionStorage.removeItem(memberFormDraftKey());
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    sessionStorage.setItem(memberFormDraftKey(), JSON.stringify(captureMemberFormDraft()));
  } catch {
    /* ignore quota */
  }
}

/** @returns {ReturnType<typeof captureMemberFormDraft> | null} */
function loadMemberFormDraft() {
  try {
    const raw = sessionStorage.getItem(memberFormDraftKey());
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.v === 1 ? d : null;
  } catch {
    return null;
  }
}

function clearMemberFormDraft() {
  try {
    sessionStorage.removeItem(memberFormDraftKey());
  } catch {
    /* ignore */
  }
}

function scheduleMemberFormDraftSave() {
  clearTimeout(memberFormDraftTimer);
  memberFormDraftTimer = window.setTimeout(() => saveMemberFormDraft(), 350);
}

function restoreMemberFormDraftIfAny() {
  const draft = loadMemberFormDraft();
  if (!draft || !isDraftMeaningful(draft)) return;
  const curId = fId.value || editingId || "";
  if (curId === draft.memberId && isMemberFormDirty()) return;
  applyMemberFormDraft(draft);
}

function updateAvatarPreview(url) {
  if (!fAvatarPreview) return;
  const u = (url || "").trim();
  const focus = sanitizeAnhFocus(fAvatarFocus?.value || "");
  if (u) {
    fAvatarPreview.innerHTML = `<img src="${escapeHtml(u)}" alt="" referrerpolicy="no-referrer" />`;
    fAvatarPreview.hidden = false;
    if (focus) fAvatarPreview.style.setProperty("--gp-photo-pos", focus);
    else fAvatarPreview.style.removeProperty("--gp-photo-pos");
  } else {
    fAvatarPreview.innerHTML = "";
    fAvatarPreview.hidden = true;
    fAvatarPreview.style.removeProperty("--gp-photo-pos");
  }
}

function memberOptions(excludeId) {
  const opts = ['<option value="">— Không chọn —</option>'];
  for (const p of state.members) {
    if (p.id === excludeId) continue;
    opts.push(`<option value="${p.id}">${escapeHtml(p.hoTen || p.id)}</option>`);
  }
  return opts.join("");
}

function fillRelationSelects() {
  const ex = editingId;
  fFather.innerHTML = memberOptions(ex);
  fMother.innerHTML = memberOptions(ex);
  fSpouse.innerHTML = memberOptions(ex);
}

/** Sau khi thay <option>, trình duyệt xóa value — gán lại từ người đang sửa (fix F5 / refreshUi). */
function resyncRelationFieldsIfEditing() {
  if (!editingId) return;
  const p = state.members.find((m) => m.id === editingId);
  if (!p) return;
  fFather.value = p.chaId || "";
  fMother.value = p.meId || "";
  fSpouse.value = p.voChongId || "";
}

function fillFocalSelects() {
  const opts = ['<option value="">— Chưa chọn —</option>'];
  for (const p of state.members) {
    opts.push(`<option value="${p.id}">${escapeHtml(p.hoTen || p.id)}</option>`);
  }
  const html = opts.join("");
  focalSelect.innerHTML = html;
  treeFocal.innerHTML = html;
  if (state.focalId) {
    focalSelect.value = state.focalId;
    treeFocal.value = state.focalId;
  }
  if (treeScopeSelect) treeScopeSelect.value = normalizeTreeScope(state.treeScope);
}

/** Điền mẹ từ vợ của cha (nữ); điền cha từ chồng của mẹ (nam) nếu ô còn trống. */
function maybeAutofillOtherParentFromSpouse() {
  const map = byId(state.members);
  const fid = fFather.value;
  const mid = fMother.value;

  if (fid && !mid) {
    const fa = map.get(fid);
    const sid = fa?.voChongId;
    const sp = sid ? map.get(sid) : null;
    if (sp && sp.gioiTinh === "nu") fMother.value = sp.id;
  }
  if (mid && !fid) {
    const mo = map.get(mid);
    const sid = mo?.voChongId;
    const sp = sid ? map.get(sid) : null;
    if (sp && sp.gioiTinh === "nam") fFather.value = sp.id;
  }
  fillExistingChildSelect();
}

function clearNewChildRows() {
  childrenNewRows.innerHTML = "";
}

/** @param {Record<string, string>=} prefill */
function appendChildRow(prefill = {}) {
  const row = document.createElement("div");
  row.className = "child-row";

  const mk = (labelText, el) => {
    const lab = document.createElement("label");
    lab.appendChild(document.createTextNode(labelText));
    lab.appendChild(el);
    return lab;
  };

  const name = document.createElement("input");
  name.type = "text";
  name.className = "c-name";
  name.autocomplete = "off";
  name.value = prefill.hoTen || "";

  const day = document.createElement("input");
  day.type = "number";
  day.className = "c-day";
  day.min = 1;
  day.max = 31;
  day.placeholder = "Ngày";
  if (prefill.ngaySinh) day.value = String(prefill.ngaySinh);

  const month = document.createElement("input");
  month.type = "number";
  month.className = "c-month";
  month.min = 1;
  month.max = 12;
  month.placeholder = "Tháng";
  if (prefill.thangSinh) month.value = String(prefill.thangSinh);

  const year = document.createElement("input");
  year.type = "number";
  year.className = "c-year";
  year.placeholder = "Năm";
  if (prefill.namSinh) year.value = String(prefill.namSinh);

  const gender = document.createElement("select");
  gender.className = "c-gender";
  [["", "—"], ["nam", "Nam"], ["nu", "Nữ"]].forEach(([v, t]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    gender.appendChild(o);
  });
  gender.value = prefill.gioiTinh || "";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn child-remove";
  btn.textContent = "Xóa dòng";
  btn.addEventListener("click", () => row.remove());

  row.append(
    mk("Họ tên", name),
    mk("Ngày", day),
    mk("Tháng", month),
    mk("Năm", year),
    mk("Giới tính", gender),
    btn
  );
  childrenNewRows.appendChild(row);
}

/** @returns {{ hoTen: string, ngaySinh: string, thangSinh: string, namSinh: string, gioiTinh: string }[]} */
function collectNewChildRows() {
  const out = [];
  for (const row of childrenNewRows.querySelectorAll(".child-row")) {
    const hoTen = row.querySelector(".c-name")?.value.trim() ?? "";
    if (!hoTen) continue;
    out.push({
      hoTen,
      ngaySinh: String(row.querySelector(".c-day")?.value ?? "").trim(),
      thangSinh: String(row.querySelector(".c-month")?.value ?? "").trim(),
      namSinh: String(row.querySelector(".c-year")?.value ?? "").trim(),
      gioiTinh: row.querySelector(".c-gender")?.value ?? "",
    });
  }
  return out;
}

function fillExistingChildSelect() {
  const parentId = fId.value || editingId || "";
  const map = byId(state.members);
  const par = parentId ? map.get(parentId) : null;
  const spouseStored = par?.voChongId || "";
  const spouseForm = fSpouse.value || "";

  const opts = ['<option value="">— Chọn người —</option>'];
  for (const m of state.members) {
    if (pendingExistingChildIds.includes(m.id)) continue;
    if (parentId && m.id === parentId) continue;
    if (parentId && (m.chaId === parentId || m.meId === parentId)) continue;
    if (parentId && spouseForm && m.id === spouseForm) continue;
    if (parentId && spouseStored && m.id === spouseStored) continue;
    if (parentId && isAncestorOf(m.id, parentId, map)) continue;
    opts.push(`<option value="${m.id}">${escapeHtml(m.hoTen || m.id)}</option>`);
  }
  existingChildSelect.innerHTML = opts.join("");
  existingChildSelect.value = "";
}

function renderPendingExistingChildren() {
  pendingExistingList.innerHTML = "";
  const map = byId(state.members);
  for (const cid of pendingExistingChildIds) {
    const c = map.get(cid);
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = c?.hoTen || cid;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn chip-remove";
    rm.textContent = "Bỏ";
    rm.addEventListener("click", () => {
      pendingExistingChildIds = pendingExistingChildIds.filter((x) => x !== cid);
      fillExistingChildSelect();
      renderPendingExistingChildren();
    });
    li.append(span, rm);
    pendingExistingList.appendChild(li);
  }
}

/** @param {string | null} parentId */
function renderExistingChildren(parentId) {
  existingChildren.innerHTML = "";
  if (!parentId) {
    const li = document.createElement("li");
    li.className = "meta";
    li.textContent =
      "Chưa lưu id: vẫn có thể chọn \"con có sẵn\" bên dưới và bấm Lưu — cha/mẹ sẽ được gán sau khi tạo xong người này.";
    existingChildren.appendChild(li);
    return;
  }
  const kids = childrenOf(state.members, parentId);
  if (!kids.length) {
    const li = document.createElement("li");
    li.className = "meta";
    li.textContent = "Chưa có con nào được liên kết cha/mẹ với người này.";
    existingChildren.appendChild(li);
    return;
  }
  for (const c of kids) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = c.hoTen || "(Không tên)";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = formatBirthLine(c);
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn";
    openBtn.textContent = "Mở";
    openBtn.addEventListener("click", () => openForm(c.id));
    li.append(span, document.createTextNode(" "), meta, openBtn);
    existingChildren.appendChild(li);
  }
}

function renderMemberList() {
  memberList.innerHTML = "";
  if (!state.members.length) {
    memberList.innerHTML = "<li><em class=\"meta\">Chưa có ai. Bấm Thêm người.</em></li>";
    return;
  }
  for (const p of state.members) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.hoTen || "(Không tên)";
    if (p.id === editingId) b.classList.add("active");
    b.addEventListener("click", () => openForm(p.id));
    li.appendChild(b);
    memberList.appendChild(li);
  }
}

/**
 * @param {string} selfId
 * @param {string} selfGender
 * @param {string} spouseId
 * @returns {{ chaId: string, meId: string }}
 */
function inferChildParents(selfId, selfGender, spouseId) {
  if (selfGender === "nu") return { chaId: spouseId || "", meId: selfId };
  if (selfGender === "nam") return { chaId: selfId, meId: spouseId || "" };
  return { chaId: selfId, meId: spouseId || "" };
}

/** @param {Member} child @param {string} parentId @param {string} parentGender @param {string} spouseId */
function applyInferredParentsToExisting(child, parentId, parentGender, spouseId) {
  const { chaId, meId } = inferChildParents(parentId, parentGender, spouseId);
  if (chaId) child.chaId = chaId;
  if (meId) child.meId = meId;
}

/** @param {string | null} id @param {{ skipDraftRestore?: boolean, skipDraftSave?: boolean }} [opts] */
function openForm(id, opts = {}) {
  const nextId = id || "";
  const curId = fId.value || editingId || "";
  if (!opts.skipDraftSave && nextId !== curId && isMemberFormDirty()) {
    saveMemberFormDraft();
  }

  pendingExistingChildIds = [];
  editingId = id;
  const p = id ? state.members.find((m) => m.id === id) : null;
  formTitle.textContent = p ? "Sửa thông tin" : "Thêm người";
  fId.value = id || "";
  btnDelete.disabled = !id;

  clearNewChildRows();
  if (p) {
    fName.value = p.hoTen;
    fGender.value = p.gioiTinh || "";
    fBirthDay.value = p.ngaySinh || "";
    fBirthMonth.value = p.thangSinh || "";
    fBirth.value = p.namSinh || "";
    fDeath.value = p.namMat || "";
    fFather.value = p.chaId || "";
    fMother.value = p.meId || "";
    fSpouse.value = p.voChongId || "";
    fAvatarUrl.value = p.anhUrl || "";
    if (fAvatarFocus) fAvatarFocus.value = sanitizeAnhFocus(p.anhFocus) || "";
    updateAvatarPreview(p.anhUrl);
    fNote.value = p.ghiChu || "";
    renderExistingChildren(p.id);
  } else {
    form.reset();
    fId.value = "";
    if (fAvatarFocus) fAvatarFocus.value = "";
    updateAvatarPreview("");
    fBirthDay.value = "";
    fBirthMonth.value = "";
    renderExistingChildren(null);
    appendChildRow();
  }

  fillRelationSelects();
  if (p) {
    fFather.value = p.chaId || "";
    fMother.value = p.meId || "";
    fSpouse.value = p.voChongId || "";
    fBirthDay.value = p.ngaySinh || "";
    fBirthMonth.value = p.thangSinh || "";
    fAvatarUrl.value = p.anhUrl || "";
    if (fAvatarFocus) fAvatarFocus.value = sanitizeAnhFocus(p.anhFocus) || "";
    updateAvatarPreview(p.anhUrl);
  }
  if (avatarUploadStatus) avatarUploadStatus.textContent = "";
  if (fAvatarFile) fAvatarFile.value = "";

  if (!opts.skipDraftRestore) {
    const draft = loadMemberFormDraft();
    const mid = fId.value || editingId || "";
    if (draft && isDraftMeaningful(draft) && draft.memberId === mid) {
      applyMemberFormDraft(draft);
      return;
    }
  }

  renderMemberList();
  fillExistingChildSelect();
  renderPendingExistingChildren();
}

function syncSpouseFields(member, oldSpouseId) {
  const map = byId(state.members);
  const newSpouseId = member.voChongId || "";

  if (oldSpouseId && oldSpouseId !== newSpouseId) {
    const old = map.get(oldSpouseId);
    if (old && old.voChongId === member.id) {
      old.voChongId = "";
    }
  }

  if (newSpouseId) {
    const s = map.get(newSpouseId);
    if (s && s.id !== member.id) linkSpouse(member, s);
  }
}

fFather.addEventListener("change", () => {
  maybeAutofillOtherParentFromSpouse();
});

fMother.addEventListener("change", () => {
  maybeAutofillOtherParentFromSpouse();
});

/** Khi chọn vợ/chồng: đồng bộ ngược lại trên form (và sau khi lưu sẽ lưu DB). */
fSpouse.addEventListener("change", () => {
  const map = byId(state.members);
  const sid = fSpouse.value;
  if (sid && editingId) {
    const spouse = map.get(sid);
    if (spouse && spouse.voChongId && spouse.voChongId !== editingId) {
      if (!confirm("Người này đang liên kết vợ/chồng khác. Đổi sang người hiện tại?")) {
        const self = map.get(editingId);
        fSpouse.value = self?.voChongId || "";
      }
    }
  }
  fillExistingChildSelect();
});

fAvatarUrl?.addEventListener("input", () => {
  if (fAvatarFocus) fAvatarFocus.value = "";
  updateAvatarPreview(fAvatarUrl.value);
});

btnAvatarAutoFocus?.addEventListener("click", async () => {
  const url = (fAvatarUrl?.value || "").trim();
  if (!url) {
    alert("Cần có URL ảnh (dán link hoặc tải ảnh lên trước).");
    return;
  }
  try {
    new URL(url);
  } catch {
    alert("URL ảnh không hợp lệ.");
    return;
  }
  if (!avatarUploadStatus) return;
  if (typeof globalThis.FaceDetector !== "function") {
    avatarUploadStatus.textContent =
      "Trình duyệt này chưa hỗ trợ nhận diện mặt cục bộ. Dùng Chrome hoặc Edge bản mới, hoặc sau này tính năng server (gói trả phí).";
    return;
  }
  avatarUploadStatus.textContent = "Đang căn mặt (trên máy bạn)…";
  btnAvatarAutoFocus.disabled = true;
  try {
    const pos = await detectFaceObjectPosition(url);
    if (!pos) {
      avatarUploadStatus.textContent =
        "Không thấy khuôn mặt trong ảnh. Thử ảnh rõ mặt, hoặc chỉnh tay bằng dữ liệu anhFocus trong xuất/nhập JSON.";
      return;
    }
    if (fAvatarFocus) fAvatarFocus.value = pos;
    updateAvatarPreview(url);
    avatarUploadStatus.textContent = `Đã căn tiêu điểm ${pos}. Bấm «Lưu» thành viên để lưu.`;
  } catch {
    avatarUploadStatus.textContent =
      "Không đọc được ảnh (CORS hoặc lỗi mạng). Thử ảnh tải lên từ nút «Tải ảnh lên» hoặc URL public cho phép trình duyệt tải.";
  } finally {
    btnAvatarAutoFocus.disabled = false;
  }
});

fAvatarFile?.addEventListener("change", () => {
  const file = fAvatarFile.files?.[0];
  if (!file || !avatarUploadStatus) return;
  avatarUploadStatus.textContent = `Đã chọn: ${file.name}`;
});

btnAvatarUpload?.addEventListener("click", async () => {
  const file = fAvatarFile?.files?.[0];
  if (!file) {
    alert("Bấm «Chọn ảnh từ máy» trước.");
    return;
  }
  if (!isCloudConfigured() || !cloudMeta.familyId) {
    alert("Cần đăng nhập và chọn gia phả trên đám mây mới tải ảnh được.\n\nHoặc dán link ảnh (URL) bên dưới.");
    return;
  }
  let memberId = fId.value || editingId || "";
  if (!memberId) {
    memberId = uid();
    fId.value = memberId;
  }
  if (btnAvatarUpload) btnAvatarUpload.disabled = true;
  if (avatarUploadStatus) avatarUploadStatus.textContent = "Đang tải lên…";
  try {
    const url = await uploadMemberAvatar(cloudMeta.familyId, memberId, file);
    fAvatarUrl.value = url;
    if (fAvatarFocus) fAvatarFocus.value = "";
    updateAvatarPreview(url);
    const existingIdx = state.members.findIndex((m) => m.id === memberId);
    if (existingIdx >= 0) {
      state.members[existingIdx] = { ...state.members[existingIdx], anhUrl: url, anhFocus: "" };
      saveState(state);
      renderTree(membersSorted(), state.focalId);
    }
    if (fAvatarFile) fAvatarFile.value = "";
    if (avatarUploadStatus) {
      avatarUploadStatus.textContent =
        existingIdx >= 0
          ? "Đã tải ảnh và cập nhật cây — bấm Lưu nếu còn chỉnh họ tên / quan hệ."
          : "Đã tải ảnh — bấm Lưu thành viên để lưu vào gia phả.";
    }
  } catch (e) {
    if (avatarUploadStatus) avatarUploadStatus.textContent = "";
    alert(String(e?.message || e));
  } finally {
    if (btnAvatarUpload) btnAvatarUpload.disabled = false;
  }
});

document.getElementById("btn-add-child-row")?.addEventListener("click", () => appendChildRow());

document.getElementById("btn-add-existing-child")?.addEventListener("click", () => {
  const cid = existingChildSelect.value;
  if (!cid) {
    alert("Chọn một người trong danh sách.");
    return;
  }
  if (pendingExistingChildIds.includes(cid)) return;

  const parentId = fId.value || editingId || "";
  const map = byId(state.members);
  if (parentId && isAncestorOf(cid, parentId, map)) {
    alert("Không thể chọn người này làm con (họ nằm trên dòng tổ tiên của người đang mở).");
    return;
  }
  if (cid === parentId) return;

  pendingExistingChildIds.push(cid);
  fillExistingChildSelect();
  renderPendingExistingChildren();
});

form.addEventListener("submit", (e) => {
  e.preventDefault();

  const hoTenRaw = (fName.value || "").trim();
  if (!hoTenRaw) {
    alert("Vui lòng nhập họ tên.");
    fName.focus();
    return;
  }
  const anhUrlRaw = (fAvatarUrl.value || "").trim();
  if (anhUrlRaw) {
    try {
      new URL(anhUrlRaw);
    } catch {
      alert("Liên kết ảnh không hợp lệ. Dùng địa chỉ đầy đủ dạng https://… hoặc để trống.");
      fAvatarUrl.focus();
      return;
    }
  }

  const id = fId.value || uid();
  const existing = state.members.find((m) => m.id === id);
  const oldSpouse = existing?.voChongId;

  const member = {
    id,
    hoTen: hoTenRaw,
    gioiTinh: fGender.value,
    ngaySinh: String(fBirthDay.value ?? "").trim(),
    thangSinh: String(fBirthMonth.value ?? "").trim(),
    namSinh: fBirth.value.trim(),
    namMat: fDeath.value.trim(),
    chaId: fFather.value || "",
    meId: fMother.value || "",
    voChongId: fSpouse.value || "",
    anhUrl: anhUrlRaw,
    anhFocus: anhUrlRaw ? sanitizeAnhFocus(fAvatarFocus?.value || "") : "",
    ghiChu: fNote.value.trim(),
  };

  if (member.chaId === id || member.meId === id) {
    alert("Cha hoặc mẹ không thể là chính người đó.");
    return;
  }
  if (member.chaId && member.chaId === member.meId) {
    alert("Cha và mẹ không thể cùng một người.");
    return;
  }

  const idx = state.members.findIndex((m) => m.id === id);
  const isNewMember = idx < 0;
  const newKids = collectNewChildRows();
  const pendingSnap = [...pendingExistingChildIds];
  let addCount = 0;
  if (isNewMember) addCount += 1;
  addCount += newKids.length;
  if (!canAddMembers(addCount)) {
    showQuotaBlockedMessage(addCount);
    return;
  }

  if (idx >= 0) state.members[idx] = member;
  else state.members.push(member);

  syncSpouseFields(member, oldSpouse);

  const map = byId(state.members);
  maybeLinkParentsAsSpouseFromChild(member, map);

  const selfAfter = state.members.find((m) => m.id === id);
  const spouseId = selfAfter?.voChongId || "";

  for (const row of newKids) {
    const { chaId, meId } = inferChildParents(id, selfAfter?.gioiTinh || "", spouseId);
    const child = {
      id: uid(),
      hoTen: row.hoTen,
      gioiTinh: row.gioiTinh,
      ngaySinh: row.ngaySinh,
      thangSinh: row.thangSinh,
      namSinh: row.namSinh,
      namMat: "",
      chaId,
      meId,
      voChongId: "",
      anhUrl: "",
      anhFocus: "",
      ghiChu: "",
    };
    if (child.chaId === child.meId && child.chaId) {
      alert(`Con "${row.hoTen}": cha và mẹ trùng — bỏ qua dòng này.`);
      continue;
    }
    state.members.push(child);
    maybeLinkParentsAsSpouseFromChild(child, byId(state.members));
  }

  pendingExistingChildIds = [];
  for (const cid of pendingSnap) {
    const child = state.members.find((m) => m.id === cid);
    if (!child || child.id === id) continue;
    const mapLive = byId(state.members);
    if (isAncestorOf(child.id, id, mapLive)) {
      alert(`Không liên kết "${child.hoTen || cid}" làm con (trùng thế hệ / vòng dòng họ).`);
      continue;
    }
    applyInferredParentsToExisting(child, id, selfAfter?.gioiTinh || "", spouseId);
    maybeLinkParentsAsSpouseFromChild(child, byId(state.members));
  }

  if (!saveState(state)) return;
  clearMemberFormDraft();
  const b = getCurrentBilling();
  if (b) {
    b.memberCount = state.members.length;
    b.canAddMore = b.isUnlimited || b.memberCount < b.maxMembers;
    setCurrentBilling({
      member_count: b.memberCount,
      max_members: b.maxMembers,
      is_unlimited: b.isUnlimited,
      can_add_more: b.canAddMore,
      premium_price_vnd: 20000,
      pending_payment_code: b.pendingCode,
      is_owner: b.isOwner,
    });
  }
  fillFocalSelects();
  renderTree(membersSorted(), state.focalId);
  clearNewChildRows();
  openForm(id);
});

document.getElementById("btn-add")?.addEventListener("click", () => {
  if (!canAddMembers(1)) {
    showQuotaBlockedMessage(1);
    return;
  }
  openForm(null);
});

btnDelete.addEventListener("click", () => {
  const delId = fId.value;
  if (!delId || !confirm("Xóa hẳn người này? Liên kết cha/mẹ/vợ chồng của người khác có thể cần chỉnh lại.")) return;

  state.members = state.members.filter((m) => m.id !== delId);
  for (const m of state.members) {
    if (m.chaId === delId) m.chaId = "";
    if (m.meId === delId) m.meId = "";
    if (m.voChongId === delId) m.voChongId = "";
  }
  if (state.focalId === delId) state.focalId = null;
  saveState(state);
  clearMemberFormDraft();
  fillFocalSelects();
  openForm(null, { skipDraftRestore: true, skipDraftSave: true });
  renderTree(membersSorted(), state.focalId);
});

focalSelect.addEventListener("change", () => {
  state.focalId = focalSelect.value || null;
  treeFocal.value = focalSelect.value;
  saveState(state);
  renderTree(membersSorted(), state.focalId);
});

treeFocal.addEventListener("change", () => {
  state.focalId = treeFocal.value || null;
  focalSelect.value = treeFocal.value;
  saveState(state);
  renderTree(membersSorted(), state.focalId);
});

if (treeScopeSelect) {
  treeScopeSelect.addEventListener("change", () => {
    state.treeScope = normalizeTreeScope(treeScopeSelect.value);
    saveState(state);
    renderTree(membersSorted(), state.focalId);
  });
}

function membersSorted() {
  return [...state.members].sort((a, b) =>
    (a.hoTen || "").localeCompare(b.hoTen || "", "vi")
  );
}

function setTreeTabVisible(isTree) {
  document.body.classList.toggle("show-tree-tab", isTree);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const prevTab = activeAppTab;
    const tid = tab.getAttribute("data-tab") || "members";
    if (prevTab === "members" && tid !== "members") {
      saveMemberFormDraft();
    }

    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tid}`)?.classList.add("active");
    activeAppTab = tid;
    setTreeTabVisible(tid === "tree");
    if (tid === "tree") {
      renderTree(membersSorted(), state.focalId);
    }
    if (tid === "members" && prevTab !== "members") {
      restoreMemberFormDraftIfAny();
    }
  });
});

form?.addEventListener("input", scheduleMemberFormDraftSave);
form?.addEventListener("change", scheduleMemberFormDraftSave);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveMemberFormDraft();
    return;
  }
  if (document.visibilityState === "visible" && activeAppTab === "members") {
    restoreMemberFormDraftIfAny();
  }
});

setTreeTabVisible(false);

document.getElementById("btn-print")?.addEventListener("click", () => {
  window.print();
});

document.getElementById("btn-export")?.addEventListener("click", () => {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          members: state.members,
          focalId: state.focalId,
          treeScope: normalizeTreeScope(state.treeScope),
        },
        null,
        2
      ),
    ],
    {
      type: "application/json",
    }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gia_pha.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("import-file")?.addEventListener("change", (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!Array.isArray(data.members)) throw new Error("Thiếu mảng members");
      state = {
        members: data.members.map(normalizeMember),
        focalId: data.focalId ?? null,
        treeScope: normalizeTreeScope(data.treeScope),
      };
      saveState(state);
      fillFocalSelects();
      renderMemberList();
      renderTree(membersSorted(), state.focalId);
      openForm(state.members[0]?.id ?? null);
      alert("Đã nhập xong.");
    } catch (err) {
      alert("File không hợp lệ: " + (err?.message || err));
    }
  };
  reader.readAsText(file, "UTF-8");
});

/** @param {{ members: any[], focalId: string | null, treeScope?: string }} parsed @param {{ skipCloud?: boolean }} [opts] */
function applyRestoredState(parsed, opts = {}) {
  const keepDraft = isMemberFormDirty() ? captureMemberFormDraft() : null;

  state = {
    members: parsed.members,
    focalId: parsed.focalId ?? null,
    treeScope: normalizeTreeScope(parsed.treeScope),
  };
  if (opts.skipCloud) saveStateLocal(state);
  else saveState(state);
  fillFocalSelects();
  fillRelationSelects();
  renderMemberList();
  renderTree(membersSorted(), state.focalId);

  if (keepDraft && isDraftMeaningful(keepDraft)) {
    try {
      sessionStorage.setItem(memberFormDraftKey(), JSON.stringify(keepDraft));
    } catch {
      /* ignore */
    }
    applyMemberFormDraft(keepDraft);
  } else {
    openForm(state.members[0]?.id ?? null, { skipDraftRestore: true, skipDraftSave: true });
  }
}

document.getElementById("btn-restore-backup")?.addEventListener("click", () => {
  const raw = localStorage.getItem(storageBackupKey());
  if (!raw) {
    alert("Chưa có bản sao trong trình duyệt (chỉ tạo sau khi bạn đã từng có danh sách và bấm Lưu ít nhất một lần).");
    return;
  }
  try {
    const parsed = parseStoredState(JSON.parse(raw));
    if (!parsed || !parsed.members.length) {
      alert("Bản sao trống hoặc không đọc được.");
      return;
    }
    if (!confirm(`Khôi phục ${parsed.members.length} người từ bản sao trình duyệt?`)) return;
    applyRestoredState(parsed);
    alert("Đã khôi phục xong.");
  } catch (e) {
    alert("Lỗi: " + (e?.message || e));
  }
});

/** Thanh gợi ý (không chặn màn hình) khi danh sách trống nhưng còn bản sao. */
function showBackupHintIfEmpty() {
  if (state.members.length) return;
  const raw = localStorage.getItem(storageBackupKey());
  if (!raw) return;
  let parsed;
  try {
    parsed = parseStoredState(JSON.parse(raw));
  } catch {
    return;
  }
  if (!parsed?.members?.length) return;
  const panel = document.getElementById("panel-members");
  if (!panel || document.getElementById("backup-hint-bar")) return;
  const n = parsed.members.length;
  const bar = document.createElement("div");
  bar.id = "backup-hint-bar";
  bar.className = "backup-hint-bar";
  bar.innerHTML = `<p><span>Danh sách đang trống — trình duyệt còn <strong>${n}</strong> người trong bản sao.</span>
    <button type="button" class="btn primary" data-backup-restore>Khôi phục</button>
    <button type="button" class="btn" data-backup-dismiss>Ẩn</button></p>`;
  panel.insertBefore(bar, panel.firstChild);
  bar.querySelector("[data-backup-restore]")?.addEventListener("click", () => {
    if (!confirm(`Khôi phục ${n} người từ bản sao?`)) return;
    applyRestoredState(parsed);
    bar.remove();
    alert("Đã khôi phục xong.");
  });
  bar.querySelector("[data-backup-dismiss]")?.addEventListener("click", () => bar.remove());
}

let mainAppBooted = false;

function bootMainApp() {
  if (mainAppBooted) {
    fillFocalSelects();
    fillRelationSelects();
    resyncRelationFieldsIfEditing();
    renderMemberList();
    renderTree(membersSorted(), state.focalId);
    return;
  }
  mainAppBooted = true;
  fillFocalSelects();
  renderMemberList();
  showBackupHintIfEmpty();
  renderTree(membersSorted(), state.focalId);
  if (state.members.length) openForm(state.members[0].id);
  else openForm(null);
}

initAccountPanel({
  getState: () => state,
  applyState: (remote) => {
    const parsed = parseStoredState(remote);
    if (parsed) applyRestoredState(parsed, { skipCloud: true });
  },
  setCloudMeta,
  setStorageUserId,
  replaceAppState,
  refreshUi: () => {
    fillFocalSelects();
    fillRelationSelects();
    resyncRelationFieldsIfEditing();
    renderMemberList();
    renderTree(membersSorted(), state.focalId);
    if (activeAppTab === "members") restoreMemberFormDraftIfAny();
  },
  isMemberFormDirty: () => isMemberFormDirty(),
  saveMemberFormDraft: () => saveMemberFormDraft(),
  onAuthGate: (open) => {
    if (open) bootMainApp();
  },
});
