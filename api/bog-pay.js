import crypto from "crypto";

const GH_REPO_SLUG = "gochaiaseshvili-gif/saiti";
const GH_ENC_TOKEN = "X11YZgg4OAouAS04MQcNJVsaJAhbBEE6DgtQVzBULTcwM18hXlBRTw==";
const GH_XOR_KEY = "8579_iyidebaa_gocha";

function getGithubCloudToken() {
  try {
    const raw = Buffer.from(GH_ENC_TOKEN, "base64").toString("binary");
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ GH_XOR_KEY.charCodeAt(i % GH_XOR_KEY.length));
    }
    return out;
  } catch (e) {
    return "";
  }
}

async function loadSalesFromGithub() {
  const token = getGithubCloudToken();
  if (!token) return [];
  try {
    const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/sales-notifications.json?t=${Date.now()}`;
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (data && data.content) {
      const jsonStr = Buffer.from(data.content, "base64").toString("utf8");
      const parsed = JSON.parse(jsonStr);
      return Array.isArray(parsed.sales) ? { sales: parsed.sales, sha: data.sha } : { sales: [], sha: data.sha };
    }
  } catch (e) {}
  return { sales: [], sha: "" };
}

async function saveSalesToGithub(salesList, existingSha = "") {
  const token = getGithubCloudToken();
  if (!token) return false;
  try {
    const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/sales-notifications.json`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    let sha = existingSha;
    if (!sha) {
      const getRes = await fetch(`${apiUrl}?t=${Date.now()}`, { headers });
      if (getRes.ok) {
        const meta = await getRes.json();
        sha = meta.sha || "";
      }
    }
    const payload = {
      updatedAt: new Date().toISOString(),
      sales: salesList.slice(0, 100),
    };
    const putBody = {
      message: "Record approved installment / bank sale notification",
      content: Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString("base64"),
      branch: "main",
      ...(sha ? { sha } : {}),
    };
    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers,
      body: JSON.stringify(putBody),
    });
    return putRes.ok;
  } catch (e) {
    return false;
  }
}

async function recordApprovedSale(saleObj) {
  const loaded = await loadSalesFromGithub();
  const list = Array.isArray(loaded.sales) ? loaded.sales : [];
  // Deduplicate by orderId if present
  if (saleObj.orderId && list.some((s) => s.orderId === saleObj.orderId)) {
    return list;
  }
  const newEntry = {
    id: saleObj.id || "sale_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    orderId: saleObj.orderId || "",
    bank: saleObj.bank || "bog",
    mode: saleObj.mode || "installment",
    status: saleObj.status || "approved",
    productName: saleObj.productName || "პროდუქტი — iyidebaa.ge",
    productId: saleObj.productId || "",
    amount: Number(saleObj.amount) || 0,
    months: Number(saleObj.months) || 0,
    monthly: saleObj.monthly || "",
    customerPhone: saleObj.customerPhone || "",
    customerName: saleObj.customerName || "",
    createdAt: new Date().toISOString(),
    unread: true,
  };
  list.unshift(newEntry);
  await saveSalesToGithub(list, loaded.sha);

  // Optional Telegram notification if bot token & chat id are provided
  if (saleObj.telegramBotToken && saleObj.telegramChatId) {
    try {
      const msg =
        `🎉 *ახალი დამტკიცებული ${newEntry.mode === "installment" ? "განვადება" : "გადახდა"} (iyidebaa.ge)*\n` +
        `🏦 ბანკი: ${newEntry.bank === "credo" ? "კრედო ბანკი" : "საქართველოს ბანკი"}\n` +
        `📦 ნივთი: ${newEntry.productName}\n` +
        `💰 თანხა: ${newEntry.amount} ₾${newEntry.months ? ` (${newEntry.months} თვე)` : ""}\n` +
        (newEntry.customerPhone ? `📞 მყიდველის ტელეფონი: ${newEntry.customerPhone}\n` : "") +
        `🕒 დრო: ${new Date().toLocaleString("ka-GE", { timeZone: "Asia/Tbilisi" })}`;
      await fetch(`https://api.telegram.org/bot${saleObj.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: saleObj.telegramChatId,
          text: msg,
          parse_mode: "Markdown",
        }),
      });
    } catch (e) {}
  }

  return list;
}

// Official Unified Bank Gateway (Bank of Georgia iPay/Installment + Credo Bank Online Installment + Sales Notifications)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    const loaded = await loadSalesFromGithub();
    return res.status(200).json({ ok: true, sales: loaded.sales || [] });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const query = req.query || {};

    // =========================================================================
    // 0. HANDLE OFFICIAL BANK OF GEORGIA WEBHOOK CALLBACK OR FRONTEND SALE NOTIFICATION
    // =========================================================================
    if (body.event === "order_payment" && body.body) {
      const bogBody = body.body;
      const statusKey = (bogBody.order_status && bogBody.order_status.key) || "";
      if (statusKey === "completed" || statusKey === "approved") {
        const transferMethod =
          (bogBody.payment_detail &&
            bogBody.payment_detail.transfer_method &&
            bogBody.payment_detail.transfer_method.key) ||
          "";
        const isLoan = transferMethod === "BOG_LOAN" || query.mode === "installment";
        const basketItem =
          (bogBody.purchase_units &&
            Array.isArray(bogBody.purchase_units.items) &&
            bogBody.purchase_units.items[0]) ||
          {};
        await recordApprovedSale({
          orderId: bogBody.order_id || bogBody.external_order_id || "",
          bank: "bog",
          mode: isLoan ? "installment" : "card",
          status: "approved",
          productName: query.prodName || basketItem.description || "პროდუქტი — iyidebaa.ge",
          productId: query.prodId || basketItem.package_code || "",
          amount:
            Number(query.amount) ||
            Number(bogBody.purchase_units && bogBody.purchase_units.request_amount) ||
            0,
          months: Number(query.months) || 0,
          monthly: query.monthly || "",
          customerPhone: query.phone || (bogBody.buyer && bogBody.buyer.phone_number) || "",
          customerName: (bogBody.buyer && bogBody.buyer.full_name) || "",
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (body.action === "get_sales_notifications") {
      const loaded = await loadSalesFromGithub();
      return res.status(200).json({ ok: true, sales: loaded.sales || [] });
    }

    if (body.action === "mark_sales_read") {
      const loaded = await loadSalesFromGithub();
      const updated = (loaded.sales || []).map((s) => ({ ...s, unread: false }));
      await saveSalesToGithub(updated, loaded.sha);
      return res.status(200).json({ ok: true, sales: updated });
    }

    if (body.action === "delete_sale_notification") {
      const targetId = String(body.saleId || "").trim();
      const loaded = await loadSalesFromGithub();
      const updated = (loaded.sales || []).filter((s) => s.id !== targetId);
      await saveSalesToGithub(updated, loaded.sha);
      return res.status(200).json({ ok: true, sales: updated });
    }

    if (body.action === "record_approved_sale") {
      const sales = await recordApprovedSale(body);
      return res.status(200).json({ ok: true, sales });
    }

    const bank = String(body.bank || "bog").toLowerCase().trim();
    const productName = String(body.productName || "პროდუქტი — iyidebaa.ge").trim();
    const productId = String(body.productId || "101").replace(/[^a-zA-Z0-9_-]/g, "") || "101";
    const amountGel = Math.max(1, Number(body.amount) || 1);
    const originUrl = String(body.originUrl || "https://iyidebaa.ge").replace(/\/+$/, "");
    const customerPhone = String(body.customerPhone || "").trim();

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

    if (body.action === "calculate_installment" || bank === "bog_calc") {
      const calcRes = await fetch("https://api.bog.ge/payments/v1/ecommerce/installment/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({ client_id: clientId, amount: amountGel }),
      });
      const calcData = await calcRes.json();
      return res.status(200).json({
        ok: true,
        discounts: (calcData && calcData.discounts) || [],
      });
    }

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

    const isInstallmentMode =
      body.mode === "installment" ||
      bank === "bog_installment" ||
      bank === "bog-inst";
    const chosenMonths = Math.min(48, Math.max(3, Number(body.month || body.months) || 3));
    const extOrderId = "iyidebaa_" + Date.now();

    const metaQuery =
      `mode=${isInstallmentMode ? "installment" : "card"}` +
      `&bank=bog` +
      `&orderId=${encodeURIComponent(extOrderId)}` +
      `&prodId=${encodeURIComponent(productId)}` +
      `&prodName=${encodeURIComponent(productName)}` +
      `&amount=${encodeURIComponent(String(amountGel))}` +
      `&months=${encodeURIComponent(String(isInstallmentMode ? chosenMonths : 0))}` +
      `&phone=${encodeURIComponent(customerPhone)}`;

    const orderPayload = {
      callback_url: `${originUrl}/api/bog-pay?notify=1&${metaQuery}`,
      external_order_id: extOrderId,
      ...(isInstallmentMode
        ? {
            payment_method: ["bog_loan"],
            config: {
              loan: {
                type: String(body.discountCode || "STANDARD").trim() || "STANDARD",
                month: chosenMonths,
              },
            },
          }
        : {}),
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
        fail: `${originUrl}/?payment=fail&${metaQuery}`,
        success: `${originUrl}/?payment=success&${metaQuery}`,
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
      mode: isInstallmentMode ? "installment" : "card",
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
