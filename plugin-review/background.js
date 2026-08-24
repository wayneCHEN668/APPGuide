/**
 * Chrome Extension Background Worker (Service Worker) - 审核版
 * 职责：
 * 1. 拦截注册的系统全局命令(Alt+C)
 * 2. 调度并分发给激活选项卡下的 content.js 脚本
 * 3. 代理 API 请求以绕过 HTTPS 页面上的 Mixed Content 限制
 * 4. 代理 selector 修正批量提交
 */

// ── 公共辅助函数 ──────────────────────────────────────────────────────────────

/**
 * 从 chrome.storage 中读取并构造 API 根 URL。
 * @returns {Promise<string>} 形如 "http://api.skillcloud.cn" 的字符串
 */
function buildBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiBaseUrl"], (result) => {
      const raw = result.apiBaseUrl || "api.skillcloud.cn";
      resolve(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    });
  });
}

/**
 * 安全地将 fetch Response 解析为 JSON。
 * 先校验 HTTP 状态码 (res.ok) 与 Content-Type，
 * 避免将 HTML 错误页（502、nginx 默认页等）当作 JSON 解析。
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function safeJson(res) {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json") && !ct.includes("text/json")) {
    const text = await res.text();
    throw new Error(`期望 JSON 响应，但服务端返回 Content-Type: ${ct}。响应片段: ${text.substring(0, 200)}`);
  }
  return res.json();
}
// ─────────────────────────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-guide") {
//     console.log("[Background-Review] 捕获快捷键命令 Alt+C，正在激活对应的选项卡...");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-guide" }, () => {
          if (chrome.runtime.lastError) {
//             console.log("[Background-Review] 当前页面不支持注入插件脚本:", chrome.runtime.lastError.message);
          }
        });
      }
    });
  }
});

// 代理 fetch 请求：从扩展自身 origin 发起，不受页面 Mixed Content 限制
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetch-guide") {
    const cleanPath = message.url;
    const flowId = message.flowId || "";

    buildBaseUrl().then((baseUrl) => {
      let fetchUrl = `${baseUrl}/rest?method=appguide.flows.guide&url=${encodeURIComponent(cleanPath)}`;
      if (flowId) {
        fetchUrl += `&flowId=${encodeURIComponent(flowId)}`;
      }

//       console.log("[Background-Review] 代理获取指南:", fetchUrl);

      fetch(fetchUrl)
        .then(safeJson)
        .then(data => {
          sendResponse({ success: true, data });
        })
        .catch(err => {
          console.error("[Background-Review] 获取指南失败:", err);
          sendResponse({ success: false, error: err.message });
        });
    });

    return true;
  }

  if (message.action === "fetch-flows-by-pattern") {
    const cleanPath = message.url;

    buildBaseUrl().then((baseUrl) => {
      const fetchUrl = `${baseUrl}/rest?method=appguide.flows.bypattern&url=${encodeURIComponent(cleanPath)}`;

//       console.log("[Background-Review] 代理获取流程模式匹配:", fetchUrl);

      fetch(fetchUrl)
        .then(safeJson)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
          console.error("[Background-Review] 获取流程模式匹配失败:", err);
          sendResponse({ success: false, error: err.message });
        });
    });

    return true;
  }

  // 新增：提交完整 steps JSON（通过 flowID 更新整个 steps 字段）
  if (message.action === "submit-full-flow") {
    const { flowId, steps } = message;

    buildBaseUrl().then((baseUrl) => {
      const fetchUrl = `${baseUrl}/rest`;

//       console.log("[Background-Review] 提交完整 steps JSON:", fetchUrl, { flowId, stepsLength: steps ? steps.length : 0 });

      fetch(fetchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "appguide.flows.updatesteps", flowId, steps }),
      })
        .then(safeJson)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
          console.error("[Background-Review] 提交完整 steps JSON 失败:", err);
          sendResponse({ success: false, error: err.message });
        });
    });

    return true;
  }

  // 新增：按 ID 获取完整流程 JSON（用于本地缓存跨页审核数据）
  if (message.action === "fetch-guide-by-id") {
    const { flowId } = message;

    buildBaseUrl().then((baseUrl) => {
      const fetchUrl = `${baseUrl}/rest?method=appguide.flows.byid&id=${encodeURIComponent(flowId)}`;

//       console.log("[Background-Review] 获取完整流程数据:", fetchUrl);

      fetch(fetchUrl)
        .then(safeJson)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
          console.error("[Background-Review] 获取完整流程数据失败:", err);
          sendResponse({ success: false, error: err.message });
        });
    });

    return true;
  }

  if (message.action === "track-stats") {
    const { flowId, type } = message;

    buildBaseUrl().then((baseUrl) => {
      const fetchUrl = `${baseUrl}/rest?method=appguide.flows.stats&id=${encodeURIComponent(flowId)}&type=${encodeURIComponent(type)}`;

//       console.log("[Background-Review] 更新流程统计:", fetchUrl);

      fetch(fetchUrl)
        .then(safeJson)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => {
          console.error("[Background-Review] 更新流程统计失败:", err);
          sendResponse({ success: false, error: err.message });
        });
    });

    return true;
  }
});
