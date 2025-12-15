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

// ========== API 调用次数统计 ==========
let apiCallStats = {
  imageAnalyze: 0,      // 图片识别（multipart）
  imageBase64Analyze: 0, // 图片识别（base64）
  excelAnalyze: 0,      // Excel表头分析
  totalCalls: 0,        // 总调用次数
  startTime: Date.now() // 服务启动时间
};

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
1. Return ONLY a valid JSON object, no extra text.
2. The JSON must match this structure EXACTLY:
{
  "title": "检查报告标题",
  "date": "YYYY-MM-DD格式的日期字符串",
  "hospital": "医院名称",
  "doctor": "医生姓名（如无则留空字符串）",
  "notes": "备注信息（如无则留空字符串）",
  "items": [
    {
      "name": "检查项名称",
      "value": "检测值（字符串）",
      "unit": "单位",
      "range": "参考范围"
    }
  ]
}

IMPORTANT:
- date MUST be a STRING in format "YYYY-MM-DD" (e.g. "2025-12-15"), NOT a timestamp number
- items array should only contain: name, value, unit, range
- Do NOT add fields like "id", "categoryName", "configName"
- Extract ALL test items from the image
`;

// 使用括号计数找到 JSON 对象的正确结束位置
const findJsonEnd = (text, startIndex) => {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1; // 没找到匹配的闭合括号
};

const cleanJsonString = (text) => {
  if (!text) return "{}";

  // 移除 markdown 代码块标记
  let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();

  // 找到第一个 {
  const firstBrace = clean.indexOf("{");

  if (firstBrace === -1) {
    console.error("[cleanJsonString] No opening brace found in:", clean.substring(0, 200));
    return "{}";
  }

  // 使用括号计数找到正确的 JSON 结束位置
  const lastBrace = findJsonEnd(clean, firstBrace);

  if (lastBrace === -1) {
    console.error("[cleanJsonString] No matching closing brace found");
    // 尝试用 lastIndexOf 作为降级方案
    const fallbackBrace = clean.lastIndexOf("}");
    if (fallbackBrace > firstBrace) {
      clean = clean.substring(firstBrace, fallbackBrace + 1);
    } else {
      return "{}";
    }
  } else {
    // 提取正确的 JSON 部分
    clean = clean.substring(firstBrace, lastBrace + 1);
  }

  // 尝试修复常见问题
  // 1. 移除可能的 BOM
  clean = clean.replace(/^\uFEFF/, '');
  // 2. 移除控制字符（除了换行和制表符）
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // 3. 确保没有尾部逗号（JSON 不支持）
  clean = clean.replace(/,(\s*[}\]])/g, '$1');

  return clean;
};

// 安全的 JSON 解析，带降级处理
const safeJsonParse = (text, context = "") => {
  const cleaned = cleanJsonString(text);

  console.log(`[safeJsonParse] ${context} - cleaned length: ${cleaned.length}`);

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    console.error(`[safeJsonParse] First parse failed for ${context}:`, firstError.message);
    console.error(`[safeJsonParse] Cleaned text (first 500 chars):`, cleaned.substring(0, 500));
    console.error(`[safeJsonParse] Cleaned text (last 100 chars):`, cleaned.substring(cleaned.length - 100));

    // 尝试更激进的清洗
    try {
      // 移除所有换行符，重新格式化
      const aggressive = cleaned
        .replace(/\n/g, ' ')
        .replace(/\r/g, '')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ');

      return JSON.parse(aggressive);
    } catch (secondError) {
      console.error(`[safeJsonParse] Aggressive parse also failed:`, secondError.message);

      // 返回一个错误对象而不是抛出异常
      return {
        error: "JSON_PARSE_FAILED",
        parseError: firstError.message,
        rawTextPreview: text ? text.substring(0, 300) : "(empty)"
      };
    }
  }
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

    const data = safeJsonParse(response.text, "image-multipart");

    // 检查是否解析失败
    if (data.error === "JSON_PARSE_FAILED") {
      console.error("[image] JSON parse failed, raw preview:", data.rawTextPreview);
      return res.status(500).json({
        error: "JSON_PARSE_FAILED",
        message: "Failed to parse Gemini response",
        detail: data.parseError
      });
    }

    // 统计成功调用
    apiCallStats.imageAnalyze++;
    apiCallStats.totalCalls++;

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

    const data = safeJsonParse(response.text, "image-base64");

    // 检查是否解析失败
    if (data.error === "JSON_PARSE_FAILED") {
      console.error("[image-base64] JSON parse failed, raw preview:", data.rawTextPreview);
      return res.status(500).json({
        error: "JSON_PARSE_FAILED",
        message: "Failed to parse Gemini response",
        detail: data.parseError
      });
    }

    // 统计成功调用
    apiCallStats.imageBase64Analyze++;
    apiCallStats.totalCalls++;

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

    const mapData = safeJsonParse(response.text, "excel-header");

    // 检查是否解析失败
    if (mapData.error === "JSON_PARSE_FAILED") {
      console.error("[excel] JSON parse failed, raw preview:", mapData.rawTextPreview);
      return res.status(500).json({
        error: "JSON_PARSE_FAILED",
        message: "Failed to parse Gemini response",
        detail: mapData.parseError
      });
    }

    // 统计成功调用
    apiCallStats.excelAnalyze++;
    apiCallStats.totalCalls++;

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
// API 端点：获取调用统计
// ===========================================
app.get("/api/stats", (req, res) => {
  const uptimeMs = Date.now() - apiCallStats.startTime;
  const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
  const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

  res.json({
    success: true,
    stats: {
      imageAnalyze: apiCallStats.imageAnalyze,
      imageBase64Analyze: apiCallStats.imageBase64Analyze,
      excelAnalyze: apiCallStats.excelAnalyze,
      totalCalls: apiCallStats.totalCalls,
      uptime: {
        hours: uptimeHours,
        minutes: uptimeMinutes,
        display: `${uptimeHours}小时${uptimeMinutes}分钟`
      },
      startTime: apiCallStats.startTime
    }
  });
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

// 兼容性处理：
// 1. Zeabur/本地开发：直接运行 node server.mjs，process.env.VERCEL 为空，执行 app.listen 启动端口监听
// 2. Vercel：作为 Serverless 函数被导入，process.env.VERCEL 为 true，跳过 app.listen，由 Vercel 托管
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(
      `Environment API Keys configured: ${ENV_API_KEYS.length > 0 ? ENV_API_KEYS.length : "None (will use request header)"}`
    );
  });
}

export default app;
