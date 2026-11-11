import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_FILE = path.join(UPLOADS_DIR, 'store-state.json');
const IMAGES_MAP_FILE = path.join(UPLOADS_DIR, 'images-map.json');
const CHAT_FILE = path.join(UPLOADS_DIR, 'chat-state.json');
const USERS_FILE = path.join(UPLOADS_DIR, 'users-state.json');
const AI_BOT_FILE = path.join(UPLOADS_DIR, 'ai-bot-config.json');
const INDEX_HTML_FILE = path.join(__dirname, 'index.html');

const GH_REPO_SLUG = 'gochaiaseshvili-gif/saiti';
const GH_ENC_TOKEN = 'X11YZgg4OAouAS04MQcNJVsaJAhbBEE6DgtQVzBULTcwM18hXlBRTw==';
const DILO_ENC_TOKEN = 'SF5oXggkGgMvBlMmADsfGjQwBQxAfw9sLygRNlFSCiZuMlohDgZZeAMLCQcWXQ==';
const GH_XOR_KEY = '8579_iyidebaa_gocha';

function getGithubCloudToken(): string {
  try {
    const raw = Buffer.from(GH_ENC_TOKEN, 'base64').toString('binary');
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ GH_XOR_KEY.charCodeAt(i % GH_XOR_KEY.length));
    }
    return out;
  } catch (e) {
    return '';
  }
}

function getDiloApiKey(): string {
  if (process.env.DILO_API_KEY) return String(process.env.DILO_API_KEY).trim();
  try {
    const raw = Buffer.from(DILO_ENC_TOKEN, 'base64').toString('binary');
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ GH_XOR_KEY.charCodeAt(i % GH_XOR_KEY.length));
    }
    return out;
  } catch (e) {
    return '';
  }
}

let cachedDiloCities: any[] | null = null;
let cachedDiloCitiesAt = 0;
const cachedDiloDistricts = new Map<string, any[]>();


function computeGitBlobSha(buf: Buffer): string {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf-8');
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

let isSyncingIndexHtml = false;
let lastPushedIndexBlobSha = '';

async function syncIndexHtmlToGithub(reason = 'Auto-sync index.html from AI Studio'): Promise<{ ok: boolean; pushed: boolean; sha?: string }> {
  if (isSyncingIndexHtml) {
    return { ok: true, pushed: false };
  }
  const token = getGithubCloudToken();
  if (!token || !fs.existsSync(INDEX_HTML_FILE)) {
    return { ok: false, pushed: false };
  }
  isSyncingIndexHtml = true;
  try {
    const contentBuf = fs.readFileSync(INDEX_HTML_FILE);
    const localBlobSha = computeGitBlobSha(contentBuf);
    if (localBlobSha === lastPushedIndexBlobSha) {
      return { ok: true, pushed: false, sha: localBlobSha };
    }

    const apiUrl = `https://api.github.com/repos/${GH_REPO_SLUG}/contents/index.html`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    let remoteSha = '';
    try {
      const getRes = await fetch(`${apiUrl}?t=${Date.now()}`, { method: 'GET', headers });
      if (getRes.ok) {
        const meta: any = await getRes.json();
        if (meta && meta.sha) {
          remoteSha = meta.sha;
        }
      }
    } catch (e) {}

    if (remoteSha && remoteSha === localBlobSha) {
      lastPushedIndexBlobSha = localBlobSha;
      return { ok: true, pushed: false, sha: remoteSha };
    }

    const putBody: Record<string, any> = {
      message: reason,
      content: contentBuf.toString('base64'),
      branch: 'main',
    };
    if (remoteSha) {
      putBody.sha = remoteSha;
    }

    const putRes = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });

    if (putRes.ok) {
      const resJson: any = await putRes.json();
      lastPushedIndexBlobSha = localBlobSha;
      console.log(`[iyidebaa.ge Sync] Pushed index.html to ${GH_REPO_SLUG} (${resJson?.commit?.sha?.slice(0, 7) || 'ok'})`);
      return { ok: true, pushed: true, sha: resJson?.commit?.sha || localBlobSha };
    } else {
      console.warn(`[iyidebaa.ge Sync] PUT index.html status: ${putRes.status}`);
    }
  } catch (err) {
    console.warn('[iyidebaa.ge Sync] Error syncing index.html:', err);
  } finally {
    isSyncingIndexHtml = false;
  }
  return { ok: false, pushed: false };
}

async function pullGithubStoreDataToLocal() {
  const token = getGithubCloudToken();
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${GH_REPO_SLUG}/contents/store-data.json?t=${Date.now()}`, {
      headers,
    });
    if (res.ok) {
      const data: any = await res.json();
      if (data && (data.hasSavedState || Array.isArray(data.productsList))) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
        if (data.imagesMap && typeof data.imagesMap === 'object') {
          saveImagesMap(data.imagesMap);
        }
      }
    }
  } catch (err) {
    console.warn('[iyidebaa.ge Sync] Initial store-data.json fetch warning:', err);
  }
}

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

type ImagesMap = Record<string, string[]>;

function loadImagesMap(): ImagesMap {
  try {
    if (fs.existsSync(IMAGES_MAP_FILE)) {
      const raw = fs.readFileSync(IMAGES_MAP_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error reading images-map.json:', err);
  }
  return {};
}

function saveImagesMap(map: ImagesMap) {
  try {
    fs.writeFileSync(IMAGES_MAP_FILE, JSON.stringify(map, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing images-map.json:', err);
  }
}

// Recover any existing uploaded slot files in /public/uploads if images-map.json does not have them yet
function recoverOrphanUploadedPhotos() {
  try {
    const map = loadImagesMap();
    const files = fs.readdirSync(UPLOADS_DIR).filter((f) => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
    if (files.length === 0) return;

    let changed = false;

    // 1. Check files named prod_<productId>_slot_<idx>_... or <productId>_slot_<idx>_...
    for (const file of files) {
      const match = file.match(/^(?:prod_)?([a-zA-Z0-9_-]+)_slot_([0-4])_\d+/);
      if (match) {
        const rawProdId = match[1];
        const slotIdx = Number(match[2]);
        const prodId = rawProdId === 'item' ? 'stagemax-1200w' : rawProdId;
        if (!Array.isArray(map[prodId])) {
          map[prodId] = ['', '', '', '', ''];
        }
        if (!map[prodId][slotIdx]) {
          map[prodId][slotIdx] = `/uploads/${file}`;
          changed = true;
        }
      }
    }

    if (changed) {
      saveImagesMap(map);
    }
  } catch (err) {
    console.error('Error recovering uploaded photos:', err);
  }
}

recoverOrphanUploadedPhotos();

function applyImagesMapToProducts(productsList: any[], map: ImagesMap): any[] {
  if (!Array.isArray(productsList)) return [];
  return productsList.map((p) => {
    if (!p || !p.id) return p;
    const prod = { ...p };
    const savedSlots = map[prod.id];
    const currentImages = Array.isArray(prod.images) ? [...prod.images] : ['', '', '', '', ''];
    while (currentImages.length < 5) currentImages.push('');
    if (Array.isArray(savedSlots)) {
      for (let i = 0; i < 5; i++) {
        if ((!currentImages[i] || !String(currentImages[i]).trim()) && savedSlots[i]) {
          currentImages[i] = savedSlots[i];
        }
      }
    }
    prod.images = currentImages.slice(0, 5);
    return prod;
  });
}

function saveBase64Image(dataUrl: string, prefix = 'img'): string {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return dataUrl;
  }
  const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9\+\-]+);base64,(.+)$/);
  if (!matches) return dataUrl;
  let ext = matches[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  else if (ext === 'svg+xml') ext = 'svg';
  else if (!['jpg', 'png', 'webp', 'gif'].includes(ext)) ext = 'jpg';

  const buffer = Buffer.from(matches[2], 'base64');
  const safePrefix = (prefix || 'upload').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const filename = `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `/uploads/${filename}`;
}

function saveBase64Media(dataUrl: string, prefix = 'media'): { url: string; mediaType: 'image' | 'video' } {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return { url: '', mediaType: 'image' };
  }
  if (dataUrl.startsWith('data:image/')) {
    return { url: saveBase64Image(dataUrl, prefix), mediaType: 'image' };
  }
  if (dataUrl.startsWith('data:video/')) {
    const matches = dataUrl.match(/^data:video\/([a-zA-Z0-9\+\-]+);base64,(.+)$/);
    if (!matches) return { url: dataUrl, mediaType: 'video' };
    let ext = matches[1].toLowerCase();
    if (ext === 'quicktime') ext = 'mov';
    else if (!['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(ext)) ext = 'mp4';

    const buffer = Buffer.from(matches[2], 'base64');
    const safePrefix = (prefix || 'vid').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const filename = `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
    return { url: `/uploads/${filename}`, mediaType: 'video' };
  }
  return { url: dataUrl, mediaType: 'image' };
}

export interface ChatMessage {
  id: string;
  sender: 'customer' | 'seller';
  senderName: string;
  text: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | '';
  productId?: string;
  productName?: string;
  createdAt: string;
  isAiBot?: boolean;
}

export interface UserProfile {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  avatar?: string;
  socialProvider: 'google' | 'facebook' | 'apple' | 'whatsapp' | 'email';
  socialId?: string;
  sessionId: string;
  createdAt: string;
  lastLoginAt: string;
}

interface UsersStoreData {
  users: Record<string, UserProfile>;
}

export interface ChatConversation {
  sessionId: string;
  userId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAvatar?: string;
  socialProvider?: string;
  lastProductId?: string;
  lastProductName?: string;
  updatedAt: string;
  unreadForSeller: number;
  unreadForCustomer: number;
  messages: ChatMessage[];
}

interface ChatStoreData {
  conversations: Record<string, ChatConversation>;
}

function loadUsersData(): UsersStoreData {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.users === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error reading users-state.json:', err);
  }
  return { users: {} };
}

function saveUsersData(data: UsersStoreData) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing users-state.json:', err);
  }
}

export interface AiBotQaItem {
  id: string;
  question: string;
  answer: string;
}

export interface AiBotConfig {
  enabled: boolean;
  mode: 'when_away' | 'always' | 'off';
  sellerAway: boolean;
  botName: string;
  greetingMessage: string;
  customInstructions: string;
  qaPairs: AiBotQaItem[];
  universalGeminiMode?: boolean;
  updatedAt?: string;
}

const DEFAULT_AI_BOT_CONFIG: AiBotConfig = {
  enabled: true,
  mode: 'when_away',
  sellerAway: true,
  botName: '🤖 AI ასისტენტი (Gemini)',
  universalGeminiMode: true,
  greetingMessage:
    'გამარჯობა! მე ვარ მაღაზია „იყიდება საინტერესო ნივთები“-ს ხელოვნური ინტელექტის ასისტენტი (Gemini). გოჩა ამ წუთას საიტზე არ იმყოფება, თუმცა მე შემიძლია გაგცეთ ზუსტი პასუხი ნებისმიერ პროდუქტზე, ფასზე, მიწოდებასა და გარანტიაზე, ასევე გიპასუხოთ ნებისმიერ ზოგად შეკითხვაზე!',
  customInstructions:
    'მაღაზიის სახელია „იყიდება საინტერესო ნივთები“ (iyidebaa.ge). მფლობელი და საკონტაქტო პირია გოჩა, ტელეფონი / WhatsApp / Viber: +995 551 58 85 79.\n' +
    'ჩვენ ვყიდით პროფესიონალურ კარაოკე დინამიკებს (უკაბელო მიკროფონებით, აკუმულატორით, Bluetooth-ით), LiFePO4 სოლარ გენერატორებს, დასაკეც მზის პანელებს და სცენის აპარატურას.\n' +
    'მიწოდება თბილისში ხდება იმავე დღეს (სწრაფი მიწოდება და ადგილზე შემოწმება), ხოლო საქართველოს რეგიონებში — 24-48 საათში.\n' +
    'ყველა პროდუქტზე ვრცელდება ოფიციალური 12-თვიანი გარანტია.\n' +
    'მოქმედებს განვადება: საქართველოს ბანკი, თიბისი ბანკი და კრედო ბანკი.\n' +
    'უპასუხე თავაზიანად, მეგობრულად, ქართულ ენაზე (ან იმ ენაზე, რა ენაზეც კლიენტი მოგწერს), მოკლედ და გასაგებად. თუ კლიენტს შეკვეთა სურს, სთხოვე დატოვოს თავისი ტელეფონის ნომერი ჩატში ან დაურეკოს გოჩას ნომერზე +995 551 58 85 79.',
  qaPairs: [
    {
      id: 'qa_1',
      question: 'ადგილზე მიტანა გაქვთ? რა ღირს მიწოდება?',
      answer:
        'დიახ! თბილისში გვაქვს სწრაფი საკურიერო მიწოდება შეკვეთის დღესვე (ადგილზე შემოწმებით), ხოლო საქართველოს ყველა რეგიონში ვაგზავნით 24–48 საათში.',
    },
    {
      id: 'qa_2',
      question: 'განვადება თუ მოქმედებს და რომელ ბანკებთან?',
      answer:
        'დიახ, მოქმედებს ონლაინ და ადგილზე განვადება საქართველოს ბანკში, თიბისი ბანკში და კრედო ბანკში.',
    },
    {
      id: 'qa_3',
      question: 'გარანტია რამდენი ხანი აქვს პროდუქციას?',
      answer:
        'ყველა კარაოკე დინამიკსა და სოლარ გენერატორს მოყვება 12-თვიანი (1 წლიანი) ოფიციალური გარანტია და სერვისის მხარდაჭერა.',
    },
    {
      id: 'qa_4',
      question: 'დინამიკებს მიკროფონები მოყვება?',
      answer:
        'დიახ, ჩვენს კარაოკე დინამიკებს კომპლექტში მოყვება 2 უკაბელო UHF მიკროფონი, სამართავი პულტი და დამტენი კაბელი.',
    },
    {
      id: 'qa_5',
      question: 'როგორ შევუკვეთო ან როგორ დაგიკავშირდეთ?',
      answer:
        'შეკვეთისთვის შეგიძლიათ პირდაპირ აქ ჩატში დაგვიტოვოთ თქვენი ტელეფონის ნომერი და სასურველი ნივთის სახელი, ან დაუკავშირდეთ გოჩას ნომერზე: +995 551 58 85 79 (ზარი, WhatsApp, Viber).',
    },
  ],
};

function loadAiBotConfig(): AiBotConfig {
  try {
    if (fs.existsSync(AI_BOT_FILE)) {
      const raw = fs.readFileSync(AI_BOT_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_AI_BOT_CONFIG.enabled,
          mode:
            parsed.mode === 'always' || parsed.mode === 'when_away' || parsed.mode === 'off'
              ? parsed.mode
              : DEFAULT_AI_BOT_CONFIG.mode,
          sellerAway: typeof parsed.sellerAway === 'boolean' ? parsed.sellerAway : DEFAULT_AI_BOT_CONFIG.sellerAway,
          universalGeminiMode:
            typeof parsed.universalGeminiMode === 'boolean'
              ? parsed.universalGeminiMode
              : DEFAULT_AI_BOT_CONFIG.universalGeminiMode,
          botName: String(parsed.botName || DEFAULT_AI_BOT_CONFIG.botName).trim() || DEFAULT_AI_BOT_CONFIG.botName,
          greetingMessage:
            typeof parsed.greetingMessage === 'string'
              ? parsed.greetingMessage
              : DEFAULT_AI_BOT_CONFIG.greetingMessage,
          customInstructions:
            typeof parsed.customInstructions === 'string'
              ? parsed.customInstructions
              : DEFAULT_AI_BOT_CONFIG.customInstructions,
          qaPairs: Array.isArray(parsed.qaPairs) ? parsed.qaPairs : DEFAULT_AI_BOT_CONFIG.qaPairs,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.error('Error reading ai-bot-config.json:', err);
  }
  return { ...DEFAULT_AI_BOT_CONFIG, qaPairs: [...DEFAULT_AI_BOT_CONFIG.qaPairs] };
}

function saveAiBotConfig(cfg: AiBotConfig): AiBotConfig {
  const normalized: AiBotConfig = {
    enabled: Boolean(cfg.enabled),
    mode: cfg.mode === 'always' || cfg.mode === 'when_away' || cfg.mode === 'off' ? cfg.mode : 'when_away',
    sellerAway: Boolean(cfg.sellerAway),
    universalGeminiMode:
      typeof cfg.universalGeminiMode === 'boolean' ? cfg.universalGeminiMode : true,
    botName: String(cfg.botName || DEFAULT_AI_BOT_CONFIG.botName).trim() || DEFAULT_AI_BOT_CONFIG.botName,
    greetingMessage: String(cfg.greetingMessage ?? DEFAULT_AI_BOT_CONFIG.greetingMessage).trim(),
    customInstructions: String(cfg.customInstructions ?? DEFAULT_AI_BOT_CONFIG.customInstructions).trim(),
    qaPairs: Array.isArray(cfg.qaPairs)
      ? cfg.qaPairs
          .map((item, idx) => ({
            id: String(item?.id || `qa_${Date.now()}_${idx}`),
            question: String(item?.question || '').trim(),
            answer: String(item?.answer || '').trim(),
          }))
          .filter((item) => item.question || item.answer)
      : DEFAULT_AI_BOT_CONFIG.qaPairs,
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(AI_BOT_FILE, JSON.stringify(normalized, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing ai-bot-config.json:', err);
  }
  return normalized;
}

let lastSellerHeartbeatMs = 0;

function isSellerActiveInChat(cfg: AiBotConfig): boolean {
  if (cfg.sellerAway) return false;
  return Date.now() - lastSellerHeartbeatMs < 60_000;
}

function shouldAiBotAutoReply(cfg: AiBotConfig): boolean {
  if (!cfg.enabled || cfg.mode === 'off') return false;
  if (cfg.mode === 'always') return true;
  // mode === 'when_away'
  return !isSellerActiveInChat(cfg);
}

function loadStoreProductsSummaryForAi(): {
  summaryText: string;
  products: any[];
  contactPhone: string;
  contactName: string;
} {
  let products: any[] = [];
  let contactPhone = '+995 551 58 85 79';
  let contactName = 'გოჩა';
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.productsList)) {
        products = parsed.productsList;
      }
      if (parsed?.storeSettings?.phoneDisplay) {
        contactPhone = String(parsed.storeSettings.phoneDisplay);
      }
      if (parsed?.storeSettings?.contactName) {
        contactName = String(parsed.storeSettings.contactName);
      }
    }
  } catch (e) {}

  const lines = products.slice(0, 80).map((p, idx) => {
    const name = p?.ka?.name || p?.name || p?.id || `პროდუქტი #${idx + 1}`;
    const price = p?.price ? `${p.price} ₾` : '';
    const oldPrice = p?.oldPrice ? ` (ძველი ფასი: ${p.oldPrice} ₾)` : '';
    const cat = p?.category || '';
    const badge = p?.ka?.badge || p?.badge || '';
    const specsObj = p?.ka?.specs || p?.specs || {};
    const specsStr =
      specsObj && typeof specsObj === 'object'
        ? Object.entries(specsObj)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ')
        : '';
    const shortDesc = String(p?.ka?.description || p?.description || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    return `- [${p?.id || idx}] ${name} | ფასი: ${price}${oldPrice} | კატეგორია: ${cat} ${badge ? `| ${badge}` : ''} ${specsStr ? `| მონაცემები: ${specsStr}` : ''} ${shortDesc ? `| აღწერა: ${shortDesc}` : ''}`;
  });

  return {
    summaryText: lines.length > 0 ? lines.join('\n') : 'პროდუქცია: კარაოკე დინამიკები და სოლარ გენერატორები.',
    products,
    contactPhone,
    contactName,
  };
}

function buildLocalTrainedFallbackReply(
  questionText: string,
  cfg: AiBotConfig,
  productName?: string
): string {
  const qLower = String(questionText || '').toLowerCase();
  const { products, contactPhone, contactName } = loadStoreProductsSummaryForAi();

  // 1. Check trained Q&A pairs for keyword match
  const STOP_WORDS = new Set([
    'როგორ', 'რამდენი', 'არის', 'რა', 'თუ', 'და', 'ან', 'მაქვს', 'გაქვთ',
    'ხართ', 'ვარ', 'ხდება', 'მინდა', 'გვაქვს', 'ჩემი', 'თქვენი', 'გთხოვთ'
  ]);
  for (const pair of cfg.qaPairs || []) {
    if (!pair.question || !pair.answer) continue;
    const qClean = pair.question.toLowerCase().trim();
    if (qLower === qClean || (qClean.length >= 10 && qLower.includes(qClean))) {
      return pair.answer;
    }
    const significantWords = qClean
      .split(/[\s,?.!-]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    if (significantWords.length >= 2) {
      const matchCount = significantWords.filter((w) => qLower.includes(w)).length;
      if (matchCount >= 2 && matchCount >= Math.ceil(significantWords.length * 0.5)) {
        return pair.answer;
      }
    }
  }

  // 2. Check if asking about a specific product
  if (productName) {
    const found = products.find((p) => {
      const n = String(p?.ka?.name || p?.name || '').toLowerCase();
      return n && (n.includes(productName.toLowerCase()) || productName.toLowerCase().includes(n));
    });
    if (found) {
      const title = found?.ka?.name || found?.name || productName;
      const price = found?.price ? `${found.price} ₾` : '';
      return `📦 „${title}“ ხელმისაწვდომია! ფასი: ${price}. მოყვება 12-თვიანი ოფიციალური გარანტია და მიწოდება თბილისში იმავე დღეს (რეგიონებში 24-48 სთ). შეკვეთისთვის მოგვწერეთ თქვენი ტელეფონის ნომერი ან დაუკავშირდით ${contactName}-ს: ${contactPhone}.`;
    }
  }

  // Check calculation intent before generic product matching
  if (qLower.includes('გამოთვლ') || qLower.includes('კალკულატორ') || (qLower.includes('რამდენ ხან') && (qLower.includes('საათ') || qLower.includes('wh') || qLower.includes('ვატ') || qLower.includes('ამუშავებ')))) {
    return `⚡ ენერგიის გამოთვლის ფორმულა:\nმუშაობის დრო (საათებში) = (ბატარეის მოცულობა Wh × მარგი ქმედების კოეფიციენტი ~0.85) / მოწყობილობის სიმძლავრე (W).\nმაგალითად: 1000Wh მოცულობის LiFePO4 სადგური 100W სიმძლავრის ტელევიზორს ამუშავებს დაახლოებით 8.5 საათს, ხოლო 50W ლეპტოპს — 17 საათს. საიტზე გვაქვს გამომთვლელი კალკულატორიც!`;
  }

  const GENERIC_PROD_WORDS = new Set(['დინამიკი', 'გენერატორი', 'პანელი', 'კარაოკე', 'სისტემა', 'მოდელი', 'სოლარ', 'აკუსტიკა', '100w', '200w', '600w']);
  for (const p of products) {
    const title = String(p?.ka?.name || p?.name || '').trim();
    if (!title) continue;
    const titleClean = title.toLowerCase();
    const isExactMention = titleClean.length >= 7 && qLower.includes(titleClean);
    const distinctiveWords = titleClean
      .split(/[\s,/-]+/)
      .filter((t) => t.length >= 3 && !GENERIC_PROD_WORDS.has(t));
    const matchedDistinct = distinctiveWords.filter((w) => qLower.includes(w));
    if (isExactMention || matchedDistinct.length >= 2) {
      const priceStr = p?.price ? `${p.price} ₾` : 'მოითხოვეთ ფასი';
      return `📦 „${title}“ მარაგშია — ფასი: ${priceStr}. მოქმედებს 12-თვიანი გარანტია, მიწოდება თბილისში და განვადება (BOG, TBC, Credo). დაგვიტოვეთ ნომერი ან დარეკეთ: ${contactPhone}.`;
    }
  }

  // 3. Common intents
  if (qLower.includes('ფას') || qLower.includes('რა ღირს') || qLower.includes('ღირებულებ')) {
    return `ჩვენს კატალოგში ფასები მითითებულია თითოეულ ნივთზე ლარებში (₾). მითხარით რომელი მოდელი გაინტერესებთ და ზუსტ ფასსა და მონაცემებს მოგწერთ, ან დაგვიკავშირდით: ${contactPhone}.`;
  }
  if (qLower.includes('მიტან') || qLower.includes('მიწოდებ') || qLower.includes('კურიერ') || qLower.includes('რეგიონ')) {
    return `🚚 მიწოდება თბილისში ხდება შეკვეთის დღესვე (ადგილზე შემოწმებით), ხოლო რეგიონებში ვაგზავნით 24-48 საათში. საკონტაქტო: ${contactPhone}.`;
  }
  if (qLower.includes('განვადებ') || qLower.includes('ბანკ')) {
    return `💳 დიახ, მოქმედებს განვადება საქართველოს ბანკში, თიბისი ბანკში და კრედო ბანკში. დაგვიტოვეთ ნომერი ან დაურეკეთ ${contactName}-ს: ${contactPhone}.`;
  }
  if (qLower.includes('გარანტ')) {
    return `🛡️ ყველა ჩვენს პროდუქტზე ვრცელდება 12-თვიანი ოფიციალური გარანტია.`;
  }

  // 4. Broader intelligent tech advice
  if (qLower.includes('ვატ') || qLower.includes('rms') || qLower.includes('pmpo') || qLower.includes('სიმძლავრ')) {
    return `🔊 სიმძლავრის შესახებ: RMS (Root Mean Square) არის რეალური, უწყვეტი სუფთა სიმძლავრე, რომელზეც აკუსტიკური სისტემა მუშაობს დამახინჯების გარეშე, ხოლო PMPO არის პიკური წამიერი მაჩვენებელი. ჩვენს კარაოკე სისტემებში (100W-დან 1200W-მდე) გამოყენებულია მაღალი ეფექტურობის გამაძლიერებლები და ძლიერი დრაივერები, რაც უზრუნველყოფს როგორც ღრმა ბასს, ასევე სუფთა ვოკალს. დამატებითი დეტალებისთვის დაგვიკავშირდით: ${contactPhone}.`;
  }
  if (qLower.includes('სოლარ') || qLower.includes('მზის') || qLower.includes('ინვერტორ') || qLower.includes('lifepo4') || qLower.includes('გენერატორ')) {
    return `☀️ სოლარ გენერატორებისა და ავტონომიური სისტემების შესახებ: LiFePO4 (ლითიუმ-რკინა-ფოსფატის) ელემენტები გამოირჩევა 3000-ზე მეტი ციკლით (10 წელზე მეტი რესურსით) და მაღალი თერმული უსაფრთხოებით. სუფთა სინუსოიდური ინვერტორი იცავს ნებისმიერ საყოფაცხოვრებო ტექნიკას (მაცივარი, გათბობის ქვაბი, კომპიუტერი), ხოლო მზის პანელები უზრუნველყოფს სრულ ავტონომიურობას. ჩვენს კატალოგში მოიპოვება სრული კომპლექტები! საკონტაქტო: ${contactPhone}.`;
  }
  if (qLower.includes('ბას') || qLower.includes('აკუსტიკ') || qLower.includes('ხმა') || qLower.includes('მიკროფონ')) {
    return `🎙️ აკუსტიკისა და ხმის შესახებ: მაღალი ხარისხის ჟღერადობისთვის მნიშვნელოვანია დინამიკის კორპუსის აკუსტიკური გათვლა, დაბალი სიხშირის ვუფერის ზომა (10", 12", 15") და სუფთა მაღალსიხშირული ტვიტერი. ჩვენს მოდელებს მოყვება UHF ციფრული უსადენო მიკროფონები ჩაშენებული ექო (Echo) რეგულირებით. სიამოვნებით შეგირჩევთ საუკეთესო ვარიანტს: ${contactPhone}.`;
  }
  if (qLower.includes('გამოთვლ') || qLower.includes('კალკულატორ') || qLower.includes('საათ') || qLower.includes('wh') || qLower.includes('ამპერ')) {
    return `⚡ ენერგიის გამოთვლის ფორმულა:\nმუშაობის დრო (საათებში) = (ბატარეის მოცულობა Wh × მარგი ქმედების კოეფიციენტი ~0.85) / მოწყობილობის სიმძლავრე (W).\nმაგალითად: 1000Wh მოცულობის LiFePO4 სადგური 100W სიმძლავრის ტელევიზორს ამუშავებს დაახლოებით 8.5 საათს, ხოლო 50W ლეპტოპს — 17 საათს. საიტზე დამატებული გვაქვს გამომთვლელი კალკულატორიც!`;
  }

  return (
    cfg.greetingMessage ||
    `გამარჯობა! მე ვარ ${cfg.botName}. მზად ვარ გიპასუხოთ როგორც ჩვენს პროდუქციასა და პირობებზე, ასევე ნებისმიერ ტექნიკურ თუ ზოგად საკითხზე. ${contactName}-თან პირდაპირი კავშირისთვის: ${contactPhone}.`
  );
}

async function generateAiBotReply(
  questionText: string,
  conv: ChatConversation | null,
  productId?: string,
  productName?: string
): Promise<string> {
  const cfg = loadAiBotConfig();
  const { summaryText, contactPhone, contactName } = loadStoreProductsSummaryForAi();

  const qaText =
    cfg.qaPairs && cfg.qaPairs.length > 0
      ? cfg.qaPairs.map((pair, i) => `${i + 1}. კითხვა: ${pair.question}\n   პასუხი: ${pair.answer}`).join('\n')
      : 'დამატებითი კითხვა-პასუხი არ არის მითითებული.';

  const recentHistory =
    conv && Array.isArray(conv.messages)
      ? conv.messages
          .slice(-8)
          .map((m) => `${m.sender === 'customer' ? 'კლიენტი' : 'მაღაზია'}: ${m.text || '[ფოტო/ვიდეო]'}`)
          .join('\n')
      : '';

  const isUniversalMode = cfg.universalGeminiMode !== false;

  const systemInstruction = `შენ ხარ უნივერსალური ხელოვნური ინტელექტი — Google Gemini-ს ბაზაზე შექმნილი სრულფასოვანი ინტელექტუალური ასისტენტი, რომელიც ინტეგრირებულია ონლაინ მაღაზიაში „იყიდება საინტერესო ნივთები“ (iyidebaa.ge).
შენი სახელია: ${cfg.botName}.
მაღაზიის მფლობელი: ${contactName} (ტელეფონი / WhatsApp / Viber: ${contactPhone}).

${
  isUniversalMode
    ? `=== უნივერსალური GEMINI-ს აზროვნება და შესაძლებლობები ===
- შენ გაქვს სრული უფლება და უნარი იფიქრო, გააანალიზო, გამოთვალო, ურჩიო და ისაუბრო აბსოლუტურად ნებისმიერ თემაზე მსოფლიოში (ზუსტად ისე, როგორც Google Gemini):
  * მეცნიერება, ტექნოლოგია, ფიზიკა, ასტრონომია, მათემატიკა, გამოთვლები
  * აკუსტიკა, დინამიკები, ბასები, ვატები (RMS/Peak), ხმის ინჟინერია, კარაოკე სისტემები
  * მზის ენერგია, სოლარ გენერატორები, ინვერტორები, აკუმულატორები (LiFePO4/Lead-Acid), ავტონომიური კვება
  * ყოველდღიური ცხოვრებისეული რჩევები, ისტორია, ლიტერატურა, მოგზაურობა, ენები, ჯანმრთელობა, იუმორი და ა.შ.
- არასოდეს თქვა: „მე მხოლოდ მაღაზიის ბოტი ვარ და სხვა თემებზე არ ვპასუხობ“. პირიქით — უპასუხე სიღრმისეულად, ჭკვიანურად, ერუდირებულად და მაქსიმალურად სასარგებლოდ ნებისმიერ შეკითხვაზე!
- თუ მომხმარებელი გეკითხება ზოგად თემაზე (მაგ. როგორ მუშაობს მზის პანელი, რა განსხვავებაა RMS და PMPO ვატებს შორის, როგორ ავირჩიოთ დინამიკი, ან რჩევა ცხოვრებისეულ/სამეცნიერო საკითხზე), გაეცი ამომწურავი, პროფესიონალური და საინტერესო პასუხი.`
    : `=== შეზღუდული რეჟიმი ===
- უპასუხე ძირითადად მაღაზიასთან და პროდუქციასთან დაკავშირებულ კითხვებზე.`
}

=== მაღაზიის ექსპერტობა და კონსულტაცია ===
- როდესაც კლიენტი გეკითხება მაღაზიის პროდუქციაზე, ფასებზე, შეკვეთაზე, მიწოდებაზე ან გარანტიაზე:
  * მიაწოდე ზუსტი მონაცემები ქვემოთ მოცემული პროდუქტების კატალოგიდან.
  * ჩვენთან მოქმედებს: 12-თვიანი ოფიციალური გარანტია, მიწოდება თბილისში იმავე დღეს (რეგიონებში 24-48 სთ), და საბანკო განვადება (საქართველოს ბანკი, თიბისი, კრედო).
  * თუ კლიენტს სურს ყიდვა ან შეკვეთის გაფორმება, სთხოვე დატოვოს ტელეფონის ნომერი ჩატში ან პირდაპირ დაურეკოს ${contactName}-ს: ${contactPhone}.

=== მაღაზიის მფლობელის მიერ ნასწავლი მთავარი წესები და ინსტრუქცია ===
${cfg.customInstructions}

=== მფლობელის მიერ ნასწავლი კითხვა-პასუხების ბაზა (Q&A) ===
${qaText}

=== საიტზე არსებული პროდუქციის კატალოგი და ფასები ===
${summaryText}

=== პასუხის გაცემის სტილი ===
1. იყავი თავაზიანი, მეგობრული, უაღრესად კომპეტენტური, ლოგიკური და გულისხმიერი.
2. უპასუხე გამართული ქართული ენით (ან იმ ენაზე, რა ენაზეც კლიენტი მოგმართავს).
3. გამოიყენე ლამაზი ფორმატირება (პუნქტები, ემოჯები), როცა ეს პასუხს უფრო აღქმადს ხდის.
4. თუ კლიენტი კონკრეტულ პროდუქტს კითხულობს${productName ? ` (ახლა ათვალიერებს: „${productName}“)` : ''}, მიაწოდე მისი ზუსტი ფასი, მახასიათებლები და პირობები.
5. თუ კლიენტს ყიდვა ან შეკვეთა უნდა, სთხოვე დატოვოს ტელეფონის ნომერი ჩატში ან დაურეკოს ${contactName}-ს ნომერზე ${contactPhone}.`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return buildLocalTrainedFallbackReply(questionText, cfg, productName);
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });

    const userPrompt = `${recentHistory ? `მიმოწერის ისტორია:\n${recentHistory}\n\n` : ''}${
      productName ? `კლიენტი ამჟამად ათვალიერებს პროდუქტს: ${productName}\n` : ''
    }კლიენტის ახალი შეტყობინება: ${questionText || 'გამარჯობა, მაინტერესებს პროდუქცია'}`;

    const candidateModels = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: userPrompt,
          config: {
            systemInstruction,
          },
        });

        const replyText = String(response.text || '').trim();
        if (replyText) {
          return replyText;
        }
      } catch (err: any) {
        console.warn(`Gemini AI (${modelName}) error:`, err?.message || err);
      }
    }
  } catch (err) {
    console.warn('Gemini AI Bot generation fallback triggered:', err);
  }

  return buildLocalTrainedFallbackReply(questionText, cfg, productName);
}

function loadChatData(): ChatStoreData {
  try {
    if (fs.existsSync(CHAT_FILE)) {
      const raw = fs.readFileSync(CHAT_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.conversations === 'object') {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error reading chat-state.json:', err);
  }
  return { conversations: {} };
}

function saveChatData(data: ChatStoreData) {
  try {
    fs.writeFileSync(CHAT_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing chat-state.json:', err);
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  app.use(express.json({ limit: '150mb' }));
  app.use(express.urlencoded({ extended: true, limit: '150mb' }));

  // Allow cross-origin requests from iyidebaa.ge and GitHub Pages/Vercel
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Static serving of uploaded images & videos
  app.use('/uploads', express.static(UPLOADS_DIR));

  // WebSocket Server for Real-Time Chat
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url ? request.url.split('?')[0] : '';
    if (pathname === '/ws-chat') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => {
      clients.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  function broadcastChatEvent(payload: any) {
    const serialized = JSON.stringify(payload);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(serialized);
        } catch (e) {}
      }
    }
  }

  // Dedicated single/batch image upload endpoint (also immediately records slot in images-map.json)
  app.post('/api/upload', (req, res) => {
    try {
      const { image, filename, productId, slotIndex } = req.body;
      if (!image || typeof image !== 'string') {
        res.status(400).json({ ok: false, error: 'No image provided' });
        return;
      }
      const cleanProdId = typeof productId === 'string' && productId.trim() ? productId.trim() : '';
      const slotNum = typeof slotIndex === 'number' && slotIndex >= 0 && slotIndex < 5 ? slotIndex : -1;
      const prefix = cleanProdId && slotNum >= 0 ? `${cleanProdId}_slot_${slotNum}` : filename || 'img';
      const publicUrl = saveBase64Image(image, prefix);

      if (cleanProdId && slotNum >= 0) {
        const map = loadImagesMap();
        if (!Array.isArray(map[cleanProdId])) {
          map[cleanProdId] = ['', '', '', '', ''];
        }
        map[cleanProdId][slotNum] = publicUrl;
        saveImagesMap(map);

        // Also update store-state.json if it already exists
        if (fs.existsSync(DATA_FILE)) {
          try {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.productsList)) {
              parsed.productsList = applyImagesMapToProducts(parsed.productsList, map);
              parsed.updatedAt = new Date().toISOString();
              fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
            }
          } catch (e) {}
        }
      }

      res.json({ ok: true, url: publicUrl });
    } catch (err) {
      console.error('Error handling /api/upload:', err);
      res.status(500).json({ ok: false, error: 'Upload failed' });
    }
  });

  // Media upload endpoint for Chat (supports both images and videos)
  app.post('/api/upload-media', (req, res) => {
    try {
      const { media, filename } = req.body;
      if (!media || typeof media !== 'string') {
        res.status(400).json({ ok: false, error: 'No media provided' });
        return;
      }
      const saved = saveBase64Media(media, filename || 'chat_media');
      res.json({ ok: true, url: saved.url, mediaType: saved.mediaType });
    } catch (err) {
      console.error('Error handling /api/upload-media:', err);
      res.status(500).json({ ok: false, error: 'Media upload failed' });
    }
  });

  // ==========================================
  // USER AUTHENTICATION & SOCIAL PROFILE API
  // ==========================================

  // 1. Social Login / Simple Registration
  app.post('/api/auth/social-login', (req, res) => {
    try {
      const {
        provider = 'google',
        socialId,
        name,
        email,
        phone,
        avatar,
        currentSessionId,
      } = req.body || {};

      const cleanProvider: 'google' | 'facebook' | 'apple' | 'whatsapp' | 'email' =
        ['google', 'facebook', 'apple', 'whatsapp', 'email'].includes(provider) ? provider : 'google';
      const cleanEmail = String(email || '').trim().toLowerCase();
      const cleanPhone = String(phone || '').trim();
      const cleanSocialId = String(socialId || '').trim();
      const cleanName = String(name || '').trim() || (cleanEmail ? cleanEmail.split('@')[0] : 'მომხმარებელი');
      const cleanSessionId = String(currentSessionId || '').trim();

      const defaultAvatar =
        cleanProvider === 'google'
          ? 'https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png'
          : cleanProvider === 'facebook'
          ? 'https://upload.wikimedia.org/wikipedia/commons/b/b8/2021_Facebook_icon.svg'
          : `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(cleanName)}&backgroundColor=7c3aed`;

      const cleanAvatar = String(avatar || '').trim() || defaultAvatar;

      const usersData = loadUsersData();
      const chatData = loadChatData();

      // Find existing user by email, phone, or provider+socialId
      let user: UserProfile | undefined = Object.values(usersData.users).find((u) => {
        if (cleanEmail && u.email && u.email.toLowerCase() === cleanEmail) return true;
        if (cleanPhone && u.phone && u.phone === cleanPhone) return true;
        if (cleanSocialId && u.socialId && u.socialId === cleanSocialId && u.socialProvider === cleanProvider) return true;
        return false;
      });

      const nowIso = new Date().toISOString();

      if (user) {
        // User exists! Update last login and optional fields
        user.lastLoginAt = nowIso;
        if (cleanName && (!user.name || user.name === 'მომხმარებელი')) user.name = cleanName;
        if (cleanPhone && !user.phone) user.phone = cleanPhone;
        if (cleanEmail && !user.email) user.email = cleanEmail;
        if (cleanAvatar && (!user.avatar || user.avatar.includes('dicebear'))) user.avatar = cleanAvatar;

        const masterSessionId = user.sessionId;
        let masterConv = chatData.conversations[masterSessionId];
        if (!masterConv) {
          masterConv = {
            sessionId: masterSessionId,
            userId: user.id,
            customerName: user.name,
            customerPhone: user.phone,
            customerEmail: user.email,
            customerAvatar: user.avatar,
            socialProvider: user.socialProvider,
            updatedAt: nowIso,
            unreadForSeller: 0,
            unreadForCustomer: 0,
            messages: [],
          };
          chatData.conversations[masterSessionId] = masterConv;
        } else {
          masterConv.userId = user.id;
          masterConv.customerName = user.name;
          if (user.phone) masterConv.customerPhone = user.phone;
          if (user.email) masterConv.customerEmail = user.email;
          if (user.avatar) masterConv.customerAvatar = user.avatar;
          masterConv.socialProvider = user.socialProvider;
        }

        // If the client had an anonymous currentSessionId with new messages, merge them into masterConv!
        if (cleanSessionId && cleanSessionId !== masterSessionId && chatData.conversations[cleanSessionId]) {
          const anonConv = chatData.conversations[cleanSessionId];
          const existingMsgIds = new Set(masterConv.messages.map((m) => m.id));
          for (const msg of anonConv.messages) {
            if (!existingMsgIds.has(msg.id)) {
              masterConv.messages.push(msg);
              existingMsgIds.add(msg.id);
            }
          }
          masterConv.updatedAt = nowIso;
          // Clean up merged anonymous conversation
          delete chatData.conversations[cleanSessionId];
        }

        usersData.users[user.id] = user;
        saveUsersData(usersData);
        saveChatData(chatData);

        res.json({
          ok: true,
          user,
          conversation: masterConv,
          merged: Boolean(cleanSessionId && cleanSessionId !== masterSessionId),
        });
        return;
      }

      // New User Registration
      const newUserId = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const targetSessionId = cleanSessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      user = {
        id: newUserId,
        name: cleanName,
        email: cleanEmail || undefined,
        phone: cleanPhone || undefined,
        avatar: cleanAvatar,
        socialProvider: cleanProvider,
        socialId: cleanSocialId || undefined,
        sessionId: targetSessionId,
        createdAt: nowIso,
        lastLoginAt: nowIso,
      };

      usersData.users[newUserId] = user;
      saveUsersData(usersData);

      let conv = chatData.conversations[targetSessionId];
      if (!conv) {
        conv = {
          sessionId: targetSessionId,
          userId: newUserId,
          customerName: user.name,
          customerPhone: user.phone,
          customerEmail: user.email,
          customerAvatar: user.avatar,
          socialProvider: user.socialProvider,
          updatedAt: nowIso,
          unreadForSeller: 0,
          unreadForCustomer: 0,
          messages: [],
        };
        chatData.conversations[targetSessionId] = conv;
      } else {
        conv.userId = newUserId;
        conv.customerName = user.name;
        if (user.phone) conv.customerPhone = user.phone;
        if (user.email) conv.customerEmail = user.email;
        conv.customerAvatar = user.avatar;
        conv.socialProvider = user.socialProvider;
      }
      saveChatData(chatData);

      res.json({
        ok: true,
        user,
        conversation: conv,
        isNew: true,
      });
    } catch (err) {
      console.error('Error in /api/auth/social-login:', err);
      res.status(500).json({ ok: false, error: 'Social authentication failed' });
    }
  });

  // 2. Get Current Logged-In User Profile & Conversation
  app.get('/api/auth/me', (req, res) => {
    try {
      const userId = String(req.query.userId || '').trim();
      const sessionId = String(req.query.sessionId || '').trim();

      const usersData = loadUsersData();
      let user: UserProfile | undefined;
      if (userId && usersData.users[userId]) {
        user = usersData.users[userId];
      } else if (sessionId) {
        user = Object.values(usersData.users).find((u) => u.sessionId === sessionId);
      }

      if (!user) {
        res.json({ ok: true, user: null, conversation: null });
        return;
      }

      const chatData = loadChatData();
      const conv = chatData.conversations[user.sessionId] || null;

      res.json({ ok: true, user, conversation: conv });
    } catch (err) {
      console.error('Error in /api/auth/me:', err);
      res.status(500).json({ ok: false, error: 'Failed to fetch user profile' });
    }
  });

  // 3. Update User Profile Info (Name / Phone / Email)
  app.post('/api/auth/update-profile', (req, res) => {
    try {
      const { userId, name, phone, email, avatar } = req.body || {};
      const cleanUserId = String(userId || '').trim();
      if (!cleanUserId) {
        res.status(400).json({ ok: false, error: 'Missing userId' });
        return;
      }

      const usersData = loadUsersData();
      const user = usersData.users[cleanUserId];
      if (!user) {
        res.status(404).json({ ok: false, error: 'User not found' });
        return;
      }

      if (name && typeof name === 'string' && name.trim()) user.name = name.trim();
      if (phone !== undefined) user.phone = String(phone).trim();
      if (email !== undefined) user.email = String(email).trim().toLowerCase();
      if (avatar && typeof avatar === 'string' && avatar.trim()) user.avatar = avatar.trim();
      user.lastLoginAt = new Date().toISOString();

      usersData.users[cleanUserId] = user;
      saveUsersData(usersData);

      // Sync conversation metadata
      const chatData = loadChatData();
      if (chatData.conversations[user.sessionId]) {
        const conv = chatData.conversations[user.sessionId];
        conv.customerName = user.name;
        conv.customerPhone = user.phone;
        conv.customerEmail = user.email;
        if (user.avatar) conv.customerAvatar = user.avatar;
        saveChatData(chatData);
      }

      res.json({ ok: true, user });
    } catch (err) {
      console.error('Error updating user profile:', err);
      res.status(500).json({ ok: false, error: 'Failed to update profile' });
    }
  });

  // 4. Logout Endpoint
  app.post('/api/auth/logout', (_req, res) => {
    res.json({ ok: true });
  });

  // Get Chat Conversations (with optional userId lookup)
  app.get('/api/chat', (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    const userId = String(req.query.userId || '').trim();
    const role = String(req.query.role || 'customer').trim();
    const chatData = loadChatData();

    if (role === 'seller') {
      const list = Object.values(chatData.conversations).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      res.json({ ok: true, conversations: list });
      return;
    }

    let targetSessionId = sessionId;
    if (userId) {
      const usersData = loadUsersData();
      const user = usersData.users[userId];
      if (user && user.sessionId) {
        targetSessionId = user.sessionId;
      }
    }

    if (!targetSessionId) {
      res.json({ ok: true, conversation: null });
      return;
    }

    const conv = chatData.conversations[targetSessionId] || null;
    res.json({ ok: true, conversation: conv, sessionId: targetSessionId });
  });

  // Send a Chat Message (Customer or Seller)
  app.post('/api/chat/message', (req, res) => {
    try {
      const {
        sessionId,
        userId,
        customerAvatar,
        customerEmail,
        sender,
        senderName,
        customerName,
        customerPhone,
        text,
        mediaData,
        mediaUrl: incomingMediaUrl,
        mediaType: incomingMediaType,
        productId,
        productName,
      } = req.body;

      const cleanSessionId = String(sessionId || '').trim();
      if (!cleanSessionId) {
        res.status(400).json({ ok: false, error: 'Missing sessionId' });
        return;
      }

      const role: 'customer' | 'seller' = sender === 'seller' ? 'seller' : 'customer';
      const cleanText = String(text || '').trim();

      let finalMediaUrl = String(incomingMediaUrl || '').trim();
      let finalMediaType: 'image' | 'video' | '' =
        incomingMediaType === 'video' ? 'video' : incomingMediaType === 'image' ? 'image' : '';

      if (mediaData && typeof mediaData === 'string' && mediaData.startsWith('data:')) {
        const saved = saveBase64Media(mediaData, `chat_${role}`);
        finalMediaUrl = saved.url;
        finalMediaType = saved.mediaType;
      }

      if (!cleanText && !finalMediaUrl) {
        res.status(400).json({ ok: false, error: 'Empty message' });
        return;
      }

      const chatData = loadChatData();
      const nowIso = new Date().toISOString();

      let conv = chatData.conversations[cleanSessionId];
      if (!conv) {
        conv = {
          sessionId: cleanSessionId,
          userId: userId ? String(userId) : undefined,
          customerName: String(customerName || (role === 'customer' ? senderName : '') || 'მომხმარებელი').trim() || 'მომხმარებელი',
          customerPhone: String(customerPhone || '').trim(),
          customerEmail: customerEmail ? String(customerEmail).trim().toLowerCase() : undefined,
          customerAvatar: customerAvatar ? String(customerAvatar).trim() : undefined,
          lastProductId: productId ? String(productId) : '',
          lastProductName: productName ? String(productName) : '',
          updatedAt: nowIso,
          unreadForSeller: 0,
          unreadForCustomer: 0,
          messages: [],
        };
        chatData.conversations[cleanSessionId] = conv;
      }

      if (userId) conv.userId = String(userId);
      if (customerAvatar) conv.customerAvatar = String(customerAvatar);
      if (customerEmail) conv.customerEmail = String(customerEmail).trim().toLowerCase();

      if (role === 'customer') {
        if (customerName && String(customerName).trim()) {
          conv.customerName = String(customerName).trim();
        }
        if (customerPhone && String(customerPhone).trim()) {
          conv.customerPhone = String(customerPhone).trim();
        }
      }
      if (productId) conv.lastProductId = String(productId);
      if (productName) conv.lastProductName = String(productName);
      conv.updatedAt = nowIso;

      if (role === 'customer') {
        conv.unreadForSeller = (conv.unreadForSeller || 0) + 1;
      } else {
        conv.unreadForCustomer = (conv.unreadForCustomer || 0) + 1;
      }

      if (role === 'seller') {
        lastSellerHeartbeatMs = Date.now();
      }

      const newMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        sender: role,
        senderName:
          String(senderName || '').trim() ||
          (role === 'seller' ? 'გოჩა (გამყიდველი)' : conv.customerName || 'მომხმარებელი'),
        text: cleanText,
        mediaUrl: finalMediaUrl || undefined,
        mediaType: finalMediaType || undefined,
        productId: productId ? String(productId) : undefined,
        productName: productName ? String(productName) : undefined,
        createdAt: nowIso,
      };

      conv.messages.push(newMsg);
      saveChatData(chatData);

      const allList = Object.values(chatData.conversations).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      broadcastChatEvent({
        type: 'chat:message',
        sessionId: cleanSessionId,
        message: newMsg,
        conversation: conv,
        conversations: allList,
      });

      const botCfg = loadAiBotConfig();
      const willAutoReply = role === 'customer' && shouldAiBotAutoReply(botCfg);

      res.json({
        ok: true,
        message: newMsg,
        conversation: conv,
        conversations: allList,
        aiAutoReplyScheduled: willAutoReply,
      });

      if (willAutoReply) {
        setTimeout(async () => {
          try {
            const latestCfg = loadAiBotConfig();
            if (!shouldAiBotAutoReply(latestCfg)) return;
            const currentChatData = loadChatData();
            const currentConv = currentChatData.conversations[cleanSessionId];
            if (!currentConv) return;

            const replyText = await generateAiBotReply(
              cleanText,
              currentConv,
              productId ? String(productId) : currentConv.lastProductId,
              productName ? String(productName) : currentConv.lastProductName
            );
            if (!replyText) return;

            const botNowIso = new Date().toISOString();
            const botMsg: ChatMessage = {
              id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              sender: 'seller',
              senderName: latestCfg.botName || '🤖 AI ასისტენტი',
              text: replyText,
              productId: productId ? String(productId) : currentConv.lastProductId || undefined,
              productName: productName ? String(productName) : currentConv.lastProductName || undefined,
              createdAt: botNowIso,
              isAiBot: true,
            };

            currentConv.messages.push(botMsg);
            currentConv.updatedAt = botNowIso;
            currentConv.unreadForCustomer = (currentConv.unreadForCustomer || 0) + 1;
            saveChatData(currentChatData);

            const updatedList = Object.values(currentChatData.conversations).sort(
              (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
            );

            broadcastChatEvent({
              type: 'chat:message',
              sessionId: cleanSessionId,
              message: botMsg,
              conversation: currentConv,
              conversations: updatedList,
            });
          } catch (botErr) {
            console.error('Error generating AI Bot auto-reply:', botErr);
          }
        }, 700);
      }
    } catch (err) {
      console.error('Error in POST /api/chat/message:', err);
      res.status(500).json({ ok: false, error: 'Failed to send message' });
    }
  });

  // Seller presence heartbeat & AI Bot API endpoints
  app.post('/api/chat/seller-heartbeat', (req, res) => {
    const { active } = req.body || {};
    if (active === false) {
      lastSellerHeartbeatMs = 0;
    } else {
      lastSellerHeartbeatMs = Date.now();
    }
    const cfg = loadAiBotConfig();
    res.json({
      ok: true,
      sellerOnline: isSellerActiveInChat(cfg),
    });
  });

  app.get('/api/ai-bot/config', (_req, res) => {
    const cfg = loadAiBotConfig();
    res.json({
      ok: true,
      config: cfg,
      sellerOnline: isSellerActiveInChat(cfg),
    });
  });

  app.post('/api/ai-bot/config', (req, res) => {
    try {
      const current = loadAiBotConfig();
      const incoming = req.body || {};
      const updated = saveAiBotConfig({
        enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : current.enabled,
        mode:
          incoming.mode === 'always' || incoming.mode === 'when_away' || incoming.mode === 'off'
            ? incoming.mode
            : current.mode,
        sellerAway: typeof incoming.sellerAway === 'boolean' ? incoming.sellerAway : current.sellerAway,
        universalGeminiMode:
          typeof incoming.universalGeminiMode === 'boolean'
            ? incoming.universalGeminiMode
            : current.universalGeminiMode ?? true,
        botName: typeof incoming.botName === 'string' ? incoming.botName : current.botName,
        greetingMessage:
          typeof incoming.greetingMessage === 'string' ? incoming.greetingMessage : current.greetingMessage,
        customInstructions:
          typeof incoming.customInstructions === 'string' ? incoming.customInstructions : current.customInstructions,
        qaPairs: Array.isArray(incoming.qaPairs) ? incoming.qaPairs : current.qaPairs,
      });

      broadcastChatEvent({
        type: 'aibot:config',
        config: updated,
        sellerOnline: isSellerActiveInChat(updated),
      });

      res.json({
        ok: true,
        config: updated,
        sellerOnline: isSellerActiveInChat(updated),
      });
    } catch (err) {
      console.error('Error saving AI bot config:', err);
      res.status(500).json({ ok: false, error: 'Failed to save AI bot config' });
    }
  });

  app.post('/api/ai-bot/test', async (req, res) => {
    try {
      const { question, productId, productName } = req.body || {};
      const cleanQ = String(question || '').trim();
      if (!cleanQ) {
        res.status(400).json({ ok: false, error: 'Empty question' });
        return;
      }
      const reply = await generateAiBotReply(cleanQ, null, productId, productName);
      res.json({ ok: true, reply });
    } catch (err) {
      console.error('Error testing AI bot:', err);
      res.status(500).json({ ok: false, error: 'AI bot test failed' });
    }
  });

  app.post('/api/ai-bot/reply-session', async (req, res) => {
    try {
      const { sessionId, question, productId, productName } = req.body || {};
      const cleanSessionId = String(sessionId || '').trim();
      if (!cleanSessionId) {
        res.status(400).json({ ok: false, error: 'Missing sessionId' });
        return;
      }
      const chatData = loadChatData();
      const conv = chatData.conversations[cleanSessionId];
      if (!conv) {
        res.status(404).json({ ok: false, error: 'Conversation not found' });
        return;
      }
      const lastCustMsg = [...conv.messages].reverse().find((m) => m.sender === 'customer');
      const queryText = String(question || lastCustMsg?.text || 'გამარჯობა').trim();
      const cfg = loadAiBotConfig();
      const replyText = await generateAiBotReply(
        queryText,
        conv,
        productId || conv.lastProductId,
        productName || conv.lastProductName
      );

      const nowIso = new Date().toISOString();
      const botMsg: ChatMessage = {
        id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        sender: 'seller',
        senderName: cfg.botName || '🤖 AI ასისტენტი',
        text: replyText,
        productId: productId || conv.lastProductId || undefined,
        productName: productName || conv.lastProductName || undefined,
        createdAt: nowIso,
        isAiBot: true,
      };

      conv.messages.push(botMsg);
      conv.updatedAt = nowIso;
      conv.unreadForCustomer = (conv.unreadForCustomer || 0) + 1;
      saveChatData(chatData);

      const allList = Object.values(chatData.conversations).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );

      broadcastChatEvent({
        type: 'chat:message',
        sessionId: cleanSessionId,
        message: botMsg,
        conversation: conv,
        conversations: allList,
      });

      res.json({ ok: true, message: botMsg, conversation: conv, conversations: allList });
    } catch (err) {
      console.error('Error in /api/ai-bot/reply-session:', err);
      res.status(500).json({ ok: false, error: 'Failed to generate AI reply' });
    }
  });

  // Mark conversation as read
  app.post('/api/chat/read', (req, res) => {
    try {
      const { sessionId, readerRole } = req.body;
      if (readerRole === 'seller') {
        lastSellerHeartbeatMs = Date.now();
      }
      const cleanSessionId = String(sessionId || '').trim();
      const chatData = loadChatData();
      const conv = chatData.conversations[cleanSessionId];
      if (conv) {
        if (readerRole === 'seller') {
          conv.unreadForSeller = 0;
        } else {
          conv.unreadForCustomer = 0;
        }
        saveChatData(chatData);
        const allList = Object.values(chatData.conversations).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        broadcastChatEvent({
          type: 'chat:read',
          sessionId: cleanSessionId,
          conversation: conv,
          conversations: allList,
        });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false });
    }
  });

  // Delete a conversation
  app.delete('/api/chat/:sessionId', (req, res) => {
    try {
      const cleanSessionId = String(req.params.sessionId || '').trim();
      const chatData = loadChatData();
      if (chatData.conversations[cleanSessionId]) {
        delete chatData.conversations[cleanSessionId];
        saveChatData(chatData);
      }
      const allList = Object.values(chatData.conversations).sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      broadcastChatEvent({
        type: 'chat:deleted',
        sessionId: cleanSessionId,
        conversations: allList,
      });
      res.json({ ok: true, conversations: allList });
    } catch (err) {
      res.status(500).json({ ok: false });
    }
  });

  // Load persisted store state (products, settings, themeColor) + imagesMap
  app.get('/api/store', (_req, res) => {
    try {
      recoverOrphanUploadedPhotos();
      const map = loadImagesMap();
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.productsList)) {
          parsed.productsList = applyImagesMapToProducts(parsed.productsList, map);
        }
        parsed.imagesMap = map;
        res.json(parsed);
        return;
      }
      res.json({
        hasSavedState: Object.keys(map).length > 0,
        imagesMap: map,
      });
      return;
    } catch (err) {
      console.error('Error reading store-state.json:', err);
    }
    res.json({ hasSavedState: false, imagesMap: {} });
  });

  // Save store state persistently to disk (converts any base64 images to static files and updates images-map.json)
  app.post('/api/store', (req, res) => {
    try {
      const map = loadImagesMap();
      const forceClearProdId = typeof req.body.forceClearProductId === 'string' ? req.body.forceClearProductId : '';
      const forceClearSlot = typeof req.body.forceClearSlot === 'number' ? req.body.forceClearSlot : -1;

      if (forceClearProdId) {
        if (forceClearSlot >= 0 && forceClearSlot < 5 && Array.isArray(map[forceClearProdId])) {
          map[forceClearProdId][forceClearSlot] = '';
        } else if (forceClearSlot === -1) {
          map[forceClearProdId] = ['', '', '', '', ''];
        }
      }

      let existingProductsMap: Record<string, any> = {};
      if (fs.existsSync(DATA_FILE)) {
        try {
          const oldRaw = fs.readFileSync(DATA_FILE, 'utf-8');
          const oldData = JSON.parse(oldRaw);
          if (Array.isArray(oldData?.productsList)) {
            for (const ep of oldData.productsList) {
              if (ep && ep.id) existingProductsMap[ep.id] = ep;
            }
          }
        } catch (e) {}
      }

      const incomingProducts = Array.isArray(req.body.productsList) ? req.body.productsList : [];
      const cleanedProducts = incomingProducts.map((p: any) => {
        const prod = { ...p };
        const existingProd = existingProductsMap[prod.id];
        if (!Array.isArray(map[prod.id])) {
          map[prod.id] = ['', '', '', '', ''];
        }

        if (Array.isArray(prod.images)) {
          prod.images = prod.images.map((img: string, idx: number) => {
            if (typeof img === 'string' && img.startsWith('data:image/')) {
              const savedUrl = saveBase64Image(img, `${prod.id || 'item'}_slot_${idx}`);
              map[prod.id][idx] = savedUrl;
              return savedUrl;
            }
            if (typeof img === 'string' && img.trim().length > 0) {
              map[prod.id][idx] = img.trim();
              return img.trim();
            }
            const isExplicitlyCleared =
              forceClearProdId === prod.id && (forceClearSlot === -1 || forceClearSlot === idx);
            if (!isExplicitlyCleared) {
              if (map[prod.id][idx]) {
                return map[prod.id][idx];
              }
              if (existingProd && Array.isArray(existingProd.images) && existingProd.images[idx]) {
                map[prod.id][idx] = existingProd.images[idx];
                return existingProd.images[idx];
              }
            }
            return '';
          });
        } else if (existingProd && Array.isArray(existingProd.images)) {
          prod.images = existingProd.images;
        }
        return prod;
      });

      saveImagesMap(map);

      const payload = {
        hasSavedState: true,
        updatedAt: new Date().toISOString(),
        storeSettings: req.body.storeSettings,
        productsList: cleanedProducts,
        themeColor: req.body.themeColor,
        imagesMap: map,
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');

      // Broadcast store update in real-time to all connected devices (phones, computers)
      broadcastChatEvent({
        type: 'store:sync',
        hasSavedState: true,
        updatedAt: payload.updatedAt,
        storeSettings: payload.storeSettings,
        productsList: cleanedProducts,
        themeColor: payload.themeColor,
        imagesMap: map,
      });

      res.json({ ok: true, productsList: cleanedProducts, imagesMap: map });
    } catch (err) {
      console.error('Error writing store-state.json:', err);
      res.status(500).json({ ok: false });
    }
  });

  // Serve /store-data.json locally as fallback
  app.get('/store-data.json', (_req, res) => {
    try {
      if (fs.existsSync(DATA_FILE)) {
        res.setHeader('Content-Type', 'application/json');
        res.send(fs.readFileSync(DATA_FILE, 'utf-8'));
        return;
      }
    } catch (e) {}
    res.json({ hasSavedState: false });
  });

  // Trigger manual or automated GitHub sync to iyidebaa.ge
  app.post('/api/sync-github', async (_req, res) => {
    const result = await syncIndexHtmlToGithub('Sync index.html to iyidebaa.ge from AI Studio');
    res.json(result);
  });

  const SALES_FILE = path.join(UPLOADS_DIR, 'sales-notifications.json');
  const VISITORS_FILE = path.join(UPLOADS_DIR, 'visitors-stats.json');
  const PRODUCT_STATS_FILE = path.join(UPLOADS_DIR, 'product-analytics.json');

  function loadLocalVisitorsStats(): any {
    try {
      if (fs.existsSync(VISITORS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(VISITORS_FILE, 'utf-8'));
        if (parsed && Array.isArray(parsed.visitors)) return parsed;
      }
    } catch (e) {}
    return { totalPageViews: 0, visitors: [] };
  }
  function saveLocalVisitorsStats(stats: any) {
    try {
      fs.writeFileSync(VISITORS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (e) {}
  }

  function loadLocalProductStats(): any {
    try {
      if (fs.existsSync(PRODUCT_STATS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(PRODUCT_STATS_FILE, 'utf-8'));
        if (parsed && typeof parsed === 'object' && parsed.products) return parsed;
      }
    } catch (e) {}
    return { products: {}, updatedAt: new Date().toISOString() };
  }
  function saveLocalProductStats(stats: any) {
    try {
      stats.updatedAt = new Date().toISOString();
      fs.writeFileSync(PRODUCT_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (e) {}
  }

  function recordProductViewInStats(productId: string, productName = '') {
    if (!productId) return loadLocalProductStats();
    const allStats = loadLocalProductStats();
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
    saveLocalProductStats(allStats);
    return allStats;
  }

  function recordProductSaleInStats(productId: string, mode = 'card', count = 1, amount = 0, productName = '') {
    if (!productId) return loadLocalProductStats();
    const allStats = loadLocalProductStats();
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
    const cleanMode = String(mode).toLowerCase() === 'installment' ? 'installment' : 'card';

    if (cleanMode === 'installment') {
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
    saveLocalProductStats(allStats);
    return allStats;
  }

  function resetProductStats(productId: string) {
    if (!productId) return loadLocalProductStats();
    const allStats = loadLocalProductStats();
    if (allStats.products && allStats.products[productId]) {
      delete allStats.products[productId];
      saveLocalProductStats(allStats);
    }
    return allStats;
  }

  function loadLocalSalesList(): any[] {
    try {
      if (fs.existsSync(SALES_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(SALES_FILE, 'utf-8'));
        if (Array.isArray(parsed.sales)) return parsed.sales;
      }
    } catch (e) {}
    return [];
  }
  function saveLocalSalesList(sales: any[]) {
    try {
      fs.writeFileSync(SALES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), sales: sales.slice(0, 100) }, null, 2), 'utf-8');
    } catch (e) {}
  }

  async function recordServerApprovedSale(saleObj: any) {
    const list = loadLocalSalesList();
    const cleanOrderId = String(saleObj.orderId || '').trim();
    const incomingStatus = String(saleObj.status || 'approved').toLowerCase().trim();

    const existingIdx = cleanOrderId ? list.findIndex((s) => s.orderId === cleanOrderId) : -1;
    let targetEntry: any = null;

    if (existingIdx !== -1) {
      const existing = list[existingIdx];
      if (existing.status === 'approved' && incomingStatus === 'started') {
        return list;
      }
      existing.status = incomingStatus;
      existing.updatedAt = new Date().toISOString();
      existing.unread = true;
      if (saleObj.customerPhone) existing.customerPhone = saleObj.customerPhone;
      if (saleObj.customerName) existing.customerName = saleObj.customerName;
      if (saleObj.rejectReason) existing.rejectReason = saleObj.rejectReason;
      targetEntry = existing;
      saveLocalSalesList(list);
    } else {
      targetEntry = {
        id: saleObj.id || `sale_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        orderId: cleanOrderId,
        bank: saleObj.bank || 'bog',
        mode: saleObj.mode || 'installment',
        status: incomingStatus,
        rejectReason: saleObj.rejectReason || '',
        productName: saleObj.productName || 'პროდუქტი — iyidebaa.ge',
        productId: saleObj.productId || '',
        amount: Number(saleObj.amount) || 0,
        months: Number(saleObj.months) || 0,
        monthly: saleObj.monthly || '',
        customerPhone: saleObj.customerPhone || '',
        customerName: saleObj.customerName || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        unread: true,
      };
      list.unshift(targetEntry);
      saveLocalSalesList(list);
    }

    if (incomingStatus === 'approved' && targetEntry.productId) {
      try {
        recordProductSaleInStats(
          targetEntry.productId,
          targetEntry.mode || 'installment',
          1,
          targetEntry.amount || 0,
          targetEntry.productName || ''
        );
      } catch (e) {}
    }

    // Post approved or rejected event directly into Seller Chat Inbox so Gocha gets a chat alert
    if (incomingStatus === 'approved' || incomingStatus === 'rejected') {
      try {
        const chatData = loadChatData();
        const sessId = 'bank_sales_alerts';
        const nowIso = new Date().toISOString();
        if (!chatData.conversations[sessId]) {
          chatData.conversations[sessId] = {
            sessionId: sessId,
            customerName: '🏦 ბანკის განვადება / სტატისტიკა',
            customerPhone: targetEntry.customerPhone || '',
            lastProductId: targetEntry.productId || '',
            lastProductName: targetEntry.productName || '',
            updatedAt: nowIso,
            unreadForSeller: 0,
            unreadForCustomer: 0,
            messages: [],
          };
        }
        const conv = chatData.conversations[sessId];
        if (targetEntry.customerPhone) conv.customerPhone = targetEntry.customerPhone;
        conv.lastProductName = targetEntry.productName;
        conv.updatedAt = nowIso;
        conv.unreadForSeller = (conv.unreadForSeller || 0) + 1;
        const bankLabel = targetEntry.bank === 'credo' ? 'კრედო ბანკი' : 'საქართველოს ბანკი';
        const statusHeadline =
          incomingStatus === 'rejected'
            ? '❌ განვადებაზე უარი მოვიდა ბანკისგან'
            : targetEntry.mode === 'installment'
            ? '🎉 განვადება დამტკიცდა'
            : '💳 ბარათით გადახდა შესრულდა';
        conv.messages.push({
          id: `msg_${Date.now()}`,
          sender: 'customer',
          senderName: `🏦 ${bankLabel}`,
          text: `${statusHeadline}!\n📦 ნივთი: ${targetEntry.productName}\n💰 თანხა: ${targetEntry.amount} ₾${targetEntry.months ? ` (${targetEntry.months} თვე)` : ''}${targetEntry.customerPhone ? `\n📞 მყიდველის ტელეფონი: ${targetEntry.customerPhone}` : ''}`,
          createdAt: nowIso,
        });
        saveChatData(chatData);
      } catch (e) {}
    }

    return list;
  }

  // Official Unified Bank Gateway (Bank of Georgia + Credo Bank Installment + Universal Card Checkout)
  const handleBankGateway = async (req: express.Request, res: express.Response, defaultBank = 'bog') => {
    try {
      if (req.method === 'GET') {
        res.json({ ok: true, sales: loadLocalSalesList() });
        return;
      }

      const body = req.body || {};
      const query: any = req.query || {};

      if (body.action === 'record_visitor') {
        const stats = loadLocalVisitorsStats();
        const visitors: any[] = Array.isArray(stats.visitors) ? stats.visitors : [];
        const visitorId = String(body.visitorId || `v_${Date.now()}`).trim();
        const countryCode = String(body.countryCode || 'GE').toUpperCase().trim();
        const countryName = String(body.countryName || (countryCode === 'GE' ? 'საქართველო' : countryCode)).trim();
        const regionName = String(body.regionName || '').trim();
        const cityName = String(body.cityName || '').trim();
        const deviceType = String(body.deviceType || 'mobile').trim();
        const currentPage = String(body.currentPage || 'მთავარი გვერდი').trim();
        const nowIso = new Date().toISOString();

        stats.totalPageViews = (Number(stats.totalPageViews) || 0) + 1;
        const existingIdx = visitors.findIndex((v) => v.visitorId === visitorId);
        if (existingIdx !== -1) {
          const ex = visitors[existingIdx];
          ex.lastSeenAt = nowIso;
          ex.visitsCount = (Number(ex.visitsCount) || 1) + 1;
          if (countryCode) ex.countryCode = countryCode;
          if (countryName) ex.countryName = countryName;
          if (regionName) ex.regionName = regionName;
          if (cityName) ex.cityName = cityName;
          if (currentPage) ex.currentPage = currentPage;
          visitors.splice(existingIdx, 1);
          visitors.unshift(ex);
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
        saveLocalVisitorsStats(stats);
        res.json({ ok: true, stats });
        return;
      }

      if (body.action === 'get_visitor_stats') {
        res.json({ ok: true, stats: loadLocalVisitorsStats() });
        return;
      }

      if (body.action === 'clear_visitor_stats') {
        const emptyStats = { totalPageViews: 0, visitors: [], updatedAt: new Date().toISOString() };
        saveLocalVisitorsStats(emptyStats);
        res.json({ ok: true, stats: emptyStats });
        return;
      }

      if (body.action === 'record_product_view') {
        const stats = recordProductViewInStats(body.productId, body.productName);
        res.json({ ok: true, stats });
        return;
      }

      if (body.action === 'get_product_analytics') {
        res.json({ ok: true, stats: loadLocalProductStats() });
        return;
      }

      if (body.action === 'record_product_sale_manual') {
        const stats = recordProductSaleInStats(
          body.productId,
          body.mode || 'card',
          body.count || 1,
          body.amount || 0,
          body.productName || ''
        );
        res.json({ ok: true, stats });
        return;
      }

      if (body.action === 'reset_product_stats') {
        const stats = resetProductStats(body.productId);
        res.json({ ok: true, stats });
        return;
      }

      if (body.event === 'order_payment' && body.body) {
        const bogBody = body.body;
        const statusKey = String(bogBody?.order_status?.key || '').toLowerCase().trim();
        const transferMethod = bogBody?.payment_detail?.transfer_method?.key || '';
        const isLoan = transferMethod === 'BOG_LOAN' || query.mode === 'installment';
        const basketItem = bogBody?.purchase_units?.items?.[0] || {};
        let mappedStatus = '';
        if (statusKey === 'completed' || statusKey === 'approved' || statusKey === 'success') {
          mappedStatus = 'approved';
        } else if (
          statusKey === 'rejected' ||
          statusKey === 'failed' ||
          statusKey === 'declined' ||
          statusKey === 'cancelled' ||
          statusKey === 'error'
        ) {
          mappedStatus = 'rejected';
        }
        if (mappedStatus) {
          await recordServerApprovedSale({
            orderId: bogBody.external_order_id || bogBody.order_id || query.orderId || '',
            bank: 'bog',
            mode: isLoan ? 'installment' : 'card',
            status: mappedStatus,
            rejectReason: bogBody.reject_reason || bogBody?.order_status?.value || '',
            productName: query.prodName || basketItem.description || 'პროდუქტი — iyidebaa.ge',
            productId: query.prodId || basketItem.package_code || '',
            amount: Number(query.amount) || Number(bogBody?.purchase_units?.request_amount) || 0,
            months: Number(query.months) || 0,
            monthly: query.monthly || '',
            customerPhone: query.phone || bogBody?.buyer?.phone_number || '',
            customerName: bogBody?.buyer?.full_name || '',
          });
        }
        res.json({ ok: true });
        return;
      }

      if (body.action === 'get_sales_notifications') {
        res.json({ ok: true, sales: loadLocalSalesList() });
        return;
      }

      if (body.action === 'mark_sales_read') {
        const updated = loadLocalSalesList().map((s) => ({ ...s, unread: false }));
        saveLocalSalesList(updated);
        res.json({ ok: true, sales: updated });
        return;
      }

      if (body.action === 'delete_sale_notification') {
        const targetId = String(body.saleId || '').trim();
        const updated = loadLocalSalesList().filter((s) => s.id !== targetId);
        saveLocalSalesList(updated);
        res.json({ ok: true, sales: updated });
        return;
      }

      if (body.action === 'update_sale_tracking') {
        const targetId = String(body.saleId || '').trim();
        const code = String(body.diloTrackingCode || body.trackingCode || '').trim();
        const updated = loadLocalSalesList().map((s) => {
          if (s.id === targetId || s.orderId === targetId) {
            return { ...s, diloTrackingCode: code, updatedAt: new Date().toISOString() };
          }
          return s;
        });
        saveLocalSalesList(updated);
        res.json({ ok: true, sales: updated });
        return;
      }

      // =========================================================================
      // DILO DELIVERY PARTNER API (https://dilo.ge)
      // =========================================================================
      if (body.action === 'dilo_cities') {
        try {
          if (cachedDiloCities && Date.now() - cachedDiloCitiesAt < 3600000) {
            res.json({ ok: true, cities: cachedDiloCities });
            return;
          }
          const r = await fetch('https://dilo.ge/api/cities', {
            headers: { Accept: 'application/json' },
          });
          if (!r.ok) {
            res.status(r.status).json({ ok: false, error: 'ვერ ჩაიტვირთა ქალაქების სია Dilo.ge-დან' });
            return;
          }
          const cities = await r.json();
          cachedDiloCities = Array.isArray(cities) ? cities : [];
          cachedDiloCitiesAt = Date.now();
          res.json({ ok: true, cities: cachedDiloCities });
        } catch (err: any) {
          res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (body.action === 'dilo_districts') {
        try {
          const cityId = String(body.cityId || '').trim();
          if (!cityId) {
            res.status(400).json({ ok: false, error: 'cityId აუცილებელია' });
            return;
          }
          if (cachedDiloDistricts.has(cityId)) {
            res.json({ ok: true, districts: cachedDiloDistricts.get(cityId) });
            return;
          }
          const r = await fetch(`https://dilo.ge/api/cities/${encodeURIComponent(cityId)}/districts`, {
            headers: { Accept: 'application/json' },
          });
          if (!r.ok) {
            res.status(r.status).json({ ok: false, error: 'ვერ ჩაიტვირთა უბნების/სოფლების სია' });
            return;
          }
          const districts = await r.json();
          const arr = Array.isArray(districts) ? districts : [];
          cachedDiloDistricts.set(cityId, arr);
          res.json({ ok: true, districts: arr });
        } catch (err: any) {
          res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (body.action === 'dilo_track_order') {
        try {
          const apiKey = getDiloApiKey();
          const rawQuery = String(body.query || body.trackingNumber || '').trim();
          if (!rawQuery) {
            res.status(400).json({ ok: false, error: 'შეიყვანეთ თრექინგ კოდი ან ტელეფონის ნომერი' });
            return;
          }
          const cleanRef = rawQuery.replace(/\s+/g, '');
          const directRes = await fetch(`https://dilo.ge/api/partner/orders/${encodeURIComponent(cleanRef)}`, {
            headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
          });
          if (directRes.ok) {
            const orderObj = await directRes.json();
            res.json({ ok: true, order: orderObj, items: [orderObj] });
            return;
          }
          const searchRes = await fetch(
            `https://dilo.ge/api/partner/orders?search=${encodeURIComponent(rawQuery)}&page=1&pageSize=20`,
            {
              headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
            }
          );
          if (searchRes.ok) {
            const searchData: any = await searchRes.json();
            const items = Array.isArray(searchData.items) ? searchData.items : [];
            if (items.length > 0) {
              let detailedFirst = items[0];
              try {
                const detRes = await fetch(
                  `https://dilo.ge/api/partner/orders/${encodeURIComponent(items[0].trackingNumber)}`,
                  { headers: { Accept: 'application/json', 'X-Api-Key': apiKey } }
                );
                if (detRes.ok) detailedFirst = await detRes.json();
              } catch (e) {}
              res.json({ ok: true, order: detailedFirst, items });
              return;
            }
          }
          res.status(404).json({
            ok: false,
            error: 'ამ კოდით ან ნომრით ამანათი Dilo.ge-ს ბაზაში ვერ მოიძებნა',
          });
        } catch (err: any) {
          res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (body.action === 'dilo_list_orders') {
        try {
          const apiKey = getDiloApiKey();
          const status = String(body.status || '').trim();
          const search = String(body.search || '').trim();
          const page = Math.max(1, Number(body.page) || 1);
          const pageSize = Math.min(200, Math.max(1, Number(body.pageSize) || 50));
          const qs = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
          });
          if (status) qs.set('status', status);
          if (search) qs.set('search', search);

          const r = await fetch(`https://dilo.ge/api/partner/orders?${qs.toString()}`, {
            headers: { Accept: 'application/json', 'X-Api-Key': apiKey },
          });
          if (!r.ok) {
            const errTxt = await r.text();
            res.status(r.status).json({ ok: false, error: errTxt || 'Dilo API შეცდომა' });
            return;
          }
          const data: any = await r.json();
          res.json({
            ok: true,
            total: data.total || 0,
            page: data.page || 1,
            pageSize: data.pageSize || pageSize,
            items: Array.isArray(data.items) ? data.items : [],
          });
        } catch (err: any) {
          res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (body.action === 'dilo_create_order') {
        try {
          const apiKey = getDiloApiKey();
          const recipientName = String(body.recipientName || '').trim();
          const recipientPhone = String(body.recipientPhone || '').replace(/\s+/g, '').trim();
          const recipientCity = String(body.recipientCity || 'თბილისი').trim();
          const recipientDistrict = String(body.recipientDistrict || '').trim();
          const recipientAddress = String(body.recipientAddress || '').trim();
          const description = String(body.description || '').trim();
          const isFragile = Boolean(body.isFragile);
          const productPaymentStatus = body.productPaymentStatus === 'Paid' ? 'Paid' : 'NotPaid';
          const whoPaysForCompanyService = body.whoPaysForCompanyService === 'Sender' ? 'Sender' : 'Recipient';
          const amountToCollectForPackage =
            productPaymentStatus === 'NotPaid' ? Math.max(0, Number(body.amountToCollectForPackage) || 0) : 0;
          const externalReference = String(body.externalReference || `IYIDEBAA-${Date.now()}`).trim();
          const note = String(body.note || '').trim();

          if (!recipientName || !recipientPhone || !recipientCity || !recipientAddress) {
            res.status(422).json({
              ok: false,
              error: 'გთხოვთ შეავსოთ: მიმღების სახელი, ტელეფონი, ქალაქი და მისამართი',
            });
            return;
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

          const r = await fetch('https://dilo.ge/api/partner/orders', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'X-Api-Key': apiKey,
            },
            body: JSON.stringify(payload),
          });

          const resData: any = await r.json().catch(() => ({}));
          if (!r.ok) {
            let errMsg = resData.title || resData.message || resData.error || 'შეკვეთის გაგზავნა ვერ მოხერხდა';
            if (resData.errors && typeof resData.errors === 'object') {
              const details = Object.values(resData.errors).flat().join('; ');
              if (details) errMsg += `: ${details}`;
            }
            res.status(r.status).json({ ok: false, error: errMsg, details: resData });
            return;
          }

          const createdOrder = Array.isArray(resData.orders) && resData.orders[0] ? resData.orders[0] : null;
          const trackingNumber = createdOrder ? createdOrder.trackingNumber : '';

          let updatedSales = null;
          if (body.saleId && trackingNumber) {
            const targetId = String(body.saleId).trim();
            updatedSales = loadLocalSalesList().map((s) => {
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
            saveLocalSalesList(updatedSales);
          }

          res.status(201).json({
            ok: true,
            groupOrderId: resData.groupOrderId || '',
            trackingNumber,
            order: createdOrder,
            sales: updatedSales,
          });
        } catch (err: any) {
          res.status(500).json({ ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (body.action === 'clear_all_sales_notifications') {
        saveLocalSalesList([]);
        res.json({ ok: true, sales: [] });
        return;
      }

      if (body.action === 'record_approved_sale' || body.action === 'record_sale_event') {
        const sales = await recordServerApprovedSale(body);
        res.json({ ok: true, sales });
        return;
      }

      const bank = String(body.bank || defaultBank).toLowerCase().trim();
      const productName = String(body.productName || 'პროდუქტი — iyidebaa.ge').trim();
      const productId = String(body.productId || '101').replace(/[^a-zA-Z0-9_-]/g, '') || '101';
      const amountGel = Math.max(1, Number(body.amount) || 1);
      const originUrl = String(body.originUrl || 'https://iyidebaa.ge').replace(/\/+$/, '');
      const customerPhone = String(body.customerPhone || '').trim();

      if (bank === 'credo') {
        const merchantId = String(body.merchantId || body.clientId || process.env.CREDO_MERCHANT_ID || '125694').trim();
        const password = String(body.password || body.clientSecret || process.env.CREDO_SECRET || '6NL7UJ0jM)3]').trim();
        const orderCode = `iyidebaa_${Date.now()}`;
        const priceInTetri = String(Math.round(amountGel * 100));

        const prodItem = {
          id: productId,
          title: productName,
          amount: '1',
          price: priceInTetri,
          type: '0',
        };

        const rawHashStr = `${prodItem.id}${prodItem.title}${prodItem.amount}${prodItem.price}${prodItem.type}${password}`;
        const checkHash = crypto.createHash('md5').update(rawHashStr, 'utf8').digest('hex');

        const credoRes = await fetch('https://ganvadeba.credo.ge/widget_api/order.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            merchantId,
            orderCode,
            check: checkHash,
            products: [prodItem],
          }),
        });

        const credoData: any = await credoRes.json();
        const redirectUrl = credoData?.data?.URL;

        if (!credoRes.ok || !redirectUrl) {
          res.status(400).json({
            ok: false,
            error: 'კრედო ბანკის განვადების ბმულის შექმნა ვერ მოხერხდა.',
            details: credoData,
          });
          return;
        }

        await recordServerApprovedSale({
          orderId: credoData?.data?.OrderHash || orderCode,
          bank: 'credo',
          mode: 'installment',
          status: 'started',
          productName,
          productId,
          amount: amountGel,
          months: 12,
          customerPhone,
        });

        res.json({
          ok: true,
          bank: 'credo',
          orderId: credoData?.data?.OrderHash || orderCode,
          redirectUrl,
        });
        return;
      }

      const clientId = String(body.clientId || process.env.BOG_CLIENT_ID || '10000576').trim();
      const clientSecret = String(body.clientSecret || process.env.BOG_SECRET_KEY || '0RAMGYvStUiE').trim();

      if (body.action === 'calculate_installment' || bank === 'bog_calc') {
        const calcRes = await fetch('https://api.bog.ge/payments/v1/ecommerce/installment/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json;charset=UTF-8' },
          body: JSON.stringify({ client_id: clientId, amount: amountGel }),
        });
        const calcData: any = await calcRes.json();
        res.json({
          ok: true,
          discounts: calcData?.discounts || [],
        });
        return;
      }

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenRes = await fetch(
        'https://oauth2.bog.ge/auth/realms/bog/protocol/openid-connect/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
          },
          body: 'grant_type=client_credentials',
        }
      );

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        res.status(401).json({
          ok: false,
          error: 'საქართველოს ბანკის ავტორიზაცია ვერ მოხერხდა (შეამოწმეთ Client ID და Secret Key).',
          details: errText,
        });
        return;
      }

      const tokenData: any = await tokenRes.json();
      const accessToken = tokenData.access_token;

      const isInstallmentMode =
        body.mode === 'installment' ||
        bank === 'bog_installment' ||
        bank === 'bog-inst';
      const chosenMonths = Math.min(48, Math.max(3, Number(body.month || body.months) || 3));
      const extOrderId = `iyidebaa_${Date.now()}`;

      const metaQuery =
        `mode=${isInstallmentMode ? 'installment' : 'card'}` +
        `&bank=bog` +
        `&orderId=${encodeURIComponent(extOrderId)}` +
        `&prodId=${encodeURIComponent(productId)}` +
        `&prodName=${encodeURIComponent(productName)}` +
        `&amount=${encodeURIComponent(String(amountGel))}` +
        `&months=${encodeURIComponent(String(isInstallmentMode ? chosenMonths : 0))}` +
        `&phone=${encodeURIComponent(customerPhone)}`;

      const orderPayload: Record<string, any> = {
        callback_url: `${originUrl}/api/bog-pay?notify=1&${metaQuery}`,
        external_order_id: extOrderId,
        ...(isInstallmentMode
          ? {
              payment_method: ['bog_loan'],
              config: {
                loan: {
                  type: String(body.discountCode || 'STANDARD').trim() || 'STANDARD',
                  month: chosenMonths,
                },
              },
            }
          : {}),
        purchase_units: {
          currency: 'GEL',
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

      const orderRes = await fetch('https://api.bog.ge/payments/v1/ecommerce/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': 'ka',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(orderPayload),
      });

      const orderData: any = await orderRes.json();
      const redirectHref = orderData?._links?.redirect?.href;

      if (!orderRes.ok || !redirectHref) {
        res.status(400).json({
          ok: false,
          error: 'საქართველოს ბანკის შეკვეთის შექმნა ვერ მოხერხდა.',
          details: orderData,
        });
        return;
      }

      if (isInstallmentMode) {
        await recordServerApprovedSale({
          orderId: extOrderId,
          bank: 'bog',
          mode: 'installment',
          status: 'started',
          productName,
          productId,
          amount: amountGel,
          months: chosenMonths,
          customerPhone,
        });
      }

      res.json({
        ok: true,
        bank: 'bog',
        mode: isInstallmentMode ? 'installment' : 'card',
        orderId: extOrderId,
        bogOrderId: orderData.id,
        redirectUrl: redirectHref,
      });
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        error: err?.message || 'Server error',
      });
    }
  };

  app.get('/api/bog-pay', (req, res) => handleBankGateway(req, res, 'bog'));
  app.post('/api/bog-pay', (req, res) => handleBankGateway(req, res, 'bog'));
  app.post('/api/credo-pay', (req, res) => handleBankGateway(req, res, 'credo'));

  function getHtmlWithBakedState(rawHtml: string): string {
    try {
      recoverOrphanUploadedPhotos();
      const map = loadImagesMap();
      if (fs.existsSync(DATA_FILE)) {
        const storeJson = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(storeJson);
        if (parsed && parsed.hasSavedState) {
          if (Array.isArray(parsed.productsList)) {
            parsed.productsList = applyImagesMapToProducts(parsed.productsList, map);
          }
          parsed.imagesMap = map;
          return rawHtml.replace(
            /<script id="baked-store-state" type="application\/json">[\s\S]*?<\/script>/,
            `<script id="baked-store-state" type="application/json">${JSON.stringify(parsed)}</script>`
          );
        }
      } else if (Object.keys(map).length > 0) {
        const baked = { hasSavedState: true, imagesMap: map };
        return rawHtml.replace(
          /<script id="baked-store-state" type="application\/json">[\s\S]*?<\/script>/,
          `<script id="baked-store-state" type="application/json">${JSON.stringify(baked)}</script>`
        );
      }
    } catch (err) {
      console.error('Error injecting store state into HTML:', err);
    }
    return rawHtml;
  }

  // Serve public static assets directly
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  // Fast HTML handler for single-file application
  const serveAppHtml = (_req: express.Request, res: express.Response) => {
    try {
      const distIndex = path.join(__dirname, 'dist', 'index.html');
      const htmlPath =
        process.env.NODE_ENV === 'production' && fs.existsSync(distIndex)
          ? distIndex
          : INDEX_HTML_FILE;
      let template = fs.readFileSync(htmlPath, 'utf-8');
      template = getHtmlWithBakedState(template);
      res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(template);
    } catch (err) {
      res.sendFile(INDEX_HTML_FILE);
    }
  };

  app.get('/', serveAppHtml);
  app.get('/index.html', serveAppHtml);

  // Bind port 3000 immediately so healthchecks never time out
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    pullGithubStoreDataToLocal();
    syncIndexHtmlToGithub('Auto-sync index.html from AI Studio');

    // Automatically push any edits made to index.html directly to iyidebaa.ge (gochaiaseshvili-gif/saiti)
    fs.watchFile(INDEX_HTML_FILE, { interval: 1500 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        syncIndexHtmlToGithub('Auto-sync index.html changes from AI Studio to iyidebaa.ge');
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'custom',
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.warn('Vite middleware skipped:', e);
    }
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath, { index: false }));
  }

  app.get('*', (req, res, next) => {
    const url = req.originalUrl;
    if (
      url.startsWith('/api') ||
      url.startsWith('/uploads') ||
      url.startsWith('/ws-chat') ||
      url.includes('.')
    ) {
      return next();
    }
    serveAppHtml(req, res);
  });
}

startServer();
