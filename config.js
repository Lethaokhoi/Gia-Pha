/** Điền thông tin Supabase (Project Settings → API). */
export const SUPABASE_URL = "https://ekeckqvdlfoasafoucvp.supabase.co";
/** Phải là anon public (bắt đầu eyJ...), KHÔNG dùng sb_publishable_... */
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrZWNrcXZkbGZvYXNhZm91Y3ZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDk3MTksImV4cCI6MjA5NDQyNTcxOX0.QfclRKG4XDsN0QW2RlDzswSxFtaE7xe0m9fmiSR4m7I";

export function isCloudConfigured() {
  return Boolean(
    SUPABASE_URL &&
      SUPABASE_ANON_KEY &&
      !SUPABASE_URL.includes("YOUR_PROJECT") &&
      !SUPABASE_ANON_KEY.includes("YOUR_ANON")
  );
}

/** Key publishable thường gây lỗi RLS khi tạo gia phả. */
export function isLegacyAnonKey() {
  return SUPABASE_ANON_KEY.startsWith("eyJ");
}

/** Gói miễn phí: tối đa thành viên / gia phả */
export const FREE_MEMBER_LIMIT = 30;
/** Giá nâng cấp không giới hạn (VND) / gia phả */
export const PREMIUM_PRICE_VND = 20000;

/** Thông tin chuyển khoản (hiển thị khi nâng cấp) */
export const PAYMENT_BANK_NAME = "MB Bank";
export const PAYMENT_ACCOUNT_NO = "0342688362";
export const PAYMENT_ACCOUNT_NAME = "CHU TUAN KHOI";
export const PAYMENT_TRANSFER_HINT =
  "Chuyển đúng 20.000đ, nội dung CK ghi đúng mã GP…. SePay sẽ tự kích hoạt gói trong ~1 phút (xem SEPAY-SETUP.txt).";

/** Mã ngân hàng VietQR (MB = 970422) — hiển thị QR sau khi tạo mã GP */
export const VIETQR_BANK_ID = "970422";

/** Bucket Storage cho ảnh thành viên (chạy supabase-storage-avatars.sql) */
export const AVATAR_BUCKET = "gp-avatars";
export const AVATAR_MAX_MB = 3;
