/** Sao chép file này thành config.js và điền URL + anon key từ Supabase. */
/** Tên hiển thị ở chân trang (copyright). */
export const SITE_AUTHOR = "Họ và tên của bạn";

export const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";

export function isCloudConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_URL.includes("YOUR_PROJECT"));
}

export const FREE_MEMBER_LIMIT = 30;
export const PREMIUM_PRICE_VND = 20000;
export const PAYMENT_BANK_NAME = "";
export const PAYMENT_ACCOUNT_NO = "";
export const PAYMENT_ACCOUNT_NAME = "";
export const PAYMENT_TRANSFER_HINT = "Ghi đúng mã thanh toán vào nội dung chuyển khoản.";
export const VIETQR_BANK_ID = "970422";
export const AVATAR_BUCKET = "gp-avatars";
export const AVATAR_MAX_MB = 3;

