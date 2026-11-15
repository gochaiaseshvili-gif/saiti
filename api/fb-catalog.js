import fs from "fs";
import path from "path";

const GH_REPO_SLUG = "gochaiaseshvili-gif/saiti";
const GH_ENC_TOKEN = "X11YZgg4OAouAS04MQcNJVsaJAhbBEE6DgtQVzBULTcwM18hXlBRTw==";
const FB_CATALOG_ID = "338932966606489";
const FB_ENC_TOKEN =
  "fXR2dBICCzhVD1tZIwxeITo8KAtac3IdCk4sByMxNRAeAiNaBipXUA4KLREcWhYUM1QGbxcnIl4GbXtvXm4NTD9RPyEpBBMDHBcHO3l4BmsRBy4hPicpEAtvEwo5KylSU25wNV9NDD1UBgQUFAsVNDFXX2FAYxxbNR83VlU7IDI9LS8rAwBseQ0lAAkFEQo7IDMGVgMKBg5WAUZoODoNAgVQEw4DBSQcLxEyWURmSQUoIDMmNhArUw49LDEgN15HcX07AQwvVTw4IAIeBgwtD1FqQHp1DTM4PV1dLCwJayZWMg==";
const GH_XOR_KEY = "8579_iyidebaa_gocha";

// Legacy items that existed in Facebook Catalog prior to connecting iyidebaa.ge
const LEGACY_FB_RETAILER_IDS = new Set([
  "14","15","18","19","20","21","22","23","24","25","26","27","29","30","31","32","33","34","35","36","37","38","39","40",
  "41","42","43","44","45","46","47","48","49","50","51","52","53","54","55","56","57","58","59","60","61","62","63","64",
  "65","66","67","68","69","70","71","72","73","74","75","76","77","78","79","7zf1kkxswa","80","81","83","84","85",
  "9wyv3fxkte","acousticpro-titan-1500w","ctkhemu7wn","ecovolt-1200w-solar","nomadpower-300w","ovil3o8b5a",
  "streetbeat-500w","suncore-mini-600w","voxmaster-800w","wjqjd3ju73","wr2857b2tp","x5g4btk8nc"
]);

function decodeXorToken(encStr) {
  try {
    const raw = Buffer.from(encStr, "base64").toString("binary");
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ GH_XOR_KEY.charCodeAt(i % GH_XOR_KEY.length));
    }
    return out;
  } catch (e) {
    return "";
  }
}

function getGithubCloudToken() {
  if (process.env.GITHUB_TOKEN) return String(process.env.GITHUB_TOKEN).trim();
  return decodeXorToken(GH_ENC_TOKEN);
}

function getFacebookAccessToken() {
  if (process.env.FB_ACCESS_TOKEN) return String(process.env.FB_ACCESS_TOKEN).trim();
  return decodeXorToken(FB_ENC_TOKEN);
}

async function loadLatestStoreDataWithSha() {
  const token = getGithubCloudToken();
  const ts = Date.now();

  if (token) {
    try {
      const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/store-data.json?t=${ts}`;
      const metaRes = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (metaRes.ok) {
        const meta = await metaRes.json();
        const sha = meta.sha || "";
        if (meta.content) {
          const text = Buffer.from(meta.content, "base64").toString("utf8").replace(/^\uFEFF/, "");
          const parsed = JSON.parse(text);
          if (parsed && Array.isArray(parsed.productsList)) {
            return { data: parsed, sha };
          }
        }
        const rawRes = await fetch(apiUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.raw+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
        if (rawRes.ok) {
          const text = (await rawRes.text()).replace(/^\uFEFF/, "");
          const parsed = JSON.parse(text);
          if (parsed && Array.isArray(parsed.productsList)) {
            return { data: parsed, sha };
          }
        }
      }
    } catch (e) {}
  }

  try {
    const rawUrl = `https://raw.githubusercontent.com/${GH_REPO_SLUG}/main/store-data.json?t=${ts}`;
    const res = await fetch(rawUrl, { cache: "no-store" });
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && Array.isArray(parsed.productsList)) {
        return { data: parsed, sha: "" };
      }
    }
  } catch (e) {}

  try {
    const localPath = path.join(process.cwd(), "store-data.json");
    if (fs.existsSync(localPath)) {
      const rawText = fs.readFileSync(localPath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(rawText);
      if (parsed && Array.isArray(parsed.productsList)) {
        return { data: parsed, sha: "" };
      }
    }
  } catch (e) {}

  return { data: { storeSettings: {}, productsList: [] }, sha: "" };
}

async function saveStoreDataToGithub(storeData, existingSha = "", commitMsg = "Auto-sync new/updated items from Facebook Catalog") {
  const token = getGithubCloudToken();
  if (!token) return false;
  try {
    const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/store-data.json`;
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
      content: Buffer.from(JSON.stringify(storeData, null, 2), "utf8").toString("base64"),
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

function parseFbPriceNumber(raw) {
  if (raw === undefined || raw === null) return 0;
  let str = String(raw).trim();
  // Handle "550,00 GEL" or "550.00 GEL"
  str = str.replace(/[^\d.,]/g, "");
  if (str.includes(",") && !str.includes(".")) {
    str = str.replace(",", ".");
  } else if (str.includes(",") && str.includes(".")) {
    str = str.replace(/,/g, "");
  }
  const num = parseFloat(str);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

export async function syncFromFacebookCatalogToStore(storeData, sha = "") {
  const fbToken = getFacebookAccessToken();
  if (!fbToken || !storeData || !Array.isArray(storeData.productsList)) {
    return { changed: false, addedCount: 0, updatedCount: 0 };
  }

  try {
    const fbUrl = `https://graph.facebook.com/v19.0/${FB_CATALOG_ID}/products?fields=id,retailer_id,name,description,price,sale_price,image_url,additional_image_urls,category,availability&limit=300&access_token=${encodeURIComponent(fbToken)}`;
    const res = await fetch(fbUrl, { cache: "no-store" });
    if (!res.ok) return { changed: false, addedCount: 0, updatedCount: 0 };
    const payload = await res.json();
    const fbItems = Array.isArray(payload.data) ? payload.data : [];
    if (fbItems.length === 0) return { changed: false, addedCount: 0, updatedCount: 0 };

    if (!storeData.fbSyncedSnapshot || typeof storeData.fbSyncedSnapshot !== "object") {
      storeData.fbSyncedSnapshot = {};
    }
    const snapshot = storeData.fbSyncedSnapshot;
    const productsList = storeData.productsList;

    let addedCount = 0;
    let updatedCount = 0;
    let snapshotInitialized = false;

    for (const fbItem of fbItems) {
      const retailerId = String(fbItem.retailer_id || fbItem.id || "").trim();
      if (!retailerId) continue;

      // Skip old legacy catalog items that existed before connecting iyidebaa.ge
      if (LEGACY_FB_RETAILER_IDS.has(retailerId)) continue;

      const basePrice = parseFbPriceNumber(fbItem.price);
      const salePrice = parseFbPriceNumber(fbItem.sale_price);
      const fbEffectivePrice = salePrice > 0 ? salePrice : basePrice;
      const fbOldPrice = salePrice > 0 && basePrice > salePrice ? basePrice : 0;
      const fbTitle = String(fbItem.name || "").trim();
      const fbDesc = String(fbItem.description || "").trim();

      const existing = productsList.find((p) => p && String(p.id) === retailerId);

      if (!existing) {
        // Brand new item added directly on Facebook! Import it automatically to iyidebaa.ge
        const extraImgs = Array.isArray(fbItem.additional_image_urls)
          ? fbItem.additional_image_urls
          : [];
        const imgs = [String(fbItem.image_url || "").trim(), ...extraImgs].filter(Boolean);
        while (imgs.length < 5) imgs.push("");

        const newProdId = retailerId.startsWith("prod-") ? retailerId : `prod-fb-${retailerId}`;
        if (productsList.some((p) => p && String(p.id) === newProdId)) continue;

        productsList.unshift({
          id: newProdId,
          sku: retailerId,
          category: "karaoke",
          categoryLabel: String(fbItem.category || "კარაოკე დინამიკები").trim(),
          badgeText: "ახალი",
          name: fbTitle || "ახალი პროდუქტი",
          shortMeta: "",
          oldPrice: fbOldPrice,
          newPrice: fbEffectivePrice,
          images: imgs.slice(0, 5),
          description: fbDesc,
          specs: [
            { label: "სიმძლავრე ვატი", value: "" },
            { label: "ელემენტი / ტევადობა", value: "" },
            { label: "კომპლექტაცია", value: "" },
            { label: "ავტონომიური მუშაობა", value: "" },
            { label: "პორტები და კავშირი", value: "" },
            { label: "წონა და გარანტია", value: "" },
          ],
          closedFields: {},
        });

        snapshot[newProdId] = { price: fbEffectivePrice, title: fbTitle };
        addedCount++;
      } else {
        // Existing item: check if its price was changed inside Facebook Commerce Manager
        const prevSnap = snapshot[retailerId];
        const sitePrice = Number(existing.newPrice) || 0;

        if (!prevSnap) {
          snapshot[retailerId] = { price: sitePrice || fbEffectivePrice, title: String(existing.name || "") };
          snapshotInitialized = true;
        } else if (fbEffectivePrice > 0 && fbEffectivePrice !== prevSnap.price) {
          // Facebook price changed compared to last synced snapshot!
          if (sitePrice === prevSnap.price) {
            // Website price was not changed, so Facebook is the newer edit -> apply to Website
            existing.newPrice = fbEffectivePrice;
            if (fbOldPrice > 0) existing.oldPrice = fbOldPrice;
            snapshot[retailerId].price = fbEffectivePrice;
            updatedCount++;
          } else {
            // Website price was changed more recently -> record website price in snapshot so next feed updates FB
            snapshot[retailerId].price = sitePrice;
            snapshotInitialized = true;
          }
        }
      }
    }

    if (addedCount > 0 || updatedCount > 0 || snapshotInitialized) {
      storeData.updatedAt = Date.now();
      await saveStoreDataToGithub(
        storeData,
        sha,
        addedCount > 0 || updatedCount > 0
          ? `Auto-sync from Facebook Catalog (+${addedCount} new, ${updatedCount} updated)`
          : "Initialize Facebook Catalog price sync snapshot"
      );
    }

    return { changed: addedCount > 0 || updatedCount > 0, addedCount, updatedCount };
  } catch (e) {
    return { changed: false, addedCount: 0, updatedCount: 0 };
  }
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeCsv(val) {
  const s = String(val ?? "").replace(/\r?\n/g, " ").trim();
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCatalogItems(storeData, siteOrigin, includeZero = false) {
  const settings = storeData.storeSettings || storeData.settings || {};
  const brandName = String(settings.brandName || "iyidebaa.ge").trim() || "iyidebaa.ge";
  const phone = String(settings.phoneDigits || "551 588-579").trim();
  const rawProducts = Array.isArray(storeData.productsList) ? storeData.productsList : [];

  const items = [];
  const seenTitles = new Map();

  for (let i = 0; i < rawProducts.length; i++) {
    const p = rawProducts[i];
    if (!p || !p.id || p.isDeleted || p.hidden) continue;

    const cf = p.closedFields || {};
    const validImages = (Array.isArray(p.images) ? p.images : [])
      .map((u) => String(u || "").trim())
      .filter((u) => u && !u.startsWith("data:"))
      .map((u) => (u.startsWith("/") ? `${siteOrigin}${u}` : u))
      .filter((u) => u.startsWith("http://") || u.startsWith("https://"));

    if (validImages.length === 0) continue;

    const newPrice = cf.newPrice ? 0 : Number(p.newPrice) || 0;
    const oldPrice = cf.oldPrice ? 0 : Number(p.oldPrice) || 0;
    let activePrice = newPrice > 0 ? newPrice : oldPrice > 0 ? oldPrice : 0;

    if (activePrice <= 0) {
      if (includeZero) {
        activePrice = 1;
      } else {
        continue;
      }
    }

    const isOnSale = oldPrice > newPrice && newPrice > 0;
    const priceStr = `${(isOnSale ? oldPrice : activePrice).toFixed(2)} GEL`;
    const salePriceStr = isOnSale ? `${newPrice.toFixed(2)} GEL` : "";

    const categoryLabel = String(p.categoryLabel || p.category || "პროდუქცია").trim();
    let baseTitle = String(p.name || "").trim();
    if (!baseTitle || baseTitle === "ახალი პროდუქტი") {
      baseTitle = `${categoryLabel} (${String(p.id).slice(-4)})`;
    }

    const titleCount = (seenTitles.get(baseTitle) || 0) + 1;
    seenTitles.set(baseTitle, titleCount);
    const finalTitle =
      titleCount > 1 ? `${baseTitle} #${titleCount}` : baseTitle;

    const specsText = Array.isArray(p.specs)
      ? p.specs
          .filter((s) => s && s.label && String(s.value || "").trim())
          .map((s) => `${String(s.label).trim()}: ${String(s.value).trim()}`)
          .join(" • ")
      : "";

    let desc = stripHtml(p.description || p.descHtml || p.shortMeta || "");
    if (specsText) {
      desc = desc ? `${desc} | ${specsText}` : specsText;
    }
    if (!desc) {
      desc = `${finalTitle} — ${categoryLabel}. ${brandName} (${phone})`;
    }

    let availability = "in stock";
    if (p.outOfStock === true) {
      availability = "out of stock";
    } else if (Array.isArray(p.specs)) {
      const stockSpec = p.specs.find((s) => s && String(s.label || "").includes("მარაგ"));
      if (stockSpec && /არ\s*არის|ამოწურ/i.test(String(stockSpec.value || ""))) {
        availability = "out of stock";
      }
    }

    const productLink = `${siteOrigin}/?product=${encodeURIComponent(String(p.id))}`;

    items.push({
      id: String(p.id),
      sku: String(p.sku || p.id),
      title: finalTitle.slice(0, 150),
      description: desc.slice(0, 4900),
      availability,
      condition: "new",
      price: priceStr,
      sale_price: salePriceStr,
      link: productLink,
      image_link: validImages[0],
      additional_image_links: validImages.slice(1, 10),
      brand: brandName.slice(0, 100),
      product_type: categoryLabel,
    });
  }

  return { brandName, settings, items };
}

export function renderCatalogXml(brandName, siteOrigin, items) {
  const itemsXml = items
    .map((item) => {
      const extraImgs = item.additional_image_links
        .map((img) => `      <g:additional_image_link>${escapeXml(img)}</g:additional_image_link>`)
        .join("\n");
      const saleXml = item.sale_price
        ? `\n      <g:sale_price>${escapeXml(item.sale_price)}</g:sale_price>`
        : "";
      return `    <item>
      <g:id>${escapeXml(item.id)}</g:id>
      <g:title>${escapeXml(item.title)}</g:title>
      <g:description>${escapeXml(item.description)}</g:description>
      <g:link>${escapeXml(item.link)}</g:link>
      <g:image_link>${escapeXml(item.image_link)}</g:image_link>${extraImgs ? "\n" + extraImgs : ""}
      <g:brand>${escapeXml(item.brand)}</g:brand>
      <g:condition>${escapeXml(item.condition)}</g:condition>
      <g:availability>${escapeXml(item.availability)}</g:availability>
      <g:price>${escapeXml(item.price)}</g:price>${saleXml}
      <g:product_type>${escapeXml(item.product_type)}</g:product_type>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>${escapeXml(brandName)}</title>
    <link>${escapeXml(siteOrigin)}</link>
    <description>${escapeXml(brandName)} - Facebook &amp; Instagram Product Catalog Feed</description>
${itemsXml}
  </channel>
</rss>`;
}

export function renderCatalogCsv(items) {
  const headers = [
    "id",
    "title",
    "description",
    "availability",
    "condition",
    "price",
    "sale_price",
    "link",
    "image_link",
    "additional_image_link",
    "brand",
    "product_type",
  ];
  const rows = [headers.join(",")];
  for (const item of items) {
    rows.push(
      [
        escapeCsv(item.id),
        escapeCsv(item.title),
        escapeCsv(item.description),
        escapeCsv(item.availability),
        escapeCsv(item.condition),
        escapeCsv(item.price),
        escapeCsv(item.sale_price),
        escapeCsv(item.link),
        escapeCsv(item.image_link),
        escapeCsv(item.additional_image_links.join(",")),
        escapeCsv(item.brand),
        escapeCsv(item.product_type),
      ].join(",")
    );
  }
  return "\uFEFF" + rows.join("\r\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const query = req.query || {};
    const format = String(query.format || "xml").toLowerCase();
    const includeZero = query.include_zero === "1" || query.zero === "1";
    const download = query.download === "1";
    const action = String(query.action || "").toLowerCase();

    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "iyidebaa.ge")
      .split(",")[0]
      .trim();
    const proto = host.includes("localhost") || host.startsWith("127.") ? "http" : "https";
    const siteOrigin = `${proto}://${host}`;

    const loaded = await loadLatestStoreDataWithSha();
    const storeData = loaded.data;

    // Automatically check Facebook Catalog for any newly added or updated items on FB
    const syncResult = await syncFromFacebookCatalogToStore(storeData, loaded.sha);

    if (action === "auto_sync" || format === "sync") {
      return res.status(200).json({
        ok: true,
        ...syncResult,
        productsList: storeData.productsList,
      });
    }

    const { brandName, items } = buildCatalogItems(storeData, siteOrigin, includeZero);

    if (format === "json") {
      return res.status(200).json({
        ok: true,
        siteOrigin,
        brandName,
        totalItems: items.length,
        includeZero,
        syncResult,
        items,
      });
    }

    if (format === "csv") {
      const csvContent = renderCatalogCsv(items);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      if (download) {
        res.setHeader("Content-Disposition", 'attachment; filename="fb-catalog.csv"');
      }
      return res.status(200).send(csvContent);
    }

    const xmlContent = renderCatalogXml(brandName, siteOrigin, items);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    if (download) {
      res.setHeader("Content-Disposition", 'attachment; filename="fb-catalog.xml"');
    }
    return res.status(200).send(xmlContent);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String((err && err.message) || err),
    });
  }
}
