/**
 * Tiêu điểm crop ảnh đại diện (object-position) theo từng thành viên.
 * - sanitizeAnhFocus: chỉ cho phép giá trị an toàn cho CSS.
 * - detectFaceObjectPosition: dùng FaceDetector (Chromium), không gửi ảnh lên server.
 */

/** @param {unknown} raw @returns {string} */
export function sanitizeAnhFocus(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 48) return "";
  const tok = "(?:\\d{1,3}(?:\\.\\d+)?%|center|left|right|top|bottom)";
  const re = new RegExp(`^${tok}(?:\\s+${tok})?$`, "i");
  return re.test(s) ? s : "";
}

/**
 * Phát hiện khuôn mặt (ảnh đã tải xong) → chuỗi object-position dạng "42% 35%".
 * @param {HTMLImageElement} img
 * @returns {Promise<string | null>}
 */
export async function detectFaceObjectPositionFromImage(img) {
  const FD = globalThis.FaceDetector;
  if (typeof FD !== "function" || !img.naturalWidth) return null;

  try {
    const detector = new FD({ fastMode: true, maxDetectedFaces: 4 });
    const faces = await detector.detect(img);
    if (!faces?.length) return null;

    let best = faces[0].boundingBox;
    let bestArea = best.width * best.height;
    for (let i = 1; i < faces.length; i++) {
      const b = faces[i].boundingBox;
      const a = b.width * b.height;
      if (a > bestArea) {
        best = b;
        bestArea = a;
      }
    }

    const nx = (best.x + best.width / 2) / img.naturalWidth;
    /** Hơi lệch lên phần trên hộp mặt (mắt), crop ô ngang đẹp hơn */
    const ny = (best.y + best.height * 0.35) / img.naturalHeight;
    const xPct = Math.round(Math.min(100, Math.max(0, nx * 100)) * 10) / 10;
    const yPct = Math.round(Math.min(100, Math.max(0, ny * 100)) * 10) / 10;
    return `${xPct}% ${yPct}%`;
  } catch {
    return null;
  }
}

/**
 * @param {string} imageUrl
 * @returns {Promise<string | null>}
 */
export async function detectFaceObjectPosition(imageUrl) {
  const u = String(imageUrl || "").trim();
  if (!u) return null;

  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    img.onload = () => resolve(undefined);
    img.onerror = () => reject(new Error("Không tải được ảnh (URL hoặc CORS)."));
    img.src = u;
  });

  return detectFaceObjectPositionFromImage(img);
}
