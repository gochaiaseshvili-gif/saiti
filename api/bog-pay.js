// Official Bank of Georgia (BOG iPay / eCommerce / ნაწილ-ნაწილ / 0% განვადება) Order Creation Endpoint for Vercel (iyidebaa.ge)
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
    const clientId = String(body.clientId || process.env.BOG_CLIENT_ID || "10000576").trim();
    const clientSecret = String(body.clientSecret || process.env.BOG_SECRET_KEY || "0RAMGYvStUiE").trim();
    const productName = String(body.productName || "პროდუქტი — iyidebaa.ge").trim();
    const productId = String(body.productId || "item_1").trim();
    const amountGel = Math.max(1, Number(body.amount) || 1);
    const originUrl = String(body.originUrl || "https://iyidebaa.ge").replace(/\/+$/, "");

    // 1. Obtain OAuth2 Bearer Token from Bank of Georgia Identity Server
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

    // 2. Build BOG eCommerce Order Payload
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
        error: "საქართველოს ბანკის შეკვეთის შექმნა ვერ მოხერხდა.",
        details: orderData,
      });
    }

    return res.status(200).json({
      ok: true,
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
