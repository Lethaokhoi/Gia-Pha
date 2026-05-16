import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/** SePay gọi khi có tiền vào TK — tự kích hoạt gp_confirm_premium_order */
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const apiKey = Deno.env.get("SEPAY_WEBHOOK_API_KEY") || "";
    if (apiKey) {
      const auth = req.headers.get("Authorization") || "";
      const ok = auth === `ApiKey ${apiKey}` || auth === `Apikey ${apiKey}`;
      if (!ok) {
        console.error("SePay: sai Authorization header");
        return new Response(JSON.stringify({ success: false }), { status: 401 });
      }
    }

    const body = await req.json();
    const transferType = String(body.transferType || "");
    if (transferType && transferType !== "in") {
      return new Response(JSON.stringify({ success: true, skip: "not incoming" }));
    }

    const amount = Number(body.transferAmount || 0);
    const minAmount = Number(Deno.env.get("PREMIUM_AMOUNT_VND") || "20000");
    if (amount > 0 && amount < minAmount) {
      console.log("SePay: số tiền nhỏ hơn gói", amount);
      return new Response(JSON.stringify({ success: true, skip: "amount low" }));
    }

    let paymentCode = String(body.code || "").trim().toUpperCase();
    const content = String(body.content || "");
    if (!paymentCode) {
      const m = content.toUpperCase().match(/GP[A-Z0-9]{6,12}/);
      if (m) paymentCode = m[0];
    }
    if (!paymentCode || !paymentCode.startsWith("GP")) {
      console.log("SePay: không thấy mã GP trong", content);
      return new Response(JSON.stringify({ success: true, skip: "no code" }));
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase.rpc("gp_confirm_premium_order", {
      p_payment_code: paymentCode,
    });

    if (error) {
      console.error("gp_confirm_premium_order", paymentCode, error);
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
      });
    }

    console.log("SePay: đã kích hoạt", paymentCode, data);
    return new Response(JSON.stringify({ success: true, payment_code: paymentCode }));
  } catch (e) {
    console.error("sepay-webhook", e);
    return new Response(JSON.stringify({ success: false }), { status: 500 });
  }
});
