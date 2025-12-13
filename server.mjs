import express from "express";
import multer from "multer";
import path from "path";
import { GoogleGenAI } from "@google/genai";

const app = express();
const upload = multer();

const port = process.env.PORT || 3000;
const defaultApiKey = process.env.GEMINI_API_KEY;

const MODEL_NAME = "gemini-2.5-flash";

const IMAGE_SYSTEM_PROMPT = `
You are a medical data assistant for kidney disease patients.
Your task is to extract medical examination data from images and convert it into a structured JSON object.

Output Rules:
1. Return ONLY a valid JSON object.
2. The JSON must match this structure exactly:
{
  "title": "String, usually '复查记录'",
  "date": Number (timestamp in milliseconds),
  "hospital": "String, extracted or 'Unknown'",
  "doctor": "String or empty",
  "notes": "String summary",
  "configName": "String (e.g. '肾功能常规', '血常规')",
  "items": [
    {
      "id": "String (use standard codes like 'scr', 'egfr', 'bun', 'ua', 'urine_pro', etc.)",
      "name": "String",
      "value": "String (numbers only usually)",
      "unit": "String",
      "range": "String",
      "categoryName": "String"
    }
  ]
}
3. For dates: Convert to Javascript Timestamp.
`;

const cleanJsonString = (text) => {
  if (!text) return "{}";
  let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }
  return clean;
};

const createClient = (req) => {
  const headerKey = req.header("x-gemini-api-key");
  const keyToUse = headerKey || defaultApiKey;
  if (!keyToUse) {
    throw new Error("NO_API_KEY");
  }
  return new GoogleGenAI({ apiKey: keyToUse });
};

app.use(express.json({ limit: "5mb" }));

app.post("/api/analyze/image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "file is required" });
    }

    const base64Data = req.file.buffer.toString("base64");

    const client = createClient(req);

    const response = await client.models.generateContent({
      model: MODEL_NAME,
      contents: {
        parts: [
          { inlineData: { mimeType: req.file.mimetype, data: base64Data } },
          { text: "Extract medical data." },
        ],
      },
      config: {
        systemInstruction: IMAGE_SYSTEM_PROMPT,
        responseMimeType: "application/json",
      },
    });

    const data = JSON.parse(cleanJsonString(response.text || "{}"));
    return res.json(data);
  } catch (err) {
    console.error("Image analyze error:", err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("429") || message.includes("Resource has been exhausted")) {
      return res.status(429).json({
        error: "RATE_LIMIT",
        message,
      });
    }
    if (message === "NO_API_KEY") {
      return res.status(400).json({
        error: "NO_API_KEY",
        message: "No Gemini API key provided",
      });
    }
    return res.status(500).json({
      error: "IMAGE_ANALYZE_FAILED",
      message,
    });
  }
});

app.post("/api/analyze/excel-header", async (req, res) => {
  try {
    const { headers } = req.body || {};
    if (!Array.isArray(headers) || headers.length === 0) {
      return res.status(400).json({ error: "headers array is required" });
    }

    const prompt = `
    I have an Excel header row:
    ${JSON.stringify(headers)}

    Task:
    1. Identify the column index for "Date" (looking for '日期', 'Date', 'Time' etc).
    2. Map other medical columns to standard IDs.

    Return JSON:
    {
      "dateColumnIndex": Number,
      "mappings": [
        { "columnIndex": Number, "id": "String (e.g. scr, egfr, bun, ua)", "name": "String (Original Name)", "category": "String (e.g. 肾功能)" }
      ]
    }
    `;

    const client = createClient(req);

    const response = await client.models.generateContent({
      model: MODEL_NAME,
      contents: { parts: [{ text: prompt }] },
      config: { responseMimeType: "application/json" },
    });

    const mapData = JSON.parse(cleanJsonString(response.text || "{}"));
    return res.json(mapData);
  } catch (err) {
    console.error("Excel header analyze error:", err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("429") || message.includes("Resource has been exhausted")) {
      return res.status(429).json({
        error: "RATE_LIMIT",
        message,
      });
    }
    if (message === "NO_API_KEY") {
      return res.status(400).json({
        error: "NO_API_KEY",
        message: "No Gemini API key provided",
      });
    }
    return res.status(500).json({
      error: "EXCEL_HEADER_ANALYZE_FAILED",
      message,
    });
  }
});

// Lightweight health check (useful for verifying Express is running)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "v1",
    port,
    hasEnvKey: !!defaultApiKey,
  });
});

app.use(express.static("dist"));

app.get("*", (req, res) => {
  const indexPath = path.join(process.cwd(), "dist", "index.html");
  res.sendFile(indexPath);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

