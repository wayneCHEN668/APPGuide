document.addEventListener("DOMContentLoaded", () => {
  const apiUrlInput = document.getElementById("apiUrl");
  const saveBtn = document.getElementById("saveBtn");
  const statusDiv = document.getElementById("status");

  // 默认使用云服务器端点。建议填写完整地址；省略协议时 background worker 会补全
  // （域名补 https://，localhost / 内网 IP 补 http://）
  const DEFAULT_URL = "https://api.skillcloud.cn";

  // 加载已有配置
  chrome.storage.local.get(["appguide_apiBaseUrl"], (result) => {
    if (result.appguide_apiBaseUrl) {
      apiUrlInput.value = result.appguide_apiBaseUrl;
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

    if (!url) {
      url = DEFAULT_URL;
      apiUrlInput.value = DEFAULT_URL;
    }

    chrome.storage.local.set({ appguide_apiBaseUrl: url }, () => {
      statusDiv.style.display = "block";
      setTimeout(() => {
        statusDiv.style.display = "none";
      }, 2000);
    });
  });
});