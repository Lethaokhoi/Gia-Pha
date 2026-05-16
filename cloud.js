import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  isCloudConfigured,
  isLegacyAnonKey,
  AVATAR_BUCKET,
  AVATAR_MAX_MB,
} from "./config.js";

export { isCloudConfigured };

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let client = null;

function authRedirectUrl() {
  const url = new URL(location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
  url.hash = "";
  return url.origin + url.pathname + url.search;
}

/** Xóa tham số OAuth khỏi thanh địa chỉ sau khi đổi code lấy session. */
export function cleanAuthParamsFromUrl() {
  const url = new URL(location.href);
  let dirty = false;
  for (const key of ["code", "state", "error", "error_description"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      dirty = true;
    }
  }
  if (url.hash && (url.hash.includes("access_token") || url.hash.includes("error"))) {
    url.hash = "";
    dirty = true;
  }
  if (dirty) {
    history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
}

/**
 * Đợi / đổi mã OAuth (PKCE) sau khi redirect từ Google.
 * @returns {Promise<import('@supabase/supabase-js').Session | null>}
 */
export async function ensureAuthSession() {
  const sb = getClient();
  if (!sb) return null;

  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const oauthError = params.get("error_description") || params.get("error");

  if (oauthError) {
    cleanAuthParamsFromUrl();
    throw new Error(decodeURIComponent(oauthError));
  }

  if (code) {
    const { data, error } = await sb.auth.exchangeCodeForSession(code);
    cleanAuthParamsFromUrl();
    if (error) throw error;
    return data.session;
  }

  const {
    data: { session },
    error,
  } = await sb.auth.getSession();
  if (error) throw error;
  return session;
}

export function getClient() {
  if (!isCloudConfigured()) return null;
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // Đổi mã OAuth thủ công trong ensureAuthSession() — tránh trùng với auto-detect.
        detectSessionInUrl: false,
        persistSession: true,
        flowType: "pkce",
      },
    });
  }
  return client;
}

/** Đăng nhập / đăng ký bằng tài khoản Google (cấu hình trong Supabase + Google Cloud). */
export async function signInWithGoogle() {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase (config.js).");
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: authRedirectUrl(),
      queryParams: { prompt: "select_account" },
    },
  });
  if (error) throw error;
}

function randomInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** @param {unknown} data */
export function parseFamilyPayload(data) {
  if (!data || typeof data !== "object") return null;
  const o = /** @type {{ members?: unknown, focalId?: unknown, treeScope?: unknown }} */ (data);
  if (!Array.isArray(o.members)) return null;
  return {
    members: o.members,
    focalId: o.focalId ?? null,
    treeScope: o.treeScope ?? "ca_hai",
  };
}

export async function getSession() {
  const sb = getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function signUp(email, password, displayName) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase (config.js).");
  const { data, error } = await sb.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { display_name: (displayName || "").trim() } },
  });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase (config.js).");
  const { data, error } = await sb.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const sb = getClient();
  if (!sb) return;
  await sb.auth.signOut();
}

/**
 * @param {string} userId
 * @returns {Promise<{ id: string, name: string, invite_code: string, role: string, updated_at: string }[]>}
 */
export async function listFamiliesForUser(userId) {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from("gp_family_members")
    .select("role, family:gp_families(id, name, invite_code, updated_at)")
    .eq("user_id", userId);
  if (error) throw error;
  /** @type {{ id: string, name: string, invite_code: string, role: string, updated_at: string }[]} */
  const out = [];
  for (const row of data || []) {
    const fam = row.family;
    if (!fam?.id) continue;
    out.push({
      id: fam.id,
      name: fam.name || "Gia phả",
      invite_code: fam.invite_code || "",
      role: row.role || "editor",
      updated_at: fam.updated_at || "",
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

/**
 * @param {string} name
 * @param {{ members: unknown[], focalId: string | null, treeScope: string }} initialState
 */
function assertUsableSupabaseKey() {
  if (!isLegacyAnonKey()) {
    throw new Error(
      "config.js: SUPABASE_ANON_KEY phải là anon public (bắt đầu eyJ…).\n" +
        "Vào Supabase → Project Settings → API → Legacy API Keys → anon public → copy vào config.js.\n" +
        "Key sb_publishable_… thường gây lỗi RLS khi tạo gia phả."
    );
  }
}

export async function createFamily(name, initialState) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  assertUsableSupabaseKey();

  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session?.user) throw new Error("Cần đăng nhập trước.");

  const invite_code = randomInviteCode();
  const familyName = (name || "Gia phả").trim() || "Gia phả";

  const { data, error } = await sb.rpc("gp_create_family", {
    p_name: familyName,
    p_invite_code: invite_code,
    p_data: initialState,
  });

  if (!error && data && typeof data === "object" && data.id) {
    return {
      id: data.id,
      name: data.name || familyName,
      invite_code: data.invite_code || invite_code,
      updated_at: data.updated_at || "",
    };
  }

  const rpcMissing =
    error?.code === "PGRST202" ||
    String(error?.message || "").includes("Could not find the function");

  if (rpcMissing) {
    throw new Error(
      "Chưa cài hàm gp_create_family trên Supabase.\n\n" +
        "1. Mở Supabase → SQL Editor\n" +
        "2. Copy toàn bộ file Gia_pha/supabase-fix-rls.sql\n" +
        "3. Run → F5 tải lại trang → thử Tạo gia phả lại"
    );
  }

  if (error) {
    throw new Error(error.message || "Lỗi tạo gia phả");
  }

  throw new Error("Không nhận được dữ liệu sau khi tạo gia phả. Thử lại.");
}

/** @returns {Promise<{ family_id: string, family_name: string, invite_email: string }[]>} */
export async function peekPendingInvites() {
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await sb.rpc("gp_peek_pending_invites");
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

/** Nhận lời mời đã gửi tới email đang đăng nhập. */
export async function claimPendingInvites() {
  const sb = getClient();
  if (!sb) return 0;
  const { data, error } = await sb.rpc("gp_claim_invites");
  if (error) throw error;
  return typeof data === "number" ? data : 0;
}

/** @param {string} familyId @param {string} email */
export async function inviteEditorByEmail(familyId, email) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const { data, error } = await sb.rpc("gp_invite_by_email", {
    p_family_id: familyId,
    p_email: email.trim(),
  });
  if (error) throw error;
  return data;
}

/** @param {string} familyId */
export async function listFamilyAccess(familyId) {
  const sb = getClient();
  if (!sb) return { members: [], invites: [], is_owner: false };

  const { data, error } = await sb.rpc("gp_list_family_access", { p_family_id: familyId });
  if (!error && data && typeof data === "object") {
    const o = /** @type {{ members?: unknown[], invites?: unknown[], is_owner?: boolean }} */ (data);
    return {
      members: Array.isArray(o.members) ? o.members : [],
      invites: Array.isArray(o.invites) ? o.invites : [],
      is_owner: Boolean(o.is_owner),
    };
  }

  const rpcMissing =
    error?.code === "PGRST202" ||
    String(error?.message || "").includes("gp_list_family_access");

  if (!rpcMissing && error) throw error;

  return listFamilyAccessFallback(sb, familyId);
}

/** Đọc trực tiếp bảng khi chưa cài RPC (chạy supabase-fix-rls.sql để đủ tính năng mời email). */
async function listFamilyAccessFallback(sb, familyId) {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { members: [], invites: [], is_owner: false };

  const { data: rows, error: memErr } = await sb
    .from("gp_family_members")
    .select("user_id, role, user_email, joined_at")
    .eq("family_id", familyId);
  if (memErr) throw memErr;

  const members = (rows || []).map((m) => ({
    user_id: m.user_id,
    role: m.role,
    email: m.user_email || (m.user_id === user.id ? user.email : m.user_id),
    joined_at: m.joined_at,
  }));

  const is_owner = members.some((m) => m.user_id === user.id && m.role === "owner");

  let invites = [];
  if (is_owner) {
    const { data: invRows, error: invErr } = await sb
      .from("gp_family_invites")
      .select("id, email, created_at")
      .eq("family_id", familyId)
      .order("created_at");
    if (!invErr && invRows) invites = invRows;
  }

  return { members, invites, is_owner };
}

/** @param {string} familyId @param {string} userId */
export async function removeFamilyMember(familyId, userId) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const { error } = await sb.rpc("gp_remove_family_member", {
    p_family_id: familyId,
    p_user_id: userId,
  });
  if (error) throw error;
}

/**
 * @typedef {{ member_count: number, max_members: number, is_unlimited: boolean, can_add_more: boolean, premium_price_vnd: number, pending_payment_code: string | null, is_owner: boolean }} FamilyBilling
 */

/** @param {string} familyId @returns {Promise<FamilyBilling | null>} */
export async function getFamilyBilling(familyId) {
  const sb = getClient();
  if (!sb || !familyId) return null;
  const { data, error } = await sb.rpc("gp_get_family_billing", { p_family_id: familyId });
  if (!error && data && typeof data === "object") {
    return /** @type {FamilyBilling} */ (data);
  }

  const rpcMissing =
    error?.code === "PGRST202" ||
    String(error?.message || "").includes("gp_get_family_billing");

  if (!rpcMissing && error) throw error;

  return getFamilyBillingFallback(sb, familyId);
}

/** @param {import('@supabase/supabase-js').SupabaseClient} sb @param {string} familyId */
async function getFamilyBillingFallback(sb, familyId) {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const { data: fam, error: famErr } = await sb
    .from("gp_families")
    .select("data, max_members, is_unlimited")
    .eq("id", familyId)
    .maybeSingle();
  if (famErr || !fam) return null;

  const { data: mem } = await sb
    .from("gp_family_members")
    .select("role")
    .eq("family_id", familyId)
    .eq("user_id", user.id)
    .maybeSingle();

  const count = Array.isArray(fam.data?.members) ? fam.data.members.length : 0;
  const max = fam.max_members ?? 30;
  const unlimited = Boolean(fam.is_unlimited);

  return {
    member_count: count,
    max_members: max,
    is_unlimited: unlimited,
    can_add_more: unlimited || count < max,
    premium_price_vnd: 20000,
    pending_payment_code: null,
    is_owner: mem?.role === "owner",
  };
}

/** @param {string} familyId */
export async function createPremiumOrder(familyId) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const { data, error } = await sb.rpc("gp_create_premium_order", { p_family_id: familyId });
  if (error) throw error;
  if (!data || typeof data !== "object") throw new Error("Không tạo được đơn thanh toán.");
  return /** @type {{ order_id: string, payment_code: string, amount_vnd: number }} */ (data);
}

/** @param {string} inviteId */
export async function revokeInvite(inviteId) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const { error } = await sb.rpc("gp_revoke_invite", { p_invite_id: inviteId });
  if (error) throw error;
}

/** @param {string} inviteCode */
export async function joinFamilyByCode(inviteCode) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("Cần đăng nhập trước.");

  const code = inviteCode.trim().toUpperCase();
  const { data: familyId, error } = await sb.rpc("gp_join_by_invite", { p_code: code });
  if (error) throw error;
  if (!familyId) throw new Error("Mã mời không đúng hoặc gia phả đã bị xóa.");

  const { data: fam, error: famErr } = await sb.from("gp_families").select("id, name").eq("id", familyId).single();
  if (famErr) throw famErr;
  return fam;
}

/**
 * @param {string} familyId
 * @returns {Promise<{ state: { members: unknown[], focalId: string | null, treeScope: string }, updatedAt: string } | null>}
 */
export async function loadFamilyState(familyId) {
  const sb = getClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from("gp_families")
    .select("data, updated_at, is_unlimited, max_members")
    .eq("id", familyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const parsed = parseFamilyPayload(data.data);
  if (!parsed) throw new Error("Dữ liệu trên máy chủ không hợp lệ.");
  return { state: parsed, updatedAt: data.updated_at || "" };
}

/**
 * @param {string} familyId
 * @param {{ members: unknown[], focalId: string | null, treeScope: string }} state
 * @param {string | null} expectedUpdatedAt
 */
export async function saveFamilyState(familyId, state, expectedUpdatedAt) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("Cần đăng nhập.");

  if (expectedUpdatedAt) {
    const { data: cur } = await sb.from("gp_families").select("updated_at").eq("id", familyId).maybeSingle();
    if (cur?.updated_at && cur.updated_at !== expectedUpdatedAt) {
      return { ok: false, conflict: true, remoteUpdatedAt: cur.updated_at };
    }
  }

  const { data, error } = await sb
    .from("gp_families")
    .update({
      data: state,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", familyId)
    .select("updated_at")
    .single();

  if (error) throw error;
  return { ok: true, conflict: false, updatedAt: data.updated_at || "" };
}

/**
 * @param {string} familyId
 * @param {(payload: { state: { members: unknown[], focalId: string | null, treeScope: string }, updatedAt: string }) => void} onChange
 */
export function subscribeFamily(familyId, onChange) {
  const sb = getClient();
  if (!sb) return () => {};

  const channel = sb
    .channel(`gp_family_${familyId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "gp_families", filter: `id=eq.${familyId}` },
      (payload) => {
        const row = payload.new;
        const parsed = parseFamilyPayload(row?.data);
        if (parsed) onChange({ state: parsed, updatedAt: row.updated_at || "" });
      }
    )
    .subscribe();

  return () => {
    sb.removeChannel(channel);
  };
}

/**
 * Tải ảnh thành viên lên Storage → URL công khai (lưu vào anhUrl).
 * @param {string} familyId
 * @param {string} memberId
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function uploadMemberAvatar(familyId, memberId, file) {
  const sb = getClient();
  if (!sb) throw new Error("Chưa cấu hình Supabase.");
  const {
    data: { session },
  } = await sb.auth.getSession();
  if (!session) throw new Error("Cần đăng nhập để tải ảnh lên.");

  const maxBytes = AVATAR_MAX_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(`Ảnh tối đa ${AVATAR_MAX_MB}MB.`);
  }

  const mime = (file.type || "").toLowerCase();
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowed.includes(mime)) {
    throw new Error("Chỉ chấp nhận JPG, PNG, WebP hoặc GIF.");
  }

  const extMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const ext = extMap[mime] || "jpg";
  const path = `${familyId}/${memberId}/${Date.now()}.${ext}`;

  const { error } = await sb.storage.from(AVATAR_BUCKET).upload(path, file, {
    cacheControl: "31536000",
    upsert: true,
    contentType: mime,
  });

  if (error) {
    const hint =
      error.message?.includes("Bucket not found") || error.message?.includes("bucket")
        ? " Chạy supabase-storage-avatars.sql trong Supabase SQL Editor."
        : "";
    throw new Error((error.message || "Không tải được ảnh.") + hint);
  }

  const { data } = sb.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Không lấy được link ảnh sau khi tải.");
  return data.publicUrl;
}

/**
 * @param {(session: import('@supabase/supabase-js').Session | null, event: string) => void} callback
 */
export function onAuthStateChange(callback) {
  const sb = getClient();
  if (!sb) return () => {};
  const { data } = sb.auth.onAuthStateChange((event, session) => callback(session, event));
  return () => data.subscription.unsubscribe();
}
