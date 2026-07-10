document.addEventListener("DOMContentLoaded", () => {
  const apiUrlInput = document.getElementById("apiUrl");
  const saveBtn = document.getElementById("saveBtn");
  const statusDiv = document.getElementById("status");

  // 默认使用云服务器端点（无需协议前缀，background worker 会自动补全）
  const DEFAULT_URL = "81.69.17.148:3010";

  // 加载已有配置
  chrome.storage.local.get(["apiBaseUrl"], (result) => {
    if (result.apiBaseUrl) {
      apiUrlInput.value = result.apiBaseUrl;
    } else {
      apiUrlInput.value = DEFAULT_URL;
    }
  });

  // 保存配置
  saveBtn.addEventListener("click", () => {
    let url = apiUrlInput.value.trim();
    // 移除尾部斜杠
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }

    // 自动去掉用户可能粘贴进来的 http:// 或 https:// 前缀
    url = url.replace(/^https?:\/\//i, "");

    if (!url) {
      url = DEFAULT_URL;
      apiUrlInput.value = DEFAULT_URL;
    }

    chrome.storage.local.set({ apiBaseUrl: url }, () => {
      statusDiv.style.display = "block";
      setTimeout(() => {
        statusDiv.style.display = "none";
      }, 2000);
    });
  });
});