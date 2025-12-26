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

// ========== 用户使用记录系统（Redis 优先，本地文件降级）==========
// 内存中的使用记录缓存（用于读取展示，实际数据存在 Redis）
let usageLogs = [];
let userStats = new Map(); // 用户累计次数统计
let usageLogsInitialized = false; // 标记是否已初始化
let initUsageLogsPromise = null; // 初始化锁，防止并发重复初始化

// Redis 使用记录相关常量
const USAGE_LOGS_REDIS_KEY = 'usage:logs';
const USAGE_STATS_REDIS_KEY = 'usage:stats';
const MAX_USAGE_LOGS = 500; // Redis 中最多保存 500 条日志

// 从 Redis 或本地文件加载使用记录（异步初始化，带锁防止并发）
const initUsageLogs = async () => {
  if (usageLogsInitialized) return;

  // 如果已有初始化任务在执行，等待它完成
  if (initUsageLogsPromise) return initUsageLogsPromise;

  initUsageLogsPromise = _doInitUsageLogs();
  return initUsageLogsPromise;
};

// 实际的初始化逻辑
const _doInitUsageLogs = async () => {

  // 先检查 Redis 配置是否可用（需要等待 Redis 配置加载）
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const canUseRedis = UPSTASH_URL && UPSTASH_TOKEN;

  if (canUseRedis) {
    try {
      // 从 Redis 加载使用记录
      const response = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['GET', USAGE_LOGS_REDIS_KEY])
      });

      if (response.ok) {
        const data = await response.json();
        if (data.result) {
          const parsed = JSON.parse(data.result);
          usageLogs = parsed.logs || [];

          // 重建用户统计
          usageLogs.forEach(log => {
            const key = log.nickname || log.userId || log.ip || "anonymous";
            userStats.set(key, (userStats.get(key) || 0) + 1);
          });

          console.log(`[Redis] Loaded ${usageLogs.length} usage logs from Redis`);
          usageLogsInitialized = true;
          return;
        }
      }
    } catch (err) {
      console.error("[Redis] Failed to load usage logs:", err.message);
    }
  }

  // 降级：从本地文件加载
  try {
    if (fs.existsSync(DATA_DIR) && fs.existsSync(USAGE_LOG_FILE)) {
      const data = fs.readFileSync(USAGE_LOG_FILE, "utf-8");
      const parsed = JSON.parse(data);
      usageLogs = parsed.logs || [];

      // 重建用户统计
      usageLogs.forEach(log => {
        const key = log.nickname || log.userId || log.ip || "anonymous";
        userStats.set(key, (userStats.get(key) || 0) + 1);
      });

      console.log(`[Storage] Loaded ${usageLogs.length} usage logs from disk (fallback)`);
    }
  } catch (err) {
    console.error("[Storage] Failed to load usage logs from disk:", err.message);
  }

  usageLogsInitialized = true;
  initUsageLogsPromise = null; // 清除锁
};

// 保存使用记录到 Redis（优先）和本地文件（备份）
const saveUsageLogs = async () => {
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const canUseRedis = UPSTASH_URL && UPSTASH_TOKEN;

  const dataToSave = JSON.stringify({
    lastUpdated: new Date().toISOString(),
    totalLogs: usageLogs.length,
    logs: usageLogs
  });

  // 优先保存到 Redis
  if (canUseRedis) {
    try {
      const response = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        // 使用 SETEX 设置 30 天过期时间
        body: JSON.stringify(['SETEX', USAGE_LOGS_REDIS_KEY, 30 * 24 * 60 * 60, dataToSave])
      });

      if (response.ok) {
        // Redis 保存成功，不需要本地备份
        return;
      }
    } catch (err) {
      console.error("[Redis] Failed to save usage logs:", err.message);
    }
  }

  // 降级：保存到本地文件
  try {
    if (fs.existsSync(DATA_DIR)) {
      fs.writeFileSync(USAGE_LOG_FILE, dataToSave, "utf-8");
    }
  } catch (err) {
    console.error("[Storage] Failed to save usage logs to disk:", err.message);
  }
};

// ========== IP 地理位置查询 ==========
// 使用 ip-api.com 免费 API 查询 IP 归属地（返回 UTF-8，无乱码问题）
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
    // 使用 ip-api.com 免费 API（返回 UTF-8 编码，每分钟限 45 次）
    // 响应格式: {"status":"success","country":"中国","regionName":"广东","city":"广州",...}
    const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,country,regionName,city,message`, {
      signal: AbortSignal.timeout(3000) // 3秒超时
    });

    if (!response.ok) {
      throw new Error('API request failed');
    }

    const data = await response.json();

    if (data.status !== 'success') {
      throw new Error(data.message || 'IP lookup failed');
    }

    const result = {
      province: data.regionName || '',
      city: data.city || '',
      district: '', // ip-api 不提供区级信息
      location: [data.country, data.regionName, data.city].filter(Boolean).join(' ') || ip
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

// 记录用户使用（带 IP 地理位置）- 现在存储到 Redis
const logUserUsage = async (req, apiType, extra = {}) => {
  // 确保日志系统已初始化
  if (!usageLogsInitialized) {
    await initUsageLogs();
  }

  const { nickname, userId } = req.body || {};

  // 获取用户IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers["x-real-ip"]
    || req.socket?.remoteAddress
    || "unknown";

  // 获取 IP 地理位置
  let locationInfo = { province: '', city: '', district: '', location: ip };
  try {
    locationInfo = await getIpLocation(ip);
  } catch (e) {
    // 忽略错误，使用默认值
  }

  const userKey = nickname || userId || ip;
  const count = (userStats.get(userKey) || 0) + 1;
  userStats.set(userKey, count);

  // 计算该用户的历史总次数和本月次数
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let userTotalCalls = 0;
  let userMonthCalls = 0;
  usageLogs.forEach(log => {
    const logUserKey = log.nickname || log.userId || log.ip;
    if (logUserKey === userKey) {
      userTotalCalls++;
      const logTime = new Date(log.timestamp).getTime();
      if (logTime >= monthStart) userMonthCalls++;
    }
  });
  // 加上当前这一次
  userTotalCalls++;
  userMonthCalls++;

  const logEntry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    nickname: nickname || null,
    userId: userId || null,
    ip: ip,
    ipLocation: locationInfo,
    apiType: apiType,
    cumulativeCount: count,
    userTotalCalls: userTotalCalls,   // 用户历史总次数
    userMonthCalls: userMonthCalls,   // 用户本月次数
    ...extra
  };

  usageLogs.push(logEntry);

  // 限制记录数量（保留最近 MAX_USAGE_LOGS 条）
  if (usageLogs.length > MAX_USAGE_LOGS) {
    usageLogs = usageLogs.slice(-MAX_USAGE_LOGS);
  }

  // 异步保存到 Redis
  saveUsageLogs().catch(err => {
    console.error("[Usage] Failed to save logs:", err.message);
  });

  console.log(`[Usage] ${nickname || userId || "匿名"} (${locationInfo.location || ip}) - ${apiType} - 第${count}次使用`);

  return logEntry;
};

// 异步初始化使用记录（服务启动时）
initUsageLogs().catch(err => {
  console.error("[Init] Failed to initialize usage logs:", err.message);
});

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

  // 异步保存到 Redis（不阻塞主流程，带错误处理）
  saveApiStats().catch(err => console.error('[Stats] Failed to save:', err.message));
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
// ========== 内存管理与空闲资源清理 ==========
// 空闲检测阈值
const IDLE_THRESHOLD_MS = 2 * 60 * 1000; // 2分钟空闲后开始清理
const DEEP_CLEAN_THRESHOLD_MS = 5 * 60 * 1000; // 5分钟空闲后深度清理

// 清理空闲资源
const cleanIdleResources = (forceDeepClean = false) => {
  const idleTime = Date.now() - lastRequestTime;
  let cleaned = [];

  // 2分钟空闲：轻度清理
  if (idleTime > IDLE_THRESHOLD_MS || forceDeepClean) {
    // 清理 Gemini 客户端缓存
    if (clientCache.size > 0) {
      clientCache.clear();
      cleaned.push('clientCache');
    }

    // 清理 IP 位置缓存
    if (ipLocationCache.size > 0) {
      ipLocationCache.clear();
      cleaned.push('ipLocationCache');
    }
  }

  // 5分钟空闲：深度清理
  if (idleTime > DEEP_CLEAN_THRESHOLD_MS || forceDeepClean) {
    // 卸载 Gemini SDK 模块（下次使用时会重新加载）
    if (GoogleGenAI !== null) {
      GoogleGenAI = null;
      cleaned.push('GoogleGenAI');
    }

    // 清理内存中的使用记录缓存（数据已在 Redis，可以安全清理）
    if (usageLogs.length > 0) {
      usageLogs = [];
      userStats.clear();
      usageLogsInitialized = false; // 下次访问时重新从 Redis 加载
      cleaned.push('usageLogs');
    }

    // 建议 V8 进行垃圾回收（需要 --expose-gc 启动参数）
    if (global.gc) {
      global.gc();
      cleaned.push('GC');
    }
  }

  if (cleaned.length > 0) {
    console.log(`[Memory] Cleaned after ${Math.round(idleTime / 1000)}s idle: ${cleaned.join(', ')}`);
  }
};

// 定期清理空闲资源（每2分钟检查一次）
setInterval(() => {
  cleanIdleResources();
}, 2 * 60 * 1000);

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

    // 记录用户使用（网页端没有用户ID，只记录 IP）
    await logUserUsage(req, "image-web", {
      itemsCount: data.items?.length || 0,
      title: data.title || null
    });

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
    await logUserUsage(req, "image-base64", {
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
// 管理后台 API - 获取使用记录（支持用户搜索）
// ===========================================
app.get("/api/admin/usage-logs", verifyAdminToken, async (req, res) => {
  // 关键修复：确保从 Redis 加载最新的使用日志（可能在空闲清理后被清空）
  await initUsageLogs();
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 50;
  const searchUser = req.query.user?.trim()?.toLowerCase() || '';

  // 按时间倒序排列
  let sortedLogs = [...usageLogs].reverse();

  // 如果有用户搜索条件，过滤日志
  if (searchUser) {
    sortedLogs = sortedLogs.filter(log => {
      const nickname = (log.nickname || '').toLowerCase();
      const userId = (log.userId || '').toLowerCase();
      const ip = (log.ip || '').toLowerCase();
      return nickname.includes(searchUser) || userId.includes(searchUser) || ip.includes(searchUser);
    });
  }

  // 预先计算所有用户的统计数据
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  // 统计每个用户的总次数和本月次数
  const userStatsMap = new Map();
  usageLogs.forEach(log => {
    const userKey = log.nickname || log.userId || log.ip || 'anonymous';
    if (!userStatsMap.has(userKey)) {
      userStatsMap.set(userKey, { total: 0, month: 0 });
    }
    const stats = userStatsMap.get(userKey);
    stats.total++;
    const logTime = new Date(log.timestamp).getTime();
    if (logTime >= monthStart) stats.month++;
  });

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedLogs = sortedLogs.slice(start, end);

  // 为每条日志补充用户统计数据
  const enrichedLogs = paginatedLogs.map(log => {
    const userKey = log.nickname || log.userId || log.ip || 'anonymous';
    const stats = userStatsMap.get(userKey) || { total: 0, month: 0 };
    return {
      ...log,
      userTotalCalls: stats.total,
      userMonthCalls: stats.month
    };
  });

  res.json({
    success: true,
    data: {
      logs: enrichedLogs,
      pagination: {
        page,
        pageSize,
        total: sortedLogs.length,
        totalPages: Math.ceil(sortedLogs.length / pageSize)
      },
      searchUser: searchUser || null
    }
  });
});

// ===========================================
// 管理后台 API - 获取用户统计汇总（含今日/本月统计）
// ===========================================
app.get("/api/admin/user-stats", verifyAdminToken, async (req, res) => {
  // 关键修复：确保从 Redis 加载最新的使用日志
  await initUsageLogs();
  // 按用户汇总统计
  const userSummary = [];
  const userLastSeen = new Map();

  // 计算今日和本月的时间范围
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let todayCalls = 0;
  let monthCalls = 0;

  // 遍历所有记录，获取每个用户的最后使用时间，并统计今日/本月调用
  usageLogs.forEach(log => {
    const key = log.nickname || log.userId || log.ip;
    userLastSeen.set(key, log.timestamp);

    const logTime = new Date(log.timestamp).getTime();
    if (logTime >= todayStart) todayCalls++;
    if (logTime >= monthStart) monthCalls++;
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
      todayCalls,
      monthCalls,
      users: userSummary
    }
  });
});

// ===========================================
// 管理后台 API - 查询单个用户统计
// ===========================================
app.get("/api/admin/user-stats/:userId", verifyAdminToken, async (req, res) => {
  // 关键修复：确保从 Redis 加载最新的使用日志
  await initUsageLogs();
  const searchUser = req.params.userId?.trim()?.toLowerCase() || '';

  if (!searchUser) {
    return res.status(400).json({ success: false, message: "请提供用户ID" });
  }

  // 计算今日和本月的时间范围
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let totalCalls = 0;
  let todayCalls = 0;
  let monthCalls = 0;
  let lastSeen = null;
  let matchedUser = null;

  // 遍历所有日志，查找匹配的用户
  usageLogs.forEach(log => {
    const nickname = (log.nickname || '').toLowerCase();
    const userId = (log.userId || '').toLowerCase();
    const ip = (log.ip || '').toLowerCase();

    if (nickname.includes(searchUser) || userId.includes(searchUser) || ip.includes(searchUser)) {
      totalCalls++;
      lastSeen = log.timestamp;
      matchedUser = log.nickname || log.userId || log.ip;

      const logTime = new Date(log.timestamp).getTime();
      if (logTime >= todayStart) todayCalls++;
      if (logTime >= monthStart) monthCalls++;
    }
  });

  if (totalCalls === 0) {
    return res.json({
      success: true,
      data: null,
      message: "未找到该用户的调用记录"
    });
  }

  res.json({
    success: true,
    data: {
      user: matchedUser,
      totalCalls,
      todayCalls,
      monthCalls,
      lastSeen
    }
  });
});

// ===========================================
// 管理后台 API - 清除记录（谨慎使用）
// ===========================================
app.delete("/api/admin/usage-logs", verifyAdminToken, async (req, res) => {
  const previousCount = usageLogs.length;
  const previousUsers = userStats.size;
  usageLogs = [];
  userStats.clear();

  // 异步保存（会清除 Redis 中的数据）
  try {
    await saveUsageLogs();
  } catch (err) {
    console.error("[Admin] Failed to save after clear:", err.message);
  }

  console.log(`[Admin] Cleared ${previousCount} logs and ${previousUsers} user stats`);

  res.json({
    success: true,
    message: `已清除 ${previousCount} 条记录`,
    data: {
      deletedCount: previousCount,
      deletedUsers: previousUsers
    }
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

// [Admin] 给用户增加额外额度（纯 Redis 模式）
app.post("/api/admin/users/add-quota", verifyAdminToken, async (req, res) => {
  const { userId, amount } = req.body;
  const addAmount = parseInt(amount) || 0;

  if (!userId) {
    return res.status(400).json({ success: false, message: "请提供用户ID" });
  }

  if (addAmount <= 0) {
    return res.status(400).json({ success: false, message: "增加的额度必须大于0" });
  }

  const users = await getQuotaUsers();

  if (!users[userId]) {
    return res.status(404).json({ success: false, message: "用户不存在或未初始化" });
  }

  // 增加额外额度
  users[userId].extraQuota = (users[userId].extraQuota || 0) + addAmount;
  await saveQuotaUsers(users);

  console.log(`[Admin] Added ${addAmount} quota to user ${userId}, new total: ${users[userId].extraQuota}`);

  res.json({
    success: true,
    message: `成功为用户增加 ${addAmount} 次额度`,
    data: {
      userId,
      newExtraQuota: users[userId].extraQuota,
      nickname: users[userId].nickname
    }
  });
});

// [User] 兑换额度（纯 Redis 模式）
app.post("/api/user/redeem", async (req, res) => {
  const { code, userId, nickname } = req.body;

  if (!code || !userId) {
    return res.status(400).json({ success: false, message: "缺少参数" });
  }

  const cleanCode = code.trim();

  // 从 Redis 获取数据
  const [codes, users] = await Promise.all([getQuotaCodes(), getQuotaUsers()]);

  // 尝试查找兑换码（先尝试原始输入，再尝试大写，再尝试小写）
  let matchedCode = null;
  if (codes[cleanCode]) {
    matchedCode = cleanCode;
  } else if (codes[cleanCode.toUpperCase()]) {
    matchedCode = cleanCode.toUpperCase();
  } else if (codes[cleanCode.toLowerCase()]) {
    matchedCode = cleanCode.toLowerCase();
  }

  if (!matchedCode) {
    return res.status(404).json({ success: false, message: "无效的兑换码" });
  }

  const codeData = codes[matchedCode];

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
    delete codes[matchedCode];

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
    delete codes[matchedCode];

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
    console.log(`[Memory] Idle cleanup: ${IDLE_THRESHOLD_MS / 1000}s light, ${DEEP_CLEAN_THRESHOLD_MS / 1000}s deep`);
    console.log(`[Memory] Initial heap: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
  });
}

export default app;
