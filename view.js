import { isCloudConfigured } from "./config.js";
import { fetchPublicFamilyByCode } from "./cloud.js";
import { buildPrintDiagramHtml } from "./pedigree.js";

const params = new URLSearchParams(location.search);
const code = (params.get("code") || "").trim();

const titleEl = document.getElementById("view-title");
const statusEl = document.getElementById("view-status");
const treeEl = document.getElementById("tree-display");

function showError(msg) {
  if (statusEl) statusEl.textContent = msg;
  if (treeEl) treeEl.innerHTML = `<p class="meta">${msg}</p>`;
}

function normalizeMembers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => ({
    ...m,
    id: String(m.id ?? ""),
    hoTen: String(m.hoTen ?? m.ten ?? "").trim(),
    gioiTinh: m.gioiTinh != null ? String(m.gioiTinh) : "",
    ngaySinh: m.ngaySinh != null ? String(m.ngaySinh) : "",
    thangSinh: m.thangSinh != null ? String(m.thangSinh) : "",
    namSinh: m.namSinh != null ? String(m.namSinh) : "",
    namMat: m.namMat != null ? String(m.namMat) : "",
    chaId: m.chaId != null ? String(m.chaId) : "",
    meId: m.meId != null ? String(m.meId) : "",
    voChongId: m.voChongId != null ? String(m.voChongId) : "",
    anhUrl: m.anhUrl != null ? String(m.anhUrl) : "",
    anhFocus: m.anhFocus != null ? String(m.anhFocus) : "",
    ghiChu: m.ghiChu != null ? String(m.ghiChu) : "",
  }));
}

async function main() {
  if (!isCloudConfigured()) {
    showError("Chưa cấu hình Supabase (config.js).");
    return;
  }
  if (!code) {
    showError("Thiếu mã trong URL — dùng view.html?code=MÃ_MỜI");
    return;
  }

  try {
    const pack = await fetchPublicFamilyByCode(code);
    if (!pack) {
      showError("Mã không đúng hoặc gia phả không tồn tại.");
      return;
    }
    const members = normalizeMembers(pack.state.members);
    const focalId = pack.state.focalId || members[0]?.id || null;
    const scope = pack.state.treeScope === "noi" || pack.state.treeScope === "ngoai" ? pack.state.treeScope : "ca_hai";

    if (titleEl) titleEl.textContent = pack.name || "Gia phả";
    if (statusEl) {
      statusEl.textContent = `Xem công khai — mã ${pack.invite_code || code.toUpperCase()} — chỉ đọc`;
    }

    if (!focalId || !members.some((m) => m.id === focalId)) {
      showError("Gia phả chưa có người gốc để vẽ cây.");
      return;
    }

    if (treeEl) {
      treeEl.innerHTML = `<div class="tree-print-diagram">${buildPrintDiagramHtml(members, focalId, scope)}</div>`;
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("gp_public_family_by_code")) {
      showError("Chưa bật xem công khai — chạy supabase-viewer.sql trong Supabase SQL Editor.");
    } else {
      showError(msg);
    }
  }
}

document.getElementById("view-btn-print")?.addEventListener("click", () => window.print());

void main();
