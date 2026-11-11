import crypto from "crypto";

const GH_REPO_SLUG = "gochaiaseshvili-gif/saiti";
const GH_ENC_TOKEN = "X11YZgg4OAouAS04MQcNJVsaJAhbBEE6DgtQVzBULTcwM18hXlBRTw==";
const DILO_ENC_TOKEN = "SF5oXggkGgMvBlMmADsfGjQwBQxAfw9sLygRNlFSCiZuMlohDgZZeAMLCQcWXQ==";
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

function getDiloApiKey() {
  if (process.env.DILO_API_KEY) return String(process.env.DILO_API_KEY).trim();
  try {
    const raw = Buffer.from(DILO_ENC_TOKEN, "base64").toString("binary");
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ GH_XOR_KEY.charCodeAt(i % GH_XOR_KEY.length));
    }
    return out;
  } catch (e) {
    return "";
  }
}

let cachedDiloCities = null;
let cachedDiloCitiesAt = 0;
const cachedDiloDistricts = new Map();


async function loadJsonFromGithub(fileName, defaultObj) {
  const token = getGithubCloudToken();
  if (!token) return { data: defaultObj, sha: "" };
  try {
    const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/${fileName}?t=${Date.now()}`;
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return { data: defaultObj, sha: "" };
    const meta = await res.json();
    if (meta && meta.content) {
      const jsonStr = Buffer.from(meta.content, "base64").toString("utf8");
      const parsed = JSON.parse(jsonStr);
      return { data: parsed || defaultObj, sha: meta.sha || "" };
    }
  } catch (e) {}
  return { data: defaultObj, sha: "" };
}

async function saveJsonToGithub(fileName, payloadObj, commitMsg, existingSha = "") {
  const token = getGithubCloudToken();
  if (!token) return false;
  try {
    const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/${fileName}`;
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
    const putBody = {
      message: commitMsg,
      content: Buffer.from(JSON.stringify(payloadObj, null, 2), "utf8").toString("base64"),
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

async function loadSalesFromGithub() {
  const loaded = await loadJsonFromGithub("sales-notifications.json", { sales: [] });
  return {
    sales: Array.isArray(loaded.data && loaded.data.sales) ? loaded.data.sales : [],
    sha: loaded.sha,
  };
}

async function saveSalesToGithub(salesList, existingSha = "") {
  return saveJsonToGithub(
    "sales-notifications.json",
    { updatedAt: new Date().toISOString(), sales: salesList.slice(0, 200) },
    "Update installment & sales statistics notification log",
    existingSha
  );
}

async function recordOrUpdateSaleEvent(saleObj) {
  const loaded = await loadSalesFromGithub();
  const list = Array.isArray(loaded.sales) ? loaded.sales : [];
  const cleanOrderId = String(saleObj.orderId || "").trim();
  const incomingStatus = String(saleObj.status || "approved").toLowerCase().trim();

  const existingIdx = cleanOrderId ? list.findIndex((s) => s.orderId === cleanOrderId) : -1;
  if (existingIdx !== -1) {
    const existing = list[existingIdx];
    if (existing.status === "approved" && incomingStatus === "started") {
      return list;
    }
    existing.status = incomingStatus;
    existing.updatedAt = new Date().toISOString();
    existing.unread = true;
    if (saleObj.customerPhone) existing.customerPhone = saleObj.customerPhone;
    if (saleObj.customerName) existing.customerName = saleObj.customerName;
    if (saleObj.rejectReason) existing.rejectReason = saleObj.rejectReason;
    await saveSalesToGithub(list, loaded.sha);
    return list;
  }

  const newEntry = {
    id: saleObj.id || "sale_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    orderId: cleanOrderId,
    bank: saleObj.bank || "bog",
    mode: saleObj.mode || "installment",
    status: incomingStatus,
    rejectReason: saleObj.rejectReason || "",
    productName: saleObj.productName || "პროდუქტი — iyidebaa.ge",
    productId: saleObj.productId || "",
    amount: Number(saleObj.amount) || 0,
    months: Number(saleObj.months) || 0,
    monthly: saleObj.monthly || "",
    customerPhone: saleObj.customerPhone || "",
    customerName: saleObj.customerName || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    unread: true,
  };
  list.unshift(newEntry);
  await saveSalesToGithub(list, loaded.sha);

  if (incomingStatus === "approved" && (saleObj.productId || newEntry.productId)) {
    try {
      await recordProductSaleGithub(
        saleObj.productId || newEntry.productId,
        saleObj.mode || "installment",
        1,
        saleObj.amount || 0,
        saleObj.productName || ""
      );
    } catch (e) {}
  }

  return list;
}

async function recordVisitorEvent(req, body) {
  const loaded = await loadJsonFromGithub("visitors-stats.json", {
    totalPageViews: 0,
    visitors: [],
  });
  const stats = loaded.data || { totalPageViews: 0, visitors: [] };
  const visitors = Array.isArray(stats.visitors) ? stats.visitors : [];

  const headerCountry = req.headers["x-vercel-ip-country"]
    ? decodeURIComponent(String(req.headers["x-vercel-ip-country"]))
    : "";
  const headerRegion = req.headers["x-vercel-ip-country-region"]
    ? decodeURIComponent(String(req.headers["x-vercel-ip-country-region"]))
    : "";
  const headerCity = req.headers["x-vercel-ip-city"]
    ? decodeURIComponent(String(req.headers["x-vercel-ip-city"]))
    : "";

  const visitorId = String(body.visitorId || "v_" + Date.now()).trim();
  const countryCode = String(body.countryCode || headerCountry || "GE").toUpperCase().trim();
  const countryName = String(body.countryName || (countryCode === "GE" ? "საქართველო" : countryCode)).trim();
  const regionName = String(body.regionName || headerRegion || "").trim();
  const cityName = String(body.cityName || headerCity || "").trim();
  const deviceType = String(body.deviceType || "mobile").trim();
  const currentPage = String(body.currentPage || "მთავარი გვერდი").trim();
  const nowIso = new Date().toISOString();

  stats.totalPageViews = (Number(stats.totalPageViews) || 0) + 1;

  const existingIdx = visitors.findIndex((v) => v.visitorId === visitorId);
  if (existingIdx !== -1) {
    const existing = visitors[existingIdx];
    existing.lastSeenAt = nowIso;
    existing.visitsCount = (Number(existing.visitsCount) || 1) + 1;
    if (countryCode) existing.countryCode = countryCode;
    if (countryName) existing.countryName = countryName;
    if (regionName) existing.regionName = regionName;
    if (cityName) existing.cityName = cityName;
    if (currentPage) existing.currentPage = currentPage;
    // Move to top of recent visitors
    visitors.splice(existingIdx, 1);
    visitors.unshift(existing);
  } else {
    visitors.unshift({
      visitorId,
      countryCode,
      countryName,
      regionName,
      cityName,
      deviceType,
      currentPage,
      visitsCount: 1,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
  }

  stats.visitors = visitors.slice(0, 500);
  stats.updatedAt = nowIso;
  await saveJsonToGithub("visitors-stats.json", stats, "Update visitor geolocation analytics", loaded.sha);
  return stats;
}

async function loadProductStatsFromGithub() {
  return await loadJsonFromGithub("product-analytics.json", {
    products: {},
    updatedAt: new Date().toISOString(),
  });
}

async function recordProductViewGithub(productId, productName) {
  if (!productId) return { products: {} };
  const loaded = await loadProductStatsFromGithub();
  const allStats = loaded.data || { products: {} };
  if (!allStats.products) allStats.products = {};
  const pId = String(productId).trim();
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);
  const yearKey = now.toISOString().slice(0, 4);

  const prod = allStats.products[pId] || {
    productId: pId,
    productName: productName || pId,
    views: { days: {}, months: {}, years: {}, total: 0 },
    sales: { card: 0, installment: 0, total: 0, revenue: 0 },
    lastViewedAt: null,
    lastSoldAt: null,
  };

  if (!prod.views) prod.views = { days: {}, months: {}, years: {}, total: 0 };
  if (!prod.views.days) prod.views.days = {};
  if (!prod.views.months) prod.views.months = {};
  if (!prod.views.years) prod.views.years = {};

  prod.views.days[dayKey] = (Number(prod.views.days[dayKey]) || 0) + 1;
  prod.views.months[monthKey] = (Number(prod.views.months[monthKey]) || 0) + 1;
  prod.views.years[yearKey] = (Number(prod.views.years[yearKey]) || 0) + 1;
  prod.views.total = (Number(prod.views.total) || 0) + 1;
  prod.lastViewedAt = now.toISOString();
  if (productName) prod.productName = productName;

  allStats.products[pId] = prod;
  allStats.updatedAt = now.toISOString();

  await saveJsonToGithub("product-analytics.json", allStats, `Record view for product ${pId}`, loaded.sha);
  return allStats;
}

async function recordProductSaleGithub(productId, mode, count, amount, productName) {
  if (!productId) return { products: {} };
  const loaded = await loadProductStatsFromGithub();
  const allStats = loaded.data || { products: {} };
  if (!allStats.products) allStats.products = {};
  const pId = String(productId).trim();
  const now = new Date();

  const prod = allStats.products[pId] || {
    productId: pId,
    productName: productName || pId,
    views: { days: {}, months: {}, years: {}, total: 0 },
    sales: { card: 0, installment: 0, total: 0, revenue: 0 },
    lastViewedAt: null,
    lastSoldAt: null,
  };

  if (!prod.sales) prod.sales = { card: 0, installment: 0, total: 0, revenue: 0 };
  const addCount = Math.max(1, Number(count) || 1);
  const cleanMode = String(mode).toLowerCase() === "installment" ? "installment" : "card";

  if (cleanMode === "installment") {
    prod.sales.installment = (Number(prod.sales.installment) || 0) + addCount;
  } else {
    prod.sales.card = (Number(prod.sales.card) || 0) + addCount;
  }
  prod.sales.total = (Number(prod.sales.card) || 0) + (Number(prod.sales.installment) || 0);
  if (amount) {
    prod.sales.revenue = (Number(prod.sales.revenue) || 0) + (Number(amount) || 0);
  }
  prod.lastSoldAt = now.toISOString();
  if (productName) prod.productName = productName;

  allStats.products[pId] = prod;
  allStats.updatedAt = now.toISOString();

  await saveJsonToGithub("product-analytics.json", allStats, `Record sale for product ${pId}`, loaded.sha);
  return allStats;
}

async function resetProductStatsGithub(productId) {
  if (!productId) return { products: {} };
  const loaded = await loadProductStatsFromGithub();
  const allStats = loaded.data || { products: {} };
  if (allStats.products && allStats.products[productId]) {
    delete allStats.products[productId];
    allStats.updatedAt = new Date().toISOString();
    await saveJsonToGithub("product-analytics.json", allStats, `Reset stats for product ${productId}`, loaded.sha);
  }
  return allStats;
}

// Official Unified Bank Gateway + Installment & Visitor Geolocation Statistics
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
    // VISITOR GEOLOCATION ANALYTICS ENDPOINTS
    // =========================================================================
    if (body.action === "record_visitor") {
      const stats = await recordVisitorEvent(req, body);
      return res.status(200).json({ ok: true, stats });
    }

    if (body.action === "get_visitor_stats") {
      const loaded = await loadJsonFromGithub("visitors-stats.json", {
        totalPageViews: 0,
        visitors: [],
      });
      return res.status(200).json({ ok: true, stats: loaded.data });
    }

    if (body.action === "clear_visitor_stats") {
      const loaded = await loadJsonFromGithub("visitors-stats.json", {
        totalPageViews: 0,
        visitors: [],
      });
      const emptyStats = { totalPageViews: 0, visitors: [], updatedAt: new Date().toISOString() };
      await saveJsonToGithub("visitors-stats.json", emptyStats, "Clear visitor stats", loaded.sha);
      return res.status(200).json({ ok: true, stats: emptyStats });
    }

    // =========================================================================
    // PRODUCT SPECIFIC ANALYTICS ENDPOINTS (Views: Day, Month, Year & Sales: Card, Installment)
    // =========================================================================
    if (body.action === "record_product_view") {
      const stats = await recordProductViewGithub(body.productId, body.productName);
      return res.status(200).json({ ok: true, stats });
    }

    if (body.action === "get_product_analytics") {
      const loaded = await loadProductStatsFromGithub();
      return res.status(200).json({ ok: true, stats: loaded.data });
    }

    if (body.action === "record_product_sale_manual") {
      const stats = await recordProductSaleGithub(
        body.productId,
        body.mode || "card",
        body.count || 1,
        body.amount || 0,
        body.productName || ""
      );
      return res.status(200).json({ ok: true, stats });
    }

    if (body.action === "reset_product_stats") {
      const stats = await resetProductStatsGithub(body.productId);
      return res.status(200).json({ ok: true, stats });
    }

    // =========================================================================
    // 0. HANDLE OFFICIAL BANK OF GEORGIA WEBHOOK CALLBACK (APPROVED OR REJECTED)
    // =========================================================================
    if (body.event === "order_payment" && body.body) {
      const bogBody = body.body;
      const statusKey = String((bogBody.order_status && bogBody.order_status.key) || "")
        .toLowerCase()
        .trim();
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

      let mappedStatus = "";
      if (statusKey === "completed" || statusKey === "approved" || statusKey === "success") {
        mappedStatus = "approved";
      } else if (
        statusKey === "rejected" ||
        statusKey === "failed" ||
        statusKey === "declined" ||
        statusKey === "cancelled" ||
        statusKey === "error" ||
        statusKey === "blocked"
      ) {
        mappedStatus = "rejected";
      }

      if (mappedStatus) {
        await recordOrUpdateSaleEvent({
          orderId: bogBody.external_order_id || bogBody.order_id || query.orderId || "",
          bank: "bog",
          mode: isLoan ? "installment" : "card",
          status: mappedStatus,
          rejectReason:
            (bogBody.reject_reason && String(bogBody.reject_reason)) ||
            (bogBody.order_status && bogBody.order_status.value) ||
            "",
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

    if (body.action === "update_sale_tracking") {
      const targetId = String(body.saleId || "").trim();
      const code = String(body.diloTrackingCode || body.trackingCode || "").trim();
      const loaded = await loadSalesFromGithub();
      const updated = (loaded.sales || []).map((s) => {
        if (s.id === targetId || s.orderId === targetId) {
          return { ...s, diloTrackingCode: code, updatedAt: new Date().toISOString() };
        }
        return s;
      });
      await saveSalesToGithub(updated, loaded.sha);
      return res.status(200).json({ ok: true, sales: updated });
    }

    // =========================================================================
    // DILO DELIVERY PARTNER API (https://dilo.ge)
    // =========================================================================
    if (body.action === "dilo_cities") {
      try {
        if (cachedDiloCities && Date.now() - cachedDiloCitiesAt < 3600000) {
          return res.status(200).json({ ok: true, cities: cachedDiloCities });
        }
        const r = await fetch("https://dilo.ge/api/cities", {
          headers: { Accept: "application/json" },
        });
        if (!r.ok) {
          return res.status(r.status).json({ ok: false, error: "ვერ ჩაიტვირთა ქალაქების სია Dilo.ge-დან" });
        }
        const cities = await r.json();
        cachedDiloCities = Array.isArray(cities) ? cities : [];
        cachedDiloCitiesAt = Date.now();
        return res.status(200).json({ ok: true, cities: cachedDiloCities });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }

    if (body.action === "dilo_districts") {
      try {
        const cityId = String(body.cityId || "").trim();
        if (!cityId) return res.status(400).json({ ok: false, error: "cityId აუცილებელია" });
        if (cachedDiloDistricts.has(cityId)) {
          return res.status(200).json({ ok: true, districts: cachedDiloDistricts.get(cityId) });
        }
        const r = await fetch(`https://dilo.ge/api/cities/${encodeURIComponent(cityId)}/districts`, {
          headers: { Accept: "application/json" },
        });
        if (!r.ok) {
          return res.status(r.status).json({ ok: false, error: "ვერ ჩაიტვირთა უბნების/სოფლების სია" });
        }
        const districts = await r.json();
        const arr = Array.isArray(districts) ? districts : [];
        cachedDiloDistricts.set(cityId, arr);
        return res.status(200).json({ ok: true, districts: arr });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }

    if (body.action === "dilo_track_order") {
      try {
        const apiKey = getDiloApiKey();
        const rawQuery = String(body.query || body.trackingNumber || "").trim();
        if (!rawQuery) {
          return res.status(400).json({ ok: false, error: "შეიყვანეთ თრექინგ კოდი ან ტელეფონის ნომერი" });
        }
        const cleanRef = rawQuery.replace(/\s+/g, "");
        // 1. Try direct reference/trackingNumber lookup
        const directRes = await fetch(`https://dilo.ge/api/partner/orders/${encodeURIComponent(cleanRef)}`, {
          headers: { Accept: "application/json", "X-Api-Key": apiKey },
        });
        if (directRes.ok) {
          const orderObj = await directRes.json();
          return res.status(200).json({ ok: true, order: orderObj, items: [orderObj] });
        }
        // 2. Fallback to search (matches trackingNumber, externalReference, recipientName, or phone)
        const searchRes = await fetch(
          `https://dilo.ge/api/partner/orders?search=${encodeURIComponent(rawQuery)}&page=1&pageSize=20`,
          {
            headers: { Accept: "application/json", "X-Api-Key": apiKey },
          }
        );
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const items = Array.isArray(searchData.items) ? searchData.items : [];
          if (items.length > 0) {
            // Also fetch full details of the first matched item to get trackingEvents
            let detailedFirst = items[0];
            try {
              const detRes = await fetch(
                `https://dilo.ge/api/partner/orders/${encodeURIComponent(items[0].trackingNumber)}`,
                { headers: { Accept: "application/json", "X-Api-Key": apiKey } }
              );
              if (detRes.ok) detailedFirst = await detRes.json();
            } catch (e) {}
            return res.status(200).json({ ok: true, order: detailedFirst, items });
          }
        }
        return res.status(404).json({
          ok: false,
          error: "ამ კოდით ან ნომრით ამანათი Dilo.ge-ს ბაზაში ვერ მოიძებნა",
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }

    if (body.action === "dilo_list_orders") {
      try {
        const apiKey = getDiloApiKey();
        const status = String(body.status || "").trim();
        const search = String(body.search || "").trim();
        const page = Math.max(1, Number(body.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(body.pageSize) || 50));
        const qs = new URLSearchParams({
          page: String(page),
          pageSize: String(pageSize),
        });
        if (status) qs.set("status", status);
        if (search) qs.set("search", search);

        const r = await fetch(`https://dilo.ge/api/partner/orders?${qs.toString()}`, {
          headers: { Accept: "application/json", "X-Api-Key": apiKey },
        });
        if (!r.ok) {
          const errTxt = await r.text();
          return res.status(r.status).json({ ok: false, error: errTxt || "Dilo API შეცდომა" });
        }
        const data = await r.json();
        return res.status(200).json({
          ok: true,
          total: data.total || 0,
          page: data.page || 1,
          pageSize: data.pageSize || pageSize,
          items: Array.isArray(data.items) ? data.items : [],
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }

    if (body.action === "dilo_create_order") {
      try {
        const apiKey = getDiloApiKey();
        const recipientName = String(body.recipientName || "").trim();
        const recipientPhone = String(body.recipientPhone || "").replace(/\s+/g, "").trim();
        const recipientCity = String(body.recipientCity || "თბილისი").trim();
        const recipientDistrict = String(body.recipientDistrict || "").trim();
        const recipientAddress = String(body.recipientAddress || "").trim();
        const description = String(body.description || "").trim();
        const isFragile = Boolean(body.isFragile);
        const productPaymentStatus = body.productPaymentStatus === "Paid" ? "Paid" : "NotPaid";
        const whoPaysForCompanyService = body.whoPaysForCompanyService === "Sender" ? "Sender" : "Recipient";
        const amountToCollectForPackage =
          productPaymentStatus === "NotPaid" ? Math.max(0, Number(body.amountToCollectForPackage) || 0) : 0;
        const externalReference = String(body.externalReference || `IYIDEBAA-${Date.now()}`).trim();
        const note = String(body.note || "").trim();

        if (!recipientName || !recipientPhone || !recipientCity || !recipientAddress) {
          return res.status(422).json({
            ok: false,
            error: "გთხოვთ შეავსოთ: მიმღების სახელი, ტელეფონი, ქალაქი და მისამართი",
          });
        }

        const payload = {
          note: note || undefined,
          orders: [
            {
              recipientName,
              recipientPhone,
              recipientCity,
              recipientDistrict,
              recipientAddress,
              description: description || undefined,
              isFragile,
              productPaymentStatus,
              whoPaysForCompanyService,
              amountToCollectForPackage,
              externalReference,
            },
          ],
        };

        const r = await fetch("https://dilo.ge/api/partner/orders", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Api-Key": apiKey,
          },
          body: JSON.stringify(payload),
        });

        const resData = await r.json().catch(() => ({}));
        if (!r.ok) {
          let errMsg = resData.title || resData.message || resData.error || "შეკვეთის გაგზავნა ვერ მოხერხდა";
          if (resData.errors && typeof resData.errors === "object") {
            const details = Object.values(resData.errors).flat().join("; ");
            if (details) errMsg += `: ${details}`;
          }
          return res.status(r.status).json({ ok: false, error: errMsg, details: resData });
        }

        const createdOrder = Array.isArray(resData.orders) && resData.orders[0] ? resData.orders[0] : null;
        const trackingNumber = createdOrder ? createdOrder.trackingNumber : "";

        let updatedSales = null;
        if (body.saleId && trackingNumber) {
          const targetId = String(body.saleId).trim();
          const loaded = await loadSalesFromGithub();
          updatedSales = (loaded.sales || []).map((s) => {
            if (s.id === targetId || s.orderId === targetId) {
              return {
                ...s,
                diloTrackingCode: trackingNumber,
                recipientName,
                recipientCity,
                recipientDistrict,
                recipientAddress,
                updatedAt: new Date().toISOString(),
              };
            }
            return s;
          });
          await saveSalesToGithub(updatedSales, loaded.sha);
        }

        return res.status(201).json({
          ok: true,
          groupOrderId: resData.groupOrderId || "",
          trackingNumber,
          order: createdOrder,
          sales: updatedSales,
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: String(err.message || err) });
      }
    }

    if (body.action === "clear_all_sales_notifications") {
      const loaded = await loadSalesFromGithub();
      await saveSalesToGithub([], loaded.sha);
      return res.status(200).json({ ok: true, sales: [] });
    }

    if (body.action === "record_approved_sale" || body.action === "record_sale_event") {
      const sales = await recordOrUpdateSaleEvent(body);
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

      await recordOrUpdateSaleEvent({
        orderId: credoData.data.OrderHash || orderCode,
        bank: "credo",
        mode: "installment",
        status: "started",
        productName,
        productId,
        amount: amountGel,
        months: 12,
        customerPhone,
      });

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

    if (isInstallmentMode) {
      await recordOrUpdateSaleEvent({
        orderId: extOrderId,
        bank: "bog",
        mode: "installment",
        status: "started",
        productName,
        productId,
        amount: amountGel,
        months: chosenMonths,
        customerPhone,
      });
    }

    return res.status(200).json({
      ok: true,
      bank: "bog",
      mode: isInstallmentMode ? "installment" : "card",
      orderId: extOrderId,
      bogOrderId: orderData.id,
      redirectUrl: redirectHref,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : "Server error",
    });
  }
}
