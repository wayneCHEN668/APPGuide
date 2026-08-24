document.addEventListener("DOMContentLoaded", () => {
  const apiUrlInput = document.getElementById("apiUrl");
  const saveBtn = document.getElementById("saveBtn");
  const statusDiv = document.getElementById("status");

  const DEFAULT_URL = "api.skillcloud.cn";

  chrome.storage.local.get(["apiBaseUrl"], (result) => {
    apiUrlInput.value = result.apiBaseUrl || DEFAULT_URL;
  });

  saveBtn.addEventListener("click", () => {
    let url = apiUrlInput.value.trim();
    if (url.endsWith("/")) {
      url = url.slice(0, -1);
    }
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
