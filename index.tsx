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

// --- Helper Functions ---

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
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
        <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 flex justify-between items-center">
          <h3 className="font-bold text-lg text-gray-800">API 密钥设置</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <i className="fa-solid fa-xmark text-xl"></i>
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Add New Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">添加新密钥 (Gemini API Key)</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                placeholder="AIzaSy..."
                className="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
              />
              <button
                onClick={handleAdd}
                disabled={!inputKey}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                添加
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              密钥将保存在本地浏览器中，并通过加密连接发送到本应用服务器。
            </p>
          </div>

          {/* Key List */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 mb-3">可用密钥列表</h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {keys.length === 0 ? (
                <div className="text-center py-4 bg-gray-50 rounded-lg border border-dashed border-gray-200 text-gray-400 text-sm">
                  暂无密钥，请先添加
                </div>
              ) : (
                keys.map((k, idx) => (
                  <div
                    key={idx}
                    onClick={() => onSelectKey(idx)}
                    className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all ${activeKeyIndex === idx ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${activeKeyIndex === idx ? 'border-blue-600' : 'border-gray-300'}`}>
                        {activeKeyIndex === idx && <div className="w-2 h-2 bg-blue-600 rounded-full"></div>}
                      </div>
                      <div className="flex flex-col truncate">
                        <span className={`text-sm font-medium truncate ${activeKeyIndex === idx ? 'text-blue-700' : 'text-gray-700'}`}>
                          密钥 {idx + 1}
                        </span>
                        <span className="text-xs text-gray-400 truncate w-32">
                          {k.substring(0, 8)}...{k.substring(k.length - 4)}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteKey(idx); }}
                      className="text-gray-400 hover:text-red-500 p-2 transition-colors"
                    >
                      <i className="fa-solid fa-trash-can"></i>
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="bg-gray-50 px-6 py-4 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-colors"
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

  useEffect(() => {
    const savedKeys = localStorage.getItem('gemini_api_keys');
    const savedIndex = localStorage.getItem('gemini_active_key_index');
    if (savedKeys) {
      const parsed = JSON.parse(savedKeys);
      setApiKeys(parsed);
      setActiveKeyIndex(savedIndex ? parseInt(savedIndex, 10) || 0 : 0);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('gemini_api_keys', JSON.stringify(apiKeys));
    localStorage.setItem('gemini_active_key_index', String(activeKeyIndex));
  }, [apiKeys, activeKeyIndex]);

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
    const headers: Record<string, string> = {};
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

  return (
    <div className="min-h-screen pb-20 font-sans text-gray-800 bg-gray-50">
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

      <header className="bg-white shadow-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-600 text-white p-2 rounded-lg shadow-blue-200 shadow-md">
              <i className="fa-solid fa-file-medical text-xl"></i>
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-800 tracking-tight">检查单识别助手</h1>
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-500">自动识别 · 智能解析</p>
                {apiKeys.length > 0 && (
                  <span className="text-[10px] bg-green-100 text-green-600 px-1.5 py-0.5 rounded border border-green-200">
                    当前 Key: {activeKeyIndex + 1}/{apiKeys.length}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setShowSettings(true)}
              className="w-10 h-10 rounded-xl bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900 transition-colors flex items-center justify-center"
              title="API 设置"
            >
              <i className="fa-solid fa-gear"></i>
            </button>
            <button
              onClick={handleExport}
              disabled={records.length === 0}
              className={`px-4 py-2.5 rounded-xl font-medium transition-all shadow-sm flex items-center space-x-2 ${records.length === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-md active:scale-95'}`}
            >
              <i className="fa-solid fa-download"></i>
              <span className="hidden sm:inline">导出</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Upload Area */}
        <section className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100 text-center relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-400 to-green-400"></div>
          <h2 className="text-xl font-bold mb-8 text-gray-800">添加数据源</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Image Upload */}
            <div
              onClick={() => imgInputRef.current?.click()}
              className="group relative border-2 border-dashed border-blue-200 bg-blue-50/50 rounded-2xl p-10 cursor-pointer hover:bg-blue-50 hover:border-blue-400 transition-all duration-300"
            >
              <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mx-auto mb-6 text-blue-500 shadow-sm group-hover:scale-110 group-hover:shadow-md transition-all duration-300">
                <i className="fa-solid fa-camera text-3xl"></i>
              </div>
              <h3 className="text-lg font-bold text-blue-900 mb-2">识别图片</h3>
              <p className="text-sm text-blue-600/80">支持多张上传<br />自动提取各项指标</p>
              <input ref={imgInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => handleFileUpload(e, 'image')} />
            </div>

            {/* Excel Upload */}
            <div
              onClick={() => excelInputRef.current?.click()}
              className="group relative border-2 border-dashed border-emerald-200 bg-emerald-50/50 rounded-2xl p-10 cursor-pointer hover:bg-emerald-50 hover:border-emerald-400 transition-all duration-300"
            >
              <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mx-auto mb-6 text-emerald-500 shadow-sm group-hover:scale-110 group-hover:shadow-md transition-all duration-300">
                <i className="fa-solid fa-file-excel text-3xl"></i>
              </div>
              <h3 className="text-lg font-bold text-emerald-900 mb-2">读取 Excel</h3>
              <p className="text-sm text-emerald-600/80">支持 .xlsx / .xls<br />批量导入历史数据</p>
              <input ref={excelInputRef} type="file" accept=".xlsx, .xls" className="hidden" onChange={(e) => handleFileUpload(e, 'excel')} />
            </div>
          </div>

          {/* Loading Indicator */}
          {isProcessing && (
            <div className="absolute inset-0 bg-white/90 backdrop-blur-sm flex flex-col items-center justify-center z-10 rounded-3xl">
              <div className="loader ease-linear rounded-full border-4 border-t-4 border-blue-500 h-12 w-12 mb-4"></div>
              <p className="text-gray-700 font-medium text-lg animate-pulse">{statusMsg}</p>
            </div>
          )}
        </section>

        {/* Records List */}
        <section className="space-y-6">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <span>已解析记录</span>
              <span className="bg-gray-200 text-gray-600 text-xs py-1 px-2 rounded-full">{records.length}</span>
            </h2>
            {records.length > 0 && (
              <button onClick={() => setRecords([])} className="text-sm text-red-500 hover:text-red-700 hover:bg-red-50 px-3 py-1 rounded-lg transition-colors">
                清空列表
              </button>
            )}
          </div>

          {records.length === 0 && !isProcessing && (
            <div className="text-center py-16 bg-white rounded-3xl border border-gray-100 shadow-sm">
              <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4 text-gray-300">
                <i className="fa-solid fa-clipboard-list text-4xl"></i>
              </div>
              <p className="text-gray-500 font-medium">暂无数据</p>
              <p className="text-gray-400 text-sm mt-1">请上传化验单图片或 Excel 表格</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4">
            {records.map((record) => (
              <RecordCard
                key={record.id}
                record={record}
                onDelete={handleDelete}
                onUpdate={updateRecord}
              />
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
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-all duration-300">
      {/* Card Header */}
      <div className="p-5 flex items-center justify-between cursor-pointer bg-white" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-center space-x-5">
          <div className={`w-14 h-14 rounded-2xl flex flex-col items-center justify-center font-bold text-white shadow-sm ${record.hospital ? 'bg-emerald-500' : 'bg-blue-500'}`}>
            <span className="text-xs opacity-80">{new Date(record.date).getFullYear()}</span>
            <span className="text-lg leading-none">{new Date(record.date).getMonth() + 1}/{new Date(record.date).getDate()}</span>
          </div>
          <div>
            <div className="flex items-baseline space-x-2">
              <h3 className="font-bold text-gray-900 text-lg">{record.title}</h3>
              {record.hospital && <span className="text-sm text-gray-500 bg-gray-100 px-1.5 rounded">{record.hospital}</span>}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
              <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600">{record.configName}</span>
              <span>{record.items.length} 项指标</span>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(record.id); }}
            className="w-10 h-10 rounded-full flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          >
            <i className="fa-solid fa-trash"></i>
          </button>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-gray-400 transition-transform duration-300 ${isExpanded ? 'rotate-180 bg-gray-100' : ''}`}>
            <i className="fa-solid fa-chevron-down"></i>
          </div>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="p-6 border-t border-gray-100 bg-gray-50/50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
            <div className="form-group">
              <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">标题</label>
              <input
                value={record.title}
                onChange={(e) => onUpdate(record.id, { title: e.target.value })}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
              />
            </div>
            <div className="form-group">
              <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">医院/来源</label>
              <input
                value={record.hospital}
                onChange={(e) => onUpdate(record.id, { hospital: e.target.value })}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
              />
            </div>
            <div className="form-group md:col-span-2">
              <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">日期 (自动校准)</label>
              <input
                type="datetime-local"
                value={new Date(record.date).toISOString().slice(0, 16)}
                onChange={(e) => onUpdate(record.id, { date: new Date(e.target.value).getTime() })}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
              />
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
              <h4 className="font-semibold text-sm text-gray-700">检查项目明细</h4>
              <button onClick={addItem} className="text-xs bg-blue-50 text-blue-600 hover:bg-blue-100 px-3 py-1.5 rounded-md font-medium transition-colors">
                + 添加项目
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-gray-400 uppercase bg-gray-50/50">
                  <tr>
                    <th className="px-4 py-3 font-medium">代码 (ID)</th>
                    <th className="px-4 py-3 font-medium">项目名称</th>
                    <th className="px-4 py-3 font-medium">结果值</th>
                    <th className="px-4 py-3 font-medium">单位</th>
                    <th className="px-4 py-3 font-medium w-10">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {record.items.map((item, idx) => (
                    <tr key={idx} className="hover:bg-blue-50/30 transition-colors group">
                      <td className="p-2 pl-4">
                        <input
                          value={item.id}
                          onChange={(e) => handleItemChange(idx, 'id', e.target.value)}
                          placeholder="code"
                          className="w-full bg-transparent border-b border-transparent focus:border-blue-300 focus:outline-none py-1 font-mono text-xs text-blue-600"
                        />
                      </td>
                      <td className="p-2">
                        <input
                          value={item.name}
                          onChange={(e) => handleItemChange(idx, 'name', e.target.value)}
                          className="w-full bg-transparent border-b border-transparent focus:border-blue-300 focus:outline-none py-1 font-medium text-gray-700"
                        />
                      </td>
                      <td className="p-2">
                        <input
                          value={item.value}
                          onChange={(e) => handleItemChange(idx, 'value', e.target.value)}
                          className="w-full bg-transparent border-b border-transparent focus:border-blue-300 focus:outline-none py-1 font-bold text-gray-900"
                        />
                      </td>
                      <td className="p-2">
                        <input
                          value={item.unit}
                          onChange={(e) => handleItemChange(idx, 'unit', e.target.value)}
                          className="w-full bg-transparent border-b border-transparent focus:border-blue-300 focus:outline-none py-1 text-gray-400 text-xs"
                        />
                      </td>
                      <td className="p-2 pr-4 text-center">
                        <button onClick={() => removeItem(idx)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                          <i className="fa-solid fa-xmark"></i>
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
