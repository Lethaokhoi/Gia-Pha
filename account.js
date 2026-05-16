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
  revokeInvite,
  ensureAuthSession,
  cleanAuthParamsFromUrl,
  getFamilyBilling,
} from "./cloud.js";
import {
  setCurrentBilling,
  initBillingPanel,
  refreshUpgradeButtons,
  getCurrentBilling,
} from "./billing.js";

const ACTIVE_FAMILY_KEY = "giaPha_activeFamilyId";
const LOCAL_ONLY_KEY = "giaPha_localOnly";

/** @type {{ getState: () => { members: unknown[], focalId: string | null, treeScope: string }, applyState: (s: unknown) => void, setCloudMeta: (m: { familyId: string | null, updatedAt: string | null }) => void, setStorageUserId: (id: string | null) => void, replaceAppState: (s: { members: unknown[], focalId: string | null, treeScope?: string }) => void, refreshUi: () => void, onAuthGate?: (open: boolean) => void }} */
let hooks = {
  getState: () => ({ members: [], focalId: null, treeScope: "ca_hai" }),
  applyState: () => {},
  setCloudMeta: () => {},
  setStorageUserId: () => {},
  replaceAppState: () => {},
  refreshUi: () => {},
  onAuthGate: () => {},
};

let shareDialogWired = false;
/** @type {string | null} */
let currentUserId = null;
/** @type {'owner' | 'editor' | null} */
let currentFamilyRole = null;

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

export function setSyncStatus(text, kind = "") {
  const node = el("cloud-sync-status");
  if (!node) return;
  node.textContent = text;
  node.className = "cloud-sync-status" + (kind ? ` cloud-sync-status--${kind}` : "");
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

  document.body.dataset.activeFamilyId = activeId || "";

  if (activeId) {
    setSyncStatus("Đang đồng bộ gia phả chung…", "sync");
    try {
      const billing = await getFamilyBilling(activeId).catch(() => null);
      setCurrentBilling(billing);
      const loaded = await loadFamilyState(activeId);
      if (loaded) {
        hooks.setCloudMeta({ familyId: activeId, updatedAt: loaded.updatedAt });
        hooks.applyState(loaded.state);
        hooks.refreshUi();
        if (billing?.is_unlimited) {
          setSyncStatus("Gói không giới hạn thành viên. Đã đồng bộ đám mây.", "ok");
        } else {
          setSyncStatus(
            `Miễn phí ${billing?.member_count ?? "?"}/${billing?.max_members ?? 30} thành viên. Đã đồng bộ đám mây.`,
            "ok"
          );
        }
      }
    } catch (e) {
      setSyncStatus("Lỗi tải: " + (e?.message || e), "err");
      hooks.replaceAppState(EMPTY_STATE);
      hooks.refreshUi();
    }
  } else {
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
  currentFamilyRole = fam?.role === "owner" ? "owner" : fam?.role === "editor" ? "editor" : null;
  document.body.dataset.familyRole = currentFamilyRole || "";

  if (shareBtn) shareBtn.hidden = currentFamilyRole !== "owner";

  if (!hint) {
    refreshUpgradeButtonsForFamily(activeId);
    return;
  }
  if (!fam) {
    hint.hidden = true;
    hint.textContent = "";
    refreshUpgradeButtonsForFamily("");
    return;
  }
  hint.hidden = false;
  if (currentFamilyRole === "owner") {
    hint.textContent = `Bạn là chủ «${fam.name}» — có thể mời người khác sửa.`;
    hint.className = "workspace-family-role meta workspace-family-role--owner";
  } else {
    hint.textContent = `«${fam.name}» — được chia sẻ, bạn chỉ sửa (không mời thêm).`;
    hint.className = "workspace-family-role meta workspace-family-role--shared";
  }

  refreshUpgradeButtonsForFamily(activeId);
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
      grp.label = `Được chia sẻ (${shared.length})`;
      for (const f of shared) {
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
            const role = m.role === "owner" ? "Chủ" : "Được mời";
            const email = escapeHtml(m.email || m.user_id || "");
            const remove =
              access.is_owner && m.role !== "owner"
                ? `<button type="button" class="btn btn-sm share-remove" data-user-id="${escapeHtml(m.user_id)}">Gỡ</button>`
                : "";
            return `<li><span>${email} <em>(${role})</em></span>${remove}</li>`;
          })
          .join("")
      : `<li class="meta">Chưa có ai.</li>`;

    membersUl.querySelectorAll(".share-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const uid = btn.getAttribute("data-user-id");
        if (!uid || !confirm("Gỡ quyền chỉnh sửa của người này?")) return;
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
              `<li><span>${escapeHtml(i.email)}</span>
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
    if (!id) {
      updateWorkspaceRoleHint([], "");
      hooks.replaceAppState(EMPTY_STATE);
      hooks.refreshUi();
      setSyncStatus("Chưa chọn gia phả chung.", "warn");
      return;
    }
    await refreshAccountUi(await getSession());
  });

  el("top-btn-share")?.addEventListener("click", () => {
    if (currentFamilyRole !== "owner") {
      alert("Chỉ chủ gia phả mới chia sẻ được. Chọn gia phả ở nhóm «Tôi làm chủ».");
      return;
    }
    openShareDialog();
  });

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
        await inviteEditorByEmail(familyId, email);
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
