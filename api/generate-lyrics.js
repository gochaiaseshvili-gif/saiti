import { GoogleGenAI } from "@google/genai";

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = parseBody(req);
    const topic = String(body.topic || "").trim();
    const vocal = String(body.vocal || "ქალი").trim();
    const genre = String(body.genre || "პოპი").trim();

    if (!topic) {
      return res.status(400).json({
        ok: false,
        error: "გთხოვთ, შეიყვანოთ სიმღერის მოკლე თემა.",
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "GEMINI_API_KEY არ არის კონფიგურირებული სერვერზე.",
      });
    }

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `დაწერე თანამედროვე, მელოდიური და რიტმული სიმღერის ტექსტი ქართულ ენაზე.
თემა: ${topic}
ვოკალი: ${vocal}
ჟანრი / არანჟირება: ${genre}

მოთხოვნები:
- ტექსტი უნდა იყოს მარტივად სამღერი, ემოციური და ბუნებრივი ქართულით.
- გამოიყენე სტრუქტურა: [კუპლეტი 1], [მისამღერი], [კუპლეტი 2], [მისამღერი], [დასასრული].
- ზომა იყოს კომპაქტური (დაახლოებით 12-18 სტრიქონი), რომ იდეალურად მოერგოს AI მუსიკის გენერატორს.
- დააბრუნე მხოლოდ სიმღერის ტექსტი ზედმეტი შესავლისა და კომენტარების გარეშე.`;

    const candidateModels = [
      "gemini-2.5-flash",
      "gemini-flash-latest",
      "gemini-2.0-flash",
    ];

    let generatedLyrics = "";
    let lastError = null;

    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
        });
        const text = String(response?.text || "").trim();
        if (text) {
          generatedLyrics = text;
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!generatedLyrics) {
      return res.status(500).json({
        ok: false,
        error:
          (lastError && lastError.message) ||
          "ტექსტის გენერირება ვერ მოხერხდა, სცადეთ თავიდან.",
      });
    }

    return res.status(200).json({
      ok: true,
      lyrics: generatedLyrics,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: (err && err.message) || "Server error",
    });
  }
}
