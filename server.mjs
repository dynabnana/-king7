import express from "express";
import multer from "multer";
import path from "path";

// 延迟加载 GoogleGenAI 以减少空闲内存
let GoogleGenAI = null;
const loadGenAI = async () => {
  if (!GoogleGenAI) {
    const module = await import("@google/genai");
    GoogleGenAI = module.GoogleGenAI;
  }
  return GoogleGenAI;
};

const app = express();
// 使用内存存储但限制文件大小，处理完立即释放
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 降低到 5MB 限制
  storage: multer.memoryStorage()
});

const port = process.env.PORT || 3000;

// 从环境变量读取 API Keys（支持多个，用逗号分隔）
const ENV_API_KEYS = (process.env.GEMINI_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

let currentKeyIndex = 0;

const MODEL_NAME = "gemini-2.5-flash";

// 客户端缓存（按需创建，空闲时清理）
let clientCache = new Map();
let lastRequestTime = Date.now();

// ========== 并发控制 ==========
// 限制同时处理的请求数，防止内存飙升
const MAX_CONCURRENT_REQUESTS = 2; // 最多同时处理2个请求
let activeRequests = 0;
const requestQueue = [];

const acquireSlot = () => {
  return new Promise((resolve) => {
    if (activeRequests < MAX_CONCURRENT_REQUESTS) {
      activeRequests++;
      resolve();
    } else {
      requestQueue.push(resolve);
    }
  });
};

const releaseSlot = () => {
  activeRequests--;
  if (requestQueue.length > 0) {
    const next = requestQueue.shift();
    activeRequests++;
    next();
  }
};

// 定期清理空闲资源（每5分钟检查一次）
setInterval(() => {
  const idleTime = Date.now() - lastRequestTime;
  // 如果空闲超过3分钟，清理客户端缓存
  if (idleTime > 3 * 60 * 1000 && clientCache.size > 0) {
    clientCache.clear();
    // 建议 V8 进行垃圾回收（如果可用）
    if (global.gc) {
      global.gc();
    }
    console.log(`[Memory] Cleared client cache after ${Math.round(idleTime / 1000)}s idle`);
  }
}, 5 * 60 * 1000);

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

// 获取 API Key（优先使用环境变量，其次使用请求头）
const getApiKey = (req) => {
  // 如果有环境变量配置的 Key，使用轮换策略
  if (ENV_API_KEYS.length > 0) {
    const key = ENV_API_KEYS[currentKeyIndex % ENV_API_KEYS.length];
    currentKeyIndex++;
    return key;
  }
  // 否则尝试从请求头获取
  const headerKey = req.header("x-gemini-api-key");
  if (headerKey) {
    return headerKey;
  }
  return null;
};

const createClient = async (apiKey) => {
  if (!apiKey) {
    throw new Error("NO_API_KEY");
  }

  // 更新最后请求时间
  lastRequestTime = Date.now();

  // 检查缓存
  if (clientCache.has(apiKey)) {
    return clientCache.get(apiKey);
  }

  // 延迟加载 SDK
  const GenAI = await loadGenAI();
  const client = new GenAI({ apiKey });

  // 缓存客户端（只缓存环境变量的 key，避免缓存用户传入的 key）
  if (ENV_API_KEYS.includes(apiKey)) {
    clientCache.set(apiKey, client);
  }

  return client;
};

// CORS 中间件 - 支持小程序跨域请求
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-gemini-api-key"
  );

  // 处理 OPTIONS 预检请求
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

// ===========================================
// API 端点：图片识别 - 用于网页端（支持 multipart/form-data）
// ===========================================
app.post("/api/analyze/image", upload.single("file"), async (req, res) => {
  // 获取并发槽位（限制同时处理的请求数）
  await acquireSlot();

  try {
    if (!req.file) {
      return res.status(400).json({ error: "file is required" });
    }

    const base64Data = req.file.buffer.toString("base64");
    const apiKey = getApiKey(req);
    const client = await createClient(apiKey);

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
    if (
      message.includes("429") ||
      message.includes("Resource has been exhausted")
    ) {
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
  } finally {
    // 无论成功失败都要释放槽位
    releaseSlot();
  }
});

// ===========================================
// API 端点：图片识别 - 用于小程序（支持 base64 JSON）
// ===========================================
app.post("/api/analyze/image-base64", async (req, res) => {
  // 获取并发槽位（限制同时处理的请求数）
  await acquireSlot();

  try {
    const { base64, mimeType } = req.body || {};
    if (!base64) {
      return res.status(400).json({ error: "base64 is required" });
    }

    // 移除可能的 data URL 前缀
    let cleanBase64 = base64;
    if (base64.includes(",")) {
      cleanBase64 = base64.split(",")[1];
    }

    const apiKey = getApiKey(req);
    const client = await createClient(apiKey);

    const response = await client.models.generateContent({
      model: MODEL_NAME,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || "image/jpeg",
              data: cleanBase64,
            },
          },
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
    console.error("Image base64 analyze error:", err);
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("429") ||
      message.includes("Resource has been exhausted")
    ) {
      return res.status(429).json({
        error: "RATE_LIMIT",
        message,
      });
    }
    if (message === "NO_API_KEY") {
      return res.status(400).json({
        error: "NO_API_KEY",
        message: "No Gemini API key configured on server",
      });
    }
    return res.status(500).json({
      error: "IMAGE_ANALYZE_FAILED",
      message,
    });
  } finally {
    // 无论成功失败都要释放槽位
    releaseSlot();
  }
});

// ===========================================
// API 端点：Excel 表头分析
// ===========================================
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

    const apiKey = getApiKey(req);
    const client = await createClient(apiKey);

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
    if (
      message.includes("429") ||
      message.includes("Resource has been exhausted")
    ) {
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

// ===========================================
// 健康检查端点（含内存和并发监控）
// ===========================================
app.get("/api/health", (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    ok: true,
    version: "v4-concurrent-limited",
    port,
    hasEnvKey: ENV_API_KEYS.length > 0,
    keyCount: ENV_API_KEYS.length,
    timestamp: Date.now(),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100, // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100, // MB
      rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100, // MB
      external: Math.round(memUsage.external / 1024 / 1024 * 100) / 100, // MB
    },
    concurrency: {
      maxConcurrent: MAX_CONCURRENT_REQUESTS,
      activeRequests: activeRequests,
      queuedRequests: requestQueue.length
    },
    cache: {
      clientsCached: clientCache.size,
      sdkLoaded: GoogleGenAI !== null,
      lastRequestAge: Math.round((Date.now() - lastRequestTime) / 1000) // seconds ago
    }
  });
});

// ===========================================
// 静态文件服务（生产环境）
// ===========================================
app.use(express.static("dist"));

app.get("*", (req, res) => {
  const indexPath = path.join(process.cwd(), "dist", "index.html");
  res.sendFile(indexPath);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  console.log(
    `Environment API Keys configured: ${ENV_API_KEYS.length > 0 ? ENV_API_KEYS.length : "None (will use request header)"}`
  );
});
