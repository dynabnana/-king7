import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";

// --- Types & Interfaces ---

interface MedicalItem {
  id: string; // e.g., 'scr', 'egfr'
  name: string;
  value: string;
  unit: string;
  range: string;
  categoryName: string;
}

interface Medication {
  name: string;
  dosage: string;
  usage: string;
  timesPerDay: number;
  amountPerDose: number;
}

interface MedicalRecord {
  id: string;
  title: string;
  date: number; // timestamp
  hospital: string;
  doctor: string;
  nextReviewDate: number;
  notes: string;
  prescription: string;
  configName: string;
  items: MedicalItem[];
  medications: Medication[];
  remarkPhotos: string[];
  createdAt: number;
  updatedAt: number;
}

interface ExportFormat {
  exportDate: string;
  medicalRecords: MedicalRecord[];
}

// Declare XLSX global from CDN
declare global {
  interface Window {
    XLSX: any;
  }
}

// API 统计数据接口
interface ApiStats {
  imageAnalyze: number;
  imageBase64Analyze: number;
  excelAnalyze: number;
  totalCalls: number;
  uptime: {
    hours: number;
    minutes: number;
    display: string;
  };
}

// --- Helper Functions ---

// 支持的模型列表
const SUPPORTED_MODELS = {
  'gemini-2.5-flash': { name: 'Flash', fullName: 'Gemini 2.5 Flash', description: '均衡性能', badge: '推荐' },
  'gemini-2.5-flash-lite': { name: 'Flash Lite', fullName: 'Gemini 2.5 Flash Lite', description: '轻量高速', badge: '快速' },
  'gemini-3-flash-preview': { name: '3 Flash', fullName: 'Gemini 3 Flash', description: '最新模型', badge: '最新' }
} as const;

type ModelId = keyof typeof SUPPORTED_MODELS;
const DEFAULT_MODEL: ModelId = 'gemini-2.5-flash';

const IconWrap = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <span className={`inline-flex items-center justify-center ${className}`}>{children}</span>
);

const AppIcon = () => (
  <IconWrap className="h-12 w-12 rounded-[18px] bg-[linear-gradient(135deg,#3b82f6_0%,#2563eb_48%,#0f172a_100%)] text-white shadow-[0_18px_40px_-20px_rgba(37,99,235,0.75)] ring-1 ring-white/70">
    <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
      <path d="M8 3.75h8a2.25 2.25 0 0 1 2.25 2.25v12A2.25 2.25 0 0 1 16 20.25H8A2.25 2.25 0 0 1 5.75 18V6A2.25 2.25 0 0 1 8 3.75Z" fill="currentColor" opacity="0.92"/>
      <path d="M9 9.25h6M12 6.75v5M10 14.5h4" stroke="white" strokeWidth="1.75" strokeLinecap="round"/>
    </svg>
  </IconWrap>
);

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
    <path d="M8.5 6.5 10 4.75h4l1.5 1.75H18A2.5 2.5 0 0 1 20.5 9v7A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16V9A2.5 2.5 0 0 1 6 6.5h2.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    <circle cx="12" cy="12.5" r="3" stroke="currentColor" strokeWidth="1.8"/>
  </svg>
);

const ExcelIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7">
    <path d="M13.5 3.75H8A2.25 2.25 0 0 0 5.75 6v12A2.25 2.25 0 0 0 8 20.25h8A2.25 2.25 0 0 0 18.25 18V8.5l-4.75-4.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    <path d="M13.25 3.9V8.5h4.6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    <path d="m9.2 15.8 2.1-3.1-1.9-2.8M14.8 15.8l-2-3.1 1.9-2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ExportIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
    <path d="M12 4.5v9m0 0 3.25-3.25M12 13.5 8.75 10.25M5 15.75v.75A2.5 2.5 0 0 0 7.5 19h9a2.5 2.5 0 0 0 2.5-2.5v-.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
    <path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Z" stroke="currentColor" strokeWidth="1.8"/>
    <path d="M19.4 10.55 17.98 9.73a6.95 6.95 0 0 0-.52-1.25l.42-1.58a.75.75 0 0 0-.2-.74l-.84-.84a.75.75 0 0 0-.74-.2l-1.58.42c-.4-.22-.82-.39-1.25-.52L13.45 3.6a.75.75 0 0 0-.65-.35h-1.6a.75.75 0 0 0-.65.35l-.82 1.42c-.43.13-.85.3-1.25.52L6.9 5.12a.75.75 0 0 0-.74.2l-.84.84a.75.75 0 0 0-.2.74l.42 1.58c-.22.4-.39.82-.52 1.25L3.6 10.55a.75.75 0 0 0-.35.65v1.6c0 .27.14.52.35.65l1.42.82c.13.43.3.85.52 1.25l-.42 1.58a.75.75 0 0 0 .2.74l.84.84c.2.2.48.27.74.2l1.58-.42c.4.22.82.39 1.25.52l.82 1.42c.13.22.37.35.65.35h1.6c.27 0 .52-.14.65-.35l.82-1.42c.43-.13.85-.3 1.25-.52l1.58.42c.26.07.54 0 .74-.2l.84-.84a.75.75 0 0 0 .2-.74l-.42-1.58c.22-.4.39-.82.52-1.25l1.42-.82c.22-.13.35-.38.35-.65v-1.6a.75.75 0 0 0-.35-.65Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
  </svg>
);

const ChevronIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 20 20" fill="none" className={className}>
    <path d="m5.75 7.75 4.25 4.5 4.25-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const TrashIcon = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 20 20" fill="none" className={className}>
    <path d="M7.5 4.75h5m-8 1.5h11m-1.25 0-.42 8.04A1.75 1.75 0 0 1 12.08 16h-4.16a1.75 1.75 0 0 1-1.75-1.71l-.42-8.04m3 2.5v4.5m3-4.5v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ChartIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
    <path d="M4 12.5v2.25M8 8.75v6M12 5.75v9M16 10.25v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
);

const RobotIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
    <path d="M10 3.5v2M6.75 7.5h6.5A1.75 1.75 0 0 1 15 9.25v3A2.25 2.25 0 0 1 12.75 14.5h-5.5A2.25 2.25 0 0 1 5 12.25v-3A1.75 1.75 0 0 1 6.75 7.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="8" cy="10.5" r=".9" fill="currentColor"/>
    <circle cx="12" cy="10.5" r=".9" fill="currentColor"/>
    <path d="M7.75 2h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>
);

// --- Components ---

const SettingsModal = ({
  isOpen,
  onClose,
  keys,
  activeKeyIndex,
  onAddKey,
  onDeleteKey,
  onSelectKey
}: {
  isOpen: boolean;
  onClose: () => void;
  keys: string[];
  activeKeyIndex: number;
  onAddKey: (key: string) => void;
  onDeleteKey: (index: number) => void;
  onSelectKey: (index: number) => void;
}) => {
  const [inputKey, setInputKey] = useState('');

  if (!isOpen) return null;

  const handleAdd = () => {
    if (!inputKey.trim()) return;
    onAddKey(inputKey.trim());
    setInputKey('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 p-4 backdrop-blur-xl">
      <div className="w-full max-w-md overflow-hidden rounded-[30px] border border-white/70 bg-white/90 shadow-[0_30px_90px_-40px_rgba(15,23,42,0.45)] backdrop-blur-2xl">
        <div className="flex items-center justify-between border-b border-slate-200/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.96)_0%,rgba(246,248,252,0.92)_100%)] px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-slate-900">API 密钥设置</h3>
            <p className="mt-1 text-xs text-slate-500">本地保存，多 Key 轮换可选</p>
          </div>
          <button onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700">
            <i className="fa-solid fa-xmark text-xl"></i>
          </button>
        </div>

        <div className="space-y-6 p-6">
          {/* Add New Key */}
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">添加新密钥 (Gemini API Key)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                placeholder="AIzaSy..."
                className="flex-1 rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-700 outline-none transition-all placeholder:text-slate-300 focus:border-blue-300 focus:ring-4 focus:ring-blue-100"
              />
              <button
                onClick={handleAdd}
                disabled={!inputKey}
                className="rounded-2xl bg-[linear-gradient(135deg,#2563eb_0%,#1d4ed8_100%)] px-4 py-3 font-medium text-white shadow-[0_16px_30px_-18px_rgba(37,99,235,0.9)] transition-all hover:-translate-y-0.5 hover:shadow-[0_22px_34px_-18px_rgba(37,99,235,0.9)] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none"
              >
                添加
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              密钥将保存在本地浏览器中，并通过加密连接发送到本应用服务器。
            </p>
          </div>

          {/* Key List */}
          <div>
            <h4 className="mb-3 text-sm font-semibold text-slate-700">可用密钥列表</h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {keys.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 py-4 text-center text-sm text-slate-400">
                  暂无密钥，请先添加
                </div>
              ) : (
                keys.map((k, idx) => (
                  <div
                    key={idx}
                    onClick={() => onSelectKey(idx)}
                    className={`flex cursor-pointer items-center justify-between rounded-2xl border p-3 transition-all ${activeKeyIndex === idx ? 'border-blue-300 bg-blue-50/70 shadow-[0_18px_30px_-24px_rgba(37,99,235,0.9)] ring-1 ring-blue-200' : 'border-slate-200 bg-white/80 hover:border-slate-300 hover:bg-slate-50/80'}`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className={`flex h-4 w-4 items-center justify-center rounded-full border ${activeKeyIndex === idx ? 'border-blue-600' : 'border-slate-300'}`}>
                        {activeKeyIndex === idx && <div className="w-2 h-2 bg-blue-600 rounded-full"></div>}
                      </div>
                      <div className="flex flex-col truncate">
                        <span className={`truncate text-sm font-medium ${activeKeyIndex === idx ? 'text-blue-700' : 'text-slate-700'}`}>
                          密钥 {idx + 1}
                        </span>
                        <span className="w-32 truncate text-xs text-slate-400">
                          {k.substring(0, 8)}...{k.substring(k.length - 4)}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteKey(idx); }}
                      className="p-2 text-slate-400 transition-colors hover:text-red-500"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-slate-200/80 bg-slate-50/80 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-2xl border border-slate-200 bg-white px-5 py-2.5 font-medium text-slate-700 transition-all hover:border-slate-300 hover:bg-slate-50"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};

const App = () => {
  const [records, setRecords] = useState<MedicalRecord[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [activeKeyIndex, setActiveKeyIndex] = useState(0);
  const [apiStats, setApiStats] = useState<ApiStats | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelId>(DEFAULT_MODEL);

  useEffect(() => {
    const savedKeys = localStorage.getItem('gemini_api_keys');
    const savedIndex = localStorage.getItem('gemini_active_key_index');
    if (savedKeys) {
      const parsed = JSON.parse(savedKeys);
      setApiKeys(parsed);
      setActiveKeyIndex(savedIndex ? parseInt(savedIndex, 10) || 0 : 0);
    }

    // 加载保存的识别记录
    const savedRecords = localStorage.getItem('medical_records');
    if (savedRecords) {
      try {
        const parsed = JSON.parse(savedRecords);
        if (Array.isArray(parsed)) {
          setRecords(parsed);
        }
      } catch (e) {
        console.error('Failed to load saved records:', e);
      }
    }

    // 加载保存的模型选择
    const savedModel = localStorage.getItem('gemini_model');
    if (savedModel && savedModel in SUPPORTED_MODELS) {
      setSelectedModel(savedModel as ModelId);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('gemini_api_keys', JSON.stringify(apiKeys));
    localStorage.setItem('gemini_active_key_index', String(activeKeyIndex));
  }, [apiKeys, activeKeyIndex]);

  // 保存模型选择到 localStorage
  useEffect(() => {
    localStorage.setItem('gemini_model', selectedModel);
  }, [selectedModel]);

  // 保存识别记录到 localStorage
  useEffect(() => {
    if (records.length > 0) {
      localStorage.setItem('medical_records', JSON.stringify(records));
    }
  }, [records]);

  // 获取 API 统计数据
  const fetchApiStats = async () => {
    try {
      const resp = await fetch('/api/stats');
      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          setApiStats(data.stats);
        }
      }
    } catch (err) {
      console.error('Failed to fetch API stats:', err);
    }
  };

  // 初始加载和定期刷新统计数据
  useEffect(() => {
    fetchApiStats();
    const interval = setInterval(fetchApiStats, 30000); // 每30秒刷新
    return () => clearInterval(interval);
  }, []);

  // File input refs
  const imgInputRef = useRef<HTMLInputElement>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);

  // --- Helpers ---

  const generateId = () => `rec_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
          const base64 = result.split(",")[1] || "";
          resolve(base64);
        } else {
          reject(new Error("无法读取文件"));
        }
      };
      reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  };

  const formatDate = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  // --- Handlers ---

  const handleApiError = (err: any, filename: string) => {
    console.error(`Error processing ${filename}:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    return `"${filename}": ${errMsg}`;
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'excel') => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // 图片识别由后端处理，无需本地 API Key
    // Excel 解析也由后端处理，无需本地 API Key
    setIsProcessing(true);

    try {
      if (type === 'image') {
        let successCount = 0;
        let errors: string[] = [];

        // Loop through all selected images
        for (let i = 0; i < files.length; i++) {
          setStatusMsg(`正在识别第 ${i + 1} / ${files.length} 张图片...`);
          try {
            await processImage(files[i]);
            successCount++;
          } catch (err) {
            errors.push(handleApiError(err, files[i].name));
          }
        }

        if (errors.length > 0) {
          alert(`批量识别完成。\n成功: ${successCount} 张\n失败: ${errors.length} 张\n\n失败原因:\n${errors.join('\n')}`);
        }

      } else {
        // Excel usually single file
        setStatusMsg('正在解析表格...');
        try {
          await processExcel(files[0]);
        } catch (err) {
          alert(`Excel 解析失败: ${handleApiError(err, files[0].name)}`);
        }
      }
    } catch (err) {
      console.error("处理系统错误:", err);
      alert(`系统错误: ${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setIsProcessing(false);
      setStatusMsg('');
      if (e.target) e.target.value = ''; // reset input
    }
  };

  const processImage = async (file: File) => {
    // 通过后端 API 进行图片识别
    const formData = new FormData();
    formData.append('file', file);

    // 如果有本地 API Key，通过请求头传递（可选，服务器优先使用环境变量）
    const headers: Record<string, string> = {
      'x-gemini-model': selectedModel // 传递选择的模型
    };
    if (apiKeys.length > 0) {
      headers['x-gemini-api-key'] = apiKeys[activeKeyIndex];
    }

    const resp = await fetch('/api/analyze/image', {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => ({}));
      if (resp.status === 429) {
        throw new Error('API 请求频率限制，请稍后重试');
      }
      if (errorData.error === 'NO_API_KEY') {
        throw new Error('服务器未配置 API Key，请联系管理员或在设置中添加');
      }
      throw new Error(errorData.message || '图片识别失败');
    }

    const data = await resp.json();
    addRecordsFromData([data]);
    fetchApiStats(); // 刷新调用统计
  };

  const processExcel = async (file: File) => {
    if (!window.XLSX) throw new Error("Excel 组件加载中，请稍候再试");
    // Excel 解析由后端 API 处理，无需本地 API Key

    setStatusMsg('正在读取表格数据...');
    const arrayBuffer = await file.arrayBuffer();
    // Use cellDates: true to let SheetJS handle standard dates
    const workbook = window.XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];

    // 1. Get raw data (Array of Arrays)
    const jsonData = window.XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });

    if (!jsonData || jsonData.length === 0) throw new Error("表格为空");

    // 2. Find Header Row (Heuristic: Row with most strings)
    let headerRowIndex = 0;
    let maxStrings = 0;
    // Check first 10 rows
    for (let i = 0; i < Math.min(jsonData.length, 10); i++) {
      const row = jsonData[i] as any[];
      if (!row) continue;
      const strCount = row.filter(c => typeof c === 'string').length;
      if (strCount > maxStrings) {
        maxStrings = strCount;
        headerRowIndex = i;
      }
    }

    const headers = (jsonData[headerRowIndex] as any[]).map((val, idx) => ({
      index: idx,
      text: String(val || '').trim()
    })).filter(h => h.text.length > 0);

    setStatusMsg('正在分析表头结构 (AI)...');

    const order: number[] = [];
    for (let i = 0; i < apiKeys.length; i++) {
      order.push((activeKeyIndex + i) % apiKeys.length);
    }

    let mapData: any = null;
    let lastError: any = null;

    for (const idx of order) {
      const key = apiKeys[idx];
      const resp = await fetch('/api/analyze/excel-header', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gemini-api-key': key,
          'x-gemini-model': selectedModel, // 传递选择的模型
        },
        body: JSON.stringify({ headers }),
      });

      if (resp.status === 429) {
        lastError = new Error(`密钥 ${idx + 1} 触发频率限制`);
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || '服务器处理表头时出错');
      }

      mapData = await resp.json();
      setActiveKeyIndex(idx);
      break;
    }

    if (!mapData) {
      if (lastError) throw lastError;
      throw new Error("分析表头失败");
    }
    const dateColIdx = mapData.dateColumnIndex;
    const mappings = mapData.mappings || [];

    if (dateColIdx === undefined || dateColIdx === -1) {
      console.warn("AI failed to find date column, using 0");
    }

    // 4. Parse rows locally
    setStatusMsg(`正在解析 ${jsonData.length} 条数据...`);
    const newRecords: MedicalRecord[] = [];
    const usedDateCol = (dateColIdx !== undefined && dateColIdx !== -1) ? dateColIdx : 0;

    const dateRegex = /(\d{4})[\.\-\/](\d{1,2})[\.\-\/](\d{1,2})/;

    for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
      const row = jsonData[i] as any[];
      if (!row) continue;

      let dateVal = row[usedDateCol];
      let timestamp = 0;
      let isValidDate = false;
      let extraContext = "";

      if (dateVal instanceof Date) {
        timestamp = dateVal.getTime();
        isValidDate = true;
      } else if (typeof dateVal === 'string') {
        const strVal = dateVal.trim();
        const match = strVal.match(dateRegex);

        if (match) {
          const year = parseInt(match[1]);
          const month = parseInt(match[2]) - 1;
          const day = parseInt(match[3]);
          const d = new Date(year, month, day);
          if (!isNaN(d.getTime())) {
            timestamp = d.getTime();
            isValidDate = true;
            extraContext = strVal.replace(match[0], '').trim();
          }
        }
      }

      if (!isValidDate) continue;

      const items: MedicalItem[] = [];
      mappings.forEach((m: any) => {
        const val = row[m.columnIndex];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          let cleanVal = String(val).trim();
          cleanVal = cleanVal.replace(/[↑↓]/g, '');
          items.push({
            id: m.id || 'unknown',
            name: m.name || 'Unknown',
            value: cleanVal,
            unit: '',
            range: '',
            categoryName: m.category || '其他'
          });
        }
      });

      if (items.length > 0) {
        let recordTitle = '复查记录';
        let recordHospital = '';
        if (extraContext) {
          recordHospital = extraContext;
          if (extraContext.includes('住院')) recordTitle = '住院检查';
          else recordTitle = '门诊复查';
        }

        newRecords.push({
          id: generateId(),
          title: recordTitle,
          date: timestamp,
          hospital: recordHospital,
          doctor: '',
          nextReviewDate: timestamp + (30 * 24 * 60 * 60 * 1000),
          notes: '',
          prescription: '',
          configName: 'Excel 导入',
          items: items,
          medications: [],
          remarkPhotos: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    }

    if (newRecords.length === 0) {
      throw new Error("未能解析出有效数据行，请检查 Excel 日期列");
    }

    addRecordsFromData(newRecords);
  };

  const addRecordsFromData = (newRecs: any[]) => {
    const processed = newRecs.map(r => ({
      ...r,
      id: r.id || generateId(),
      items: r.items || [],
      medications: r.medications || [],
      remarkPhotos: r.remarkPhotos || [],
    }));

    setRecords(prev => {
      const combined = [...processed, ...prev];
      return combined.sort((a, b) => b.date - a.date);
    });
  };

  const handleDelete = (id: string) => {
    setRecords(prev => prev.filter(r => r.id !== id));
  };

  const handleExport = () => {
    if (records.length === 0) {
      alert("没有记录可导出");
      return;
    }
    const exportData: ExportFormat = {
      exportDate: formatDate(new Date()),
      medicalRecords: records
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kidney_records_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const updateRecord = (id: string, updatedFields: Partial<MedicalRecord>) => {
    setRecords(prev => prev.map(r => r.id === id ? { ...r, ...updatedFields } : r));
  };

  const selectedModelMeta = SUPPORTED_MODELS[selectedModel];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(191,219,254,0.9),transparent_32%),radial-gradient(circle_at_top_right,rgba(167,243,208,0.6),transparent_30%),linear-gradient(180deg,#f8fafc_0%,#eef2f7_48%,#f7f9fc_100%)] pb-20 font-['SF_Pro_Display','SF_Pro_Text','PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei','sans-serif'] text-slate-800">
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        keys={apiKeys}
        activeKeyIndex={activeKeyIndex}
        onAddKey={(key) => {
          setApiKeys(prev => {
            if (prev.length >= 3) {
              alert("最多只能保存 3 个密钥，请先删除一个。");
              return prev;
            }
            const next = [...prev, key];
            setActiveKeyIndex(next.length - 1);
            return next;
          });
        }}
        onDeleteKey={(idx) => {
          setApiKeys(prev => {
            const next = prev.filter((_, i) => i !== idx);
            if (next.length === 0) {
              setActiveKeyIndex(0);
            } else if (activeKeyIndex >= idx) {
              setActiveKeyIndex(Math.max(0, activeKeyIndex - 1));
            }
            return next;
          });
        }}
        onSelectKey={setActiveKeyIndex}
      />

      <header className="sticky top-0 z-20 border-b border-white/60 bg-white/55 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-5 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div>
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.8)]">Lab Vision</div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[30px]">检查单识别助手</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                <span>自动识别 · 智能解析</span>
                {apiKeys.length > 0 && (
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">当前 Key {activeKeyIndex + 1}/{apiKeys.length}</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 lg:justify-end">
            {apiStats && (
              <div className="group relative">
                <div className="flex cursor-default items-center gap-2 rounded-[22px] border border-white/70 bg-white/70 px-4 py-3 shadow-[0_18px_40px_-30px_rgba(15,23,42,0.8)] backdrop-blur-xl">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,#dbeafe_0%,#bfdbfe_100%)] text-blue-700"><ChartIcon /></span>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">API Calls</div>
                    <div className="flex items-baseline gap-1"><span className="text-lg font-semibold text-slate-900">{apiStats.totalCalls}</span><span className="text-xs text-slate-500">次调用</span></div>
                  </div>
                </div>
                <div className="invisible absolute right-0 top-full z-30 mt-3 min-w-[220px] rounded-[24px] border border-white/80 bg-white/92 p-4 opacity-0 shadow-[0_30px_80px_-42px_rgba(15,23,42,0.5)] backdrop-blur-2xl transition-all duration-200 group-hover:visible group-hover:opacity-100">
                  <div className="mb-3 border-b border-slate-100 pb-2 text-xs font-semibold tracking-wide text-slate-600">API 调用统计</div>
                  <div className="space-y-2.5 text-sm text-slate-600">
                    <div className="flex items-center justify-between"><span>图片识别 (网页)</span><span className="font-semibold text-slate-900">{apiStats.imageAnalyze}</span></div>
                    <div className="flex items-center justify-between"><span>图片识别 (小程序)</span><span className="font-semibold text-slate-900">{apiStats.imageBase64Analyze}</span></div>
                    <div className="flex items-center justify-between"><span>Excel 分析</span><span className="font-semibold text-slate-900">{apiStats.excelAnalyze}</span></div>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500"><span>运行时间</span><span>{apiStats.uptime.display}</span></div>
                </div>
              </div>
            )}

            <div className="group relative">
              <button className="flex cursor-pointer items-center gap-3 rounded-[22px] border border-white/70 bg-white/72 px-4 py-3 shadow-[0_18px_40px_-30px_rgba(15,23,42,0.8)] backdrop-blur-xl transition-all hover:bg-white/88" title="切换识别模型">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,#fef3c7_0%,#fde68a_100%)] text-amber-700"><RobotIcon /></span>
                <div className="hidden text-left sm:block">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Model</div>
                  <div className="text-sm font-medium text-slate-800">{selectedModelMeta.name}</div>
                </div>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-600">{selectedModelMeta.badge}</span>
                <ChevronIcon className="h-4 w-4 text-slate-400" />
              </button>
              <div className="invisible absolute right-0 top-full z-30 mt-3 min-w-[300px] rounded-[26px] border border-white/80 bg-white/94 p-2 opacity-0 shadow-[0_30px_80px_-42px_rgba(15,23,42,0.5)] backdrop-blur-2xl transition-all duration-200 group-hover:visible group-hover:opacity-100">
                <div className="px-3 py-2 text-xs font-semibold tracking-wide text-slate-500">选择识别模型</div>
                {(Object.entries(SUPPORTED_MODELS) as [ModelId, typeof SUPPORTED_MODELS[ModelId]][]).map(([id, model]) => (
                  <button key={id} onClick={() => setSelectedModel(id)} className={`flex w-full items-start gap-3 rounded-[20px] px-3 py-3 text-left transition-all ${selectedModel === id ? 'bg-amber-50 ring-1 ring-amber-200' : 'hover:bg-slate-50'}`}>
                    <div className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border ${selectedModel === id ? 'border-amber-500 bg-amber-100' : 'border-slate-300 bg-white'}`}>
                      {selectedModel === id && <div className="h-2.5 w-2.5 rounded-full bg-amber-500"></div>}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2"><span className={`text-sm font-medium ${selectedModel === id ? 'text-amber-800' : 'text-slate-800'}`}>{model.fullName}</span><span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500">{model.badge}</span></div>
                      <p className="mt-1 text-xs text-slate-500">{model.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <button onClick={() => setShowSettings(true)} className="flex h-12 w-12 items-center justify-center rounded-[20px] border border-white/70 bg-white/72 text-slate-600 shadow-[0_18px_40px_-30px_rgba(15,23,42,0.8)] backdrop-blur-xl transition-all hover:bg-white hover:text-slate-900" title="API 设置">
              <SettingsIcon />
            </button>

            <button onClick={handleExport} disabled={records.length === 0} className={`flex items-center gap-2 rounded-[22px] px-5 py-3 text-sm font-medium transition-all ${records.length === 0 ? 'cursor-not-allowed border border-slate-200 bg-slate-100/90 text-slate-400' : 'border border-blue-400/20 bg-[linear-gradient(135deg,#2563eb_0%,#1d4ed8_48%,#1e40af_100%)] text-white shadow-[0_24px_40px_-24px_rgba(37,99,235,0.85)] hover:-translate-y-0.5 hover:shadow-[0_30px_45px_-24px_rgba(37,99,235,0.85)]'}`}>
              <ExportIcon />
              <span>导出</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 lg:px-6">
        <section className="relative overflow-hidden rounded-[36px] border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.92)_0%,rgba(248,250,252,0.88)_100%)] p-6 shadow-[0_30px_80px_-46px_rgba(15,23,42,0.35)] backdrop-blur-2xl sm:p-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.16),transparent_24%),radial-gradient(circle_at_top_right,rgba(16,185,129,0.14),transparent_22%)]"></div>
          <div className="relative flex flex-col gap-8">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <span className="inline-flex rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Data Intake</span>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[32px]">添加数据源</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">用更轻盈、圆润的工作台体验整理化验单。上传图片或 Excel 即可，流程与原来一致，仅调整界面视觉与交互外观。</p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:flex">
                <div className="rounded-[24px] border border-white/70 bg-white/80 px-4 py-3 shadow-[0_20px_40px_-34px_rgba(15,23,42,0.8)]"><div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">模型</div><div className="mt-1 text-sm font-medium text-slate-800">{selectedModelMeta.fullName}</div></div>
                <div className="rounded-[24px] border border-white/70 bg-white/80 px-4 py-3 shadow-[0_20px_40px_-34px_rgba(15,23,42,0.8)]"><div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">记录总数</div><div className="mt-1 text-sm font-medium text-slate-800">{records.length} 条</div></div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div onClick={() => imgInputRef.current?.click()} className="group relative cursor-pointer overflow-hidden rounded-[30px] border border-blue-200/70 bg-[linear-gradient(145deg,rgba(239,246,255,0.96)_0%,rgba(255,255,255,0.9)_100%)] p-8 shadow-[0_28px_60px_-40px_rgba(59,130,246,0.7)] transition-all duration-300 hover:-translate-y-1 hover:border-blue-300">
                <div className="absolute -right-14 -top-14 h-36 w-36 rounded-full bg-blue-200/30 blur-3xl transition-transform duration-500 group-hover:scale-125"></div>
                <div className="relative">
                  <div className="flex h-20 w-20 items-center justify-center rounded-[28px] border border-white/80 bg-white/88 text-blue-600 shadow-[0_22px_40px_-28px_rgba(59,130,246,0.85)]"><CameraIcon /></div>
                  <h3 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">识别图片</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-500">支持多张上传，自动提取化验指标与记录信息，适合拍照录入最新检查单。</p>
                  <div className="mt-6 flex flex-wrap gap-2 text-xs text-blue-700"><span className="rounded-full border border-blue-200 bg-white/80 px-3 py-1">多图上传</span><span className="rounded-full border border-blue-200 bg-white/80 px-3 py-1">自动识别</span></div>
                </div>
                <input ref={imgInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleFileUpload(e, 'image')} />
              </div>

              <div onClick={() => excelInputRef.current?.click()} className="group relative cursor-pointer overflow-hidden rounded-[30px] border border-emerald-200/70 bg-[linear-gradient(145deg,rgba(236,253,245,0.96)_0%,rgba(255,255,255,0.9)_100%)] p-8 shadow-[0_28px_60px_-40px_rgba(16,185,129,0.7)] transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300">
                <div className="absolute -right-14 -top-14 h-36 w-36 rounded-full bg-emerald-200/30 blur-3xl transition-transform duration-500 group-hover:scale-125"></div>
                <div className="relative">
                  <div className="flex h-20 w-20 items-center justify-center rounded-[28px] border border-white/80 bg-white/88 text-emerald-600 shadow-[0_22px_40px_-28px_rgba(16,185,129,0.85)]"><ExcelIcon /></div>
                  <h3 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900">读取 Excel</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-500">支持 `.xlsx` / `.xls` 批量导入历史数据，适合已有整理表格的一次性同步。</p>
                  <div className="mt-6 flex flex-wrap gap-2 text-xs text-emerald-700"><span className="rounded-full border border-emerald-200 bg-white/80 px-3 py-1">历史导入</span><span className="rounded-full border border-emerald-200 bg-white/80 px-3 py-1">批量解析</span></div>
                </div>
                <input ref={excelInputRef} type="file" accept=".xlsx, .xls" className="hidden" onChange={(e) => handleFileUpload(e, 'excel')} />
              </div>
            </div>

            {isProcessing && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-[36px] bg-white/72 backdrop-blur-2xl">
                <div className="loader h-14 w-14 rounded-full border-4 border-slate-200 border-t-blue-500"></div>
                <p className="mt-5 animate-pulse text-base font-medium text-slate-700">{statusMsg}</p>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-5">
          <div className="flex flex-col gap-4 px-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Records</div>
              <h2 className="mt-2 flex items-center gap-3 text-2xl font-semibold tracking-tight text-slate-900"><span>已解析记录</span><span className="rounded-full border border-white/80 bg-white/80 px-3 py-1 text-xs font-medium text-slate-500 shadow-[0_18px_40px_-34px_rgba(15,23,42,0.8)]">{records.length}</span></h2>
            </div>
            {records.length > 0 && (
              <button onClick={() => { setRecords([]); localStorage.removeItem('medical_records'); }} className="inline-flex items-center justify-center rounded-full border border-red-200 bg-white/80 px-4 py-2 text-sm font-medium text-red-500 transition-all hover:border-red-300 hover:bg-red-50">清空列表</button>
            )}
          </div>

          {records.length === 0 && !isProcessing && (
            <div className="rounded-[34px] border border-white/80 bg-white/82 px-6 py-16 text-center shadow-[0_30px_80px_-46px_rgba(15,23,42,0.35)] backdrop-blur-2xl">
              <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-[linear-gradient(145deg,#eff6ff_0%,#ecfeff_100%)] text-slate-400 shadow-inner">
                <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10"><path d="M7 5.75h10A2.25 2.25 0 0 1 19.25 8v8A2.25 2.25 0 0 1 17 18.25H7A2.25 2.25 0 0 1 4.75 16V8A2.25 2.25 0 0 1 7 5.75Z" stroke="currentColor" strokeWidth="1.7"/><path d="M8.75 10.25h6.5M8.75 13.75h4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>
              </div>
              <p className="mt-5 text-lg font-medium text-slate-700">还没有解析记录</p>
              <p className="mt-2 text-sm text-slate-500">上传化验单图片或 Excel 后，结果会以更清晰的卡片方式呈现。</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4">
            {records.map((record) => (
              <RecordCard key={record.id} record={record} onDelete={handleDelete} onUpdate={updateRecord} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

// --- Sub-Components ---

interface RecordCardProps {
  record: MedicalRecord;
  onDelete: (id: string) => void;
  onUpdate: (id: string, data: Partial<MedicalRecord>) => void;
}

const RecordCard: React.FC<RecordCardProps> = ({ record, onDelete, onUpdate }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const recordDate = new Date(record.date);
  const monthDay = `${recordDate.getMonth() + 1}/${recordDate.getDate()}`;
  const fullDate = recordDate.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const handleItemChange = (index: number, field: string, val: string) => {
    const newItems = [...record.items];
    newItems[index] = { ...newItems[index], [field]: val };
    onUpdate(record.id, { items: newItems });
  };

  const addItem = () => {
    onUpdate(record.id, {
      items: [...record.items, { id: '', name: '', value: '', unit: '', range: '', categoryName: '其他' }]
    });
  };

  const removeItem = (index: number) => {
    const newItems = record.items.filter((_, i) => i !== index);
    onUpdate(record.id, { items: newItems });
  };

  return (
    <div className="overflow-hidden rounded-[30px] border border-white/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.92)_0%,rgba(248,250,252,0.86)_100%)] shadow-[0_30px_70px_-48px_rgba(15,23,42,0.5)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_36px_80px_-46px_rgba(15,23,42,0.45)]">
      <div className="flex cursor-pointer flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-center gap-4 sm:gap-5">
          <div className={`flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-[24px] text-white shadow-[0_20px_40px_-26px_rgba(15,23,42,0.6)] ${record.hospital ? 'bg-[linear-gradient(135deg,#34d399_0%,#059669_100%)]' : 'bg-[linear-gradient(135deg,#60a5fa_0%,#2563eb_100%)]'}`}>
            <span className="text-[11px] font-medium opacity-80">{recordDate.getFullYear()}</span>
            <span className="text-lg font-semibold leading-none">{monthDay}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold tracking-tight text-slate-900">{record.title}</h3>
              {record.hospital && <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-500">{record.hospital}</span>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <span className="rounded-full border border-slate-200 bg-slate-50/90 px-3 py-1">{record.configName}</span>
              <span>{record.items.length} 项指标</span>
              <span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block"></span>
              <span>{fullDate}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button onClick={(e) => { e.stopPropagation(); onDelete(record.id); }} className="flex h-11 w-11 items-center justify-center rounded-full border border-transparent bg-white/70 text-slate-400 transition-all hover:border-red-100 hover:bg-red-50 hover:text-red-500">
            <TrashIcon className="h-4.5 w-4.5" />
          </button>
          <div className={`flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white/70 text-slate-400 transition-all duration-300 ${isExpanded ? 'rotate-180 text-slate-700' : ''}`}>
            <ChevronIcon className="h-4 w-4" />
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-white/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.82)_0%,rgba(241,245,249,0.65)_100%)] p-5 sm:p-6">
          <div className="mb-6 grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">标题</label>
              <input value={record.title} onChange={(e) => onUpdate(record.id, { title: e.target.value })} className="w-full rounded-[18px] border border-white/80 bg-white/88 px-4 py-3 text-sm text-slate-700 outline-none transition-all placeholder:text-slate-300 focus:border-blue-300 focus:ring-4 focus:ring-blue-100" />
            </div>
            <div>
              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">医院/来源</label>
              <input value={record.hospital} onChange={(e) => onUpdate(record.id, { hospital: e.target.value })} className="w-full rounded-[18px] border border-white/80 bg-white/88 px-4 py-3 text-sm text-slate-700 outline-none transition-all placeholder:text-slate-300 focus:border-blue-300 focus:ring-4 focus:ring-blue-100" />
            </div>
            <div className="md:col-span-2">
              <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">日期 (自动校准)</label>
              <input type="datetime-local" value={recordDate.toISOString().slice(0, 16)} onChange={(e) => onUpdate(record.id, { date: new Date(e.target.value).getTime() })} className="w-full rounded-[18px] border border-white/80 bg-white/88 px-4 py-3 text-sm text-slate-700 outline-none transition-all focus:border-blue-300 focus:ring-4 focus:ring-blue-100" />
            </div>
          </div>

          <div className="overflow-hidden rounded-[26px] border border-white/80 bg-white/88 shadow-[0_20px_50px_-42px_rgba(15,23,42,0.75)]">
            <div className="flex flex-col gap-3 border-b border-slate-100 bg-slate-50/85 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div>
                <h4 className="text-sm font-semibold text-slate-800">检查项目明细</h4>
                <p className="mt-1 text-xs text-slate-500">仅调整视觉样式，编辑逻辑与原有行为保持一致。</p>
              </div>
              <button onClick={addItem} className="inline-flex items-center justify-center rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-700 transition-all hover:border-blue-300 hover:bg-blue-100">+ 添加项目</button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-slate-50/90 text-[11px] uppercase tracking-[0.16em] text-slate-400">
                  <tr>
                    <th className="px-5 py-3 font-semibold">代码 (ID)</th>
                    <th className="px-5 py-3 font-semibold">项目名称</th>
                    <th className="px-5 py-3 font-semibold">结果值</th>
                    <th className="px-5 py-3 font-semibold">单位</th>
                    <th className="w-12 px-5 py-3 text-right font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {record.items.map((item, idx) => (
                    <tr key={idx} className="group transition-colors hover:bg-slate-50/80">
                      <td className="px-5 py-3">
                        <input value={item.id} onChange={(e) => handleItemChange(idx, 'id', e.target.value)} placeholder="code" className="w-full rounded-xl border border-transparent bg-transparent px-2 py-2 font-mono text-xs text-blue-600 outline-none transition-all focus:border-blue-100 focus:bg-blue-50/70" />
                      </td>
                      <td className="px-5 py-3">
                        <input value={item.name} onChange={(e) => handleItemChange(idx, 'name', e.target.value)} className="w-full rounded-xl border border-transparent bg-transparent px-2 py-2 font-medium text-slate-700 outline-none transition-all focus:border-slate-200 focus:bg-slate-50" />
                      </td>
                      <td className="px-5 py-3">
                        <input value={item.value} onChange={(e) => handleItemChange(idx, 'value', e.target.value)} className="w-full rounded-xl border border-transparent bg-transparent px-2 py-2 font-semibold text-slate-900 outline-none transition-all focus:border-blue-100 focus:bg-blue-50/70" />
                      </td>
                      <td className="px-5 py-3">
                        <input value={item.unit} onChange={(e) => handleItemChange(idx, 'unit', e.target.value)} className="w-full rounded-xl border border-transparent bg-transparent px-2 py-2 text-xs text-slate-500 outline-none transition-all focus:border-slate-200 focus:bg-slate-50" />
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button onClick={() => removeItem(idx)} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-300 transition-all hover:bg-red-50 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100">
                          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
