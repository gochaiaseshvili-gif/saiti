import crypto from "crypto";

// Official Unified Bank Gateway (Bank of Georgia iPay/Installment + Credo Bank Online Installment + Universal Card Checkout) for Vercel (iyidebaa.ge)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const bank = String(body.bank || "bog").toLowerCase().trim();
    const productName = String(body.productName || "პროდუქტი — iyidebaa.ge").trim();
    const productId = String(body.productId || "101").replace(/[^a-zA-Z0-9_-]/g, "") || "101";
    const amountGel = Math.max(1, Number(body.amount) || 1);
    const originUrl = String(body.originUrl || "https://iyidebaa.ge").replace(/\/+$/, "");

    // =========================================================================
    // 1. CREDO BANK ONLINE INSTALLMENT (ganvadeba.credo.ge)
    // =========================================================================
    if (bank === "credo") {
      const merchantId = String(body.merchantId || body.clientId || process.env.CREDO_MERCHANT_ID || "125694").trim();
      const password = String(body.password || body.clientSecret || process.env.CREDO_SECRET || "6NL7UJ0jM)3]").trim();
      const orderCode = "iyidebaa_" + Date.now();
      const priceInTetri = String(Math.round(amountGel * 100));

      const prodItem = {
        id: productId,
        title: productName,
        amount: "1",
        price: priceInTetri,
        type: "0",
      };

      const rawHashStr = `${prodItem.id}${prodItem.title}${prodItem.amount}${prodItem.price}${prodItem.type}${password}`;
      const checkHash = crypto.createHash("md5").update(rawHashStr, "utf8").digest("hex");

      const credoPayload = {
        merchantId,
        orderCode,
        check: checkHash,
        products: [prodItem],
      };

      const credoRes = await fetch("https://ganvadeba.credo.ge/widget_api/order.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credoPayload),
      });

      const credoData = await credoRes.json();
      const redirectUrl = credoData && credoData.data && credoData.data.URL;

      if (!credoRes.ok || !redirectUrl) {
        return res.status(400).json({
          ok: false,
          error: "კრედო ბანკის განვადების ბმულის შექმნა ვერ მოხერხდა.",
          details: credoData,
        });
      }

      return res.status(200).json({
        ok: true,
        bank: "credo",
        orderId: credoData.data.OrderHash || orderCode,
        redirectUrl,
      });
    }

    // =========================================================================
    // 2. BANK OF GEORGIA & UNIVERSAL 3D-SECURE CARD CHECKOUT (BOG / TBC / CREDO CARDS)
    // =========================================================================
    const clientId = String(body.clientId || process.env.BOG_CLIENT_ID || "10000576").trim();
    const clientSecret = String(body.clientSecret || process.env.BOG_SECRET_KEY || "0RAMGYvStUiE").trim();

    const basicAuth = Buffer.from(clientId + ":" + clientSecret).toString("base64");
    const tokenRes = await fetch(
      "https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + basicAuth,
        },
        body: "grant_type=client_credentials",
      }
    );

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(401).json({
        ok: false,
        error: "საქართველოს ბანკის ავტორიზაცია ვერ მოხერხდა (შეამოწმეთ Client ID და Secret Key).",
        details: errText,
      });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const orderPayload = {
      callback_url: originUrl + "/api/bog-pay",
      external_order_id: "iyidebaa_" + Date.now(),
      purchase_units: {
        currency: "GEL",
        total_amount: amountGel,
        basket: [
          {
            quantity: 1,
            unit_price: amountGel,
            product_id: productId,
            description: productName,
          },
        ],
      },
      redirect_urls: {
        fail: originUrl + "/?payment=fail",
        success: originUrl + "/?payment=success",
      },
    };

    const orderRes = await fetch("https://api.bog.ge/payments/v1/ecommerce/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "ka",
        Authorization: "Bearer " + accessToken,
      },
      body: JSON.stringify(orderPayload),
    });

    const orderData = await orderRes.json();
    const redirectHref =
      orderData &&
      orderData._links &&
      orderData._links.redirect &&
      orderData._links.redirect.href;

    if (!orderRes.ok || !redirectHref) {
      return res.status(400).json({
        ok: false,
        error: "საბანკო გადახდის გვერდის შექმნა ვერ მოხერხდა.",
        details: orderData,
      });
    }

    return res.status(200).json({
      ok: true,
      bank: "bog",
      orderId: orderData.id,
      redirectUrl: redirectHref,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Server error",
    });
  }
}
