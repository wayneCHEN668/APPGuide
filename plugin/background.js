/**
 * Chrome Extension Background Worker (Service Worker)
 * 职责：
 * 1. 拦截注册的系统全局命令(Alt+G)
 * 2. 调度并分发给激活选项卡下的 content.js 脚本
 * 3. 代理 API 请求以绕过 HTTPS 页面上的 Mixed Content 限制
 */

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-guide") {
    console.log("[Background] 捕获快捷键命令 Alt + G，正在激活对应的选项卡...");

    // 查询当前活跃选项卡
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-guide" }, () => {
          if (chrome.runtime.lastError) {
            console.log("[Background] 当前页面不支持注入插件脚本:", chrome.runtime.lastError.message);
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

    chrome.storage.local.get(["apiBaseUrl"], (result) => {
      const apiBaseUrl = result.apiBaseUrl || "81.69.17.148:3010";
      // 自动补全 http:// 协议前缀
      const baseUrl = /^https?:\/\//i.test(apiBaseUrl) ? apiBaseUrl : `http://${apiBaseUrl}`;
      let fetchUrl = `${baseUrl}/api/guide?url=${encodeURIComponent(cleanPath)}`;
      if (flowId) {
        // 携带正在进行中的流程id，供服务端优先在该流程内匹配当前页（跨页续接）
        fetchUrl += `&flowId=${encodeURIComponent(flowId)}`;
      }

      console.log("[Background] 代理获取指南:", fetchUrl);

      fetch(fetchUrl)
        .then(res => res.json())
        .then(data => {
          sendResponse({ success: true, data });
        })
        .catch(err => {
          console.error("[Background] 获取指南失败:", err);
          sendResponse({ success: false, error: err.message });
        });
    });

    return true; // 保持消息通道开放以进行异步响应
  }
});
