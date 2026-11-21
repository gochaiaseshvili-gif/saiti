import fs from "fs";
import path from "path";
import { loadJsonFromGithub } from "./bog-pay.js";

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let cachedLocalStore = null;

function loadLocalStoreData() {
  if (cachedLocalStore) return cachedLocalStore;
  try {
    const localPath = path.join(process.cwd(), "store-data.json");
    if (fs.existsSync(localPath)) {
      const parsed = JSON.parse(fs.readFileSync(localPath, "utf8"));
      if (parsed && Array.isArray(parsed.productsList)) {
        cachedLocalStore = parsed;
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

async function loadStoreDataForProduct(productId) {
  // 1. Fast local read (~10ms) so Facebook/social crawlers never time out
  const local = loadLocalStoreData();
  if (local && local.productsList.some((p) => p && String(p.id) === productId)) {
    return local;
  }

  // 2. Fallback to GitHub only for brand-new products not yet in the deployed bundle
  try {
    const loaded = await loadJsonFromGithub("store-data.json", null);
    if (loaded && loaded.data && Array.isArray(loaded.data.productsList)) {
      return loaded.data;
    }
  } catch (e) {}

  return local || { storeSettings: {}, productsList: [] };
}

function resolveProductImage(prod, origin) {
  const candidates = [];
  if (Array.isArray(prod.images)) {
    for (const img of prod.images) {
      if (img && typeof img === "string" && img.trim()) candidates.push(img.trim());
    }
  }
  if (prod.image && typeof prod.image === "string" && prod.image.trim()) {
    candidates.push(prod.image.trim());
  }

  const ghPrefix = "https://raw.githubusercontent.com/gochaiaseshvili-gif/saiti/main/uploads/";

  for (const raw of candidates) {
    if (raw.startsWith("data:")) continue;
    if (raw.startsWith(ghPrefix)) {
      const fname = raw.slice(ghPrefix.length).split("?")[0];
      if (fname && fs.existsSync(path.join(process.cwd(), "uploads", fname))) {
        return `${origin}/uploads/${encodeURIComponent(fname)}`;
      }
      return raw;
    }
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw;
    }
    if (raw.startsWith("/")) {
      return `${origin}${raw}`;
    }
    return `${origin}/${raw}`;
  }

  return `${origin}/iyidebaa-logo-1000x1000.png`;
}

export default async function handler(req, res) {
  const origin = "https://www.iyidebaa.ge";
  const productId = String((req.query && (req.query.product || req.query.id)) || "").trim();

  if (!productId) {
    res.setHeader("Location", `${origin}/`);
    return res.status(302).end();
  }

  const targetUrl = `${origin}/?product=${encodeURIComponent(productId)}`;
  const store = await loadStoreDataForProduct(productId);
  const list = Array.isArray(store.productsList) ? store.productsList : [];
  const prod = list.find((p) => p && String(p.id) === productId);

  const shareUrl = `${origin}/p/${encodeURIComponent(productId)}`;

  const brandName =
    (store.storeSettings && store.storeSettings.brandName) ||
    "იყიდება საინტერესო ნივთები";
  const phone =
    (store.storeSettings && store.storeSettings.phoneDisplay) ||
    "+995 551 58 85 79";

  let title = `${brandName} | iyidebaa.ge`;
  let description = `12-თვიანი გარანტია, ონლაინ განვადება და სწრაფი მიწოდება მთელ საქართველოში • ტელ: ${phone}`;
  let imageUrl = `${origin}/iyidebaa-logo-1000x1000.png`;

  if (prod) {
    const priceNum = Number(prod.newPrice || prod.price || 0);
    const priceText = priceNum > 0 ? `${priceNum} ₾` : "";
    const prodName = String(prod.name || "პროდუქტი").trim();
    title = priceText ? `${prodName} — ${priceText} | ${brandName}` : `${prodName} | ${brandName}`;

    const descParts = [];
    if (priceText) descParts.push(`ფასი: ${priceText}`);
    if (prod.shortMeta) descParts.push(String(prod.shortMeta).trim());
    if (prod.description) descParts.push(String(prod.description).replace(/\s+/g, " ").trim().slice(0, 160));
    descParts.push(`ონლაინ განვადება (BOG • TBC • კრედო) • ტელ: ${phone}`);
    description = descParts.filter(Boolean).join(" • ").slice(0, 280);

    imageUrl = resolveProductImage(prod, origin);
  }

  const html = `<!doctype html>
<html lang="ka">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(shareUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escapeHtml(brandName)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(shareUrl)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
</head>
<body>
  <script>window.location.replace(${JSON.stringify(targetUrl)});</script>
  <noscript><a href="${escapeHtml(targetUrl)}">${escapeHtml(title)}</a></noscript>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  return res.status(200).send(html);
}
