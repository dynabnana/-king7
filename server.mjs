import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

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

// 管理后台密码（可通过环境变量覆盖）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "600606";

// 数据存储目录（Zeabur 挂载硬盘路径）
const DATA_DIR = process.env.DATA_DIR || "/data";
const USAGE_LOG_FILE = path.join(DATA_DIR, "usage_logs.json");

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

// ========== 用户使用记录系统 ==========
// 内存中的使用记录缓存
let usageLogs = [];
let userStats = new Map(); // 用户累计次数统计

// 初始化数据目录和加载历史记录
const initDataStorage = () => {
  try {
    // 检查数据目录是否存在
    if (!fs.existsSync(DATA_DIR)) {
      console.log(`[Storage] Data directory ${DATA_DIR} does not exist, using memory only`);
      return;
    }

    // 尝试加载历史记录
    if (fs.existsSync(USAGE_LOG_FILE)) {
      const data = fs.readFileSync(USAGE_LOG_FILE, "utf-8");
      const parsed = JSON.parse(data);
      usageLogs = parsed.logs || [];

      // 重建用户统计
      usageLogs.forEach(log => {
        const key = log.nickname || log.userId || "anonymous";
        userStats.set(key, (userStats.get(key) || 0) + 1);
      });

      console.log(`[Storage] Loaded ${usageLogs.length} usage logs from disk`);
    }
  } catch (err) {
    console.error("[Storage] Failed to load usage logs:", err.message);
  }
};

// 保存使用记录到磁盘
const saveUsageLogs = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      return; // 目录不存在，跳过保存
    }

    const data = JSON.stringify({
      lastUpdated: new Date().toISOString(),
      totalLogs: usageLogs.length,
      logs: usageLogs
    }, null, 2);

    fs.writeFileSync(USAGE_LOG_FILE, data, "utf-8");
  } catch (err) {
    console.error("[Storage] Failed to save usage logs:", err.message);
  }
};

// ========== IP 地理位置查询 ==========
// 使用 PConline 免费 API 查询 IP 归属地（省+市+区）
const ipLocationCache = new Map(); // 缓存 IP 位置，避免重复查询

const getIpLocation = async (ip) => {
  // 检查缓存
  if (ipLocationCache.has(ip)) {
    return ipLocationCache.get(ip);
  }

  // 过滤本地/内网 IP
  if (!ip || ip === 'unknown' || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return { province: '本地网络', city: '', district: '', location: '本地网络' };
  }

  try {
    // 使用 PConline IP 查询 API
    const response = await fetch(`http://whois.pconline.com.cn/ipJson.jsp?ip=${ip}&json=true`, {
      timeout: 3000 // 3秒超时
    });

    if (!response.ok) {
      throw new Error('API request failed');
    }

    const text = await response.text();
    // PConline 返回的是 GBK 编码的 JSON，需要处理
    // 响应格式: {"ip":"x.x.x.x","pro":"省份","proCode":"xxx","city":"城市","cityCode":"xxx","region":"区县","regionCode":"xxx","addr":"完整地址","regionNames":"","err":""}
    const data = JSON.parse(text);

    const result = {
      province: data.pro || '',
      city: data.city || '',
      district: data.region || '',
      location: [data.pro, data.city, data.region].filter(Boolean).join(' ') || data.addr || ip
    };

    // 缓存结果（最多缓存100个，节省内存）
    if (ipLocationCache.size > 100) {
      const firstKey = ipLocationCache.keys().next().value;
      ipLocationCache.delete(firstKey);
    }
    ipLocationCache.set(ip, result);

    return result;
  } catch (err) {
    console.error(`[IP Location] Failed to get location for ${ip}:`, err.message);
    // 降级返回 IP
    return { province: '', city: '', district: '', location: ip };
  }
};

// 记录用户使用（带 IP 地理位置）
const logUserUsage = async (req, apiType, extra = {}) => {
  const { nickname, userId } = req.body || {};

  // 获取用户IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress
    || "unknown";

  // 获取 IP 地理位置（异步但不阻塞主流程）
  let locationInfo = { province: '', city: '', district: '', location: ip };
  try {
    locationInfo = await getIpLocation(ip);
  } catch (e) {
    // 忽略错误，使用默认值
  }

  const userKey = nickname || userId || ip;
  const count = (userStats.get(userKey) || 0) + 1;
  userStats.set(userKey, count);

  const logEntry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    nickname: nickname || null,
    userId: userId || null,
    ip: ip,
    ipLocation: locationInfo, // 新增：IP 地理位置信息（省+市+区）
    apiType: apiType,
    cumulativeCount: count,
    ...extra
  };

  usageLogs.push(logEntry);

  // 限制内存中的记录数量（保留最近100条，节省内存）
  if (usageLogs.length > 100) {
    usageLogs = usageLogs.slice(-100);
  }

  // 异步保存到磁盘
  setImmediate(saveUsageLogs);

  console.log(`[Usage] ${nickname || userId || "匿名"} (${locationInfo.location || ip}) - ${apiType} - 第${count}次使用`);

  return logEntry;
};

// 初始化存储
initDataStorage();

// ========== 用户配额与兑换码系统（纯 Redis 模式）==========
// Upstash Redis 配置（从环境变量读取）
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_REDIS = UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN;

// 本地文件存储（Redis 不可用时的降级方案）
const QUOTA_FILE = path.join(DATA_DIR, "user_quotas.json");

// Redis 数据过期时间（21 天）
const REDIS_DATA_TTL = 21 * 24 * 60 * 60;

// Redis 操作辅助函数
const redisCommand = async (command, ...args) => {
  if (!USE_REDIS) return null;

  try {
    const response = await fetch(`${UPSTASH_REDIS_REST_URL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([command, ...args])
    });

    if (!response.ok) {
      throw new Error(`Redis request failed: ${response.status}`);
    }

    const data = await response.json();
    return data.result;
  } catch (err) {
    console.error(`[Redis] Command ${command} failed:`, err.message);
    return null;
  }
};

// 工具函数：获取当前周标识 (e.g. "2025-W51")
const getCurrentWeekId = () => {
  const now = new Date();
  const onejan = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil((((now - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
};

// ===== 纯 Redis 读写函数（不使用内存缓存）=====

// 获取所有用户配额数据
const getQuotaUsers = async () => {
  if (USE_REDIS) {
    try {
      const data = await redisCommand('GET', 'quota:users');
      return data ? JSON.parse(data) : {};
    } catch (err) {
      console.error("[Redis] Failed to get users:", err.message);
    }
  }
  // 降级到本地文件
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8"));
      return data.users || {};
    }
  } catch (err) { }
  return {};
};

// 保存用户配额数据
const saveQuotaUsers = async (users) => {
  if (USE_REDIS) {
    try {
      await redisCommand('SETEX', 'quota:users', REDIS_DATA_TTL, JSON.stringify(users));
      return;
    } catch (err) {
      console.error("[Redis] Failed to save users:", err.message);
    }
  }
  // 降级到本地文件
  try {
    if (fs.existsSync(DATA_DIR)) {
      const existing = fs.existsSync(QUOTA_FILE) ? JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) : {};
      existing.users = users;
      fs.writeFileSync(QUOTA_FILE, JSON.stringify(existing, null, 2), "utf-8");
    }
  } catch (err) { }
};

// 获取所有兑换码数据
const getQuotaCodes = async () => {
  if (USE_REDIS) {
    try {
      const data = await redisCommand('GET', 'quota:codes');
      return data ? JSON.parse(data) : {};
    } catch (err) {
      console.error("[Redis] Failed to get codes:", err.message);
    }
  }
  // 降级到本地文件
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8"));
      return data.codes || {};
    }
  } catch (err) { }
  return {};
};

// 保存兑换码数据
const saveQuotaCodes = async (codes) => {
  if (USE_REDIS) {
    try {
      await redisCommand('SETEX', 'quota:codes', REDIS_DATA_TTL, JSON.stringify(codes));
      return;
    } catch (err) {
      console.error("[Redis] Failed to save codes:", err.message);
    }
  }
  // 降级到本地文件
  try {
    if (fs.existsSync(DATA_DIR)) {
      const existing = fs.existsSync(QUOTA_FILE) ? JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) : {};
      existing.codes = codes;
      fs.writeFileSync(QUOTA_FILE, JSON.stringify(existing, null, 2), "utf-8");
    }
  } catch (err) { }
};

// 初始化日志
(async () => {
  if (USE_REDIS) {
    const [users, codes] = await Promise.all([getQuotaUsers(), getQuotaCodes()]);
    console.log(`[Redis] Connected - ${Object.keys(users).length} users, ${Object.keys(codes).length} codes`);
    console.log("[Redis] Pure Redis mode enabled - no memory cache for quota data");
  } else {
    console.log("[Quota] Using local file storage (Redis not configured)");
  }
})();

// 检查并扣除配额（纯 Redis 模式）
// 返回: { allowed: boolean, reason: string, remaining: number, isUnlimited: boolean }
const checkAndConsumeQuota = async (userId, nickname) => {
  if (!userId) {
    // 如果没有用户ID，暂时允许
    return { allowed: true, reason: "anonymous", remaining: 1, isUnlimited: false };
  }

  // 从 Redis 获取所有用户数据
  const users = await getQuotaUsers();

  // 初始化用户数据
  if (!users[userId]) {
    users[userId] = {
      weeklyUsage: 0,
      currentWeek: getCurrentWeekId(),
      extraQuota: 0,
      isUnlimited: false,
      nickname: nickname || "未命名"
    };
  }

  const user = users[userId];

  // 更新昵称
  if (nickname) user.nickname = nickname;

  // 检查是否无限额度
  if (user.isUnlimited) {
    return { allowed: true, reason: "unlimited", remaining: 9999, isUnlimited: true };
  }

  // 检查周重置
  const thisWeek = getCurrentWeekId();
  if (user.currentWeek !== thisWeek) {
    user.currentWeek = thisWeek;
    user.weeklyUsage = 0;
  }

  // 1. 检查周免费额度 (每周5次)
  if (user.weeklyUsage < 5) {
    user.weeklyUsage++;
    await saveQuotaUsers(users);
    return { allowed: true, reason: "weekly_free", remaining: 5 - user.weeklyUsage, isUnlimited: false };
  }

  // 2. 检查额外额度 (兑换码)
  if (user.extraQuota > 0) {
    user.extraQuota--;
    await saveQuotaUsers(users);
    return { allowed: true, reason: "extra_quota", remaining: user.extraQuota, isUnlimited: false };
  }

  return { allowed: false, reason: "quota_exceeded", remaining: 0, isUnlimited: false };
};

// ========== API 调用次数统计（Redis 持久化）==========
let apiCallStats = {
  imageAnalyze: 0,      // 图片识别（multipart）
  imageBase64Analyze: 0, // 图片识别（base64）
  excelAnalyze: 0,      // Excel表头分析
  totalCalls: 0,        // 总调用次数
  startTime: Date.now() // 服务启动时间
};

// 从 Redis 加载调用统计
const loadApiStats = async () => {
  if (!USE_REDIS) return;

  try {
    const statsData = await redisCommand('GET', 'api:stats');
    if (statsData) {
      const saved = JSON.parse(statsData);
      // 合并已保存的统计数据，保留当前启动时间
      apiCallStats.imageAnalyze = saved.imageAnalyze || 0;
      apiCallStats.imageBase64Analyze = saved.imageBase64Analyze || 0;
      apiCallStats.excelAnalyze = saved.excelAnalyze || 0;
      apiCallStats.totalCalls = saved.totalCalls || 0;
      console.log(`[Redis] Loaded API stats: ${apiCallStats.totalCalls} total calls`);
    }
  } catch (err) {
    console.error("[Redis] Failed to load API stats:", err.message);
  }
};

// 保存调用统计到 Redis
const saveApiStats = async () => {
  if (!USE_REDIS) return;

  try {
    await redisCommand('SETEX', 'api:stats', REDIS_DATA_TTL, JSON.stringify({
      imageAnalyze: apiCallStats.imageAnalyze,
      imageBase64Analyze: apiCallStats.imageBase64Analyze,
      excelAnalyze: apiCallStats.excelAnalyze,
      totalCalls: apiCallStats.totalCalls,
      lastUpdated: new Date().toISOString()
    }));
  } catch (err) {
    console.error("[Redis] Failed to save API stats:", err.message);
  }
};

// 增加调用统计并保存
const incrementApiStats = async (type) => {
  if (type === 'image') {
    apiCallStats.imageAnalyze++;
  } else if (type === 'image-base64') {
    apiCallStats.imageBase64Analyze++;
  } else if (type === 'excel') {
    apiCallStats.excelAnalyze++;
  }
  apiCallStats.totalCalls++;

  // 异步保存到 Redis（不阻塞主流程）
  setImmediate(() => saveApiStats());
};

// 初始化时加载统计数据
(async () => {
  await loadApiStats();
})();

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

    // 统计成功调用（保存到 Redis）
    incrementApiStats('image');

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
    const { base64, mimeType, userId, nickname } = req.body || {};

    // ----- 配额检查 START -----
    // 优先使用 userId，如果没有则尝试用 IP (不推荐，小程序应传 userId/openid)
    const userIdentifier = userId || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "anonymous_user";

    const quotaResult = await checkAndConsumeQuota(userIdentifier, nickname);
    if (!quotaResult.allowed) {
      return res.status(403).json({
        error: "QUOTA_EXCEEDED",
        message: "本周免费额度已用完，请联系管理员获取兑换码。",
        quota: quotaResult
      });
    }
    // ----- 配额检查 END -----

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

    // 统计成功调用（保存到 Redis）
    incrementApiStats('image-base64');

    // 记录用户使用（小程序端需要传递 nickname 字段）
    logUserUsage(req, "image-base64", {
      itemsCount: data.items?.length || 0,
      title: data.title || null
    });

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

    // 统计成功调用（保存到 Redis）
    incrementApiStats('excel');

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
// 管理后台 API - 密码验证
// ===========================================
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};

  if (password === ADMIN_PASSWORD) {
    res.json({
      success: true,
      message: "登录成功",
      // 返回一个简单的 token（基于时间戳，24小时有效）
      token: Buffer.from(`admin:${Date.now()}`).toString("base64")
    });
  } else {
    res.status(401).json({
      success: false,
      message: "密码错误"
    });
  }
});

// 验证管理员 token 中间件
const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "未授权访问" });
  }

  try {
    const token = authHeader.substring(7);
    const decoded = Buffer.from(token, "base64").toString("utf-8");
    const [prefix, timestamp] = decoded.split(":");

    if (prefix !== "admin") {
      return res.status(401).json({ success: false, message: "无效的令牌" });
    }

    // 检查 token 是否过期（24小时）
    const tokenAge = Date.now() - parseInt(timestamp);
    if (tokenAge > 24 * 60 * 60 * 1000) {
      return res.status(401).json({ success: false, message: "令牌已过期，请重新登录" });
    }

    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "令牌验证失败" });
  }
};

// ===========================================
// 管理后台 API - 获取使用记录
// ===========================================
app.get("/api/admin/usage-logs", verifyAdminToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;

  // 按时间倒序排列
  const sortedLogs = [...usageLogs].reverse();

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedLogs = sortedLogs.slice(start, end);

  res.json({
    success: true,
    data: {
      logs: paginatedLogs,
      pagination: {
        page,
        pageSize,
        total: usageLogs.length,
        totalPages: Math.ceil(usageLogs.length / pageSize)
      }
    }
  });
});

// ===========================================
// 管理后台 API - 获取用户统计汇总
// ===========================================
app.get("/api/admin/user-stats", verifyAdminToken, (req, res) => {
  // 按用户汇总统计
  const userSummary = [];
  const userLastSeen = new Map();

  // 遍历所有记录，获取每个用户的最后使用时间
  usageLogs.forEach(log => {
    const key = log.nickname || log.userId || log.ip;
    userLastSeen.set(key, log.timestamp);
  });

  // 构建汇总数据
  userStats.forEach((count, userKey) => {
    userSummary.push({
      user: userKey,
      totalCalls: count,
      lastSeen: userLastSeen.get(userKey) || null
    });
  });

  // 按调用次数倒序
  userSummary.sort((a, b) => b.totalCalls - a.totalCalls);

  res.json({
    success: true,
    data: {
      totalUsers: userSummary.length,
      totalCalls: usageLogs.length,
      users: userSummary
    }
  });
});

// ===========================================
// 管理后台 API - 清除记录（谨慎使用）
// ===========================================
app.delete("/api/admin/usage-logs", verifyAdminToken, (req, res) => {
  const previousCount = usageLogs.length;
  usageLogs = [];
  userStats.clear();
  saveUsageLogs();

  res.json({
    success: true,
    message: `已清除 ${previousCount} 条记录`
  });
});

// ===========================================
// 配额管理 API (Admin & User)
// ===========================================

// [Admin] 生成兑换码（纯 Redis 模式）
app.post("/api/admin/codes/generate", verifyAdminToken, async (req, res) => {
  const { amount, count } = req.body;
  const quotaAmount = parseInt(amount) || 10;
  const generateCount = parseInt(count) || 1;

  // 从 Redis 获取现有兑换码
  const codes = await getQuotaCodes();

  const newCodes = [];
  for (let i = 0; i < generateCount; i++) {
    const code = "PRO-" + Math.random().toString(36).substr(2, 6).toUpperCase() + Math.random().toString(36).substr(2, 2).toUpperCase();
    codes[code] = {
      quota: quotaAmount,
      createTime: Date.now(),
      type: 'quota'
    };
    newCodes.push(code);
  }

  await saveQuotaCodes(codes);

  res.json({
    success: true,
    data: { codes: newCodes, quota: quotaAmount }
  });
});

// [Admin] 生成无限畅享兑换码（纯 Redis 模式）
app.post("/api/admin/codes/generate-unlimited", verifyAdminToken, async (req, res) => {
  const { count, remark } = req.body;
  const generateCount = parseInt(count) || 1;

  // 从 Redis 获取现有兑换码
  const codes = await getQuotaCodes();

  const newCodes = [];
  for (let i = 0; i < generateCount; i++) {
    const timestamp = Date.now().toString().slice(-4);
    const random = Math.floor(Math.random() * 100).toString().padStart(2, '0');
    const code = `dzwdsg${timestamp}${random}`;

    codes[code] = {
      quota: -1,
      createTime: Date.now(),
      type: 'unlimited',
      remark: remark || ''
    };
    newCodes.push(code);
  }

  await saveQuotaCodes(codes);

  res.json({
    success: true,
    data: { codes: newCodes, type: 'unlimited' },
    message: `成功生成 ${newCodes.length} 个无限畅享兑换码`
  });
});

// [Admin] 获取所有兑换码（纯 Redis 模式）
app.get("/api/admin/codes", verifyAdminToken, async (req, res) => {
  const codes = await getQuotaCodes();
  res.json({
    success: true,
    data: codes
  });
});

// [Admin] 删除兑换码（纯 Redis 模式）
app.delete("/api/admin/codes/:code", verifyAdminToken, async (req, res) => {
  const { code } = req.params;
  const codes = await getQuotaCodes();

  if (!codes[code]) {
    return res.status(404).json({ success: false, message: "兑换码不存在" });
  }

  delete codes[code];
  await saveQuotaCodes(codes);

  res.json({
    success: true,
    message: `兑换码 ${code} 已删除`
  });
});

// [Admin] 更新兑换码备注（纯 Redis 模式）
app.put("/api/admin/codes/:code/remark", verifyAdminToken, async (req, res) => {
  const { code } = req.params;
  const { remark } = req.body;
  const codes = await getQuotaCodes();

  if (!codes[code]) {
    return res.status(404).json({ success: false, message: "兑换码不存在" });
  }

  codes[code].remark = remark || '';
  await saveQuotaCodes(codes);

  res.json({
    success: true,
    message: "备注已更新",
    data: codes[code]
  });
});

// [Admin] 获取用户配额列表（纯 Redis 模式）
app.get("/api/admin/quota/users", verifyAdminToken, async (req, res) => {
  const users = await getQuotaUsers();
  const userList = Object.entries(users).map(([id, data]) => ({
    id,
    ...data
  }));
  res.json({ success: true, data: userList });
});

// [Admin] 设置用户无限额度（纯 Redis 模式）
app.post("/api/admin/users/unlimited", verifyAdminToken, async (req, res) => {
  const { userId, isUnlimited } = req.body;
  const users = await getQuotaUsers();

  if (!userId || !users[userId]) {
    return res.status(404).json({ success: false, message: "用户不存在或未初始化" });
  }

  users[userId].isUnlimited = !!isUnlimited;
  await saveQuotaUsers(users);

  res.json({ success: true, data: users[userId] });
});

// [User] 兑换额度（纯 Redis 模式）
app.post("/api/user/redeem", async (req, res) => {
  const { code, userId, nickname } = req.body;

  if (!code || !userId) {
    return res.status(400).json({ success: false, message: "缺少参数" });
  }

  const cleanCode = code.trim().toUpperCase();

  // 从 Redis 获取数据
  const [codes, users] = await Promise.all([getQuotaCodes(), getQuotaUsers()]);

  if (!codes[cleanCode]) {
    return res.status(404).json({ success: false, message: "无效的兑换码" });
  }

  const codeData = codes[cleanCode];

  // 初始化用户如果不存在
  if (!users[userId]) {
    users[userId] = {
      weeklyUsage: 0,
      currentWeek: getCurrentWeekId(),
      extraQuota: 0,
      isUnlimited: false,
      nickname: nickname || "未命名"
    };
  }

  // 判断兑换码类型
  if (codeData.type === 'unlimited' || codeData.quota === -1) {
    // 无限畅享兑换码
    users[userId].isUnlimited = true;
    delete codes[cleanCode];

    await Promise.all([saveQuotaCodes(codes), saveQuotaUsers(users)]);

    res.json({
      success: true,
      message: "🎉 恭喜！您已成功兑换无限畅享权益，现在可以无限使用识别功能了！",
      data: {
        isUnlimited: true,
        totalExtra: users[userId].extraQuota || 0
      }
    });
  } else {
    // 普通额度兑换码
    users[userId].extraQuota = (users[userId].extraQuota || 0) + codeData.quota;
    delete codes[cleanCode];

    await Promise.all([saveQuotaCodes(codes), saveQuotaUsers(users)]);

    res.json({
      success: true,
      message: `兑换成功！增加了 ${codeData.quota} 次额度`,
      data: {
        isUnlimited: false,
        totalExtra: users[userId].extraQuota
      }
    });
  }
});

// [User] 查询配额状态（纯 Redis 模式）
app.get("/api/user/quota", async (req, res) => {
  const { userId } = req.query;
  const users = await getQuotaUsers();

  if (!userId || !users[userId]) {
    return res.json({
      success: true,
      data: { weeklyUsage: 0, weeklyLimit: 5, extraQuota: 0, isUnlimited: false }
    });
  }

  const user = users[userId];
  const thisWeek = getCurrentWeekId();
  const weeklyUsage = (user.currentWeek === thisWeek) ? user.weeklyUsage : 0;

  res.json({
    success: true,
    data: {
      weeklyUsage: weeklyUsage,
      weeklyLimit: 5,
      extraQuota: user.extraQuota || 0,
      isUnlimited: user.isUnlimited || false
    }
  });
});

// ===========================================
// 静态文件服务（生产环境）
// ===========================================
app.use(express.static("dist"));

// 管理后台页面路由
app.get("/admin", (req, res) => {
  const adminPath = path.join(process.cwd(), "admin.html");
  res.sendFile(adminPath);
});

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
