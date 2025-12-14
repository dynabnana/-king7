# 检查单识别助手 - 部署指南

## Zeabur 部署配置

### 1. 环境变量配置

在 Zeabur 控制台中，进入你的服务 → **环境变量** → 添加以下变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `GEMINI_API_KEY` | Gemini API 密钥（必需）。支持多个密钥，用英文逗号分隔 | `AIzaSy...xxx,AIzaSy...yyy` |
| `PORT` | 服务端口（可选，Zeabur 会自动设置） | `3000` |

⚠️ **重要**：配置多个 API Key 可以提高并发能力，服务器会自动轮换使用。

### 2. 构建命令

Zeabur 应该会自动检测到这是一个 Node.js 项目。如果需要手动配置：

- **构建命令**: `npm install && npm run build`
- **启动命令**: `npm start`

### 3. 验证部署

部署成功后，访问以下 URL 验证服务状态：

```
https://你的域名.zeabur.app/api/health
```

返回示例：
```json
{
  "ok": true,
  "version": "v2",
  "hasEnvKey": true,
  "keyCount": 2,
  "timestamp": 1702500000000
}
```

如果 `hasEnvKey` 为 `true`，说明环境变量配置成功。

---

## 小程序调用指南

### API 端点

#### 图片识别（Base64 格式 - 推荐小程序使用）

**POST** `/api/analyze/image-base64`

**请求体**:
```json
{
  "base64": "图片的 Base64 编码（可包含 data URL 前缀）",
  "mimeType": "image/jpeg"  // 可选，默认 image/jpeg
}
```

**响应示例**:
```json
{
  "title": "复查记录",
  "date": 1702396800000,
  "hospital": "北京协和医院",
  "doctor": "张医生",
  "notes": "肾功能检查",
  "configName": "肾功能常规",
  "items": [
    {
      "id": "scr",
      "name": "血肌酐",
      "value": "85",
      "unit": "μmol/L",
      "range": "45-84",
      "categoryName": "肾功能"
    }
  ]
}
```

#### 图片识别（FormData 格式 - 网页使用）

**POST** `/api/analyze/image`

使用 `multipart/form-data` 格式，文件字段名为 `file`。

---

### 小程序示例代码

```javascript
// 在小程序中调用识别 API
async function recognizeMedicalReport(tempFilePath) {
  try {
    // 1. 读取图片为 base64
    const fileSystemManager = wx.getFileSystemManager();
    const base64 = fileSystemManager.readFileSync(tempFilePath, 'base64');
    
    // 2. 调用后端 API
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: 'https://你的域名.zeabur.app/api/analyze/image-base64',
        method: 'POST',
        header: {
          'Content-Type': 'application/json'
        },
        data: {
          base64: base64,
          mimeType: 'image/jpeg'
        },
        success: (res) => resolve(res),
        fail: (err) => reject(err)
      });
    });
    
    if (res.statusCode === 200) {
      console.log('识别结果:', res.data);
      return res.data;
    } else {
      console.error('识别失败:', res.data);
      throw new Error(res.data.message || '识别失败');
    }
  } catch (err) {
    console.error('请求错误:', err);
    throw err;
  }
}

// 使用示例
wx.chooseImage({
  count: 1,
  success: async (res) => {
    const tempFilePath = res.tempFilePaths[0];
    try {
      const result = await recognizeMedicalReport(tempFilePath);
      // 处理识别结果...
    } catch (err) {
      wx.showToast({
        title: err.message,
        icon: 'none'
      });
    }
  }
});
```

---

## 错误处理

| HTTP 状态码 | 错误类型 | 说明 |
|-------------|----------|------|
| 400 | `NO_API_KEY` | 服务器未配置 API Key |
| 429 | `RATE_LIMIT` | API 请求频率超限，稍后重试 |
| 500 | `IMAGE_ANALYZE_FAILED` | 图片识别失败 |

---

## 本地开发

```bash
# 安装依赖
npm install

# 开发模式（仅前端）
npm run dev

# 构建生产版本
npm run build

# 启动服务器（需要先构建）
npm start
```

本地开发时，可以在项目根目录创建 `.env` 文件（不要提交到 Git）：

```env
GEMINI_API_KEY=AIzaSy...xxx
PORT=3000
```

注意：需要安装 dotenv 包来读取 `.env` 文件，或者直接在终端设置环境变量：

```powershell
# Windows PowerShell
$env:GEMINI_API_KEY="AIzaSy...xxx"
npm start
```
