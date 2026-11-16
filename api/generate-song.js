function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

const VOCAL_STYLE_MAP = {
  "ქალი": "female vocals",
  "კაცი": "male vocals",
  "ორივე ერთად (დუეტი)": "male and female duet vocals",
};

const GENRE_STYLE_MAP = {
  "პოპი": "modern pop, upbeat, catchy melody, studio quality",
  "ლირიკული / აკუსტიკური": "lyrical acoustic, emotional, warm guitar and piano",
  "ჰიპ-ჰოპი / რეპი": "hip-hop, rap, modern beat, rhythmic flow",
  "როკი": "rock, electric guitar, energetic drums, powerful",
  "სადღესასწაულო": "festive, celebratory, joyful party vibe, upbeat",
};

function extractAudioUrl(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.audio_url === "string" && payload.audio_url) return payload.audio_url;
  if (typeof payload.audioUrl === "string" && payload.audioUrl) return payload.audioUrl;
  if (typeof payload.url === "string" && payload.url.includes(".mp3")) return payload.url;

  const listCandidates = [
    payload.data,
    payload.clips,
    payload.songs,
    payload.tracks,
    payload.data && payload.data.data,
    payload.data && payload.data.clips,
  ];

  for (const list of listCandidates) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object") {
          const found = item.audio_url || item.audioUrl || item.song_url || item.url;
          if (typeof found === "string" && found.startsWith("http")) {
            return found;
          }
        }
      }
    }
  }
  return "";
}

function extractTaskId(payload) {
  if (!payload || typeof payload !== "object") return "";
  return String(
    payload.task_id ||
      payload.taskId ||
      payload.job_id ||
      payload.jobId ||
      (payload.data && (payload.data.task_id || payload.data.taskId || payload.data.id)) ||
      payload.id ||
      ""
  ).trim();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const musicApiKey = String(process.env.MUSIC_API_KEY || "").trim();
  if (!musicApiKey) {
    return res.status(500).json({
      ok: false,
      error: "MUSIC_API_KEY არ არის კონფიგურირებული სერვერზე.",
    });
  }

  const createEndpoint =
    String(process.env.MUSIC_API_URL || "").trim() ||
    "https://api.musicapi.ai/api/v1/sonic/create";
  const statusBaseEndpoint =
    String(process.env.MUSIC_API_STATUS_URL || "").trim() ||
    "https://api.musicapi.ai/api/v1/sonic/task";

  // GET: Poll async task status by taskId
  if (req.method === "GET") {
    const taskId = String((req.query && req.query.taskId) || "").trim();
    if (!taskId) {
      return res.status(400).json({ ok: false, error: "taskId აუცილებელია." });
    }
    try {
      const statusUrl = statusBaseEndpoint.includes("{taskId}")
        ? statusBaseEndpoint.replace("{taskId}", encodeURIComponent(taskId))
        : `${statusBaseEndpoint.replace(/\/$/, "")}/${encodeURIComponent(taskId)}`;

      const pollRes = await fetch(statusUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${musicApiKey}`,
          Accept: "application/json",
        },
      });
      const pollData = await pollRes.json().catch(() => ({}));
      const audioUrl = extractAudioUrl(pollData);

      if (audioUrl) {
        return res.status(200).json({
          ok: true,
          pending: false,
          audioUrl,
          title: (pollData && pollData.title) || "AI სიმღერა — iyidebaa.ge",
        });
      }

      const stateStr = String(
        pollData?.status || pollData?.state || pollData?.data?.[0]?.state || ""
      ).toLowerCase();
      if (stateStr === "failed" || stateStr === "error") {
        return res.status(500).json({
          ok: false,
          error: pollData?.error || pollData?.message || "სიმღერის გენერირება ვერ დასრულდა.",
        });
      }

      return res.status(200).json({
        ok: true,
        pending: true,
        taskId,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: (err && err.message) || "სტატუსის შემოწმების შეცდომა.",
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    const lyrics = String(body.lyrics || "").trim();
    const vocal = String(body.vocal || "ქალი").trim();
    const genre = String(body.genre || "პოპი").trim();
    const orderId = String(body.orderId || "").trim();

    if (!lyrics) {
      return res.status(400).json({
        ok: false,
        error: "სიმღერის ტექსტი ცარიელია.",
      });
    }

    if (!orderId) {
      return res.status(402).json({
        ok: false,
        error: "საჭიროა 2 ₾ გადახდის დადასტურება.",
      });
    }

    const vocalTag = VOCAL_STYLE_MAP[vocal] || "female vocals";
    const genreTag = GENRE_STYLE_MAP[genre] || "modern pop, studio quality";
    const tags = `${genreTag}, ${vocalTag}, georgian language`;

    const apiPayload = {
      custom_mode: true,
      prompt: lyrics,
      lyrics,
      tags,
      style: tags,
      vocal,
      genre,
      title: `iyidebaa.ge - ${genre}`,
      make_instrumental: false,
      mv: "sonic-v4",
    };

    const apiRes = await fetch(createEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${musicApiKey}`,
      },
      body: JSON.stringify(apiPayload),
    });

    const apiData = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      return res.status(apiRes.status >= 400 ? apiRes.status : 500).json({
        ok: false,
        error:
          (apiData && (apiData.error || apiData.message)) ||
          "მუსიკის გენერირების სერვისმა დააბრუნა შეცდომა.",
      });
    }

    const immediateAudioUrl = extractAudioUrl(apiData);
    if (immediateAudioUrl) {
      return res.status(200).json({
        ok: true,
        pending: false,
        audioUrl: immediateAudioUrl,
        orderId,
      });
    }

    const taskId = extractTaskId(apiData);
    if (taskId) {
      return res.status(200).json({
        ok: true,
        pending: true,
        taskId,
        orderId,
      });
    }

    return res.status(500).json({
      ok: false,
      error: "აუდიო ფაილის ან დავალების ID-ის მიღება ვერ მოხერხდა.",
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: (err && err.message) || "Server error",
    });
  }
}
