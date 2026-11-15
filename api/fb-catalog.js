import fs from "fs";
import path from "path";

const GH_REPO_SLUG = "gochaiaseshvili-gif/saiti";
const GH_ENC_TOKEN = "X11YZgg4OAouAS04MQcNJVsaJAhbBEE6DgtQVzBULTcwM18hXlBRTw==";
const GH_XOR_KEY = "8579_iyidebaa_gocha";

function getGithubCloudToken() {
  if (process.env.GITHUB_TOKEN) return String(process.env.GITHUB_TOKEN).trim();
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

async function loadLatestStoreData() {
  const token = getGithubCloudToken();
  const ts = Date.now();

  // 1. Live GitHub API (always up-to-date right after Control Panel edits)
  if (token) {
    try {
      const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/store-data.json?t=${ts}`;
      const res = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.raw+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.ok) {
        const text = await res.text();
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.productsList)) {
          return parsed;
        }
      }
    } catch (e) {}
  }

  // 2. Fallback: GitHub Raw
  try {
    const rawUrl = `https://raw.githubusercontent.com/${GH_REPO_SLUG}/main/store-data.json?t=${ts}`;
    const res = await fetch(rawUrl, { cache: "no-store" });
    if (res.ok) {
      const parsed = await res.json();
      if (parsed && Array.isArray(parsed.productsList)) {
        return parsed;
      }
    }
  } catch (e) {}

  // 3. Fallback: Local store-data.json bundled on disk
  try {
    const localPath = path.join(process.cwd(), "store-data.json");
    if (fs.existsSync(localPath)) {
      const rawText = fs.readFileSync(localPath, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(rawText);
      if (parsed && Array.isArray(parsed.productsList)) {
        return parsed;
      }
    }
  } catch (e) {}

  return { storeSettings: {}, productsList: [] };
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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const query = req.query || {};
    const format = String(query.format || "xml").toLowerCase();
    const includeZero = query.include_zero === "1" || query.zero === "1";
    const download = query.download === "1";

    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "iyidebaa.ge")
      .split(",")[0]
      .trim();
    const proto = host.includes("localhost") || host.startsWith("127.") ? "http" : "https";
    const siteOrigin = `${proto}://${host}`;

    const storeData = await loadLatestStoreData();
    const { brandName, items } = buildCatalogItems(storeData, siteOrigin, includeZero);

    if (format === "json") {
      return res.status(200).json({
        ok: true,
        siteOrigin,
        brandName,
        totalItems: items.length,
        includeZero,
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
