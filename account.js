import {
  isCloudConfigured,
  getSession,
  signUp,
  signIn,
  signInWithGoogle,
  signOut,
  listFamiliesForUser,
  createFamily,
  loadFamilyState,
  onAuthStateChange,
  claimPendingInvites,
  peekPendingInvites,
  inviteEditorByEmail,
  listFamilyAccess,
  removeFamilyMember,
  setFamilyMemberRole,
  revokeInvite,
  ensureAuthSession,
  cleanAuthParamsFromUrl,
  getFamilyBilling,
  resetPasswordForEmail,
  joinFamilyByCode,
  getFamilyShareInfo,
  buildPublicViewUrl,
} from "./cloud.js";
import {
  setCurrentBilling,
  initBillingPanel,
  refreshUpgradeButtons,
  getCurrentBilling,
} from "./billing.js";

const ACTIVE_FAMILY_KEY = "giaPha_activeFamilyId";
const LOCAL_ONLY_KEY = "giaPha_localOnly";

/** @type {{ getState: () => { members: unknown[], focalId: string | null, treeScope: string }, applyState: (s: unknown) => void, setCloudMeta: (m: { familyId: string | null, updatedAt: string | null }) => void, setStorageUserId: (id: string | null) => void, replaceAppState: (s: { members: unknown[], focalId: string | null, treeScope?: string }) => void, refreshUi: () => void, onAuthGate?: (open: boolean) => void, isMemberFormDirty?: () => boolean, saveMemberFormDraft?: () => void, resetMemberFormOnFamilyChange?: (previousFamilyId: string) => void }} */
let hooks = {
  getState: () => ({ members: [], focalId: null, treeScope: "ca_hai" }),
  applyState: () => {},
  setCloudMeta: () => {},
  setStorageUserId: () => {},
  replaceAppState: () => {},
  refreshUi: () => {},
  onAuthGate: () => {},
  isMemberFormDirty: () => false,
  saveMemberFormDraft: () => {},
  resetMemberFormOnFamilyChange: () => {},
};

let shareDialogWired = false;
/** Gia phả đã load members lần cuối — để biết khi nào cần đóng form / tải lại. */
let lastLoadedFamilyId = "";
/** @type {string | null} */
let currentUserId = null;
/** @type {'owner' | 'editor' | 'viewer' | null} */
let currentFamilyRole = null;

export function isFamilyReadOnly() {
  return currentFamilyRole === "viewer";
}

function activeFamilyKey(userId) {
  return userId ? `${ACTIVE_FAMILY_KEY}_${userId}` : ACTIVE_FAMILY_KEY;
}

/** @param {string} [userId] */
export function getActiveFamilyId(userId) {
  const uid = userId || currentUserId;
  if (uid) return localStorage.getItem(activeFamilyKey(uid)) || "";
  return localStorage.getItem(ACTIVE_FAMILY_KEY) || "";
}

/** @param {string} id @param {string} [userId] */
export function setActiveFamilyId(id, userId) {
  const uid = userId || currentUserId;
  const key = activeFamilyKey(uid || "");
  if (id) localStorage.setItem(key, id);
  else localStorage.removeItem(key);
  if (uid) localStorage.removeItem(ACTIVE_FAMILY_KEY);
}

const EMPTY_STATE = { members: [], focalId: null, treeScope: "ca_hai" };

function isLocalOnlyMode() {
  return localStorage.getItem(LOCAL_ONLY_KEY) === "1";
}

function setLocalOnlyMode(on) {
  if (on) localStorage.setItem(LOCAL_ONLY_KEY, "1");
  else localStorage.removeItem(LOCAL_ONLY_KEY);
}

/**
 * @param {typeof hooks} h
 */
export function initAccountPanel(h) {
  hooks = { ...hooks, ...h };
  injectSqlScript();
  bindAccountEvents();
  initBillingPanel();
  // Không gọi async trực tiếp trong callback — Supabase có thể không cập nhật session (đặc biệt sau Google OAuth).
  onAuthStateChange((session, event) => {
    applySessionToShell(session);
    if (hooks.isMemberFormDirty?.()) {
      hooks.saveMemberFormDraft?.();
    }
    // Alt+Tab / làm mới token — không tải lại gia phả (tránh ghi đè form đang nhập).
    if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
    if (event === "INITIAL_SESSION" && lastLoadedFamilyId) return;
    setTimeout(() => {
      refreshAccountUi(session).catch((e) => {
        console.error("refreshAccountUi", e);
        setSyncStatus("Lỗi đăng nhập: " + (e?.message || e), "err");
      });
    }, 0);
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
      cleanAuthParamsFromUrl();
    }
  });
  void bootstrapAuth();
}

function handlePaymentReturnQuery() {
  /* Giữ cho tương thích URL cũ sau thanh toán */
  const params = new URLSearchParams(location.search);
  if (params.get("payment") === "success") {
    alert("Nếu đã chuyển khoản đúng mã GP, gói sẽ tự bật qua SePay — F5 trang sau ~1 phút.");
    params.delete("payment");
    params.delete("code");
    const q = params.toString();
    history.replaceState({}, "", location.pathname + (q ? `?${q}` : ""));
  }
}

async function bootstrapAuth() {
  handlePaymentReturnQuery();
  const hasOAuthCode = new URLSearchParams(location.search).has("code");
  if (hasOAuthCode) {
    setSyncStatus("Đang hoàn tất đăng nhập Google…", "sync");
    const login = el("cloud-login-panel");
    const signup = el("cloud-signup-panel");
    const loggedIn = el("cloud-logged-in");
    if (login) login.hidden = true;
    if (signup) signup.hidden = true;
    if (loggedIn) {
      loggedIn.hidden = false;
      const p = loggedIn.querySelector(".meta");
      if (p) p.textContent = "Đang hoàn tất đăng nhập Google…";
    }
  }
  try {
    const session = await ensureAuthSession();
    applySessionToShell(session);
    await refreshAccountUi(session);
  } catch (e) {
    setSyncStatus("Đăng nhập thất bại: " + (e?.message || e), "err");
    await refreshAccountUi(null);
  }
}

/** Cập nhật giao diện ngay từ session (không chờ getSession lần nữa). */
function applySessionToShell(session) {
  const user = session?.user ?? null;
  refreshTopAuth(user);
  const canEnter = Boolean(user) || isLocalOnlyMode();
  setAppShell(canEnter);
  const login = el("cloud-login-panel");
  const signup = el("cloud-signup-panel");
  const loggedIn = el("cloud-logged-in");
  const intro = el("cloud-auth-block")?.querySelector(".cloud-auth-intro");
  if (user) {
    if (login) login.hidden = true;
    if (signup) signup.hidden = true;
    if (intro) intro.hidden = true;
    if (loggedIn) loggedIn.hidden = false;
  } else {
    if (loggedIn) loggedIn.hidden = true;
    if (intro) intro.hidden = false;
    showAuthPanel(authPanelMode);
  }
}

function injectSqlScript() {
  const pre = el("cloud-sql-script");
  if (!pre || pre.textContent) return;
  fetch("./supabase-schema.sql")
    .then((r) => r.text())
    .then((t) => {
      pre.textContent = t;
    })
    .catch(() => {
      pre.textContent = "Không tải được supabase-schema.sql — mở file trong thư mục Gia_pha.";
    });
}

function el(id) {
  return document.getElementById(id);
}

/** Bấm vùng tối / ngoài hộp thoại → đóng (như nút Đóng). */
function wireDialogBackdropClose(dialogId) {
  const dlg = /** @type {HTMLDialogElement | null} */ (el(dialogId));
  if (!dlg || dlg.dataset.backdropCloseWired === "1") return;
  dlg.dataset.backdropCloseWired = "1";
  dlg.addEventListener("click", (e) => {
    const inner = dlg.querySelector(".share-dialog-inner");
    if (inner && !inner.contains(/** @type {Node} */ (e.target))) dlg.close();
  });
}

export function setSyncStatus(text, kind = "") {
  const node = el("cloud-sync-status");
  if (!node) return;
  node.textContent = text;
  node.className = "cloud-sync-status" + (kind ? ` cloud-sync-status--${kind}` : "");
}

/** Sau Alt+Tab: bỏ dòng vàng «đang nhập» nếu form không thực sự đổi. */
export function refreshFamilySyncStatusIfIdle() {
  if (hooks.isMemberFormDirty?.()) return;
  const activeId = getActiveFamilyId(currentUserId || undefined);
  if (!activeId || !lastLoadedFamilyId) return;
  const bill = getCurrentBilling();
  if (bill?.is_unlimited) {
    setSyncStatus("Gói không giới hạn thành viên. Đã đồng bộ đám mây.", "ok");
  } else {
    setSyncStatus(
      `Miễn phí ${bill?.member_count ?? "?"}/${bill?.max_members ?? 30} thành viên. Đã đồng bộ đám mây.`,
      "ok"
    );
  }
}

function setAppShell(open) {
  document.body.classList.toggle("app-authenticated", open);
  const gate = el("app-gate");
  const main = el("app-main-shell");
  if (gate) gate.hidden = open;
  if (main) main.hidden = !open;
  hooks.onAuthGate?.(open);
}

function scrollToAuth() {
  el("cloud-auth-block")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

let authPanelMode = "login";

/** @param {"login" | "signup"} mode */
function showAuthPanel(mode = "login") {
  authPanelMode = mode;
  const login = el("cloud-login-panel");
  const signup = el("cloud-signup-panel");
  if (login) login.hidden = mode !== "login";
  if (signup) signup.hidden = mode !== "signup";
}

function refreshTopAuth(user) {
  const top = el("top-auth");
  if (!top) return;

  if (!isCloudConfigured()) {
    top.innerHTML = `<span class="top-auth-meta">Chỉ trên máy</span>`;
    return;
  }

  if (!user) {
    top.innerHTML = `
      <button type="button" class="btn btn-ghost" id="top-show-login">Đăng nhập</button>
      <button type="button" class="btn primary" id="top-show-signup">Đăng ký</button>`;
    el("top-show-login")?.addEventListener("click", () => {
      scrollToAuth();
      showAuthPanel("login");
    });
    el("top-show-signup")?.addEventListener("click", () => {
      scrollToAuth();
      showAuthPanel("signup");
      el("cloud-signup-email")?.focus();
    });
    return;
  }

  const email = user.email || "Tài khoản";
  top.innerHTML = `
    <span class="top-auth-meta" title="${escapeHtml(email)}">${escapeHtml(email)}</span>
    <button type="button" class="btn btn-upgrade btn-upgrade--compact" id="top-header-upgrade" hidden title="Nâng cấp không giới hạn thành viên">Nâng cấp</button>
    <button type="button" class="btn" id="top-header-share">Chia sẻ</button>
    <button type="button" class="btn btn-ghost" id="top-btn-signout">Thoát</button>`;
  el("top-header-share")?.addEventListener("click", () => {
    if (currentFamilyRole !== "owner") {
      alert("Chỉ chủ gia phả mới chia sẻ được. Chọn gia phả ở nhóm «Tôi làm chủ».");
      return;
    }
    openShareDialog();
  });
  el("top-btn-signout")?.addEventListener("click", async () => {
    const uid = currentUserId;
    await signOut();
    if (uid) setActiveFamilyId("", uid);
    currentUserId = null;
    hooks.setStorageUserId(null);
    setLocalOnlyMode(false);
    hooks.resetMemberFormOnFamilyChange(document.body.dataset.activeFamilyId || "");
    lastLoadedFamilyId = "";
    hooks.setCloudMeta({ familyId: null, updatedAt: null });
    hooks.replaceAppState(EMPTY_STATE);
    hooks.refreshUi();
    await refreshAccountUi(null);
  });
}

/**
 * @param {import('@supabase/supabase-js').Session | null} [knownSession]
 */
async function refreshAccountUi(knownSession) {
  const cfgBlock = el("cloud-config-hint");
  const authBlock = el("cloud-auth-block");
  const loggedIn = el("cloud-logged-in");

  const configured = isCloudConfigured();
  if (cfgBlock) cfgBlock.hidden = configured;
  if (authBlock) authBlock.hidden = !configured;

  if (!configured) {
    el("cloud-login-panel") && (el("cloud-login-panel").hidden = true);
    el("cloud-signup-panel") && (el("cloud-signup-panel").hidden = true);
    if (loggedIn) loggedIn.hidden = true;
    refreshTopAuth(null);
    setAppShell(isLocalOnlyMode());
    setSyncStatus("Chỉ lưu trên máy này (chưa bật đám mây).", "local");
    return;
  }

  const session = knownSession ?? (await getSession());
  const user = session?.user ?? null;
  applySessionToShell(session);

  if (!user) {
    currentUserId = null;
    hooks.setStorageUserId(null);
    hooks.setCloudMeta({ familyId: null, updatedAt: null });
    setSyncStatus("Đăng nhập để đồng bộ và chỉnh sửa chung.", "warn");
    return;
  }

  if (currentUserId && currentUserId !== user.id) {
    setActiveFamilyId("", currentUserId);
  }
  currentUserId = user.id;
  hooks.setStorageUserId(user.id);

  const loginEmail = (user.email || "").toLowerCase();
  try {
    const pending = await peekPendingInvites();
    const claimed = await claimPendingInvites();
    if (claimed > 0) {
      setSyncStatus(`Đã nhận ${claimed} lời mời chia sẻ.`, "ok");
    } else if (pending.length > 0) {
      const names = pending.map((p) => p.family_name).join(", ");
      setSyncStatus(`Có lời mời «${names}» nhưng chưa nhận được — chạy lại supabase-fix-missing-functions.sql rồi F5.`, "err");
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("gp_claim_invites") || msg.includes("gp_peek_pending")) {
      setSyncStatus(
        "Thiếu hàm nhận lời mời — chạy supabase-fix-missing-functions.sql trong Supabase SQL Editor, F5 trang.",
        "err"
      );
    }
  }

  const families = await renderFamilyList(user.id);
  let activeId = getActiveFamilyId(user.id);
  if (activeId && !families.some((f) => f.id === activeId)) {
    activeId = "";
    setActiveFamilyId("", user.id);
  }
  if (!activeId && families.length > 0) {
    const owned = families.filter((f) => f.role === "owner");
    const shared = families.filter((f) => f.role === "editor");
    activeId = (owned[0] || shared[0]).id;
    setActiveFamilyId(activeId, user.id);
  }

  const select = el("cloud-family-select");
  if (select) select.value = activeId || "";
  updateWorkspaceRoleHint(families, activeId);

  const prevLoaded = lastLoadedFamilyId;
  if (activeId !== prevLoaded) {
    hooks.resetMemberFormOnFamilyChange(prevLoaded || document.body.dataset.activeFamilyId || "");
  }

  document.body.dataset.activeFamilyId = activeId || "";

  const sameFamily = Boolean(activeId && activeId === lastLoadedFamilyId);

  if (activeId) {
    setSyncStatus("Đang đồng bộ gia phả chung…", "sync");
    try {
      const billing = await getFamilyBilling(activeId).catch(() => null);
      setCurrentBilling(billing);

      if (!sameFamily) {
        const loaded = await loadFamilyState(activeId);
        if (loaded) {
          hooks.setCloudMeta({ familyId: activeId, updatedAt: loaded.updatedAt });
          hooks.applyState(loaded.state);
          lastLoadedFamilyId = activeId;
        }
      }

      hooks.refreshUi();

      const stillEditing = Boolean(hooks.isMemberFormDirty?.());
      if (sameFamily && stillEditing) {
        setSyncStatus("Đang sửa — chưa lưu (chưa tải lại từ máy chủ).", "warn");
      } else if (billing?.is_unlimited) {
        setSyncStatus("Gói không giới hạn thành viên. Đã đồng bộ đám mây.", "ok");
      } else {
        setSyncStatus(
          `Miễn phí ${billing?.member_count ?? "?"}/${billing?.max_members ?? 30} thành viên. Đã đồng bộ đám mây.`,
          "ok"
        );
      }
    } catch (e) {
      setSyncStatus("Lỗi tải: " + (e?.message || e), "err");
      if (!sameFamily) {
        lastLoadedFamilyId = "";
        hooks.replaceAppState(EMPTY_STATE);
        hooks.refreshUi();
      }
    }
  } else {
    lastLoadedFamilyId = "";
    setCurrentBilling(null);
    document.body.dataset.activeFamilyId = "";
    hooks.setCloudMeta({ familyId: null, updatedAt: null });
    hooks.replaceAppState(EMPTY_STATE);
    hooks.refreshUi();
    const emailHint = loginEmail
      ? ` Đang đăng nhập: ${loginEmail} — lời mời phải gửi đúng email này.`
      : "";
    setSyncStatus(
      families.length
        ? "Chọn gia phả ở thanh trên."
        : `Chưa có gia phả — bấm «+ Tạo gia phả» hoặc đợi chủ mời.${emailHint}`,
      "warn"
    );
  }
}

/**
 * @param {string} userId
 * @returns {Promise<{ id: string, name: string, invite_code: string, role: string, updated_at: string }[]>}
 */
/**
 * @param {{ id: string, name: string, role: string }[]} families
 * @param {string} activeId
 */
function updateWorkspaceRoleHint(families, activeId) {
  const hint = el("workspace-family-role");
  const shareBtn = el("top-btn-share");
  const fam = families.find((f) => f.id === activeId);
  currentFamilyRole =
    fam?.role === "owner" ? "owner" : fam?.role === "editor" ? "editor" : fam?.role === "viewer" ? "viewer" : null;
  document.body.dataset.familyRole = currentFamilyRole || "";

  if (shareBtn) shareBtn.hidden = currentFamilyRole !== "owner";

  const roBanner = el("workspace-readonly-banner");
  if (roBanner) roBanner.hidden = currentFamilyRole !== "viewer";

  if (!hint) {
    refreshUpgradeButtonsForFamily(activeId);
    hooks.refreshUi?.();
    return;
  }
  if (!fam) {
    hint.hidden = true;
    hint.textContent = "";
    refreshUpgradeButtonsForFamily("");
    hooks.refreshUi?.();
    return;
  }
  hint.hidden = false;
  if (currentFamilyRole === "owner") {
    hint.textContent = `Bạn là chủ «${fam.name}» — có thể mời người khác sửa hoặc chỉ xem.`;
    hint.className = "workspace-family-role meta workspace-family-role--owner";
  } else if (currentFamilyRole === "viewer") {
    hint.textContent = `«${fam.name}» — bạn chỉ được xem (không lưu / không thêm).`;
    hint.className = "workspace-family-role meta workspace-family-role--viewer";
  } else {
    hint.textContent = `«${fam.name}» — được chia sẻ, bạn có thể sửa (không mời thêm).`;
    hint.className = "workspace-family-role meta workspace-family-role--shared";
  }

  refreshUpgradeButtonsForFamily(activeId);
  hooks.refreshUi?.();
}

/** @param {string} activeId */
function refreshUpgradeButtonsForFamily(activeId) {
  const bill = getCurrentBilling();
  refreshUpgradeButtons({
    isOwner: currentFamilyRole === "owner" || bill?.isOwner === true,
    isUnlimited: bill?.isUnlimited ?? false,
    hasFamily: Boolean(activeId),
    pendingCode: bill?.pendingCode ?? null,
  });
}

async function renderFamilyList(userId) {
  const select = el("cloud-family-select");
  /** @type {{ id: string, name: string, invite_code: string, role: string, updated_at: string }[]} */
  let families = [];

  try {
    families = await listFamiliesForUser(userId);
  } catch (e) {
    setSyncStatus("Không tải danh sách gia phả: " + (e?.message || e), "err");
    return families;
  }

  const owned = families.filter((f) => f.role === "owner");
  const shared = families.filter((f) => f.role === "editor");
  const viewers = families.filter((f) => f.role === "viewer");

  if (select) {
    select.innerHTML = `<option value="">— Chọn gia phả —</option>`;

    if (owned.length) {
      const grp = document.createElement("optgroup");
      grp.label = `Tôi làm chủ (${owned.length})`;
      for (const f of owned) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name;
        grp.appendChild(opt);
      }
      select.appendChild(grp);
    }

    if (shared.length) {
      const grp = document.createElement("optgroup");
      grp.label = `Được chia sẻ — sửa (${shared.length})`;
      for (const f of shared) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name;
        grp.appendChild(opt);
      }
      select.appendChild(grp);
    }

    if (viewers.length) {
      const grp = document.createElement("optgroup");
      grp.label = `Chỉ xem (${viewers.length})`;
      for (const f of viewers) {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.name;
        grp.appendChild(opt);
      }
      select.appendChild(grp);
    }
  }

  return families;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function openShareDialog() {
  const dlg = /** @type {HTMLDialogElement | null} */ (el("share-dialog"));
  const familyId = getActiveFamilyId(currentUserId || undefined);
  if (!familyId) {
    alert("Chọn gia phả chung trước.");
    return;
  }
  await renderShareAccess(familyId);
  const pubBlock = el("share-public-block");
  const codeEl = el("share-invite-code");
  const urlInput = /** @type {HTMLInputElement | null} */ (el("share-public-url"));
  try {
    const info = await getFamilyShareInfo(familyId);
    if (info?.invite_code && pubBlock && codeEl && urlInput) {
      pubBlock.hidden = false;
      codeEl.textContent = info.invite_code;
      urlInput.value = buildPublicViewUrl(info.invite_code);
    } else if (pubBlock) {
      pubBlock.hidden = true;
    }
  } catch {
    if (pubBlock) pubBlock.hidden = true;
  }
  if (dlg?.showModal) dlg.showModal();
}

async function renderShareAccess(familyId) {
  const membersUl = el("share-members-list");
  const invitesUl = el("share-invites-list");
  const inviteBtn = el("share-btn-invite");
  const emailInput = /** @type {HTMLInputElement | null} */ (el("share-invite-email"));

  let access = { members: [], invites: [], is_owner: false };
  try {
    access = await listFamilyAccess(familyId);
  } catch (e) {
    const msg = String(e?.message || e);
    const hint = msg.includes("gp_list_family_access")
      ? " Chạy file supabase-fix-share.sql trong Supabase → SQL Editor, đợi ~10 giây, F5 trang."
      : "";
    if (membersUl) {
      membersUl.innerHTML = `<li class="meta">Chưa tải được danh sách: ${escapeHtml(msg)}.${hint}</li>`;
    }
    return;
  }

  if (inviteBtn) inviteBtn.hidden = !access.is_owner;
  if (emailInput) emailInput.disabled = !access.is_owner;

  if (membersUl) {
    membersUl.innerHTML = access.members.length
      ? access.members
          .map((m) => {
            const role =
              m.role === "owner" ? "Chủ" : m.role === "viewer" ? "Chỉ xem" : "Chỉnh sửa";
            const email = escapeHtml(m.email || m.user_id || "");
            const uid = escapeHtml(m.user_id);
            const actions =
              access.is_owner && m.role !== "owner"
                ? `<div class="share-member-actions">
                    <select class="share-role-select" data-user-id="${uid}" aria-label="Quyền cho ${email}">
                      <option value="editor"${m.role === "editor" ? " selected" : ""}>Chỉnh sửa</option>
                      <option value="viewer"${m.role === "viewer" ? " selected" : ""}>Chỉ xem</option>
                    </select>
                    <button type="button" class="btn btn-sm primary share-role-apply" data-user-id="${uid}">Cấp lại quyền</button>
                    <button type="button" class="btn btn-sm share-remove" data-user-id="${uid}">Gỡ</button>
                  </div>`
                : "";
            return `<li><span class="share-member-label">${email} <em>(${role})</em></span>${actions}</li>`;
          })
          .join("")
      : `<li class="meta">Chưa có ai.</li>`;

    membersUl.querySelectorAll(".share-role-apply").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.getAttribute("data-user-id");
        if (!uid) return;
        const row = btn.closest("li");
        const sel = row?.querySelector(".share-role-select");
        const role = sel?.value === "viewer" ? "viewer" : "editor";
        try {
          await setFamilyMemberRole(familyId, uid, role);
          await renderShareAccess(familyId);
          await refreshAccountUi();
          alert(role === "viewer" ? "Đã cấp quyền chỉ xem." : "Đã cấp quyền chỉnh sửa.");
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes("gp_set_family_member_role")) {
            alert(msg + "\n\n→ Chạy supabase-viewer.sql trong Supabase → SQL Editor, F5 trang.");
          } else {
            alert(msg);
          }
        }
      });
    });

    membersUl.querySelectorAll(".share-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.getAttribute("data-user-id");
        if (!uid || !confirm("Gỡ quyền truy cập của người này?")) return;
        try {
          await removeFamilyMember(familyId, uid);
          await renderShareAccess(familyId);
          await refreshAccountUi();
        } catch (e) {
          alert(String(e?.message || e));
        }
      });
    });
  }

  if (invitesUl) {
    if (!access.is_owner) {
      invitesUl.innerHTML = `<li class="meta">Chỉ chủ gia phả xem lời mời chờ.</li>`;
      return;
    }
    invitesUl.innerHTML = access.invites.length
      ? access.invites
          .map(
            (i) =>
              `<li><span>${escapeHtml(i.email)} <em>(${i.role === "viewer" ? "chỉ xem" : "sửa"})</em></span>
              <button type="button" class="btn btn-sm share-revoke" data-invite-id="${escapeHtml(i.id)}">Hủy</button></li>`
          )
          .join("")
      : `<li class="meta">Không có lời mời chờ.</li>`;

    invitesUl.querySelectorAll(".share-revoke").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-invite-id");
        if (!id) return;
        try {
          await revokeInvite(id);
          await renderShareAccess(familyId);
        } catch (e) {
          alert(String(e?.message || e));
        }
      });
    });
  }
}

function bindAccountEvents() {
  el("cloud-btn-local-only")?.addEventListener("click", () => {
    setLocalOnlyMode(true);
    refreshAccountUi();
  });

  const googleAuth = async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      alert("Không mở được đăng nhập Google: " + (e?.message || e));
    }
  };
  el("cloud-btn-google-login")?.addEventListener("click", googleAuth);
  el("cloud-btn-google-signup")?.addEventListener("click", googleAuth);

  el("cloud-show-signup")?.addEventListener("click", () => showAuthPanel("signup"));
  el("cloud-show-login")?.addEventListener("click", () => showAuthPanel("login"));

  el("cloud-show-forgot")?.addEventListener("click", () => {
    const panel = el("cloud-forgot-panel");
    const loginForm = el("cloud-login-panel")?.querySelector(".cloud-auth-form");
    if (panel) panel.hidden = false;
    if (loginForm) /** @type {HTMLElement} */ (loginForm).hidden = true;
    const email = /** @type {HTMLInputElement} */ (el("cloud-login-email"))?.value || "";
    const forgotEmail = /** @type {HTMLInputElement} */ (el("cloud-forgot-email"));
    if (forgotEmail && email) forgotEmail.value = email;
  });

  el("cloud-hide-forgot")?.addEventListener("click", () => {
    const panel = el("cloud-forgot-panel");
    const loginForm = el("cloud-login-panel")?.querySelector(".cloud-auth-form");
    if (panel) panel.hidden = true;
    if (loginForm) /** @type {HTMLElement} */ (loginForm).hidden = false;
  });

  el("cloud-btn-forgot")?.addEventListener("click", async () => {
    const email = /** @type {HTMLInputElement} */ (el("cloud-forgot-email"))?.value?.trim() || "";
    if (!email) {
      alert("Nhập email.");
      return;
    }
    try {
      await resetPasswordForEmail(email);
      alert("Đã gửi email đặt lại mật khẩu (kiểm tra hộp thư / spam).");
    } catch (e) {
      alert("Không gửi được: " + (e?.message || e));
    }
  });

  el("cloud-btn-signin")?.addEventListener("click", async () => {
    const email = /** @type {HTMLInputElement} */ (el("cloud-login-email"))?.value || "";
    const password = /** @type {HTMLInputElement} */ (el("cloud-login-password"))?.value || "";
    try {
      await signIn(email, password);
      setLocalOnlyMode(false);
      await refreshAccountUi();
    } catch (e) {
      alert("Đăng nhập thất bại: " + (e?.message || e));
    }
  });

  el("cloud-btn-signup")?.addEventListener("click", async () => {
    const email = /** @type {HTMLInputElement} */ (el("cloud-signup-email"))?.value || "";
    const password = /** @type {HTMLInputElement} */ (el("cloud-signup-password"))?.value || "";
    const name = /** @type {HTMLInputElement} */ (el("cloud-signup-name"))?.value || "";
    if (password.length < 6) {
      alert("Mật khẩu tối thiểu 6 ký tự.");
      return;
    }
    try {
      const res = await signUp(email, password, name);
      if (res.session) {
        setLocalOnlyMode(false);
        alert("Đăng ký thành công.");
        await refreshAccountUi();
      } else {
        alert("Đã gửi email xác nhận (nếu bật trong Supabase). Sau khi xác nhận, đăng nhập lại.");
      }
    } catch (e) {
      alert("Đăng ký thất bại: " + (e?.message || e));
    }
  });

  el("cloud-btn-create-family")?.addEventListener("click", async () => {
    const session = await getSession();
    if (!session?.user) {
      alert("Cần đăng nhập trước.");
      return;
    }
    let name = /** @type {HTMLInputElement} */ (el("cloud-family-name"))?.value?.trim() || "";
    if (!name) {
      name = prompt("Tên gia phả mới:", "Gia phả họ tôi")?.trim() || "";
      if (!name) return;
    }
    try {
      const fam = await createFamily(name, EMPTY_STATE);
      hooks.resetMemberFormOnFamilyChange(document.body.dataset.activeFamilyId || "");
      setActiveFamilyId(fam.id, session.user.id);
      hooks.setCloudMeta({ familyId: fam.id, updatedAt: fam.updated_at || "" });
      hooks.applyState(EMPTY_STATE);
      await renderFamilyList(session.user.id);
      const select = el("cloud-family-select");
      if (select) select.value = fam.id;
      setSyncStatus(`Đã tạo «${fam.name}». Thêm thành viên và lưu để đồng bộ.`, "ok");
    } catch (e) {
      alert("Không tạo được: " + (e?.message || e));
    }
  });

  el("cloud-family-select")?.addEventListener("change", async (ev) => {
    const id = /** @type {HTMLSelectElement} */ (ev.target).value;
    const uid = currentUserId;
    setActiveFamilyId(id, uid || undefined);
    hooks.setCloudMeta({ familyId: id || null, updatedAt: null });
    await refreshAccountUi(await getSession());
  });

  el("top-btn-share")?.addEventListener("click", () => {
    if (currentFamilyRole !== "owner") {
      alert("Chỉ chủ gia phả mới chia sẻ được. Chọn gia phả ở nhóm «Tôi làm chủ».");
      return;
    }
    openShareDialog();
  });

  wireDialogBackdropClose("share-dialog");

  if (!shareDialogWired) {
    shareDialogWired = true;
    el("share-btn-invite")?.addEventListener("click", async () => {
      const familyId = getActiveFamilyId(currentUserId || undefined);
      const email = /** @type {HTMLInputElement} */ (el("share-invite-email"))?.value?.trim() || "";
      if (!familyId || !email) {
        alert("Nhập email người được mời.");
        return;
      }
      try {
        const roleSel = /** @type {HTMLSelectElement | null} */ (el("share-invite-role"));
        const role = roleSel?.value === "viewer" ? "viewer" : "editor";
        await inviteEditorByEmail(familyId, email, role);
        /** @type {HTMLInputElement} */ (el("share-invite-email")).value = "";
        await renderShareAccess(familyId);
        alert(`Đã gửi lời mời tới ${email}. Họ cần đăng ký/đăng nhập bằng đúng email đó.`);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("gp_invite_by_email") || msg.includes("gp_list_family_access")) {
          alert(
            msg +
              "\n\n→ Chạy file supabase-fix-missing-functions.sql (hoặc supabase-fix-share.sql) trong Supabase → SQL Editor, đợi 10 giây, F5 trang rồi thử lại."
          );
        } else {
          alert(msg);
        }
      }
    });

    el("share-copy-public")?.addEventListener("click", async () => {
      const url = /** @type {HTMLInputElement} */ (el("share-public-url"))?.value || "";
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        alert("Đã sao chép link xem công khai.");
      } catch {
        alert(url);
      }
    });

    el("cloud-btn-join")?.addEventListener("click", async () => {
      const code = /** @type {HTMLInputElement} */ (el("cloud-join-code"))?.value?.trim() || "";
      const roleSel = /** @type {HTMLSelectElement | null} */ (el("cloud-join-role"));
      const role = roleSel?.value === "viewer" ? "viewer" : "editor";
      if (!code) {
        alert("Nhập mã mời.");
        return;
      }
      const session = await getSession();
      if (!session?.user) {
        alert("Cần đăng nhập trước.");
        return;
      }
      try {
        const fam = await joinFamilyByCode(code, role);
        setActiveFamilyId(fam.id, session.user.id);
        hooks.resetMemberFormOnFamilyChange(document.body.dataset.activeFamilyId || "");
        hooks.setCloudMeta({ familyId: fam.id, updatedAt: null });
        await refreshAccountUi(session);
        const select = el("cloud-family-select");
        if (select) select.value = fam.id;
        setSyncStatus(`Đã tham gia «${fam.name}».`, "ok");
        /** @type {HTMLInputElement} */ (el("cloud-join-code")).value = "";
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("gp_join_by_invite") || msg.includes("viewer")) {
          alert(msg + "\n\n→ Chạy supabase-viewer.sql trong Supabase → SQL Editor, F5 trang.");
        } else {
          alert(msg);
        }
      }
    });

    el("share-btn-pull")?.addEventListener("click", async () => {
      const id = getActiveFamilyId(currentUserId || undefined);
      if (!id) return;
      try {
        const loaded = await loadFamilyState(id);
        if (!loaded) return;
        if (!confirm("Tải bản trên máy chủ? Thay đổi chưa đồng bộ trên máy này có thể mất.")) return;
        hooks.setCloudMeta({ familyId: id, updatedAt: loaded.updatedAt });
        hooks.applyState(loaded.state);
        hooks.refreshUi();
        setSyncStatus("Đã tải bản mới nhất từ máy chủ.", "ok");
      } catch (e) {
        alert("Lỗi: " + (e?.message || e));
      }
    });
  }
}
