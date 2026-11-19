import fs from "fs";
import path from "path";
import { loadJsonFromGithub, recordOrUpdateSaleEvent } from "./bog-pay.js";

/**
 * Load TBC Online Installments configuration from Admin Panel store-data.json
 * (GitHub cloud or local file) with Vercel Environment Variables fallback.
 */
// Remove ALL whitespace (spaces, tabs, newlines, NBSP, zero-width chars, BOM) and wrapping quotes
const cleanCred = (v) =>
  String(v === undefined || v === null ? "" : v)
    .replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]+/g, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();

async function resolveTbcConfig() {
  const pick = (cfg) => ({
    apiKey: cleanCred(cfg && (cfg.tbcApiKey || cfg.tbcClientId)),
    apiSecret: cleanCred(cfg && (cfg.tbcApiSecret || cfg.tbcSecret)),
    merchantKey: cleanCred(cfg && cfg.tbcMerchantKey),
    campaignId: cleanCred(cfg && cfg.tbcCampaignId),
    testMode: cfg && typeof cfg.tbcTestMode === "boolean" ? cfg.tbcTestMode : undefined,
  });

  const sources = [];

  // 1. Admin Panel data saved in GitHub cloud (store-data.json; > 1MB handled via raw fetch)
  try {
    const loaded = await loadJsonFromGithub("store-data.json", {});
    const ghCfg = loaded && loaded.data && loaded.data.storeSettings && loaded.data.storeSettings.bankConfig;
    if (ghCfg && typeof ghCfg === "object") sources.push(pick(ghCfg));
  } catch (e) {}

  // 2. Local store-data.json bundled with the deployment / local dev server
  try {
    const localPath = path.join(process.cwd(), "store-data.json");
    if (fs.existsSync(localPath)) {
      const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
      const localCfg = parsed && parsed.storeSettings && parsed.storeSettings.bankConfig;
      if (localCfg && typeof localCfg === "object") sources.push(pick(localCfg));
    }
  } catch (e) {}

  // 3. Vercel Environment Variables (fallback for every missing field)
  sources.push({
    apiKey: cleanCred(process.env.TBC_API_KEY),
    apiSecret: cleanCred(process.env.TBC_API_SECRET),
    merchantKey: cleanCred(process.env.TBC_MERCHANT_KEY),
    campaignId: cleanCred(process.env.TBC_CAMPAIGN_ID),
    testMode:
      process.env.TBC_TEST_MODE !== undefined
        ? String(process.env.TBC_TEST_MODE).toLowerCase() === "true"
        : undefined,
  });

  const firstNonEmpty = (field) => {
    for (const s of sources) if (s[field]) return s[field];
    return "";
  };
  const firstDefined = (field) => {
    for (const s of sources) if (typeof s[field] === "boolean") return s[field];
    return false;
  };

  const apiKey = firstNonEmpty("apiKey");
  const apiSecret = firstNonEmpty("apiSecret");
  const merchantKey = firstNonEmpty("merchantKey");
  const campaignId = firstNonEmpty("campaignId");
  const testMode = firstDefined("testMode");
  const baseUrl = testMode ? "https://test-api.tbcbank.ge" : "https://api.tbcbank.ge";

  return { apiKey, apiSecret, merchantKey, campaignId, testMode, baseUrl };
}

/**
 * Normalize incoming product(s) into TBC Online Installments format where
 * each product's `price` equals `unitPrice * quantity` (2-decimal float)
 * and `priceTotal` equals the exact sum of all `products[].price`.
 */
function buildTbcProductsAndTotal(body) {
  const rawItems = Array.isArray(body.products) && body.products.length > 0
    ? body.products
    : [
        {
          name: body.productName || "პროდუქტი — iyidebaa.ge",
          unitPrice: body.unitPrice ?? body.amount ?? body.price ?? 0,
          quantity: body.quantity ?? 1,
        },
      ];

  const products = rawItems
    .map((item) => {
      const name = String(item.name || "პროდუქტი — iyidebaa.ge").trim().slice(0, 200);
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      const unitPrice = Math.max(0.01, Number(item.unitPrice ?? item.price ?? 0) || 0);
      const summedLinePrice = Number((unitPrice * quantity).toFixed(2));
      return {
        name,
        price: summedLinePrice,
        quantity,
      };
    })
    .filter((p) => p.price > 0);

  const priceTotal = Number(
    products.reduce((acc, p) => acc + p.price, 0).toFixed(2)
  );

  return { products, priceTotal };
}

function extractSessionIdFromLocation(locationUrl) {
  if (!locationUrl) return "";
  try {
    const u = new URL(locationUrl);
    const paramId = u.searchParams.get("sessionId") || u.searchParams.get("session_id");
    if (paramId) return paramId;
    const segments = u.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : "";
  } catch (e) {
    return "";
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    let body = req.body || {};
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }

    const cfg = await resolveTbcConfig();

    if (!cfg.apiKey || !cfg.apiSecret || !cfg.merchantKey || !cfg.campaignId) {
      return res.status(400).json({
        ok: false,
        error:
          "თიბისი ბანკის განვადების API პარამეტრები (API Key, API Secret, Merchant Key, Campaign ID) არ არის შევსებული.",
      });
    }

    const { products, priceTotal } = buildTbcProductsAndTotal(body);
    if (products.length === 0 || priceTotal <= 0) {
      return res.status(400).json({
        ok: false,
        error: "პროდუქტის თანხა ან სია არასწორია.",
      });
    }

    const invoiceId =
      String(body.invoiceId || "").trim() ||
      `iyidebaa_tbc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const productId = String(body.productId || "101").replace(/[^a-zA-Z0-9_,-]/g, "") || "101";
    const customerPhone = String(body.customerPhone || "").trim();
    const customerName = String(body.customerName || "").trim();

    // Step 1: Obtain OAuth Access Token
    const basicAuth = Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`, "utf8").toString("base64");
    const tokenParams = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "online_installments",
    });

    const tokenUrl = `${cfg.baseUrl}/oauth/token`;
    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
      body: tokenParams.toString(),
    });

    const tokenText = await tokenRes.text().catch(() => "");
    let tokenData = {};
    try {
      tokenData = tokenText ? JSON.parse(tokenText) : {};
    } catch (e) {
      tokenData = { raw: tokenText };
    }
    if (!tokenRes.ok || !tokenData.access_token) {
      const bankReply = (tokenText || "").replace(/\s+/g, " ").trim().slice(0, 500) || "(ცარიელი პასუხი)";
      return res.status(502).json({
        ok: false,
        error:
          `თიბისი ბანკთან ავტორიზაცია (OAuth Token) ვერ მოხერხდა. ` +
          `სტატუსი: ${tokenRes.status} ${tokenRes.statusText || ""} | ` +
          `რეჟიმი: ${cfg.testMode ? "TEST" : "PRODUCTION"} (${tokenUrl}) | ` +
          `ბანკის პასუხი: ${bankReply}`,
        status: tokenRes.status,
        statusText: tokenRes.statusText || "",
        url: tokenUrl,
        testMode: cfg.testMode,
        details: tokenData,
      });
    }

    // Step 2: Initiate Online Installment Application
    const applicationPayload = {
      merchantKey: cfg.merchantKey,
      priceTotal,
      campaignId: cfg.campaignId,
      invoiceId,
      products,
    };

    const appRes = await fetch(`${cfg.baseUrl}/v1/online-installments/applications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify(applicationPayload),
    });

    const locationUrl = appRes.headers.get("location") || "";
    const appText = await appRes.text().catch(() => "");
    let appData = {};
    if (appText) {
      try {
        appData = JSON.parse(appText);
      } catch (e) {
        appData = { raw: appText };
      }
    }

    if ((appRes.status !== 201 && !appRes.ok) || !locationUrl) {
      const appReply = (appText || "").replace(/\s+/g, " ").trim().slice(0, 500) || "(ცარიელი პასუხი)";
      return res.status(400).json({
        ok: false,
        error:
          `თიბისი ბანკის განვადების განაცხადის შექმნა ვერ მოხერხდა. ` +
          `სტატუსი: ${appRes.status} ${appRes.statusText || ""} | ბანკის პასუხი: ${appReply}`,
        status: appRes.status,
        details: appData,
      });
    }

    // Step 3: Save sessionId with the order and return redirect URL
    const sessionId =
      String(appData.sessionId || "").trim() ||
      extractSessionIdFromLocation(locationUrl) ||
      invoiceId;

    const summaryProductName = products
      .map((p) => (p.quantity > 1 ? `${p.name} (×${p.quantity})` : p.name))
      .join(", ");

    try {
      await recordOrUpdateSaleEvent({
        orderId: invoiceId,
        sessionId,
        bank: "tbc",
        mode: "installment",
        status: "started",
        productName: summaryProductName,
        productId,
        amount: priceTotal,
        customerPhone,
        customerName,
      });
    } catch (e) {}

    return res.status(200).json({
      ok: true,
      bank: "tbc",
      mode: "installment",
      testMode: cfg.testMode,
      invoiceId,
      sessionId,
      redirectUrl: locationUrl,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Server error",
    });
  }
}
