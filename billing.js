import {
  FREE_MEMBER_LIMIT,
  PREMIUM_PRICE_VND,
  PAYMENT_BANK_NAME,
  PAYMENT_ACCOUNT_NO,
  PAYMENT_ACCOUNT_NAME,
  PAYMENT_TRANSFER_HINT,
  VIETQR_BANK_ID,
} from "./config.js";
import { getFamilyBilling, createPremiumOrder } from "./cloud.js";

/** @type {{ memberCount: number, maxMembers: number, isUnlimited: boolean, canAddMore: boolean, isOwner: boolean, pendingCode: string | null } | null} */
let currentBilling = null;

export function getCurrentBilling() {
  return currentBilling;
}

/**
 * @param {import('./cloud.js').FamilyBilling | null} b
 */
export function setCurrentBilling(b) {
  if (!b) {
    currentBilling = null;
    return;
  }
  currentBilling = {
    memberCount: b.member_count,
    maxMembers: b.max_members,
    isUnlimited: b.is_unlimited,
    canAddMore: b.can_add_more,
    isOwner: b.is_owner,
    pendingCode: b.pending_payment_code || null,
  };
  refreshBillingUi();
}

/**
 * Hiện nút nâng cấp cho chủ gia phả (kể cả chưa đủ 30 người).
 * @param {{ isOwner?: boolean, isUnlimited?: boolean, hasFamily?: boolean, pendingCode?: string | null }} opts
 */
export function refreshUpgradeButtons(opts = {}) {
  const b = currentBilling;
  const isOwner = opts.isOwner ?? b?.isOwner ?? isCurrentFamilyOwner();
  const isUnlimited = opts.isUnlimited ?? b?.isUnlimited ?? false;
  const hasFamily = opts.hasFamily ?? Boolean(document.body.dataset.activeFamilyId);
  const pendingCode = opts.pendingCode !== undefined ? opts.pendingCode : b?.pendingCode ?? null;
  const show = isOwner && hasFamily && !isUnlimited;
  const label = pendingCode ? "Đang chờ thanh toán…" : `Nâng cấp ${formatVnd(PREMIUM_PRICE_VND)}`;

  for (const id of ["btn-upgrade-premium", "top-header-upgrade"]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.hidden = !show;
    if (show) btn.textContent = label;
  }

  const link = document.getElementById("billing-upgrade-link");
  if (link) link.hidden = !show;
}

export function refreshBillingUi() {
  const bar = document.getElementById("billing-quota-bar");
  const b = currentBilling;

  if (!bar) return;

  if (!b) {
    bar.hidden = true;
    refreshUpgradeButtons({ isOwner: false, hasFamily: Boolean(document.body.dataset.activeFamilyId) });
    return;
  }

  bar.hidden = false;

  if (b.isUnlimited) {
    bar.className = "billing-quota-bar billing-quota-bar--premium";
    bar.innerHTML = `<span class="billing-quota-text">Gói <strong>không giới hạn</strong> thành viên · hiện có <strong>${b.memberCount}</strong> người</span>`;
    refreshUpgradeButtons({ isOwner: b.isOwner, isUnlimited: true, hasFamily: true });
    return;
  }

  const atLimit = b.memberCount >= b.maxMembers;
  const priceShort = new Intl.NumberFormat("vi-VN").format(PREMIUM_PRICE_VND) + "₫";
  bar.className = "billing-quota-bar" + (atLimit ? " billing-quota-bar--full" : "");
  bar.innerHTML = `<span class="billing-quota-text">Miễn phí: <strong>${b.memberCount}/${b.maxMembers}</strong> thành viên</span>
    ${atLimit ? '<span class="billing-quota-warn">Đã đủ — nâng cấp để thêm</span>' : ""}
    <button type="button" class="billing-upgrade-link" id="billing-upgrade-link" hidden>Nâng cấp không giới hạn · ${priceShort}</button>`;

  document.getElementById("billing-upgrade-link")?.addEventListener("click", openUpgradeDialog);

  refreshUpgradeButtons({
    isOwner: b.isOwner,
    isUnlimited: false,
    hasFamily: true,
    pendingCode: b.pendingCode,
  });
}

/**
 * @param {number} additionalCount
 * @returns {boolean}
 */
export function canAddMembers(additionalCount = 1) {
  if (!currentBilling) return true;
  if (currentBilling.isUnlimited) return true;
  return currentBilling.memberCount + additionalCount <= currentBilling.maxMembers;
}

/** @param {number} additionalCount */
export function showQuotaBlockedMessage(additionalCount = 1) {
  const b = currentBilling;
  const limit = b?.maxMembers ?? FREE_MEMBER_LIMIT;
  const price = formatVnd(PREMIUM_PRICE_VND);
  alert(
    `Gia phả miễn phí tối đa ${limit} thành viên (đang ${b?.memberCount ?? "?"}).\n\n` +
      `Nâng cấp ${price}/gia phả để thêm không giới hạn.\n` +
      `Bấm «Nâng cấp» trên thanh công cụ (chỉ chủ gia phả).`
  );
  openUpgradeDialog();
}

export function formatVnd(n) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);
}

function isCurrentFamilyOwner() {
  if (currentBilling?.isOwner) return true;
  return document.body.dataset.familyRole === "owner";
}

export function openUpgradeDialog() {
  const dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById("upgrade-dialog"));
  if (!dlg) return;

  if (!isCurrentFamilyOwner()) {
    alert("Chỉ chủ gia phả mới nâng cấp được. Chọn gia phả ở nhóm «Tôi làm chủ».");
    return;
  }

  if (!document.body.dataset.activeFamilyId) {
    alert("Chọn gia phả cần nâng cấp trước.");
    return;
  }

  fillUpgradeDialog();
  dlg.showModal();
}

function fillUpgradeDialog() {
  const priceEl = document.getElementById("upgrade-price");
  const bankEl = document.getElementById("upgrade-bank-info");
  const codeEl = document.getElementById("upgrade-payment-code");
  const b = currentBilling;

  if (priceEl) priceEl.textContent = formatVnd(PREMIUM_PRICE_VND);
  if (bankEl) {
    bankEl.innerHTML = PAYMENT_BANK_NAME
      ? `<p><strong>Ngân hàng:</strong> ${escapeHtml(PAYMENT_BANK_NAME)}</p>
         <p><strong>Số TK:</strong> ${escapeHtml(PAYMENT_ACCOUNT_NO)}</p>
         <p><strong>Chủ TK:</strong> ${escapeHtml(PAYMENT_ACCOUNT_NAME)}</p>
         <p class="hint">${escapeHtml(PAYMENT_TRANSFER_HINT)}</p>`
      : `<p class="hint">Điền thông tin chuyển khoản trong <code>config.js</code> (PAYMENT_*).</p>`;
  }
  if (codeEl) {
    codeEl.textContent = b?.pendingCode || "— Bấm «Tạo mã & quét VietQR» —";
    codeEl.classList.toggle("upgrade-code--ready", Boolean(b?.pendingCode));
  }

  const qrWrap = document.getElementById("upgrade-vietqr-wrap");
  const qrImg = /** @type {HTMLImageElement | null} */ (document.getElementById("upgrade-vietqr"));
  if (qrWrap && qrImg && b?.pendingCode) {
    qrWrap.hidden = false;
    qrImg.src = vietQrUrl(b.pendingCode, PREMIUM_PRICE_VND);
    qrImg.alt = `VietQR ${b.pendingCode}`;
  } else if (qrWrap) {
    qrWrap.hidden = true;
  }
}

function vietQrUrl(paymentCode, amountVnd) {
  const bank = VIETQR_BANK_ID || "970422";
  const acc = PAYMENT_ACCOUNT_NO || "";
  const name = encodeURIComponent(PAYMENT_ACCOUNT_NAME || "");
  const desc = encodeURIComponent(paymentCode);
  return `https://img.vietqr.io/image/${bank}-${acc}-compact2.png?amount=${amountVnd}&addInfo=${desc}&accountName=${name}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function initBillingPanel() {
  document.addEventListener("click", (ev) => {
    const t = /** @type {HTMLElement} */ (ev.target);
    const id = t.id;
    if (
      id === "btn-upgrade-premium" ||
      id === "top-header-upgrade" ||
      id === "billing-upgrade-link"
    ) {
      openUpgradeDialog();
    }
  });

  document.getElementById("upgrade-btn-create-code")?.addEventListener("click", async () => {
    const familyId = /** @type {string} */ (document.body.dataset.activeFamilyId || "");
    if (!familyId) {
      alert("Chọn gia phả trước.");
      return;
    }
    try {
      const order = await createPremiumOrder(familyId);
      if (currentBilling) currentBilling.pendingCode = order.payment_code;
      fillUpgradeDialog();
      refreshBillingUi();
      alert(
        `Mã: ${order.payment_code}\nSố tiền: ${formatVnd(order.amount_vnd)}\n\n` +
          `Chuyển khoản / quét VietQR với đúng mã trong nội dung CK.\n` +
          `SePay sẽ tự kích hoạt trong ~1 phút (cần cấu hình SEPAY-SETUP.txt).`
      );
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("gp_is_family_owner") || msg.includes("gp_create_premium_order")) {
        alert(
          msg +
            "\n\n→ Chạy file supabase-billing.sql (hoặc supabase-fix-missing-functions.sql) trong Supabase → SQL Editor, đợi 10 giây, F5 trang rồi thử lại."
        );
      } else {
        alert(msg);
      }
    }
  });

  document.getElementById("upgrade-dialog")?.addEventListener("close", () => {});
}
