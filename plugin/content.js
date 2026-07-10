/**
 * 企业业务合规指引 Chrome 插件 Content Script
 * 职责：
 * 1. 监测 URL 变化 (不带问号/Hash等参数)
 * 2. 监听 Alt+G 快捷键或来自 Background 的快捷键命令
 * 3. 实时访问指定 API 端点获取 JSON 指南
 * 4. 动态创建和管理页面高亮遮罩/气泡浮窗组件
 * 5. 拥有完整的客户端本地语义匹配引擎（Semantic Vector Matcher）：
 *    若获取的业务步骤未提供精确 Selector，或页面元素 ID 发生变化导致 Selector 失效时，
 *    在浏览器端实时对 DOM 树进行本地字符级向量分词、计算 TF-IDF 余弦相似度，
 *    自动、动态将业务指南文本关联绑定到最优选择器上，实现零代码自适应引导！
 * 6. 监听输入聚焦以实现自动流程流转
 */

(function() {
  let activeGuide = null;
  let currentStepIndex = 0;
  let isGuideActive = false;
  
  // 气泡 DOM 及高亮层 DOM
  let bubbleElement = null;
  let highlightElement = null;
  let resizeObserver = null;

  // 注：API 地址由 popup 配置并存储在 chrome.storage，实际 fetch 由 background worker 代理执行

  console.log("[BusinessGuide] 插件内容脚本已成功注入目标系统。支持高级本地语义模糊匹配。");

  // 初始化：监听键盘 Alt+G
  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "g" || e.key === "G" || e.key === "9")) {
      e.preventDefault();
      toggleGuide();
    }
  });

  // 监听来自后台 Service Worker 的全局 Chrome 命令
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === "toggle-guide") {
        toggleGuide();
      }
    });
  }

  // ------------------ 客户端本地语义匹配引擎 (Semantic Matcher) ------------------
  
  // 清洗文本并进行字符级一元+二元及英文单词切词
  function tokenize(text) {
    if (!text) return [];
    const clean = text.toLowerCase().trim();
    
    const tokens = [];
    
    // 1. 中文字符一元组 (Unigrams)
    for (let i = 0; i < clean.length; i++) {
      tokens.push(clean[i]);
    }
    
    // 2. 中文字符二元组 (Bigrams)
    for (let i = 0; i < clean.length - 1; i++) {
      tokens.push(clean.substring(i, i + 2));
    }
    
    // 3. 英文单词切分
    const words = clean.split(/[^a-z0-9]+/i).filter(w => w.length > 0);
    tokens.push(...words);
    
    return tokens;
  }

  // 计算词频向量的余弦相似度
  function computeSimilarity(textA, textB) {
    const tokensA = tokenize(textA);
    const tokensB = tokenize(textB);
    
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    
    const countsA = {};
    const countsB = {};
    
    tokensA.forEach(t => countsA[t] = (countsA[t] || 0) + 1);
    tokensB.forEach(t => countsB[t] = (countsB[t] || 0) + 1);
    
    const allTokens = new Set([...Object.keys(countsA), ...Object.keys(countsB)]);
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    allTokens.forEach(t => {
      const valA = countsA[t] || 0;
      const valB = countsB[t] || 0;
      dotProduct += valA * valB;
      normA += valA * valA;
      normB += valB * valB;
    });
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // 扫描当前页面真实的 DOM 树
  function scanDOM() {
    const list = [];
    // 查找页面中所有的可交互控件
    const elements = document.querySelectorAll("input, select, textarea, button, a, [role='button'], div[class*='submit'], div[class*='btn'], div[class*='Btn'], [class*='submit-btn']");
    
    elements.forEach(el => {
      const id = el.id || "";
      const tagName = el.tagName.toLowerCase();
      const type = el.type || "";
      const placeholder = el.placeholder || "";
      const className = el.className || "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const textContent = el.textContent ? el.textContent.trim() : "";
      
      // 寻找对应的 Label 标签
      let labelText = "";
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) {
          labelText = labelEl.textContent || "";
        }
      }
      
      if (!labelText) {
        // Element Plus / 自定义 UI: 查找 .selectLabel 兄弟元素
        let scanEl = el;
        for (let level = 0; level < 6 && !labelText && scanEl; level++) {
          let prev = scanEl.previousElementSibling;
          while (prev) {
            if (prev.classList && prev.classList.contains('selectLabel')) {
              labelText = (prev.textContent || '').trim();
              break;
            }
            prev = prev.previousElementSibling;
          }
          scanEl = scanEl.parentElement;
        }
      }

      if (!labelText) {
        if (tagName === "button" || tagName === "a" || el.getAttribute("role") === "button") {
          labelText = textContent;
        } else if (tagName === "div" && textContent && textContent.length < 30) {
          // 类按钮 div（如"创建任务"），优先用自身文本
          labelText = textContent;
        } else {
          // 向上找父节点容器中的关联文本
          const parent = el.parentElement;
          if (parent) {
            labelText = parent.textContent ? parent.textContent.trim() : "";
          }
        }
      }

      // 清理过多换行和冗余空白
      labelText = labelText.replace(/\s+/g, " ").substring(0, 100);

      // 自动构建可用的 CSS 选择器
      let selector = "";
      if (id) {
        selector = `#${id}`;
      } else if (className) {
        const firstClass = className.split(/\s+/)[0];
        if (firstClass && !firstClass.includes(":") && !firstClass.includes("[")) {
          selector = `${tagName}.${firstClass}`;
        } else {
          selector = tagName;
        }
      } else {
        selector = tagName;
      }

      // 只要选择器存在且不是高亮气泡本身的元素，就记录下来
      if (selector && !className.includes("guide-extension")) {
        list.push({
          element: el,
          selector: selector,
          label: labelText || placeholder || id || tagName,
          placeholder: placeholder,
          className: className,
          ariaLabel: ariaLabel,
          type: tagName
        });
      }
    });

    return list;
  }

  // 对特定步骤指南执行本地语义匹配，返回最匹配的页面 DOM 元素
  function findBestSemanticMatch(step) {
    const scanned = scanDOM();
    if (scanned.length === 0) return null;

    const isDebug = step.title === "上传PPT文件";
    if (isDebug) {
      console.log("[DEBUG] === 匹配步骤:", step.title, "===");
      console.log("[DEBUG] 扫描到", scanned.length, "个控件");
      console.log("[DEBUG] 前10个控件:", scanned.slice(0, 10).map(it => ({
        tag: it.type, selector: it.selector, label: it.label.substring(0,40)
      })));
      const relevant = scanned.filter(it =>
        it.type === "input" || it.label.includes("上传") || it.label.includes("文稿") ||
        it.label.includes("拖拽") || it.label.includes("文件")
      );
      console.log("[DEBUG] 相关控件 (input/上传/文稿/拖拽/文件):", relevant.map(it => ({
        tag: it.type, selector: it.selector, label: it.label.substring(0,60), className: it.className.substring(0,40)
      })));
    }

    // 策略1: 标题关键词子串匹配 (高置信度)
    const titleChars = step.title.replace(/^(设置|选择|找到|点击|上传|提交)/, '').trim();
    if (isDebug) console.log("[DEBUG] S1 关键词:", JSON.stringify(titleChars));
    for (const item of scanned) {
      const labelInTitle = titleChars.length >= 2 && item.label.includes(titleChars);
      const labelInDesc = item.label.length >= 2 && step.description.includes(item.label);
      if (labelInTitle || labelInDesc) {
        if (isDebug) console.log("[DEBUG] S1 命中! label:", item.label.substring(0,30), "reason:", labelInTitle ? "label含关键词" : "label在描述中");
        return {
          element: item.element,
          selector: item.selector,
          label: item.label,
          score: 0.90 + (Math.min(item.label.length, 6) / Math.max(item.label.length, 6)) * 0.10
        };
      }
    }
    if (isDebug) console.log("[DEBUG] S1 未命中，进入S2");

    // 策略2: 标题全字符双向重叠检测
    if (isDebug) console.log("[DEBUG] S2 开始扫描...");
    let s2Top = [];
    for (const item of scanned) {
      const titleSet = new Set(step.title.replace(/\s/g, '').split(''));
      const labelSet = new Set(item.label.replace(/\s/g, '').split(''));
      const overlap = [...titleSet].filter(c => labelSet.has(c)).length;
      const titleOverlap = overlap / titleSet.size;
      const labelOverlap = labelSet.size > 0 ? overlap / labelSet.size : 0;
      const bestOverlap = Math.max(titleOverlap, labelOverlap);
      if (isDebug && bestOverlap > 0.3) {
        s2Top.push({label: item.label.substring(0,30), selector: item.selector, overlap, titleOverlap: titleOverlap.toFixed(2), labelOverlap: labelOverlap.toFixed(2), best: bestOverlap.toFixed(2)});
      }
      if (bestOverlap >= 0.5 && titleSet.size >= 2) {
        if (isDebug) console.log("[DEBUG] S2 命中! label:", item.label.substring(0,30), "bestOverlap:", bestOverlap.toFixed(2));
        return {
          element: item.element,
          selector: item.selector,
          label: item.label,
          score: 0.70 + bestOverlap * 0.30
        };
      }
    }
    if (isDebug) console.log("[DEBUG] S2 未命中 (bestOverlap>=0.5)。高重叠候选:", s2Top.sort((a,b) => parseFloat(b.best)-parseFloat(a.best)).slice(0,5));

    // 策略3: 加权 TF 余弦相似度 (标题3份 + 描述1份)
    const query = step.title + " " + step.title + " " + step.title + " " + step.description;
    let bestMatch = null;
    let highestScore = 0;
    let s3Top = [];

    scanned.forEach(item => {
      const score = computeSimilarity(
        query,
        item.label + " " + item.label + " " + item.placeholder + " " + item.ariaLabel
      );

      if (score > highestScore) {
        highestScore = score;
        bestMatch = {
          element: item.element,
          selector: item.selector,
          label: item.label,
          score: score
        };
      }
      if (isDebug && score > 0.1) {
        s3Top.push({label: item.label.substring(0,30), selector: item.selector, score: score.toFixed(4)});
      }
    });

    if (isDebug) console.log("[DEBUG] S3 结果: score=", bestMatch ? bestMatch.score.toFixed(4) : "N/A", "label:", bestMatch ? bestMatch.label.substring(0,30) : "N/A", "selector:", bestMatch ? bestMatch.selector : "N/A");
    if (isDebug && s3Top.length > 1) console.log("[DEBUG] S3 Top5:", s3Top.sort((a,b) => parseFloat(b.score)-parseFloat(a.score)).slice(0,5));

    if (bestMatch && bestMatch.score > 0.10) {
      return bestMatch;
    }
    return null;
  }

  // ------------------ 焦点与事件追踪 ------------------

  // 监听页面元素焦点的捕获
  document.addEventListener("focus", (e) => {
    if (!isGuideActive || !activeGuide) return;
    
    const step = activeGuide.steps[currentStepIndex];
    if (!step) return;

    try {
      const activeSelector = step.resolvedSelector || step.selector;
      const target = document.querySelector(activeSelector);
      if (target && (target === e.target || target.contains(e.target))) {
        console.log("[BusinessGuide] 操作员精准定位到当前目标：", activeSelector);
        
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
    const cleanPath = window.location.pathname;
    console.log("[BusinessGuide] 正在检测页面并获取 API 校验...", cleanPath);

    try {
      // 通过 background worker 代理请求，绕过 HTTPS 页面的 Mixed Content 限制
      const data = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetch-guide", url: cleanPath },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response && response.success) {
              resolve(response.data);
            } else {
              reject(new Error(response?.error || "API 请求失败"));
            }
          }
        );
      });

      if (data && data.success && data.guide && data.guide.steps.length > 0) {
        activeGuide = data.guide;
        currentStepIndex = 0;
        isGuideActive = true;

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

    let targetElement = null;
    let matchMethod = "精确选择器定位";
    let scorePercent = 100;

    if (step.selector && step.selector !== "auto") {
      targetElement = document.querySelector(step.selector);
    }

    if (!targetElement) {
      console.log(`[BusinessGuide] 选择器 "${step.selector}" 缺失，正在启动本地语义匹配...`);
      const semanticMatch = findBestSemanticMatch(step);
      
      if (semanticMatch) {
        targetElement = semanticMatch.element;
        step.resolvedSelector = semanticMatch.selector;
        matchMethod = `语义模糊对齐 [${semanticMatch.label}]`;
        scorePercent = Math.round(semanticMatch.score * 100);
        console.log(`[BusinessGuide] 语义对齐成功！绑定到 "${semanticMatch.selector}"，置信度 ${scorePercent}%`);

        // 升级隐藏/零尺寸 input 为可交互父容器
        if (targetElement && targetElement.tagName === 'INPUT') {
          // Element Plus 下拉框
          const elSelect = targetElement.closest('.el-select');
          if (elSelect) {
            targetElement = elSelect;
            step.resolvedSelector = 'div.el-select';
            console.log(`[BusinessGuide] 自动升级目标: input → .el-select 容器`);
          } else {
            // 零尺寸隐藏 input (如 file upload)：升级到可见父容器
            const rect = targetElement.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) {
              let parent = targetElement.parentElement;
              for (let i = 0; i < 4 && parent; i++) {
                const pr = parent.getBoundingClientRect();
                if (pr.width > 20 && pr.height > 20) {
                  targetElement = parent;
                  step.resolvedSelector = parent.className ?
                    `${parent.tagName.toLowerCase()}.${parent.className.split(/\s+/).filter(c => !c.includes(':') && c.length > 3).slice(0,2).join('.')}` :
                    parent.tagName.toLowerCase();
                  console.log(`[BusinessGuide] 自动升级目标: 零尺寸input → 可见父容器 ${step.resolvedSelector}`);
                  break;
                }
                parent = parent.parentElement;
              }
            }
          }
        }
      } else {
        console.warn("[BusinessGuide] 未能在页面中匹配到符合要求的元素");
        step.resolvedSelector = null;
      }
    } else {
      step.resolvedSelector = step.selector;
    }

    const activeSelector = step.resolvedSelector || step.selector;

    if (targetElement) {
      highlightElement = document.createElement("div");
      highlightElement.className = "guide-extension-highlight " + "guide-style-" + (step.highlightStyle || "pulse");
      document.body.appendChild(highlightElement);

      updateHighlightPosition(targetElement);
      
      if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
          updateHighlightPosition(targetElement);
        });
        resizeObserver.observe(targetElement);
        resizeObserver.observe(document.body);
      }
    }

    bubbleElement = document.createElement("div");
    bubbleElement.className = "guide-extension-bubble";
    
    bubbleElement.innerHTML = `
      <div class="guide-header">
        <span>🤖 业务合规助手：${activeGuide.title}</span>
        <button id="guide-close-btn" class="guide-btn-close">×</button>
      </div>
      <div class="guide-body">
        <h3 class="guide-step-title">
          <span class="guide-step-num">步骤 ${currentStepIndex + 1}</span>
          ${step.title}
        </h3>
        <p class="guide-step-desc">${step.description}</p>
        <!--
        <div class="guide-meta" style="margin-top: 8px; font-size: 10px; color: #64748b; border-top: 1px dashed #1e293b; padding-top: 6px;">
          <div>定位方式: <span style="color: #22d3ee; font-weight: bold;">${matchMethod}</span></div>
          <div>匹配度: <span style="color: #10b981; font-weight: bold;">${scorePercent}%</span></div>
          <div style="margin-top: 2px;">目标节点: <code>${activeSelector}</code></div>
        </div>
        -->
      </div>
      <div class="guide-footer">
        <span class="guide-progress">进度: ${currentStepIndex + 1} / ${activeGuide.steps.length}</span>
        <div class="guide-actions">
          <button id="guide-prev-btn" class="guide-btn-nav" ${currentStepIndex === 0 ? "disabled" : ""}>上一步</button>
          <button id="guide-next-btn" class="guide-btn-primary">${currentStepIndex === activeGuide.steps.length - 1 ? "完成" : "下一步"}</button>
        </div>
      </div>
    `;

    document.body.appendChild(bubbleElement);

    document.getElementById("guide-close-btn").onclick = disableGuide;
    document.getElementById("guide-prev-btn").onclick = prevStep;
    document.getElementById("guide-next-btn").onclick = nextStep;

    positionBubble(targetElement, step.tipPosition);
  }

  function updateHighlightPosition(element) {
    if (!highlightElement) return;
    const rect = element.getBoundingClientRect();
    highlightElement.style.top = `${rect.top + window.scrollY - 4}px`;
    highlightElement.style.left = `${rect.left + window.scrollX - 4}px`;
    highlightElement.style.width = `${rect.width + 8}px`;
    highlightElement.style.height = `${rect.height + 8}px`;
  }

  function positionBubble(target, position) {
    if (!bubbleElement) return;

    const gap = 12;
    if (!target) {
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
        top = tRect.top + scrollY + tRect.height / 2 - bRect.height / 2;
        left = tRect.right + scrollX + gap;
    }

    left = Math.max(10, Math.min(left, window.innerWidth - bRect.width - 20));
    top = Math.max(10, Math.min(top, document.documentElement.scrollHeight - bRect.height - 20));

    bubbleElement.style.top = `${top}px`;
    bubbleElement.style.left = `${left}px`;
  }

  function prevStep() {
    if (currentStepIndex > 0) {
      currentStepIndex--;
      renderGuideUI();
    }
  }

  // 下一步
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
})();