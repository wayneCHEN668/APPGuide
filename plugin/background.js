/**
 * Chrome Extension Background Worker (Service Worker)
 * 职责：
 * 1. 拦截注册的系统全局命令(Alt+G)
 * 2. 调度并分发给激活选项卡下的 content.js 脚本
 * 3. 代理 API 请求以绕过 HTTPS 页面上的 Mixed Content 限制
 */

const FETCH_TIMEOUT_MS = 8000;

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
});
