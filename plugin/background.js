/**
 * Chrome Extension Background Worker (Service Worker)
 * 职责：
 * 1. 拦截注册的系统全局命令(Alt+G)
 * 2. 调度并分发给激活选项卡下的 content.js 脚本
 * 3. 代理 API 请求以绕过 HTTPS 页面上的 Mixed Content 限制
 */

const FETCH_TIMEOUT_MS = 8000;
// 产物（录像几 MB）下载 / 文件参数上传超时单独放宽
const ARTIFACT_TIMEOUT_MS = 60000;

const DEFAULT_BASE_URL = "https://api.skillcloud.cn";
// 本机/内网调试端点仍走 http，其余一律 https
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?$/i;

// 归一化 API 基址：兼容用户输入与历史无协议存量值
function normalizeBaseUrl(raw) {
  const v = String(raw || "").trim().replace(/\/+$/, "");
  if (!v) return DEFAULT_BASE_URL;
  if (/^https?:\/\//i.test(v)) return v;
  return `${LOCAL_HOST_RE.test(v) ? "http" : "https"}://${v}`;
}

function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-guide") {
//     console.log("[Background] 捕获快捷键命令 Alt + G，正在激活对应的选项卡...");

    // 查询当前活跃选项卡
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-guide" }, () => {
          if (chrome.runtime.lastError) {
//             console.log("[Background] 当前页面不支持注入插件脚本:", chrome.runtime.lastError.message);
          }
        });
      }
    });
  }
});

// 代理 REST 请求：统一拼接 URL、超时控制、错误处理
function proxyRestRequest(method, params, sendResponse) {
  chrome.storage.local.get(["appguide_apiBaseUrl"], (result) => {
    const baseUrl = normalizeBaseUrl(result.appguide_apiBaseUrl);
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const fetchUrl = `${baseUrl}/rest?method=${encodeURIComponent(method)}&${qs}`;

//     console.log(`[Background] 代理请求 ${method}:`, fetchUrl);

    fetchWithTimeout(fetchUrl)
      .then(res => res.json())
      .then(data => sendResponse({ success: true, data }))
      .catch(err => {
//         console.error(`[Background] ${method} 失败:`, err);
        sendResponse({ success: false, error: err.name === "AbortError" ? "请求超时" : err.message });
      });
  });
}

// 代理 POST 请求：/rest?method=... + JSON body。
// 执行 RPA（appguide.rpa.run）是唯一需要请求体的 method —— 必须走 POST。
function proxyPostRequest(method, params, body, sendResponse) {
  chrome.storage.local.get(["appguide_apiBaseUrl"], (result) => {
    const baseUrl = normalizeBaseUrl(result.appguide_apiBaseUrl);
    const qs = Object.entries(params || {})
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const fetchUrl = `${baseUrl}/rest?method=${encodeURIComponent(method)}${qs ? "&" + qs : ""}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetch(fetchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => {
        sendResponse({ success: false, error: err.name === "AbortError" ? "请求超时" : err.message });
      })
      .finally(() => clearTimeout(timer));
  });
}

// 代理 RPA 产物下载：二进制（video.webm / 截图），不能走 res.json()。
// 内容脚本在页面 origin 下读不到扩展 origin 的 blob URL，所以这里读成 base64 回传，
// 由内容脚本用 atob→Blob→objectURL 重建。
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function proxyArtifactRequest(runId, name, sendResponse) {
  chrome.storage.local.get(["appguide_apiBaseUrl"], (result) => {
    const baseUrl = normalizeBaseUrl(result.appguide_apiBaseUrl);
    const fetchUrl = `${baseUrl}/rest?method=appguide.rpa.artifact&runId=${encodeURIComponent(runId)}&name=${encodeURIComponent(name)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTIFACT_TIMEOUT_MS);

    fetch(fetchUrl, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          let msg = `产物不可用（HTTP ${res.status}）`;
          try {
            const d = await res.json();
            if (d && (d.message || d.error)) msg = d.message || d.error;
          } catch (e) { /* 不是 JSON 错误体 */ }
          throw new Error(msg);
        }
        const contentType = res.headers.get("content-type") || "application/octet-stream";
        const buf = await res.arrayBuffer();
        return { contentType, buf };
      })
      .then(({ contentType, buf }) => {
        sendResponse({ success: true, data: { contentType, base64: arrayBufferToBase64(buf) } });
      })
      .catch((err) => sendResponse({ success: false, error: err.name === "AbortError" ? "产物下载超时" : err.message }))
      .finally(() => clearTimeout(timer));
  });
}

// 代理文件参数上传：内容脚本只能经消息传 JSON，文件以 base64 过来，这里还原成字节发出。
// 回 { success, data }，data 为服务端信封（成功时 data.data.path = RPA 容器内路径）。
function proxyAssetUpload(appguideId, name, base64, sendResponse) {
  chrome.storage.local.get(["appguide_apiBaseUrl"], (result) => {
    const baseUrl = normalizeBaseUrl(result.appguide_apiBaseUrl);
    const fetchUrl = `${baseUrl}/rest?method=appguide.rpa.asset&appguideId=${encodeURIComponent(appguideId)}&name=${encodeURIComponent(name)}`;
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTIFACT_TIMEOUT_MS);

    fetch(fetchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => {
        sendResponse({ success: false, error: err.name === "AbortError" ? "上传超时" : err.message });
      })
      .finally(() => clearTimeout(timer));
  });
}

// 代理 fetch 请求：从扩展自身 origin 发起，不受页面 Mixed Content 限制
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetch-guide") {
    const params = { url: message.url };
    if (message.flowId) params.flowId = message.flowId;
    proxyRestRequest("appguide.flows.guide", params, sendResponse);
    return true;
  }

  if (message.action === "fetch-flows-by-pattern") {
    proxyRestRequest("appguide.flows.bypattern", { url: message.url }, sendResponse);
    return true;
  }

  if (message.action === "track-stats") {
    proxyRestRequest("appguide.flows.stats", { id: message.flowId, type: message.type }, sendResponse);
    return true;
  }

  if (message.action === "fetch-flow-by-id") {
    proxyRestRequest("appguide.flows.byid", { id: message.flowId || "" }, sendResponse);
    return true;
  }

  if (message.action === "fetch-flow-by-ocid") {
    proxyRestRequest("appguide.flows.byocid", { ocid: message.ocid || "" }, sendResponse);
    return true;
  }

  // ---- RPA 桥（④ UI 用）----
  if (message.action === "rpa-spec") {
    proxyRestRequest("appguide.rpa.spec", { appguideId: message.appguideId || "" }, sendResponse);
    return true;
  }

  if (message.action === "rpa-run") {
    proxyPostRequest("appguide.rpa.run", {}, message.body || {}, sendResponse);
    return true;
  }

  if (message.action === "rpa-status") {
    proxyRestRequest("appguide.rpa.status", { runId: message.runId || "" }, sendResponse);
    return true;
  }

  if (message.action === "rpa-artifact") {
    proxyArtifactRequest(message.runId, message.name, sendResponse);
    return true;
  }

  if (message.action === "rpa-asset") {
    proxyAssetUpload(message.appguideId || "", message.name || "", message.base64, sendResponse);
    return true;
  }
});
