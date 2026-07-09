/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { GuideStep } from "../types";
import { 
  FileCode, 
  Copy, 
  Check, 
  FolderPlus, 
  FileText, 
  Download, 
  HelpCircle,
  ExternalLink
} from "lucide-react";

interface ExtensionExporterProps {
  currentUrl: string;
  steps: GuideStep[];
}

export const ExtensionExporter: React.FC<ExtensionExporterProps> = ({
  currentUrl,
  steps
}) => {
  const [selectedFile, setSelectedFile] = useState<string>("manifest.json");
  const [copied, setCopied] = useState<boolean>(false);

  // Dynamic values based on app state
  const devServerUrl = window.location.origin;

  // Extension Files Definitions
  const files: Record<string, { title: string; desc: string; type: "json" | "js" | "html" | "md"; code: string }> = {
    "manifest.json": {
      title: "manifest.json",
      desc: "Chrome 插件的核心配置文件 (V3 版本规范)",
      type: "json",
      code: `{
  "manifest_version": 3,
  "name": "企业业务流步骤合规引导系统",
  "version": "1.0.0",
  "description": "实时解析复杂行业系统中的输入焦点与URL，动态加载对应业务指南，步骤化高亮引导规范操作。",
  "permissions": [
    "activeTab",
    "storage"
  ],
  "host_permissions": [
    "http://localhost:3000/*",
    "${devServerUrl}/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"]
    }
  ],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "commands": {
    "toggle-guide": {
      "suggested_key": {
        "default": "Alt+G",
        "mac": "Alt+G"
      },
      "description": "呼出/关闭当前业务操作引导流程"
    }
  }
}`
    },

    "content.js": {
      title: "content.js",
      desc: "内容脚本，运行在目标业务页面中。负责监测 URL、焦点，拉取 API 数据并动态渲染悬浮气泡及高亮层",
      type: "js",
      code: `/**
 * 企业业务合规指引 Chrome 插件 Content Script
 * 职责：
 * 1. 监测 URL 变化 (不带问号/Hash等参数)
 * 2. 监听 Alt+G 快捷键或来自 Background 的快捷键命令
 * 3. 实时访问指定 API 端点获取 JSON 指南
 * 4. 动态创建和管理页面高亮遮罩/气泡浮窗组件
 * 5. 监听输入聚焦以实现自动流程流转
 */

(function() {
  let activeGuide = null;
  let currentStepIndex = 0;
  let isGuideActive = false;
  
  // 气泡 DOM 及高亮层 DOM
  let bubbleElement = null;
  let highlightElement = null;
  let resizeObserver = null;

  // 配置数据：API 地址
  const API_BASE_URL = "${devServerUrl}";

  console.log("[BusinessGuide] 插件内容脚本已成功注入目标系统。");

  // 初始化：监听键盘 Alt+G
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "g" || e.key === "G" || e.key === "9")) {
      e.preventDefault();
      toggleGuide();
    }
  });

  // 监听来自后台 Service Worker 的全局 Chrome 命令
  chrome.runtime?.onMessage?.addListener((message) => {
    if (message.action === "toggle-guide") {
      toggleGuide();
    }
  });

  // 监听页面元素焦点的捕获
  document.addEventListener("focus", (e) => {
    if (!isGuideActive || !activeGuide) return;
    
    const step = activeGuide.steps[currentStepIndex];
    if (!step) return;

    // 匹配当前步骤的选择器
    try {
      const target = document.querySelector(step.selector);
      if (target && (target === e.target || target.contains(e.target))) {
        console.log("[BusinessGuide] 操作员精准定位到当前目标：", step.selector);
        
        // 如果是 focus 类型动作，则在 800ms 后自动推荐前行
        if (step.actionType === "focus") {
          setTimeout(() => {
            advanceStep();
          }, 800);
        }
      }
    } catch(err) {
      console.error(err);
    }
  }, true);

  // 核心功能：开关引导
  function toggleGuide() {
    if (isGuideActive) {
      disableGuide();
    } else {
      enableGuide();
    }
  }

  // 开启引导并请求 API 决策
  async function enableGuide() {
    // 1. 获取不带问号和哈希的干净 URL Path 
    const cleanPath = window.location.pathname;
    console.log("[BusinessGuide] 正在检测页面并获取 API 校验...", cleanPath);

    try {
      // 2. 实时访问后端 API 决策指南
      const res = await fetch(\`\${API_BASE_URL}/api/guide?url=\${encodeURIComponent(cleanPath)}\`);
      const data = await res.json();

      if (data && data.success && data.guide && data.guide.steps.length > 0) {
        activeGuide = data.guide;
        currentStepIndex = 0;
        isGuideActive = true;
        
        // 3. 动态渲染界面
        renderGuideUI();
        console.log("[BusinessGuide] 成功拉取最新业务流程指南：" + activeGuide.title);
      } else {
        showToast("💡 当前页面未配置特定的业务操作指南 API");
      }
    } catch (e) {
      console.error("[BusinessGuide] 无法连接到 API 配置端点:", e);
      showToast("❌ 业务指南 API 端点连接失败");
    }
  }

  function disableGuide() {
    isGuideActive = false;
    activeGuide = null;
    cleanupUI();
    console.log("[BusinessGuide] 业务操作引导已关闭。");
  }

  // 渲染/重绘 高亮框与浮窗气泡
  function renderGuideUI() {
    cleanupUI();
    if (!isGuideActive || !activeGuide) return;

    const step = activeGuide.steps[currentStepIndex];
    if (!step) return;

    const targetElement = document.querySelector(step.selector);

    // 1. 创建高亮覆盖物
    if (targetElement) {
      highlightElement = document.createElement("div");
      highlightElement.className = "guide-extension-highlight " + "guide-style-" + (step.highlightStyle || "pulse");
      document.body.appendChild(highlightElement);

      // 实时追踪尺寸
      updateHighlightPosition(targetElement);
      
      // 使用 ResizeObserver 确保目标尺寸或屏幕自适应时位置精确
      if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
          updateHighlightPosition(targetElement);
        });
        resizeObserver.observe(targetElement);
        resizeObserver.observe(document.body);
      }
    }

    // 2. 创建引导步骤悬浮气泡
    bubbleElement = document.createElement("div");
    bubbleElement.className = "guide-extension-bubble";
    
    // 注入富文本结构（包含主题动画）
    bubbleElement.innerHTML = \`
      <div class="guide-header">
        <span>🤖 业务合规助手：\${activeGuide.title}</span>
        <button id="guide-close-btn" class="guide-btn-close">×</button>
      </div>
      <div class="guide-body">
        <h3 class="guide-step-title">
          <span class="guide-step-num">步骤 \${currentStepIndex + 1}</span>
          \${step.title}
        </h3>
        <p class="guide-step-desc">\${step.description}</p>
        <div class="guide-meta">目标: <code>\${step.selector}</code></div>
      </div>
      <div class="guide-footer">
        <span class="guide-progress">进度: \${currentStepIndex + 1} / \${activeGuide.steps.length}</span>
        <div class="guide-actions">
          <button id="guide-prev-btn" class="guide-btn-nav" \${currentStepIndex === 0 ? "disabled" : ""}>上一步</button>
          <button id="guide-next-btn" class="guide-btn-primary">\${currentStepIndex === activeGuide.steps.length - 1 ? "完成" : "下一步"}</button>
        </div>
      </div>
    \`;

    document.body.appendChild(bubbleElement);

    // 绑定导航事件
    document.getElementById("guide-close-btn").onclick = disableGuide;
    document.getElementById("guide-prev-btn").onclick = prevStep;
    document.getElementById("guide-next-btn").onclick = nextStep;

    // 定位气泡框
    positionBubble(targetElement, step.tipPosition);
  }

  function updateHighlightPosition(element) {
    if (!highlightElement) return;
    const rect = element.getBoundingClientRect();
    highlightElement.style.top = \`\${rect.top + window.scrollY - 4}px\`;
    highlightElement.style.left = \`\${rect.left + window.scrollX - 4}px\`;
    highlightElement.style.width = \`\${rect.width + 8}px\`;
    highlightElement.style.height = \`\${rect.height + 8}px\`;
  }

  // 气泡框绝对定位算法
  function positionBubble(target, position) {
    if (!bubbleElement) return;

    const gap = 12;
    if (!target) {
      // 若元素不存在，居中浮动显示
      bubbleElement.style.top = "30%";
      bubbleElement.style.left = "50%";
      bubbleElement.style.transform = "translate(-50%, -30%)";
      bubbleElement.style.position = "fixed";
      return;
    }

    const tRect = target.getBoundingClientRect();
    const bRect = bubbleElement.getBoundingClientRect();
    
    let top = 0;
    let left = 0;

    const scrollY = window.scrollY;
    const scrollX = window.scrollX;

    switch (position) {
      case "top":
        top = tRect.top + scrollY - bRect.height - gap;
        left = tRect.left + scrollX + tRect.width / 2 - bRect.width / 2;
        break;
      case "bottom":
        top = tRect.bottom + scrollY + gap;
        left = tRect.left + scrollX + tRect.width / 2 - bRect.width / 2;
        break;
      case "left":
        top = tRect.top + scrollY + tRect.height / 2 - bRect.height / 2;
        left = tRect.left + scrollX - bRect.width - gap;
        break;
      case "right":
        top = tRect.top + scrollY + tRect.height / 2 - bRect.height / 2;
        left = tRect.right + scrollX + gap;
        break;
      default:
        top = tRect.bottom + scrollY + gap;
        left = tRect.left + scrollX + tRect.width / 2 - bRect.width / 2;
    }

    // 简易边界安全溢出纠偏
    left = Math.max(10, Math.min(left, window.innerWidth - bRect.width - 20));
    top = Math.max(10, Math.min(top, document.documentElement.scrollHeight - bRect.height - 20));

    bubbleElement.style.top = \`\${top}px\`;
    bubbleElement.style.left = \`\${left}px\`;
  }

  function prevStep() {
    if (currentStepIndex > 0) {
      currentStepIndex--;
      renderGuideUI();
    }
  }

  function nextStep() {
    advanceStep();
  }

  function advanceStep() {
    if (currentStepIndex < activeGuide.steps.length - 1) {
      currentStepIndex++;
      renderGuideUI();
    } else {
      showToast("🎉 恭喜！您已成功遵照合规完成了该业务流程。");
      disableGuide();
    }
  }

  function cleanupUI() {
    if (bubbleElement && bubbleElement.parentNode) {
      bubbleElement.parentNode.removeChild(bubbleElement);
    }
    if (highlightElement && highlightElement.parentNode) {
      highlightElement.parentNode.removeChild(highlightElement);
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    bubbleElement = null;
    highlightElement = null;
  }

  // 简易通知
  function showToast(text) {
    const toast = document.createElement("div");
    toast.className = "guide-extension-toast";
    toast.innerText = text;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add("show");
    }, 50);

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3500);
  }
})();`
    },

    "content.css": {
      title: "content.css",
      desc: "注入目标网页的视觉样式表，实现悬浮气泡框及流畅的呼吸高亮效果",
      type: "html",
      code: `/* ------------------ 动态引导悬浮窗气泡 ------------------ */
.guide-extension-bubble {
  position: absolute;
  z-index: 10000000;
  width: 320px;
  background-color: #0f172a !important;
  border: 1px solid rgba(59, 130, 246, 0.4) !important;
  border-radius: 12px !important;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4) !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
  color: #f1f5f9 !important;
  overflow: hidden;
  transition: opacity 0.2s ease-in-out;
}

.guide-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background-color: #020617 !important;
  border-bottom: 1px solid #1e293b !important;
}

.guide-header span {
  font-size: 11px !important;
  font-weight: 700 !important;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8 !important;
}

.guide-btn-close {
  background: none !important;
  border: none !important;
  color: #64748b !important;
  font-size: 18px !important;
  cursor: pointer !important;
  line-height: 1 !important;
  padding: 0 !important;
}

.guide-btn-close:hover {
  color: #f1f5f9 !important;
}

.guide-body {
  padding: 14px !important;
}

.guide-step-title {
  margin: 0 0 6px 0 !important;
  font-size: 14px !important;
  font-weight: 700 !important;
  color: #ffffff !important;
  display: flex;
  align-items: center;
}

.guide-step-num {
  font-size: 10px !important;
  font-family: monospace !important;
  background-color: #1e1b4b !important;
  border: 1px solid rgba(99, 102, 241, 0.4) !important;
  color: #818cf8 !important;
  padding: 2px 6px !important;
  border-radius: 4px !important;
  margin-right: 8px !important;
  font-weight: bold !important;
}

.guide-step-desc {
  margin: 0 !important;
  font-size: 12px !important;
  line-height: 1.5 !important;
  color: #cbd5e1 !important;
}

.guide-meta {
  margin-top: 10px !important;
  font-size: 10px !important;
  font-family: monospace !important;
  color: #475569 !important;
}

.guide-meta code {
  color: #94a3b8 !important;
}

.guide-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px !important;
  background-color: #020617/50 !important;
  border-top: 1px solid #1e293b !important;
}

.guide-progress {
  font-size: 10px !important;
  font-family: monospace !important;
  color: #64748b !important;
}

.guide-actions {
  display: flex;
  gap: 6px !important;
}

.guide-btn-nav, .guide-btn-primary {
  padding: 4px 10px !important;
  font-size: 11px !important;
  font-weight: 600 !important;
  border-radius: 6px !important;
  cursor: pointer !important;
  border: none !important;
  transition: all 0.15s ease !important;
}

.guide-btn-nav {
  background-color: #1e293b !important;
  color: #cbd5e1 !important;
  border: 1px solid #334155 !important;
}

.guide-btn-nav:hover:not(:disabled) {
  background-color: #334155 !important;
  color: #f1f5f9 !important;
}

.guide-btn-nav:disabled {
  opacity: 0.3 !important;
  cursor: not-allowed !important;
}

.guide-btn-primary {
  background-color: #2563eb !important;
  color: #ffffff !important;
}

.guide-btn-primary:hover {
  background-color: #3b82f6 !important;
}

/* ------------------ 高亮遮罩覆盖层 ------------------ */
.guide-extension-highlight {
  position: absolute;
  pointer-events: none;
  z-index: 9999999;
  border-radius: 6px;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes extensionPulse {
  0%, 100% { box-shadow: 0 0 0 0px rgba(59, 130, 246, 0.7); }
  50% { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0); }
}
@keyframes extensionSolid {
  0%, 100% { box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.8); }
  50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.4); }
}

.guide-style-pulse {
  border: 2px solid #3b82f6 !important;
  animation: extensionPulse 1.5s infinite;
}

.guide-style-solid {
  border: 2px solid #ef4444 !important;
  animation: extensionSolid 2s infinite;
}

.guide-style-glow {
  border: 2px dashed #f59e0b !important;
  box-shadow: 0 0 15px #f59e0b !important;
}

/* ------------------ 通知小吐司 ------------------ */
.guide-extension-toast {
  position: fixed;
  bottom: -60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000001;
  background-color: #1e293b;
  border: 1px solid #3b82f6;
  color: #ffffff;
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
  transition: bottom 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28);
}

.guide-extension-toast.show {
  bottom: 30px;
}`
    },

    "background.js": {
      title: "background.js",
      desc: "后台服务脚本。注册系统快捷键（Alt+G）并向当前激活标签页的分发激活指令",
      type: "js",
      code: `/**
 * Chrome Extension Background Worker (Service Worker)
 * 职责：
 * 1. 拦截注册的系统全局命令(Alt+G)
 * 2. 调度并分发给激活选项卡下的 content.js 脚本
 */

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-guide") {
    console.log("[Background] 捕获快捷键命令 Alt + G，正在指引选项卡...");
    
    // 查询当前活跃选项卡
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-guide" });
      }
    });
  }
});
`
    },

    "popup.html": {
      title: "popup.html",
      desc: "点击 Chrome 导航栏图标时的悬浮卡片外观界面",
      type: "html",
      code: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      width: 220px;
      padding: 12px;
      background-color: #0f172a;
      color: #f1f5f9;
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
    }
    .title {
      font-size: 13px;
      font-weight: bold;
      color: #3b82f6;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .desc {
      font-size: 10px;
      color: #94a3b8;
      line-height: 1.4;
      margin-bottom: 12px;
    }
    .divider {
      height: 1px;
      background-color: #1e293b;
      margin: 8px 0;
    }
    .shortcut-badge {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background-color: #020617;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 10px;
      border: 1px solid #1e293b;
    }
    .key {
      font-family: monospace;
      font-weight: bold;
      color: #f59e0b;
      background-color: #1e1b4b;
      padding: 2px 6px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="title">🤖 业务合规引导助手</div>
  <div class="desc">在任何企业级后台系统界面，点击该插件或配合快捷键即可拉取特定步骤引导。</div>
  <div class="divider"></div>
  <div class="shortcut-badge">
    <span>快捷呼出按键</span>
    <span class="key">Alt + G</span>
  </div>
</body>
</html>`
    },

    "README.md": {
      title: "README.md",
      desc: "关于如何打包、加载到 Chrome 浏览器并应用本地 API 的完整部署教程",
      type: "md",
      code: `# 📦 企业业务合规步骤引导 - 浏览器插件部署使用文档

本目录包含了直接可导入 Google Chrome 浏览器的轻量级 V3 插件完整代码。

## ✨ 核心特性
1. **轻量合规无感**：完全由快捷键或图标激活，不增加主系统额外加载负荷。
2. **实时 URL 解析**：利用 \`window.location.pathname\` 去除尾部问号参数，精准、合规地向指定 API 发起请求。
3. **高精准 DOM 定位与呼吸高亮**：对目标 DOM 选择器实时建立 \`ResizeObserver\` 检测框，多样式高亮，且不影响其本身任何原生事件交互。
4. **API 热加载模式**：完全解耦！仅需在服务端更新对应 URL 下的 JSON 规范，终端无需重新安装插件，即可体验毫秒级同步热刷新。

---

## 🚀 部署步骤 (3分钟快速加载)

### 第一步：在您的电脑中新建文件夹
在您电脑上的任意安全位置新建一个空文件夹，例如命名为 \`Enterprise-Guide-Extension\`。

### 第二步：保存文件
在刚才新建的文件夹内，分别创建以下 5 个文件，并将控制台展示的对应代码拷贝保存进去：
- \`manifest.json\` (核心描述)
- \`content.js\` (脚本逻辑)
- \`content.css\` (视觉主题)
- \`background.js\` (快捷键拦截调度)
- \`popup.html\` (导航栏气泡面板)

### 第三步：生成/放入空白图标 (可选)
如果不需要图标，可直接将 \`manifest.json\` 中的 \`"default_icon"\` 节点整段移除。如需放置图标，可在文件夹内新建 \`icons\` 目录并放置任意 PNG 图片，分别命名为 \`icon16.png\`, \`icon48.png\`, \`icon128.png\`。

### 第四步：导入至 Chrome 浏览器
1. 打开您的 **Google Chrome 浏览器**，在地址栏输入 \`chrome://extensions/\` 并回车。
2. 开启右上角的 **“开发者模式” (Developer mode)** 开关。
3. 点击左上角的 **“加载已解压的扩展程序” (Load unpacked)** 按钮。
4. 在弹出的系统文件选择框中，选择您在 **第一步** 创建的 \`Enterprise-Guide-Extension\` 文件夹。
5. 成功导入！您会看到卡片中出现了 *“企业业务流步骤合规引导系统”*。

---

## 🎯 连通性测试
1. 运行当前的开发环境服务器 (\`${devServerUrl}\`)。
2. 打开真实的业务系统或在该模拟器中输入测试，按下 **Alt + G**。
3. 插件会自动向 \`${devServerUrl}/api/guide?url=...\` 获取配置好的业务步骤 JSON。
4. 页面中会立即呈现浮动的操作指南和定位框！
`
    }
  };

  const handleCopyCode = (codeText: string) => {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div id="extension-exporter-root" className="space-y-4">
      {/* 顶部指示说明 */}
      <div className="p-3 bg-cyan-950/10 border border-cyan-800/20 rounded-xl space-y-1">
        <h4 className="text-xs font-bold text-cyan-400 flex items-center">
          <FolderPlus className="w-3.5 h-3.5 mr-1" />
          已经过定制化导出的 Chrome 核心源码
        </h4>
        <p className="text-[10px] text-zinc-300 leading-normal font-sans">
          下面是根据您当前系统实时适配后的 Chrome Extension V3 插件完整代码。该插件已内联连通此开发环境下的 API 服务器端点：
          <span className="font-mono text-[9px] bg-cyan-950/70 border border-cyan-900/40 text-cyan-300 px-1 py-0.2 rounded ml-1">{devServerUrl}</span>。
        </p>
      </div>

      {/* 左右分栏：文件列表 vs 代码区 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* 左侧：文件目录树 */}
        <div className="bg-[#050505] border border-zinc-800/60 rounded-lg p-2 flex flex-col space-y-1 select-none">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider px-2 py-1 block">
            插件包目录结构
          </span>
          {Object.keys(files).map((fileName) => (
            <button
              key={fileName}
              onClick={() => setSelectedFile(fileName)}
              className={`w-full flex items-center space-x-2 px-2.5 py-2 rounded-md text-xs font-medium text-left transition-all cursor-pointer ${
                selectedFile === fileName
                  ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/50 border border-transparent"
              }`}
            >
              {fileName.endsWith(".md") ? (
                <FileText className="w-3.5 h-3.5" />
              ) : (
                <FileCode className="w-3.5 h-3.5 text-cyan-400/80" />
              )}
              <span className="truncate flex-1">{fileName}</span>
            </button>
          ))}
        </div>

        {/* 右侧：代码展示与拷贝 */}
        <div className="md:col-span-2 bg-[#050505] border border-zinc-800/60 rounded-lg flex flex-col overflow-hidden">
          {/* 文件顶栏说明 */}
          <div className="px-3.5 py-2.5 bg-zinc-900/30 border-b border-zinc-800/80 flex items-center justify-between">
            <div className="min-w-0">
              <span className="text-[11px] font-mono text-zinc-300 font-bold block">{files[selectedFile].title}</span>
              <span className="text-[9px] text-zinc-500 block truncate">{files[selectedFile].desc}</span>
            </div>
            
            <button
              onClick={() => handleCopyCode(files[selectedFile].code)}
              className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 hover:text-cyan-400 text-zinc-200 text-[10px] font-semibold rounded border border-zinc-800 flex items-center space-x-1 transition-all cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="text-cyan-400">已拷贝!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制代码</span>
                </>
              )}
            </button>
          </div>

          {/* 代码本体展示 */}
          <pre className="p-3.5 overflow-x-auto text-[10.5px] font-mono text-zinc-300 max-h-[350px] leading-relaxed select-all">
            <code>{files[selectedFile].code}</code>
          </pre>
        </div>
      </div>

      {/* 帮助卡片 */}
      <div className="p-3 bg-[#050505] border border-zinc-850 rounded-xl space-y-2 select-none">
        <h5 className="text-[11px] font-bold text-zinc-400 flex items-center">
          <HelpCircle className="w-3.5 h-3.5 text-cyan-400 mr-1.5" />
          如何装载至 Chrome 浏览器测试？
        </h5>
        <p className="text-[10px] text-zinc-400 leading-normal">
          请点开 <span className="font-mono text-cyan-400 bg-zinc-900 px-1 py-0.2 border border-zinc-800 rounded">README.md</span> 查看手把手指导。
          仅需在您本地创建文件夹、粘入这 5 个文件、并在 Chrome 的 <code>chrome://extensions/</code> 中加载，
          即可将本开发环境的决策数据库直接同步加载到您的 Chrome 浏览器！
        </p>
      </div>
    </div>
  );
};
