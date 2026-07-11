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

  // 当前引导所属的跨页流程元信息（单页引导时为null）
  // { flowId, pageIndex, totalPages, globalStepOffset, totalSteps }
  let flowMeta = null;

  // 气泡 DOM 及高亮层 DOM
  let bubbleElement = null;
  let highlightElement = null;
  let resizeObserver = null;

  // 跨页流程运行时状态：存在 chrome.storage.local，仅记录"进行到哪一步了"，
  // 不存具体steps内容（那些每次都从API重新拉取，保证内容永远最新）
  const FLOW_STATE_KEY = "guideFlowState";
  const FLOW_TTL_MS = 2 * 60 * 60 * 1000; // 2小时不活跃视为放弃

  // 注：API 地址由 popup 配置并存储在 chrome.storage，实际 fetch 由 background worker 代理执行

  console.log("[BusinessGuide] 插件内容脚本已成功注入目标系统。支持高级本地语义模糊匹配 + 跨页流程续接。");

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

  // ------------------ 跨页流程：被动型自动续接 ------------------
  // 页面刚加载时（脚本刚被注入），静默检查是否有一个尚未过期的进行中流程，
  // 如果当前页恰好是该流程的下一页，就自动恢复引导，不需要用户再按一次 Alt+G。
  // 注意：这里只在 mode==="resume" 时才动作；如果检测结果是 new/choose/not_found
  // （说明用户此刻打开的页面跟进行中的流程无关），一律保持安静，不弹任何提示，
  // 也不清空已存的流程状态（万一用户只是临时切走，待会儿还会跳回正确的页面）。
  (async function autoResumeFlowOnLoad() {
    const state = await getFlowStateIfValid();
    if (!state) return;

    try {
      const data = await fetchGuideFromApi(window.location.pathname, state.flowId);
      if (data && data.success && data.mode === "resume") {
        console.log("[BusinessGuide] 检测到进行中的跨页流程，自动续接：", state.flowId);
        startGuideFromResolved(data, state);
      }
    } catch (e) {
      console.warn("[BusinessGuide] 自动续接检测失败（静默忽略，不打扰用户）:", e);
    }
  })();

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

  // 通过 background worker 代理请求 /api/guide，绕过 HTTPS 页面的 Mixed Content 限制。
  // flowId 传入当前进行中的流程id（没有则不传），供服务端做分支A/B判定。
  function fetchGuideFromApi(pathname, flowId) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "fetch-guide", url: pathname, flowId: flowId || "" },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response.data);
          } else {
            reject(new Error((response && response.error) || "API 请求失败"));
          }
        }
      );
    });
  }

  // 读取跨页流程运行时状态，并做TTL过期判断（过期则顺手清空，返回null）
  function getFlowStateIfValid() {
    return new Promise((resolve) => {
      chrome.storage.local.get([FLOW_STATE_KEY], (result) => {
        const state = result[FLOW_STATE_KEY];
        if (!state) {
          resolve(null);
          return;
        }
        if (Date.now() - state.lastActiveAt > FLOW_TTL_MS) {
          chrome.storage.local.remove(FLOW_STATE_KEY);
          resolve(null);
          return;
        }
        resolve(state);
      });
    });
  }

  // 记录"接下来应该显示第几步"（globalStepNumber），每次渲染/翻页都要调用
  function persistFlowState(nextGlobalStepNumber) {
    if (!flowMeta) return;
    chrome.storage.local.set({
      [FLOW_STATE_KEY]: {
        flowId: flowMeta.flowId,
        globalStepNumber: nextGlobalStepNumber,
        lastActiveAt: Date.now(),
      },
    });
  }

  function clearFlowState() {
    chrome.storage.local.remove(FLOW_STATE_KEY);
  }

  // 核心功能：开关引导（用户手动按 Alt+G 触发）
  async function enableGuide() {
    const cleanPath = window.location.pathname;
    console.log("[BusinessGuide] 正在检测页面并获取 API 校验...", cleanPath);

    const state = await getFlowStateIfValid();

    try {
      const data = await fetchGuideFromApi(cleanPath, state ? state.flowId : null);
      handleGuideApiResult(data, cleanPath, state, true);
    } catch (e) {
      console.error("[BusinessGuide] 无法连接到 API 配置端点:", e);
      showToast("❌ 业务指南 API 端点连接失败");
    }
  }

  // 统一处理 /api/guide 的四种返回结果：resume / new / choose / not_found(或其它失败)
  // manual=true 表示这是用户主动触发的（Alt+G 或候选选择），所有结果都要给出UI反馈；
  // manual=false 表示这是页面加载时的被动自动检测，只在 resume 时才动作，其余情况保持安静。
  function handleGuideApiResult(data, cleanPath, state, manual) {
    if (!data) {
      if (manual) showToast("❌ 业务指南 API 端点连接失败");
      return;
    }

    if (data.success && data.mode === "resume") {
      startGuideFromResolved(data, state);
      return;
    }

    if (!manual) return; // 被动检测：非resume结果一律静默忽略

    if (data.success && data.mode === "new") {
      startGuideFromResolved(data, null);
      return;
    }
    if (data.success && data.mode === "choose") {
      renderCandidateChooser(data.candidates, cleanPath);
      return;
    }
    if (!data.success && data.reason === "not_found") {
      showToast("💡 " + (data.message || "当前页面未配置特定的业务操作指南 API"));
      return;
    }
    showToast("❌ 业务指南 API 端点连接失败");
  }

  // 根据 /api/guide 返回的已解析页面数据，启动/续接引导渲染
  // resumeState：仅当data.mode==="resume"且是从storage续接来的时候传入，
  // 用于把之前存的globalStepNumber换算成这一页内的localIndex，从而精确停在原来的步骤上；
  // 否则（全新流程/用户手动选择流程）一律从这一页第一步开始。
  function startGuideFromResolved(data, resumeState) {
    flowMeta = {
      flowId: data.flowId,
      pageIndex: data.pageIndex,
      totalPages: data.totalPages,
      globalStepOffset: data.globalStepOffset,
      totalSteps: data.totalSteps,
    };
    activeGuide = {
      title: data.flowTitle,
      steps: data.page.steps,
    };

    let startLocalIndex = 0;
    if (resumeState && typeof resumeState.globalStepNumber === "number") {
      const idx = resumeState.globalStepNumber - data.globalStepOffset - 1;
      if (idx >= 0 && idx < activeGuide.steps.length) {
        startLocalIndex = idx;
      }
    }

    currentStepIndex = startLocalIndex;
    isGuideActive = true;
    renderGuideUI();
    persistFlowState(activeGuide.steps[currentStepIndex].globalStepNumber);
    console.log("[BusinessGuide] 已加载业务流程指南：" + activeGuide.title +
      `（第${data.pageIndex + 1}/${data.totalPages}页，步骤${activeGuide.steps[currentStepIndex].globalStepNumber}/${data.totalSteps}）`);
  }

  // 多个流程共享同一起始页时，展示候选列表让用户选择
  function renderCandidateChooser(candidates, cleanPath) {
    cleanupUI();

    bubbleElement = document.createElement("div");
    bubbleElement.className = "guide-extension-bubble";
    bubbleElement.innerHTML = `
      <div class="guide-header">
        <span>🤖 业务合规助手</span>
        <button id="guide-close-btn" class="guide-btn-close">×</button>
      </div>
      <div class="guide-body">
        <h3 class="guide-step-title">检测到多个可用引导流程</h3>
        <p class="guide-step-desc">请选择要开始的流程：</p>
        <div class="guide-candidate-list">
          ${candidates.map(c => `
            <button class="guide-candidate-item" data-flow-id="${c.flowId}">
              <strong>${c.title}</strong>
              <span>${c.description || ""}</span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
    document.body.appendChild(bubbleElement);

    document.getElementById("guide-close-btn").onclick = disableGuide;
    bubbleElement.querySelectorAll(".guide-candidate-item").forEach((btn) => {
      btn.onclick = async () => {
        const chosenFlowId = btn.getAttribute("data-flow-id");
        try {
          const data = await fetchGuideFromApi(cleanPath, chosenFlowId);
          handleGuideApiResult(data, cleanPath, null, true);
        } catch (e) {
          console.error("[BusinessGuide] 选择流程后拉取指南失败:", e);
          showToast("❌ 业务指南 API 端点连接失败");
        }
      };
    });

    positionBubble(null, "top");
  }

  function disableGuide() {
    isGuideActive = false;
    activeGuide = null;
    flowMeta = null;
    cleanupUI();
    clearFlowState();
    console.log("[BusinessGuide] 业务操作引导已关闭，进行中的流程状态已清除。");
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

    // 进度显示：有跨页flow元信息时用全局步数，兼容没有flowMeta的极端情况（理论上不会发生）
    const globalNum = step.globalStepNumber || (currentStepIndex + 1);
    const totalNum = (flowMeta && flowMeta.totalSteps) || activeGuide.steps.length;
    const isLastStepOnPage = currentStepIndex === activeGuide.steps.length - 1;
    const isLastPageOfFlow = !flowMeta || flowMeta.pageIndex >= flowMeta.totalPages - 1;
    let nextBtnLabel = "下一步";
    if (isLastStepOnPage) {
      nextBtnLabel = isLastPageOfFlow ? "完成" : "前往下一页";
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
          <span class="guide-step-num">步骤 ${globalNum}</span>
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
        <span class="guide-progress">进度: ${globalNum} / ${totalNum}</span>
        <div class="guide-actions">
          <button id="guide-prev-btn" class="guide-btn-nav" ${currentStepIndex === 0 ? "disabled" : ""}>上一步</button>
          <button id="guide-next-btn" class="guide-btn-primary">${nextBtnLabel}</button>
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

    const scrollY = window.scrollY;
    const scrollX = window.scrollX;
    const viewportWidth = window.innerWidth;

    // 没显式指定 top/bottom/left 时，一律按原有默认行为"right"处理
    let effectivePosition = (position === "top" || position === "bottom" || position === "left")
      ? position
      : "right";

    // 空间探测：右侧/左侧各自能放下气泡宽度的可用空间
    const spaceOnRight = viewportWidth - (tRect.right + gap);
    const spaceOnLeft = tRect.left - gap;

    if (effectivePosition === "right" && spaceOnRight < bRect.width) {
      // 右侧放不下：左侧够放，或左侧空间明显比右侧宽裕，就翻转到左侧
      if (spaceOnLeft >= bRect.width || spaceOnLeft > spaceOnRight) {
        effectivePosition = "left";
      }
      // 两侧都放不下（视口特别窄）时保留right，交给最后的clamp兜底
    } else if (effectivePosition === "left" && spaceOnLeft < bRect.width) {
      if (spaceOnRight >= bRect.width || spaceOnRight > spaceOnLeft) {
        effectivePosition = "right";
      }
    }

    let top = 0;
    let left = 0;

    switch (effectivePosition) {
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
    // 注：目前"上一步"只在本页内回退，不支持跨页回退到上一页最后一步
    // （跨页后退涉及浏览器历史导航，复杂度更高，暂不在这次范围内）
    if (currentStepIndex > 0) {
      currentStepIndex--;
      renderGuideUI();
      persistFlowState(activeGuide.steps[currentStepIndex].globalStepNumber);
    }
  }

  // 下一步
  function nextStep() {
    advanceStep();
  }

  function advanceStep() {
    const isLastStepOnPage = currentStepIndex >= activeGuide.steps.length - 1;

    if (!isLastStepOnPage) {
      currentStepIndex++;
      renderGuideUI();
      persistFlowState(activeGuide.steps[currentStepIndex].globalStepNumber);
      return;
    }

    const isLastPageOfFlow = !flowMeta || flowMeta.pageIndex >= flowMeta.totalPages - 1;

    if (isLastPageOfFlow) {
      // 整个跨页流程全部完成
      showToast("🎉 恭喜！您已成功遵照合规完成了该业务流程。");
      clearFlowState();
      disableGuide();
    } else {
      // 本页步骤已走完，但流程还有后续页面——不清空流程进度，只收起当前UI，
      // 等用户跳转到下一页（真实业务系统的页面跳转）后，被动型自动续接逻辑会接上。
      const lastGlobalNum = activeGuide.steps[currentStepIndex].globalStepNumber;
      persistFlowState(lastGlobalNum + 1);
      showToast("✅ 本页操作已完成，请前往下一步骤对应页面继续引导。");
      isGuideActive = false;
      activeGuide = null;
      flowMeta = null;
      cleanupUI();
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