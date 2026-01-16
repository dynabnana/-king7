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

// 支持的模型列表
const SUPPORTED_MODELS = {
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', description: '更强能力，每日约20次免费' },
  'gemini-2.5-flash-lite': { name: 'Gemini 2.5 Flash Lite', description: '高速识别，每日约1500次免费' },
  'gemini-3-flash-preview': { name: 'Gemini 3 Flash', description: 'KING专属，最新模型' }
};
const DEFAULT_MODEL = 'gemini-2.5-flash';
// KING 用户专用模型（isUnlimited 用户）
const KING_USER_MODEL = 'gemini-3-flash-preview';

// 从请求中获取模型名称（从请求头或请求体读取）
const getModelName = (req) => {
  // 优先从请求头读取
  const headerModel = req.headers['x-gemini-model'];
  if (headerModel && SUPPORTED_MODELS[headerModel]) {
    return headerModel;
  }
  // 其次从请求体读取
  const bodyModel = req.body?.model;
  if (bodyModel && SUPPORTED_MODELS[bodyModel]) {
    return bodyModel;
  }
  return DEFAULT_MODEL;
};

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
const initUsageLogs = async (forceReload = false) => {
  // 如果强制重新加载，先清除状态
  if (forceReload) {
    usageLogsInitialized = false;
    initUsageLogsPromise = null;
    usageLogs = [];
    userStats.clear();
  }

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
          initUsageLogsPromise = null; // 清除锁，确保空闲清理后能重新初始化
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

// ===== 全局配额配置 =====
// 默认配置：普通用户每周5次，Pro用户每周10次
const DEFAULT_QUOTA_CONFIG = {
  normalWeeklyLimit: 5,  // 普通用户每周限额
  proWeeklyLimit: 10     // Pro用户每周限额
};

// 获取全局配额配置
const getQuotaConfig = async () => {
  if (USE_REDIS) {
    try {
      const data = await redisCommand('GET', 'quota:config');
      if (data) {
        return { ...DEFAULT_QUOTA_CONFIG, ...JSON.parse(data) };
      }
    } catch (err) {
      console.error("[Redis] Failed to get config:", err.message);
    }
  }
  // 降级到本地文件
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8"));
      if (data.config) {
        return { ...DEFAULT_QUOTA_CONFIG, ...data.config };
      }
    }
  } catch (err) { }
  return DEFAULT_QUOTA_CONFIG;
};

// 保存全局配额配置
const saveQuotaConfig = async (config) => {
  const newConfig = { ...DEFAULT_QUOTA_CONFIG, ...config };
  if (USE_REDIS) {
    try {
      await redisCommand('SETEX', 'quota:config', REDIS_DATA_TTL, JSON.stringify(newConfig));
      return;
    } catch (err) {
      console.error("[Redis] Failed to save config:", err.message);
    }
  }
  // 降级到本地文件
  try {
    if (fs.existsSync(DATA_DIR)) {
      const existing = fs.existsSync(QUOTA_FILE) ? JSON.parse(fs.readFileSync(QUOTA_FILE, "utf-8")) : {};
      existing.config = newConfig;
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

  // 获取全局配额配置
  const quotaConfig = await getQuotaConfig();

  // 初始化用户数据
  if (!users[userId]) {
    users[userId] = {
      weeklyUsage: 0,
      currentWeek: getCurrentWeekId(),
      extraQuota: 0,
      isUnlimited: false,
      isPro: false,  // Pro用户（通过兑换码获得，每周10次额度）
      totalUsage: 0, // 累计使用次数（从2026年第1周开始统计）
      nickname: nickname || "未命名"
    };
  }

  const user = users[userId];

  // 更新昵称
  if (nickname) user.nickname = nickname;

  // 检查是否无限额度
  if (user.isUnlimited) {
    user.totalUsage = (user.totalUsage || 0) + 1;  // 累计使用次数+1
    await saveQuotaUsers(users);
    return { allowed: true, reason: "unlimited", remaining: 9999, isUnlimited: true };
  }

  // 检查周重置
  const thisWeek = getCurrentWeekId();
  if (user.currentWeek !== thisWeek) {
    user.currentWeek = thisWeek;
    user.weeklyUsage = 0;
  }

  // 从全局配置获取每周额度限制
  const weeklyLimit = user.isPro ? quotaConfig.proWeeklyLimit : quotaConfig.normalWeeklyLimit;

  // 1. 检查周免费额度
  if (user.weeklyUsage < weeklyLimit) {
    user.weeklyUsage++;
    user.totalUsage = (user.totalUsage || 0) + 1;  // 累计使用次数+1
    await saveQuotaUsers(users);
    return { allowed: true, reason: "weekly_free", remaining: weeklyLimit - user.weeklyUsage, isUnlimited: false, isPro: user.isPro };
  }

  // 2. 检查额外额度（一次性额度，用完才消耗每周额度）
  if (user.extraQuota > 0) {
    user.extraQuota--;
    user.totalUsage = (user.totalUsage || 0) + 1;  // 累计使用次数+1
    await saveQuotaUsers(users);
    return { allowed: true, reason: "extra_quota", remaining: user.extraQuota, isUnlimited: false, isPro: user.isPro };
  }

  return { allowed: false, reason: "quota_exceeded", remaining: 0, isUnlimited: false, isPro: user.isPro };
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
    if (usageLogs.length > 0 || usageLogsInitialized) {
      usageLogs = [];
      userStats.clear();
      usageLogsInitialized = false; // 下次访问时重新从 Redis 加载
      initUsageLogsPromise = null;  // 清除 Promise 锁，确保能重新初始化
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
      model: getModelName(req),
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

    // KING 用户使用 Gemini 3 Flash 模型
    const modelToUse = quotaResult.isUnlimited ? KING_USER_MODEL : getModelName(req);
    console.log(`[image-base64] User ${nickname || userId || 'anonymous'} using model: ${modelToUse} (isUnlimited: ${quotaResult.isUnlimited})`);

    const response = await client.models.generateContent({
      model: modelToUse,
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
      model: getModelName(req),
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
// 智能小结功能（独立模块 - 使用七牛云 API）
// ===========================================

// 七牛云 AI API 配置
const QINIU_AI_API_KEY = process.env.QINIU_AI_API_KEY || "";
const QINIU_AI_BASE_URL = "https://api.qnaigc.com/v1";

// 心流平台（iFlow）API 配置 - 免费API作为备选
const IFLOW_AI_API_KEY = process.env.IFLOW_AI_API_KEY || "";
const IFLOW_AI_BASE_URL = "https://apis.iflow.cn/v1";
const IFLOW_DEFAULT_MODEL = "qwen3-max";  // 心流平台的默认模型

// Gemini API 配置（智能小结专用，与OCR的GEMINI_API_KEY分开）
const SUMMARY_GEMINI_API_KEY = process.env.SUMMARY_GEMINI_API_KEY || "";

// ========== 智能小结模型配置 ==========
// Gemini 模型选项列表
const GEMINI_MODEL_OPTIONS = {
  'gemini-3-flash': { name: 'Gemini 3 Flash', description: '最新模型，能力最强' },
  'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', description: '性能均衡，推荐使用' },
  'gemini-2.0-flash': { name: 'Gemini 2.0 Flash', description: '经典稳定版本' }
};

// iFlow 心流平台模型选项列表
const IFLOW_MODEL_OPTIONS = {
  'qwen3-max': { name: 'Qwen3 Max', description: '通义千问3，综合能力强' },
  'kimi-k2-0905': { name: 'Kimi K2', description: 'Moonshot最新模型，推理能力强' }
};

// 合并所有模型选项（用于验证）
const SUMMARY_MODEL_OPTIONS = { ...GEMINI_MODEL_OPTIONS, ...IFLOW_MODEL_OPTIONS };

// 七牛云 API 映射的模型名（仅Gemini模型）
const SUMMARY_MODELS = {
  'gemini-3-flash': 'gemini-2.0-flash-001',
  'gemini-2.5-flash': 'gemini-2.5-flash-preview-05-20',
  'gemini-2.0-flash': 'gemini-2.0-flash-001'
};

// Gemini API 直连时使用的模型名
const GEMINI_DIRECT_MODELS = {
  'gemini-3-flash': 'gemini-2.0-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash-preview-05-20',
  'gemini-2.0-flash': 'gemini-2.0-flash'
};

// iFlow 心流平台模型映射（直接使用）
const IFLOW_MODELS = {
  'qwen3-max': 'qwen3-max',
  'kimi-k2-0905': 'kimi-k2-0905'
};

const DEFAULT_SUMMARY_MODEL = 'gemini-2.5-flash';

// 智能小结默认配额配置
const DEFAULT_SUMMARY_QUOTA_CONFIG = {
  // API源选择: 'gemini' 或 'iflow'
  apiProvider: 'gemini',
  
  // 配额设置
  normalWeeklyLimit: 2,   // 普通用户每周2次
  proWeeklyLimit: 5,      // Pro用户每周5次
  kingWeeklyLimit: 999,   // KING用户无限制
  maxImagesNormal: 1,     // 普通用户最多1张图
  maxImagesPro: 3,        // Pro用户最多3张图
  maxImagesKing: 5,       // KING用户最多5张图
  
  // Gemini 各用户等级使用的模型
  geminiNormalModel: 'gemini-2.0-flash',
  geminiProModel: 'gemini-2.5-flash',
  geminiKingModel: 'gemini-3-flash',
  
  // iFlow 各用户等级使用的模型
  iflowNormalModel: 'qwen3-max',
  iflowProModel: 'qwen3-max',
  iflowKingModel: 'kimi-k2-0905'
};

// 智能小结提示词槽位（4个槽位）
const DEFAULT_SUMMARY_PROMPTS = {
  slot1: {
    name: "槽位1",
    prompt: "",
    description: "未设置"
  },
  slot2: {
    name: "槽位2", 
    prompt: "",
    description: "未设置"
  },
  slot3: {
    name: "槽位3",
    prompt: "",
    description: "未设置"
  },
  slot4: {
    name: "槽位4",
    prompt: "",
    description: "未设置"
  }
};

// 获取提示词槽位配置
const getSummaryPrompts = async () => {
  if (USE_REDIS) {
    try {
      const data = await redisCommand('GET', 'summary:prompts');
      if (data) {
        return { ...DEFAULT_SUMMARY_PROMPTS, ...JSON.parse(data) };
      }
    } catch (err) {
      console.error("[Redis] Failed to get summary prompts:", err.message);
    }
  }
  return DEFAULT_SUMMARY_PROMPTS;
};

// 保存提示词槽位配置
const saveSummaryPrompts = async (prompts) => {
  const newPrompts = { ...DEFAULT_SUMMARY_PROMPTS, ...prompts };
  if (USE_REDIS) {
    try {
      await redisCommand('SETEX', 'summary:prompts', REDIS_DATA_TTL, JSON.stringify(newPrompts));
      return true;
    } catch (err) {
      console.error("[Redis] Failed to save summary prompts:", err.message);
    }
  }
  return false;
};

// 获取智能小结配额配置（从 Redis）
const getSummaryConfig = async () => {
  if (USE_REDIS) {
    try {
      const data = await redisCommand('GET', 'summary:config');
      if (data) {
        return { ...DEFAULT_SUMMARY_QUOTA_CONFIG, ...JSON.parse(data) };
      }
    } catch (err) {
      console.error("[Redis] Failed to get summary config:", err.message);
    }
  }
  return DEFAULT_SUMMARY_QUOTA_CONFIG;
};

// 保存智能小结配额配置
const saveSummaryConfig = async (config) => {
  const newConfig = { ...DEFAULT_SUMMARY_QUOTA_CONFIG, ...config };
  if (USE_REDIS) {
    try {
      await redisCommand('SETEX', 'summary:config', REDIS_DATA_TTL, JSON.stringify(newConfig));
      return true;
    } catch (err) {
      console.error("[Redis] Failed to save summary config:", err.message);
    }
  }
  return false;
};

// 获取用户智能小结使用数据
const getSummaryUsers = async () => {
  if (USE_REDIS) {
    try {
      const data = await redisCommand('GET', 'summary:users');
      return data ? JSON.parse(data) : {};
    } catch (err) {
      console.error("[Redis] Failed to get summary users:", err.message);
    }
  }
  return {};
};

// 保存用户智能小结使用数据
const saveSummaryUsers = async (users) => {
  if (USE_REDIS) {
    try {
      await redisCommand('SETEX', 'summary:users', REDIS_DATA_TTL, JSON.stringify(users));
      return true;
    } catch (err) {
      console.error("[Redis] Failed to save summary users:", err.message);
    }
  }
  return false;
};

// 检查并扣除智能小结配额
const checkAndConsumeSummaryQuota = async (userId, nickname, userLevel = 'normal') => {
  if (!userId) {
    return { allowed: false, reason: "no_user_id", remaining: 0 };
  }

  // 【重要】首先从 OCR 系统的用户数据中读取用户等级
  // 这样 King 用户（isUnlimited）和 Pro 用户在智能小结中也能享受对应权益
  const ocrUsers = await getQuotaUsers();
  const ocrUser = ocrUsers[userId];
  
  // 确定实际的用户等级（OCR系统的等级优先于传入的参数）
  let actualUserLevel = userLevel;
  if (ocrUser) {
    if (ocrUser.isUnlimited) {
      actualUserLevel = 'king';
      console.log(`[Summary] User ${userId} is KING (isUnlimited from OCR system)`);
    } else if (ocrUser.isPro) {
      actualUserLevel = 'pro';
      console.log(`[Summary] User ${userId} is Pro (isPro from OCR system)`);
    }
  }

  const config = await getSummaryConfig();
  const users = await getSummaryUsers();

  // 初始化用户
  if (!users[userId]) {
    users[userId] = {
      weeklyUsage: 0,
      currentWeek: getCurrentWeekId(),
      totalUsage: 0,
      nickname: nickname || ocrUser?.nickname || "未命名"
    };
  }

  const user = users[userId];
  if (nickname) user.nickname = nickname;

  // 检查周重置
  const thisWeek = getCurrentWeekId();
  if (user.currentWeek !== thisWeek) {
    user.currentWeek = thisWeek;
    user.weeklyUsage = 0;
  }

  // 根据用户等级获取每周限额
  let weeklyLimit;
  switch (actualUserLevel) {
    case 'king':
      weeklyLimit = config.kingWeeklyLimit;
      break;
    case 'pro':
      weeklyLimit = config.proWeeklyLimit;
      break;
    default:
      weeklyLimit = config.normalWeeklyLimit;
  }

  // 检查是否超过限额
  if (user.weeklyUsage >= weeklyLimit) {
    return { 
      allowed: false, 
      reason: "quota_exceeded", 
      remaining: 0,
      weeklyLimit,
      weeklyUsage: user.weeklyUsage,
      userLevel: actualUserLevel
    };
  }

  // 扣除配额
  user.weeklyUsage++;
  user.totalUsage = (user.totalUsage || 0) + 1;
  await saveSummaryUsers(users);

  return { 
    allowed: true, 
    reason: "success", 
    remaining: weeklyLimit - user.weeklyUsage,
    weeklyLimit,
    weeklyUsage: user.weeklyUsage,
    userLevel: actualUserLevel
  };
};

// 调用七牛云 AI API
const callQiniuAI = async (model, messages, maxTokens = 2000) => {
  const modelId = SUMMARY_MODELS[model] || SUMMARY_MODELS[DEFAULT_SUMMARY_MODEL];
  
  console.log(`[Summary] Calling Qiniu AI with model: ${modelId}`);

  const response = await fetch(`${QINIU_AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${QINIU_AI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelId,
      messages: messages,
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Summary] Qiniu AI error: ${response.status}`, errorText);
    throw new Error(`Qiniu AI API error: ${response.status}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    usage: data.usage || {},
    provider: 'qiniu'
  };
};

// 调用心流平台（iFlow）API - 免费API，使用OpenAI兼容格式
const callIflowAI = async (model, messages, maxTokens = 2000) => {
  // 从映射中获取实际模型ID，如果没有则使用默认
  const modelId = IFLOW_MODELS[model] || IFLOW_DEFAULT_MODEL;
  
  console.log(`[Summary] Calling iFlow AI with model: ${modelId}`);

  const response = await fetch(`${IFLOW_AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${IFLOW_AI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: modelId,
      messages: messages,
      max_tokens: maxTokens,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Summary] iFlow AI error: ${response.status}`, errorText);
    throw new Error(`iFlow AI API error: ${response.status}`);
  }

  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    usage: data.usage || {},
    provider: 'iflow'
  };
};

// 调用 Gemini API（使用 @google/genai SDK）
const callGeminiAI = async (model, messages, maxTokens = 2000) => {
  const GenAI = await loadGenAI();
  const client = new GenAI({ apiKey: SUMMARY_GEMINI_API_KEY });
  
  const modelName = GEMINI_DIRECT_MODELS[model] || GEMINI_DIRECT_MODELS[DEFAULT_SUMMARY_MODEL];
  console.log(`[Summary] Calling Gemini API with model: ${modelName}`);

  // 转换消息格式为 Gemini 格式
  const systemPrompt = messages.find(m => m.role === 'system')?.content || '';
  const userMessage = messages.find(m => m.role === 'user');
  
  let contents;
  if (typeof userMessage?.content === 'string') {
    // 纯文本消息
    contents = {
      parts: [{ text: userMessage.content }]
    };
  } else if (Array.isArray(userMessage?.content)) {
    // 多模态消息（包含图片）
    const parts = [];
    for (const item of userMessage.content) {
      if (item.type === 'text') {
        parts.push({ text: item.text });
      } else if (item.type === 'image_url') {
        // 从 data URL 提取 base64
        const dataUrl = item.image_url.url;
        const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          parts.push({
            inlineData: {
              mimeType: matches[1],
              data: matches[2]
            }
          });
        }
      }
    }
    contents = { parts };
  }

  const response = await client.models.generateContent({
    model: modelName,
    contents: contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
      temperature: 0.7
    }
  });

  return {
    content: response.text || "",
    usage: {},
    provider: 'gemini'
  };
};

// 智能小结 AI 调用（根据配置的API源调用）
// apiProvider: 'gemini' | 'iflow'，由后台配置决定
const callSummaryAI = async (model, messages, maxTokens = 2000, apiProvider = 'gemini') => {
  console.log(`[Summary] API Provider: ${apiProvider}, Model: ${model}`);
  console.log(`[Summary] API Keys: QINIU=${!!QINIU_AI_API_KEY}, GEMINI=${!!SUMMARY_GEMINI_API_KEY}, IFLOW=${!!IFLOW_AI_API_KEY}`);
  
  // 根据配置的API源调用对应的API
  if (apiProvider === 'iflow') {
    // 使用心流平台
    if (!IFLOW_AI_API_KEY) {
      throw new Error("iFlow API not configured. Set IFLOW_AI_API_KEY environment variable.");
    }
    console.log('[Summary] Using iFlow AI...');
    return await callIflowAI(model, messages, maxTokens);
  } else {
    // 使用 Gemini（默认）
    // 优先使用七牛云代理，失败则直连 Gemini
    if (QINIU_AI_API_KEY) {
      try {
        console.log('[Summary] Using Qiniu AI (Gemini proxy)...');
        return await callQiniuAI(model, messages, maxTokens);
      } catch (err) {
        console.error('[Summary] Qiniu AI failed:', err.message);
        // 七牛云失败，尝试直连 Gemini
        if (SUMMARY_GEMINI_API_KEY) {
          console.log('[Summary] Falling back to direct Gemini API...');
          return await callGeminiAI(model, messages, maxTokens);
        }
        throw err;
      }
    }
    
    // 如果七牛云未配置，直接使用 Gemini
    if (SUMMARY_GEMINI_API_KEY) {
      console.log('[Summary] Using direct Gemini API...');
      return await callGeminiAI(model, messages, maxTokens);
    }
    
    throw new Error("Gemini API not configured. Set QINIU_AI_API_KEY or SUMMARY_GEMINI_API_KEY environment variable.");
  }
};

// 智能小结 API 调用统计
let summaryApiStats = {
  textSummary: 0,
  imageSummary: 0,
  totalCalls: 0
};

// 从 Redis 加载智能小结统计
const loadSummaryStats = async () => {
  if (!USE_REDIS) return;
  try {
    const data = await redisCommand('GET', 'summary:stats');
    if (data) {
      const saved = JSON.parse(data);
      summaryApiStats.textSummary = saved.textSummary || 0;
      summaryApiStats.imageSummary = saved.imageSummary || 0;
      summaryApiStats.totalCalls = saved.totalCalls || 0;
      console.log(`[Redis] Loaded summary stats: ${summaryApiStats.totalCalls} total calls`);
    }
  } catch (err) {
    console.error("[Redis] Failed to load summary stats:", err.message);
  }
};

// 保存智能小结统计到 Redis
const saveSummaryStats = async () => {
  if (!USE_REDIS) return;
  try {
    await redisCommand('SETEX', 'summary:stats', REDIS_DATA_TTL, JSON.stringify({
      textSummary: summaryApiStats.textSummary,
      imageSummary: summaryApiStats.imageSummary,
      totalCalls: summaryApiStats.totalCalls,
      lastUpdated: new Date().toISOString()
    }));
  } catch (err) {
    console.error("[Redis] Failed to save summary stats:", err.message);
  }
};

// 增加智能小结调用统计
const incrementSummaryStats = async (type) => {
  if (type === 'text') {
    summaryApiStats.textSummary++;
  } else if (type === 'image') {
    summaryApiStats.imageSummary++;
  }
  summaryApiStats.totalCalls++;
  saveSummaryStats().catch(err => console.error('[Summary Stats] Failed to save:', err.message));
};

// 初始化加载统计
loadSummaryStats();

// ===========================================
// API 端点：智能小结 - 文本输入模式
// ===========================================
app.post("/api/summary/text", async (req, res) => {
  try {
    const { userId, nickname, userLevel, model, examData, systemPrompt, promptSlot } = req.body || {};

    // 参数验证
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required" });
    }
    if (!examData || !examData.items || examData.items.length === 0) {
      return res.status(400).json({ success: false, error: "examData with items is required" });
    }

    // 确定使用的提示词：优先使用 promptSlot 预设，其次使用传入的 systemPrompt
    let finalPrompt = systemPrompt;
    if (promptSlot && ['slot1', 'slot2', 'slot3', 'slot4'].includes(promptSlot)) {
      const prompts = await getSummaryPrompts();
      const slotData = prompts[promptSlot];
      if (slotData && slotData.prompt && slotData.prompt.trim()) {
        finalPrompt = slotData.prompt;
        console.log(`[Summary] Using prompt slot: ${promptSlot} (${slotData.name})`);
      }
    }

    if (!finalPrompt) {
      return res.status(400).json({ success: false, error: "systemPrompt or valid promptSlot is required" });
    }

    // 检查配额
    const quotaResult = await checkAndConsumeSummaryQuota(userId, nickname, userLevel || 'normal');
    if (!quotaResult.allowed) {
      return res.status(403).json({
        success: false,
        error: "QUOTA_EXCEEDED",
        message: "本周智能小结次数已用完",
        quota: quotaResult
      });
    }

    // 获取配置，确定API源和用户等级对应的模型
    const config = await getSummaryConfig();
    const actualUserLevel = quotaResult.userLevel || 'normal';
    const apiProvider = config.apiProvider || 'gemini';
    
    let modelToUse = model; // 如果前端传了模型，优先使用
    if (!modelToUse) {
      // 根据API源和用户等级从配置中获取对应模型
      if (apiProvider === 'iflow') {
        // iFlow 模型
        switch (actualUserLevel) {
          case 'king':
            modelToUse = config.iflowKingModel || 'kimi-k2-0905';
            break;
          case 'pro':
            modelToUse = config.iflowProModel || 'qwen3-max';
            break;
          default:
            modelToUse = config.iflowNormalModel || 'qwen3-max';
        }
      } else {
        // Gemini 模型（默认）
        switch (actualUserLevel) {
          case 'king':
            modelToUse = config.geminiKingModel || 'gemini-3-flash';
            break;
          case 'pro':
            modelToUse = config.geminiProModel || 'gemini-2.5-flash';
            break;
          default:
            modelToUse = config.geminiNormalModel || 'gemini-2.0-flash';
        }
      }
    }
    
    // 验证模型是否在支持列表中
    if (!SUMMARY_MODEL_OPTIONS[modelToUse]) {
      modelToUse = apiProvider === 'iflow' ? IFLOW_DEFAULT_MODEL : DEFAULT_SUMMARY_MODEL;
    }
    
    console.log(`[Summary] User ${nickname || userId} (${actualUserLevel}) using ${apiProvider}/${modelToUse}`);

    // 构建消息内容
    const userContent = `检查日期: ${examData.date || '未知'}\n\n检查项目:\n${
      examData.items.map(item => 
        `- ${item.name}: ${item.value} ${item.unit || ''} (参考范围: ${item.range || '未提供'})`
      ).join('\n')
    }`;

    const messages = [
      { role: "system", content: finalPrompt },
      { role: "user", content: userContent }
    ];

    // 调用 AI API（根据配置的API源调用）
    const result = await callSummaryAI(modelToUse, messages, 2000, apiProvider);

    // 记录统计
    await incrementSummaryStats('text');

    // 记录使用日志
    await logUserUsage(req, "summary-text", {
      itemsCount: examData.items.length,
      model: modelToUse,
      apiProvider: apiProvider,
      userLevel: actualUserLevel
    });

    console.log(`[Summary] Text summary completed for user ${nickname || userId}`);

    return res.json({
      success: true,
      summary: result.content,
      model: modelToUse,
      modelName: SUMMARY_MODEL_OPTIONS[modelToUse]?.name || modelToUse,
      usage: result.usage,
      quota: {
        remaining: quotaResult.remaining,
        weeklyLimit: quotaResult.weeklyLimit,
        weeklyUsage: quotaResult.weeklyUsage,
        userLevel: actualUserLevel
      }
    });

  } catch (err) {
    console.error("Summary text error:", err);
    const message = err instanceof Error ? err.message : String(err);
    
    // API 未配置
    if (message.includes("No AI API configured")) {
      return res.status(503).json({
        success: false,
        error: "API_NOT_CONFIGURED",
        message: "智能小结服务暂未配置，请联系管理员"
      });
    }
    
    // 频率限制（必须明确包含429状态码或rate limit关键词）
    if (message.includes("429") || message.toLowerCase().includes("rate limit")) {
      return res.status(429).json({
        success: false,
        error: "RATE_LIMIT",
        message: "请求过于频繁，请稍后再试"
      });
    }
    
    return res.status(500).json({
      success: false,
      error: "SUMMARY_FAILED",
      message: message || "AI分析失败，请重试"
    });
  }
});

// ===========================================
// API 端点：智能小结 - 图片输入模式（支持多图）
// ===========================================
app.post("/api/summary/images", async (req, res) => {
  try {
    const { userId, nickname, userLevel, model, images, systemPrompt, promptSlot } = req.body || {};

    // 参数验证
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId is required" });
    }
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ success: false, error: "images array is required" });
    }

    // 确定使用的提示词：优先使用 promptSlot 预设，其次使用传入的 systemPrompt
    let finalPrompt = systemPrompt;
    if (promptSlot && ['slot1', 'slot2', 'slot3', 'slot4'].includes(promptSlot)) {
      const prompts = await getSummaryPrompts();
      const slotData = prompts[promptSlot];
      if (slotData && slotData.prompt && slotData.prompt.trim()) {
        finalPrompt = slotData.prompt;
        console.log(`[Summary] Using prompt slot: ${promptSlot} (${slotData.name})`);
      }
    }

    if (!finalPrompt) {
      return res.status(400).json({ success: false, error: "systemPrompt or valid promptSlot is required" });
    }

    // 获取配置，检查图片数量限制
    const config = await getSummaryConfig();
    let maxImages;
    switch (userLevel) {
      case 'king':
        maxImages = config.maxImagesKing;
        break;
      case 'pro':
        maxImages = config.maxImagesPro;
        break;
      default:
        maxImages = config.maxImagesNormal;
    }

    if (images.length > maxImages) {
      return res.status(400).json({
        success: false,
        error: "IMAGE_LIMIT_EXCEEDED",
        message: `您最多可以上传 ${maxImages} 张图片`,
        maxImages
      });
    }

    // 检查配额
    const quotaResult = await checkAndConsumeSummaryQuota(userId, nickname, userLevel || 'normal');
    if (!quotaResult.allowed) {
      return res.status(403).json({
        success: false,
        error: "QUOTA_EXCEEDED",
        message: "本周智能小结次数已用完",
        quota: quotaResult
      });
    }

    // 构建多模态消息内容（七牛云支持 OpenAI 格式的多模态输入）
    const contentParts = [];
    
    // 添加图片
    images.forEach((img, index) => {
      let base64Data = img.base64;
      // 移除可能的 data URL 前缀
      if (base64Data.includes(",")) {
        base64Data = base64Data.split(",")[1];
      }
      
      contentParts.push({
        type: "image_url",
        image_url: {
          url: `data:${img.mimeType || 'image/jpeg'};base64,${base64Data}`
        }
      });
    });
    
    // 添加文本提示
    contentParts.push({
      type: "text",
      text: "请根据上传的检查报告图片进行分析总结。"
    });

    const messages = [
      { role: "system", content: finalPrompt },
      { role: "user", content: contentParts }
    ];

    // 调用 AI API（优先七牛云，备选 Gemini）
    const result = await callSummaryAI(model || DEFAULT_SUMMARY_MODEL, messages, 3000);

    // 记录统计
    await incrementSummaryStats('image');

    // 记录使用日志
    await logUserUsage(req, "summary-images", {
      imagesCount: images.length,
      model: model || DEFAULT_SUMMARY_MODEL
    });

    console.log(`[Summary] Image summary completed for user ${nickname || userId}, ${images.length} images`);

    return res.json({
      success: true,
      summary: result.content,
      model: model || DEFAULT_SUMMARY_MODEL,
      imagesProcessed: images.length,
      usage: result.usage,
      quota: {
        remaining: quotaResult.remaining,
        weeklyLimit: quotaResult.weeklyLimit,
        weeklyUsage: quotaResult.weeklyUsage
      }
    });

  } catch (err) {
    console.error("Summary images error:", err);
    const message = err instanceof Error ? err.message : String(err);
    
    // API 未配置
    if (message.includes("No AI API configured")) {
      return res.status(503).json({
        success: false,
        error: "API_NOT_CONFIGURED",
        message: "智能小结服务暂未配置，请联系管理员"
      });
    }
    
    // 频率限制
    if (message.includes("429") || message.toLowerCase().includes("rate limit")) {
      return res.status(429).json({
        success: false,
        error: "RATE_LIMIT",
        message: "请求过于频繁，请稍后再试"
      });
    }
    
    return res.status(500).json({
      success: false,
      error: "SUMMARY_FAILED",
      message: message || "AI分析失败，请重试"
    });
  }
});

// ===========================================
// API 端点：获取智能小结配额状态
// ===========================================
app.get("/api/summary/quota", async (req, res) => {
  const { userId, userLevel } = req.query;
  
  const config = await getSummaryConfig();
  const users = await getSummaryUsers();

  // 根据用户等级获取限额
  let weeklyLimit, maxImages;
  switch (userLevel) {
    case 'king':
      weeklyLimit = config.kingWeeklyLimit;
      maxImages = config.maxImagesKing;
      break;
    case 'pro':
      weeklyLimit = config.proWeeklyLimit;
      maxImages = config.maxImagesPro;
      break;
    default:
      weeklyLimit = config.normalWeeklyLimit;
      maxImages = config.maxImagesNormal;
  }

  if (!userId || !users[userId]) {
    return res.json({
      success: true,
      data: {
        weeklyUsage: 0,
        weeklyLimit,
        remaining: weeklyLimit,
        maxImages,
        totalUsage: 0
      }
    });
  }

  const user = users[userId];
  const thisWeek = getCurrentWeekId();
  const weeklyUsage = (user.currentWeek === thisWeek) ? user.weeklyUsage : 0;

  res.json({
    success: true,
    data: {
      weeklyUsage,
      weeklyLimit,
      remaining: Math.max(0, weeklyLimit - weeklyUsage),
      maxImages,
      totalUsage: user.totalUsage || 0
    }
  });
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
      // OCR 识别统计
      imageAnalyze: apiCallStats.imageAnalyze,
      imageBase64Analyze: apiCallStats.imageBase64Analyze,
      excelAnalyze: apiCallStats.excelAnalyze,
      totalCalls: apiCallStats.totalCalls,
      // 智能小结统计
      summary: {
        textSummary: summaryApiStats.textSummary,
        imageSummary: summaryApiStats.imageSummary,
        totalCalls: summaryApiStats.totalCalls
      },
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
// API 端点：获取智能小结统计（管理后台用）
// ===========================================
app.get("/api/admin/summary/stats", verifyAdminToken, async (req, res) => {
  const config = await getSummaryConfig();
  const users = await getSummaryUsers();
  
  res.json({
    success: true,
    stats: summaryApiStats,
    config,
    userCount: Object.keys(users).length
  });
});

// ===========================================
// API 端点：更新智能小结配置（管理后台用）
// ===========================================
app.put("/api/admin/summary/config", verifyAdminToken, async (req, res) => {
  const newConfig = req.body || {};
  
  // 验证配置值
  const validNumericKeys = [
    'normalWeeklyLimit', 'proWeeklyLimit', 'kingWeeklyLimit',
    'maxImagesNormal', 'maxImagesPro', 'maxImagesKing'
  ];
  
  // Gemini 模型配置字段
  const geminiModelKeys = ['geminiNormalModel', 'geminiProModel', 'geminiKingModel'];
  // iFlow 模型配置字段
  const iflowModelKeys = ['iflowNormalModel', 'iflowProModel', 'iflowKingModel'];
  
  const sanitizedConfig = {};
  
  // 处理 API 源选择
  if (newConfig.apiProvider && ['gemini', 'iflow'].includes(newConfig.apiProvider)) {
    sanitizedConfig.apiProvider = newConfig.apiProvider;
  }
  
  // 处理数字配置
  for (const key of validNumericKeys) {
    if (typeof newConfig[key] === 'number' && newConfig[key] >= 0) {
      sanitizedConfig[key] = newConfig[key];
    }
  }
  
  // 处理 Gemini 模型配置
  for (const key of geminiModelKeys) {
    if (typeof newConfig[key] === 'string' && GEMINI_MODEL_OPTIONS[newConfig[key]]) {
      sanitizedConfig[key] = newConfig[key];
    }
  }
  
  // 处理 iFlow 模型配置
  for (const key of iflowModelKeys) {
    if (typeof newConfig[key] === 'string' && IFLOW_MODEL_OPTIONS[newConfig[key]]) {
      sanitizedConfig[key] = newConfig[key];
    }
  }

  const currentConfig = await getSummaryConfig();
  const mergedConfig = { ...currentConfig, ...sanitizedConfig };
  
  const saved = await saveSummaryConfig(mergedConfig);
  
  if (saved) {
    console.log(`[Admin] Updated summary config:`, sanitizedConfig);
    res.json({
      success: true,
      message: "配置已更新",
      config: mergedConfig
    });
  } else {
    res.status(500).json({
      success: false,
      message: "保存配置失败"
    });
  }
});

// ===========================================
// API 端点：获取智能小结提示词槽位（管理后台用）
// ===========================================
app.get("/api/admin/summary/prompts", verifyAdminToken, async (req, res) => {
  const prompts = await getSummaryPrompts();
  res.json({
    success: true,
    prompts
  });
});

// ===========================================
// API 端点：更新智能小结提示词槽位（管理后台用）
// ===========================================
app.put("/api/admin/summary/prompts", verifyAdminToken, async (req, res) => {
  const { slot, name, prompt, description } = req.body || {};
  
  // 验证槽位
  if (!slot || !['slot1', 'slot2', 'slot3', 'slot4'].includes(slot)) {
    return res.status(400).json({
      success: false,
      message: "无效的槽位，必须是 slot1-slot4"
    });
  }

  const currentPrompts = await getSummaryPrompts();
  currentPrompts[slot] = {
    name: name || currentPrompts[slot].name,
    prompt: prompt !== undefined ? prompt : currentPrompts[slot].prompt,
    description: description || currentPrompts[slot].description
  };
  
  const saved = await saveSummaryPrompts(currentPrompts);
  
  if (saved) {
    console.log(`[Admin] Updated summary prompt ${slot}:`, name);
    res.json({
      success: true,
      message: `${slot} 提示词已更新`,
      prompts: currentPrompts
    });
  } else {
    res.status(500).json({
      success: false,
      message: "保存提示词失败"
    });
  }
});

// ===========================================
// 管理后台 API - 获取使用记录（支持用户搜索）
// ===========================================
app.get("/api/admin/usage-logs", verifyAdminToken, async (req, res) => {
  // 强制从 Redis 重新加载最新数据
  await initUsageLogs(true);
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

  // 计算每个用户的当前最新累计总次数和本月次数
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  // 用于记录每个用户的当前总次数和本月次数
  const userTotalCalls = new Map();
  const userMonthCalls = new Map();

  // 统一的用户标识计算函数
  const getUserKey = (log) => {
    // nickname 要有值且不是 '匿名'
    if (log.nickname && log.nickname !== '匿名' && log.nickname !== 'null') {
      return log.nickname;
    }
    // userId 要有值
    if (log.userId && log.userId !== 'null') {
      return log.userId;
    }
    // 最后用 IP
    return log.ip || 'anonymous';
  };

  // 遍历所有日志，计算每个用户的累计统计
  usageLogs.forEach(log => {
    const userKey = getUserKey(log);
    const logTime = new Date(log.timestamp).getTime();

    // 累加该用户的总次数
    userTotalCalls.set(userKey, (userTotalCalls.get(userKey) || 0) + 1);

    // 累加该用户的本月次数
    if (logTime >= monthStart) {
      userMonthCalls.set(userKey, (userMonthCalls.get(userKey) || 0) + 1);
    }
  });

  // 调试日志：输出统计结果
  console.log('[Admin API] User stats:', Object.fromEntries(userTotalCalls));

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const paginatedLogs = sortedLogs.slice(start, end);

  // 为每条日志返回该用户的当前最新累计数据
  const enrichedLogs = paginatedLogs.map(log => {
    const userKey = getUserKey(log);
    return {
      ...log,
      userTotalCalls: userTotalCalls.get(userKey) || 0,
      userMonthCalls: userMonthCalls.get(userKey) || 0
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
  // 强制从 Redis 重新加载最新数据
  await initUsageLogs(true);
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

// [Admin] 生成Pro兑换码（每周10次额度，纯 Redis 模式）
app.post("/api/admin/codes/generate-pro", verifyAdminToken, async (req, res) => {
  const { count, remark } = req.body;
  const generateCount = parseInt(count) || 1;

  // 从 Redis 获取现有兑换码
  const codes = await getQuotaCodes();

  const newCodes = [];
  for (let i = 0; i < generateCount; i++) {
    const code = "PRO-" + Math.random().toString(36).substr(2, 4).toUpperCase() + "-" + Math.random().toString(36).substr(2, 4).toUpperCase();

    codes[code] = {
      quota: 0,  // Pro用户没有一次性额度，而是每周10次
      createTime: Date.now(),
      type: 'pro',
      remark: remark || ''
    };
    newCodes.push(code);
  }

  await saveQuotaCodes(codes);

  res.json({
    success: true,
    data: { codes: newCodes, type: 'pro' },
    message: `成功生成 ${newCodes.length} 个Pro用户兑换码`
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
  const thisWeek = getCurrentWeekId();
  const quotaConfig = await getQuotaConfig();  // 获取全局配额配置

  const userList = Object.entries(users).map(([id, data]) => {
    // 如果用户的 currentWeek 不是本周，显示的 weeklyUsage 应该是 0
    const weeklyUsage = (data.currentWeek === thisWeek) ? (data.weeklyUsage || 0) : 0;
    // 从全局配置获取每周限额
    const weeklyLimit = data.isPro ? quotaConfig.proWeeklyLimit : quotaConfig.normalWeeklyLimit;

    return {
      id,
      ...data,
      weeklyUsage,      // 修正后的本周已用次数
      weeklyLimit       // 每周限额（从全局配置获取）
    };
  });
  res.json({
    success: true,
    data: userList,
    config: quotaConfig  // 返回全局配额配置
  });
});

// [Admin] 获取全局配额配置
app.get("/api/admin/quota/config", verifyAdminToken, async (req, res) => {
  const config = await getQuotaConfig();
  res.json({ success: true, data: config });
});

// [Admin] 更新全局配额配置
app.put("/api/admin/quota/config", verifyAdminToken, async (req, res) => {
  const { normalWeeklyLimit, proWeeklyLimit } = req.body;

  // 验证参数
  const newNormalLimit = parseInt(normalWeeklyLimit);
  const newProLimit = parseInt(proWeeklyLimit);

  if (isNaN(newNormalLimit) || newNormalLimit < 0 || newNormalLimit > 100) {
    return res.status(400).json({ success: false, message: "普通用户每周限额必须在0-100之间" });
  }
  if (isNaN(newProLimit) || newProLimit < 0 || newProLimit > 100) {
    return res.status(400).json({ success: false, message: "Pro用户每周限额必须在0-100之间" });
  }

  const newConfig = {
    normalWeeklyLimit: newNormalLimit,
    proWeeklyLimit: newProLimit
  };

  await saveQuotaConfig(newConfig);

  console.log(`[Admin] Updated quota config: Normal=${newNormalLimit}, Pro=${newProLimit}`);

  res.json({
    success: true,
    message: `配额配置已更新：普通用户每周${newNormalLimit}次，Pro用户每周${newProLimit}次`,
    data: newConfig
  });
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

// [Admin] 更新用户备注（纯 Redis 模式）
app.put("/api/admin/users/:userId/remark", verifyAdminToken, async (req, res) => {
  const { userId } = req.params;
  const { remark } = req.body;
  const users = await getQuotaUsers();

  if (!userId || !users[userId]) {
    return res.status(404).json({ success: false, message: "用户不存在或未初始化" });
  }

  users[userId].remark = remark || '';
  await saveQuotaUsers(users);

  console.log(`[Admin] Updated remark for user ${userId}: ${remark}`);

  res.json({
    success: true,
    message: "备注已更新",
    data: {
      userId,
      remark: users[userId].remark
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
      isPro: false,
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
        isPro: users[userId].isPro || false,
        totalExtra: users[userId].extraQuota || 0
      }
    });
  } else if (codeData.type === 'pro') {
    // Pro用户兑换码（每周10次额度）
    users[userId].isPro = true;
    delete codes[matchedCode];

    await Promise.all([saveQuotaCodes(codes), saveQuotaUsers(users)]);

    res.json({
      success: true,
      message: "🌟 恭喜！您已成功升级为Pro用户，每周可使用10次识别功能！",
      data: {
        isUnlimited: false,
        isPro: true,
        weeklyLimit: 10,
        totalExtra: users[userId].extraQuota || 0
      }
    });
  } else {
    // 普通额度兑换码（一次性额外额度）
    users[userId].extraQuota = (users[userId].extraQuota || 0) + codeData.quota;
    delete codes[matchedCode];

    await Promise.all([saveQuotaCodes(codes), saveQuotaUsers(users)]);

    res.json({
      success: true,
      message: `兑换成功！增加了 ${codeData.quota} 次额外额度`,
      data: {
        isUnlimited: false,
        isPro: users[userId].isPro || false,
        totalExtra: users[userId].extraQuota
      }
    });
  }
});

// [User] 查询配额状态（纯 Redis 模式）
app.get("/api/user/quota", async (req, res) => {
  const { userId } = req.query;
  const users = await getQuotaUsers();
  const quotaConfig = await getQuotaConfig();  // 获取全局配额配置

  if (!userId || !users[userId]) {
    return res.json({
      success: true,
      data: { weeklyUsage: 0, weeklyLimit: quotaConfig.normalWeeklyLimit, extraQuota: 0, isUnlimited: false, isPro: false }
    });
  }

  const user = users[userId];
  const thisWeek = getCurrentWeekId();
  const weeklyUsage = (user.currentWeek === thisWeek) ? user.weeklyUsage : 0;
  const isPro = user.isPro || false;
  // 从全局配置获取每周限额
  const weeklyLimit = isPro ? quotaConfig.proWeeklyLimit : quotaConfig.normalWeeklyLimit;

  res.json({
    success: true,
    data: {
      weeklyUsage: weeklyUsage,
      weeklyLimit: weeklyLimit,
      extraQuota: user.extraQuota || 0,
      isUnlimited: user.isUnlimited || false,
      isPro: isPro
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
