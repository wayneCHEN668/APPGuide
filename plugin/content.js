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

  // 本次页面加载内，已经被某一步选中/高亮过的元素——用于"重复label去重"（见 findBestSemanticMatch）。
  // 用WeakSet是因为不需要手动清理，元素被移出DOM后会自动被垃圾回收。
  // 作用域仅限"当前这一个文档"，不跨iframe/跨页面共享。
  let usedElements = new WeakSet();

  // 顶层文档 vs iframe worker 身份判定。
  // 顶层：持有引导状态、渲染气泡、读写storage、调用API——唯一的"指挥官"。
  // iframe：只被动响应顶层广播的"帮我找这个控件"指令，自己画高亮，不渲染气泡、不碰API/storage。
  // （当前只处理单层嵌套：iframe内部再嵌套iframe的情况不在这次范围内）
  const IS_TOP_FRAME = (window === window.top);
  const IFRAME_PROBE_TIMEOUT_MS = 800;

  // 跨页流程运行时状态：存在 chrome.storage.local，仅记录"进行到哪一步了"，
  // 不存具体steps内容（那些每次都从API重新拉取，保证内容永远最新）
  const FLOW_STATE_KEY = "guideFlowState";
  const FLOW_TTL_MS = 2 * 60 * 60 * 1000; // 2小时不活跃视为放弃

  // 注：API 地址由 popup 配置并存储在 chrome.storage，实际 fetch 由 background worker 代理执行

  // 给 window.__appguideDebug 加个setter：赋值时顺手写入localStorage，
  // 这样在控制台执行一次 window.__appguideDebug = true 之后，哪怕接下来页面刷新/跳转，
  // 调试开关依然保持开启，不用每次都重新设置一遍（尤其是自动续接这种页面一加载就立刻触发匹配的场景，
  // 手动设置openLog的手速根本追不上）。
  try {
    Object.defineProperty(window, "__appguideDebug", {
      configurable: true,
      get() {
        try { return localStorage.getItem("__appguideDebug") === "1"; } catch (e) { return false; }
      },
      set(val) {
        try {
          if (val) localStorage.setItem("__appguideDebug", "1");
          else localStorage.removeItem("__appguideDebug");
        } catch (e) {
          // localStorage不可用（极少数受限环境），静默忽略，退回当次页面临时生效
        }
      },
    });
  } catch (e) {
    // 极少数情况下defineProperty失败，不影响主流程
  }

  console.log(
    IS_TOP_FRAME
      ? "[BusinessGuide] 插件内容脚本已成功注入目标系统（顶层）。支持高级本地语义模糊匹配 + 跨页流程续接 + iframe内控件探测。"
      : "[BusinessGuide] 插件内容脚本已注入iframe子文档，作为顶层的控件探测worker运行。"
  );

  if (IS_TOP_FRAME) {
    // ------------------ 以下监听器只在顶层文档生效 ------------------

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
        const data = await fetchGuideFromApi(window.location.href.replace(/\/+$/, ""), state.flowId);
        if (data && data.success && data.mode === "resume") {
          console.log("[BusinessGuide] 检测到进行中的跨页流程，自动续接：", state.flowId);
          startGuideFromResolved(data, state);
        }
      } catch (e) {
        console.warn("[BusinessGuide] 自动续接检测失败（静默忽略，不打扰用户）:", e);
      }
    })();

    // 监听页面元素焦点的捕获（自动流程流转）
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
  } else {
    // ------------------ 以下只在 iframe worker 身份下生效 ------------------
    // 被动等待顶层广播的指令：找一个目标元素 / 清除当前高亮。
    // 不主动发起任何请求，不持有引导状态。
    console.log("[BusinessGuide][iframe] worker已就绪，等待顶层指令。当前文档URL:", window.location.href);

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.__appguide !== true) {
        return; // 不是我们自己的协议消息，绝大多数postMessage流量都会走这条，不打日志避免刷屏
      }

      // 单层嵌套场景下，只信任直属父frame发来的指令，避免被页面自身脚本的postMessage干扰
      if (event.source !== window.parent) {
        console.warn(
          "[BusinessGuide][iframe] 收到__appguide协议消息，但event.source不是window.parent，已丢弃。" +
          "如果顶层确实发了指令但这里一直丢弃，通常是嵌套层级超过1层，或者浏览器对这个跨域iframe的source标识有特殊处理。",
          { messageType: data.type, hasParent: window.parent !== window }
        );
        return;
      }

      console.log("[BusinessGuide][iframe] 收到顶层指令:", data.type, data.type === "find" ? `(步骤: "${data.step && data.step.title}")` : "");

      if (data.type === "clear-highlight") {
        cleanupUI();
        return;
      }

      if (data.type === "find") {
        cleanupUI(); // 开始新一轮查找前，先清掉自己可能还留着的旧高亮
        const local = resolveLocalTarget(data.step);
        if (local) {
          usedElements.add(local.element);
          createHighlightForElement(local.element, data.step.highlightStyle);
          console.log(`[BusinessGuide][iframe] 本文档内找到匹配元素，已画高亮，回复顶层 found:true`);
        } else {
          console.log(`[BusinessGuide][iframe] 本文档内没有找到"${data.step && data.step.title}"对应的元素，回复顶层 found:false`);
        }
        try {
          window.parent.postMessage({
            __appguide: true,
            type: "find-result",
            requestId: data.requestId,
            found: !!local,
          }, "*");
        } catch (e) {
          console.error("[BusinessGuide][iframe] 回复顶层失败（parent可能已不可达）:", e);
        }
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
  // 判断一个元素是不是"看起来像标签文字"——不管它是 <label>、<h3>、<div> 还是 <span>，
  // 不依赖具体标签名或class命名习惯，只看内容特征：
  // 有文字、文字不长（真正的字段标签都是短词，不会是大段说明文字）、
  // 自己内部不再装着别的可交互控件（避免把"标签+按钮"的整个容器误当成纯标签）。
  function looksLikeLabelText(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button" ||
        tag === "a" || tag === "svg" || tag === "img") {
      return false;
    }
    const text = (el.textContent || "").trim();
    if (!text || text.length > 20) return false;
    if (el.querySelector && el.querySelector("input, select, textarea, button, a, [role='button'], [tabindex]")) {
      return false;
    }
    return true;
  }

  function scanDOM() {
    const list = [];
    const seen = new Set(); // 避免同一个元素被下面多个层级重复收录

    function pushCandidate(el) {
      if (seen.has(el)) return;
      seen.add(el);

      // 排除真正"没有被渲染出来/看不见"的元素：
      // display:none / visibility:hidden / opacity:0，或者干脆尺寸就是0×0（空盒子）。
      // 注意：零尺寸这条专门给 <input> 标签留了豁免——文件上传等场景常见"隐藏input+可见父容器"
      // 的写法，input本身可能就是设计成0宽高，这种合法场景后面resolveLocalTarget里有专门的
      // "零尺寸input升级到可见父容器"逻辑处理。其它标签（尤其是div/span这类新增的候选来源）
      // 如果尺寸是0，就是真的看不见摸不着，没有理由被选中。
      // <button> 和 <a> 也豁免 display:none 检查：侧边栏折叠等场景下按钮/链接仍是有意义的引导目标。
      try {
        const cs = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const isHiddenByStyle = cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0;
        if (isHiddenByStyle && tag !== "button" && tag !== "a") {
          return;
        }
        if (tag !== "input") {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) {
            return;
          }
        }
      } catch (e) {
        // 计算样式失败（极少数情况，比如元素已从DOM分离），不因此排除
      }

      const id = el.id || "";
      const tagName = el.tagName.toLowerCase();
      const placeholder = el.placeholder || "";
      const className = (typeof el.className === "string") ? el.className : "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const textContent = el.textContent ? el.textContent.trim() : "";

      // 寻找对应的 Label 文字
      let labelText = "";
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) {
          labelText = labelEl.textContent || "";
        }
      }

      if (!labelText) {
        // 往上最多找6层，每层检查前面的兄弟节点是不是"看起来像标签文字"
        let scanEl = el;
        for (let level = 0; level < 6 && !labelText && scanEl; level++) {
          let prev = scanEl.previousElementSibling;
          while (prev) {
            if (looksLikeLabelText(prev)) {
              labelText = (prev.textContent || "").trim();
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
        } else if ((tagName === "div" || tagName === "span" || tagName === "p" || /^h[3-6]$/.test(tagName)) && textContent && textContent.length < 30) {
          // 类按钮容器（如"创建任务"/"创建一个语料库"）及标题元素，优先用自身文本
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
    }

    // 第1层：原有的标签+关键词选择器，最常见、最便宜，优先扫
    document.querySelectorAll(
      "input, select, textarea, button, a, [role='button'], div[class*='submit'], div[class*='btn'], div[class*='Btn'], [class*='submit-btn'], h3, h4, h5, h6, div[class*='switch']"
    ).forEach(pushCandidate);

    // 第2层：有 tabindex 或标准 ARIA 交互 role 的元素——
    // 这是无障碍开发规范里的信号，不依赖类名怎么起，覆盖"自定义组件但按规范做了无障碍标注"的情况
    const INTERACTIVE_ROLES = ["button", "combobox", "listbox", "menuitem", "tab", "checkbox", "radio", "switch", "option"];
    document.querySelectorAll("[tabindex], [role]").forEach(el => {
      if (seen.has(el)) return;
      const role = el.getAttribute("role");
      if (el.hasAttribute("tabindex") || (role && INTERACTIVE_ROLES.includes(role))) {
        pushCandidate(el);
      }
    });

    // 第3层："图标+短文本"结构模式——自定义下拉框/按钮很常见的长相
    // （比如 <div><p>舞蹈</p><svg>▼</svg></div> 这种，不依赖class命名）。
    // 开销可控：只看有没有svg/img子节点+文字长度，不涉及样式计算。
    document.querySelectorAll("div, span, p").forEach(el => {
      if (seen.has(el)) return;
      // 内部已经有真正的表单控件/链接了，说明这一层是容器而不是控件本身，不重复收录
      if (el.querySelector("input, select, textarea, button, a[href]")) return;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 30) return;
      if (!el.querySelector("svg, img")) return;
      // 容器太复杂（子节点太多）大概率是一大块区域而不是一个独立控件，跳过避免整块被误当成按钮
      if (el.querySelectorAll("*").length > 15) return;
      pushCandidate(el);
    });

    // 第4层：cursor:pointer 兜底——开销最大，放最后，且只对已经"文字+结构都比较像"的元素才计算样式，
    // 不会对全页面所有div暴力调用getComputedStyle。
    document.querySelectorAll("div, span, p").forEach(el => {
      if (seen.has(el)) return;
      if (el.querySelector("input, select, textarea, button, a[href]")) return;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 30) return;
      if (el.querySelectorAll("*").length > 10) return;
      try {
        if (getComputedStyle(el).cursor === "pointer") {
          pushCandidate(el);
        }
      } catch (e) {
        // 极少数情况下getComputedStyle会抛错（比如元素已经从DOM里被移除），忽略即可
      }
    });

    return list;
  }

  // 从一组"打分相同"的候选里，优先挑一个本次页面还没被别的步骤用过的；
  // 如果全都用过了（大概率是想回头再强调同一个元素），就退回原来的行为——选第一个。
  function pickPreferUnused(items) {
    const unused = items.find((it) => !usedElements.has(it.element));
    return unused || items[0];
  }

  // 对特定步骤指南执行本地语义匹配，返回最匹配的页面 DOM 元素
  function findBestSemanticMatch(step) {
    const scanned = scanDOM();
    if (scanned.length === 0) return null;

    // 调试开关：在Chrome控制台执行 window.__appguideDebug = true 即可对"接下来匹配的每一步"
    // 打印详细的候选打分过程；执行 window.__appguideDebug = false 关闭。
    // （之前这里是写死 step.title === "上传PPT文件" 只能调试固定的某一步，现在改成运行时开关，
    // 不用改代码就能对任意一步开启，包括iframe worker里也认这个开关）
    // window.__appguideDebug 现在是个读写localStorage的属性（见文件顶部defineProperty），
    // 这里直接读取即可，不用再单独处理持久化逻辑。
    const isDebug = !!window.__appguideDebug;
    if (isDebug) {
      console.log("[DEBUG] === 匹配步骤:", step.title, "===", IS_TOP_FRAME ? "(顶层文档)" : "(iframe worker: " + window.location.href + ")");
      console.log("[DEBUG] 扫描到", scanned.length, "个控件");
      console.log("[DEBUG] 全部控件:", scanned.map(it => ({
        tag: it.type, selector: it.selector, label: it.label.substring(0,40)
      })));
    }

    // 策略0: 完整标题匹配 (最高优先级)
    // clickText 优先：如果步骤配置了按钮上的确切文本，用 clickText 比对；否则回退到 title
    // 比较前去掉双方的非文字符号（如 *、#、- 等），避免因格式差异导致相等匹配失败
    const matchText = step.clickText || step.title;
    const stripSymbols = (str) => str.replace(/[^\w\u4e00-\u9fff\s]/g, '').replace(/\s+/g, ' ').trim();
    const normalizedTitle = stripSymbols(matchText);
    if (isDebug) console.log("[DEBUG] S0 完整标题匹配: matchText =", JSON.stringify(matchText), "(来源:", step.clickText ? "clickText" : "title", ")", "normalized =", JSON.stringify(normalizedTitle));
    const s0Matches = [];
    for (const item of scanned) {
      const normalizedLabel = stripSymbols(item.label);
      if (normalizedLabel === normalizedTitle) {
        s0Matches.push(item);
      }
    }
    if (s0Matches.length > 0) {
      const chosen = pickPreferUnused(s0Matches);
      if (isDebug) console.log("[DEBUG] S0 命中! label:", chosen.label.substring(0, 30), `(候选数:${s0Matches.length}, 已去重复用)`);
      return {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: 0.95
      };
    }
    if (isDebug) console.log("[DEBUG] S0 未命中，进入S1");

    // 策略1: 标题关键词子串匹配 (高置信度)
    const titleChars = matchText.replace(/^(设置|选择|找到|点击|上传|提交|填写|添加)/, '').trim();
    if (isDebug) console.log("[DEBUG] S1 关键词:", JSON.stringify(titleChars));
    const s1Matches = [];
    for (const item of scanned) {
      const labelInTitle = titleChars.length >= 2 && item.label.includes(titleChars);
      const labelInDesc = item.label.length >= 2 && step.description.includes(item.label);
      if (labelInTitle || labelInDesc) {
        s1Matches.push(item);
      }
    }
    if (s1Matches.length > 0) {
      const chosen = pickPreferUnused(s1Matches);
      if (isDebug) console.log("[DEBUG] S1 命中! label:", chosen.label.substring(0,30), `(候选数:${s1Matches.length}, 已去重复用)`);
      return {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: 0.90 + (Math.min(chosen.label.length, 6) / Math.max(chosen.label.length, 6)) * 0.10
      };
    }
    if (isDebug) console.log("[DEBUG] S1 未命中，进入S2");

    // 策略2: 标题全字符双向重叠检测
    if (isDebug) console.log("[DEBUG] S2 开始扫描...");
    let s2Top = [];
    const s2Matches = [];
    for (const item of scanned) {
      const titleSet = new Set(matchText.replace(/\s/g, '').split(''));
      const labelSet = new Set(item.label.replace(/\s/g, '').split(''));
      const overlap = [...titleSet].filter(c => labelSet.has(c)).length;
      const titleOverlap = overlap / titleSet.size;
      const labelOverlap = labelSet.size > 0 ? overlap / labelSet.size : 0;
      const bestOverlap = Math.max(titleOverlap, labelOverlap);
      if (isDebug && bestOverlap > 0.3) {
        s2Top.push({label: item.label.substring(0,30), selector: item.selector, overlap, titleOverlap: titleOverlap.toFixed(2), labelOverlap: labelOverlap.toFixed(2), best: bestOverlap.toFixed(2)});
      }
      if (bestOverlap >= 0.5 && titleSet.size >= 2) {
        s2Matches.push({ ...item, bestOverlap });
      }
    }
    if (s2Matches.length > 0) {
      const chosen = pickPreferUnused(s2Matches);
      if (isDebug) console.log("[DEBUG] S2 命中! label:", chosen.label.substring(0,30), "bestOverlap:", chosen.bestOverlap.toFixed(2), `(候选数:${s2Matches.length}, 已去重复用)`);
      return {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: 0.70 + chosen.bestOverlap * 0.30
      };
    }
    if (isDebug) console.log("[DEBUG] S2 未命中 (bestOverlap>=0.5)。高重叠候选:", s2Top.sort((a,b) => parseFloat(b.best)-parseFloat(a.best)).slice(0,5));

    // 策略3: 加权 TF 余弦相似度 (标题3份 + 描述1份)
    const query = matchText + " " + matchText + " " + matchText + " " + step.description;
    let highestScore = 0;
    let bestCandidates = []; // 记录并列最高分的所有候选（重复label场景下，分数会完全相等）
    let s3Top = [];

    scanned.forEach(item => {
      const score = computeSimilarity(
        query,
        item.label + " " + item.label + " " + item.placeholder + " " + item.ariaLabel
      );

      if (score > highestScore) {
        highestScore = score;
        bestCandidates = [item];
      } else if (score === highestScore && score > 0) {
        bestCandidates.push(item);
      }
      if (isDebug && score > 0.1) {
        s3Top.push({label: item.label.substring(0,30), selector: item.selector, score: score.toFixed(4)});
      }
    });

    let bestMatch = null;
    if (bestCandidates.length > 0) {
      const chosen = pickPreferUnused(bestCandidates);
      bestMatch = {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: highestScore
      };
    }

    if (isDebug) console.log("[DEBUG] S3 结果: score=", bestMatch ? bestMatch.score.toFixed(4) : "N/A", "label:", bestMatch ? bestMatch.label.substring(0,30) : "N/A", "selector:", bestMatch ? bestMatch.selector : "N/A", `(候选数:${bestCandidates.length})`);
    if (isDebug && s3Top.length > 1) console.log("[DEBUG] S3 Top5:", s3Top.sort((a,b) => parseFloat(b.score)-parseFloat(a.score)).slice(0,5));

    if (bestMatch && bestMatch.score >= 0.30) {
      return bestMatch;
    }
    return null;
  }

  // ------------------ 焦点与事件追踪 ------------------
  // （监听器已合并进上方 IS_TOP_FRAME 判定块内，这里不再重复注册）

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
      try {
        chrome.storage.local.get([FLOW_STATE_KEY], (result) => {
          if (chrome.runtime.lastError) {
            console.warn("[BusinessGuide] 读取流程状态失败:", chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          const state = result[FLOW_STATE_KEY];
          if (!state) {
            resolve(null);
            return;
          }
          if (Date.now() - state.lastActiveAt > FLOW_TTL_MS) {
            try { chrome.storage.local.remove(FLOW_STATE_KEY); } catch (e) { /* 静默 */ }
            resolve(null);
            return;
          }
          resolve(state);
        });
      } catch (e) {
        console.warn("[BusinessGuide] chrome.storage 不可用（扩展上下文已失效）:", e.message);
        resolve(null);
      }
    });
  }

  // 记录"接下来应该显示第几步"（globalStepNumber），每次渲染/翻页都要调用
  function persistFlowState(nextGlobalStepNumber) {
    if (!flowMeta) return;
    try {
      chrome.storage.local.set({
        [FLOW_STATE_KEY]: {
          flowId: flowMeta.flowId,
          globalStepNumber: nextGlobalStepNumber,
          lastActiveAt: Date.now(),
        },
      });
    } catch (e) {
      console.warn("[BusinessGuide] 保存流程状态失败（扩展上下文已失效）:", e.message);
    }
  }

  function clearFlowState() {
    try {
      chrome.storage.local.remove(FLOW_STATE_KEY);
    } catch (e) {
      console.warn("[BusinessGuide] 清除流程状态失败（扩展上下文已失效）:", e.message);
    }
  }

  // 核心功能：开关引导（用户手动按 Alt+G 触发）
  async function enableGuide() {
    const cleanPath = window.location.href.replace(/\/+$/, "");
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

    if (!isGuideActive || !activeGuide) {
      // renderGuideUI 因为匹配不到目标元素而中断了（已经处理过toast提示），
      // 这里不能再往下访问 activeGuide，直接结束
      return;
    }

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
  let renderRequestToken = 0; // 每次渲染自增，用于让过期的异步iframe探测结果自动作废

  function renderGuideUI() {
    cleanupUI();
    renderRequestToken++;
    const myToken = renderRequestToken;

    if (!isGuideActive || !activeGuide) return;

    const step = activeGuide.steps[currentStepIndex];
    if (!step) return;

    const local = resolveLocalTarget(step);
    if (local) {
      usedElements.add(local.element);
      createHighlightForElement(local.element, step.highlightStyle);
      renderBubble(step, local.element);
      return;
    }

    // 本文档没找到：如果是顶层且页面里确实有iframe，广播去问一次子文档；
    // 否则（不是顶层，或者顶层但没有iframe）直接判定未找到。
    // 注：当前只处理单层嵌套，不会让子iframe再往下递归探测自己的子iframe。
    const iframeEls = IS_TOP_FRAME ? Array.from(document.querySelectorAll("iframe")) : [];
    console.log(
      `[BusinessGuide] 本文档内未找到"${step.title}"，` +
      (IS_TOP_FRAME
        ? `检测到页面内共有 ${iframeEls.length} 个<iframe>` + (iframeEls.length > 0 ? "，开始向它们广播探测请求..." : "，无iframe可探测，直接判定未找到。")
        : "（当前是iframe worker身份，不会再往下探测子iframe）")
    );
    if (iframeEls.length === 0) {
      handleTargetNotFound(step);
      return;
    }

    probeChildFrames(step, iframeEls).then((foundIframeEl) => {
      // 探测是异步的，回来的时候用户可能已经点了下一步/关闭了引导/翻到了别的步骤，
      // 用token校验一下，过期的结果直接丢弃，不能覆盖当前状态。
      if (myToken !== renderRequestToken) return;
      if (!isGuideActive || !activeGuide || activeGuide.steps[currentStepIndex] !== step) return;

      if (foundIframeEl) {
        // 高亮已经由匹配到目标的那个iframe自己画好了（见文件顶部iframe worker消息处理），
        // 顶层这里只需要把气泡贴着这个iframe的边界摆放即可，不需要（也没法）自己再画一次高亮。
        renderBubble(step, foundIframeEl);
      } else {
        handleTargetNotFound(step);
      }
    });
  }

  // 只在"当前文档自己的DOM"里找目标元素（不涉及iframe）。
  // 顶层和iframe worker共用这一份逻辑：顶层用它来处理本页字段，
  // iframe worker收到顶层探测请求时，也是调用这个函数来判断自己是否有匹配的控件。
  function resolveLocalTarget(step) {
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
        try {
          const rect = targetElement.getBoundingClientRect();
          const cs = getComputedStyle(targetElement);
          console.log(
            `[BusinessGuide] 匹配元素详情 —— 位置:(${Math.round(rect.left)},${Math.round(rect.top)}) ` +
            `尺寸:${Math.round(rect.width)}×${Math.round(rect.height)} ` +
            `display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity}` +
            (rect.width === 0 || rect.height === 0 ? " ⚠️ 尺寸为0，可能是不可见元素" : ""),
            targetElement
          );
        } catch (e) {
          // 诊断信息获取失败不影响主流程
        }

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

    if (!targetElement) return null;
    return { element: targetElement, matchMethod, scorePercent };
  }

  // 顶层专用：向所有直属子iframe广播"帮我找这个步骤的目标元素"，等待第一个回复"找到了"的iframe，
  // 或者超时（说明没有任何iframe里有匹配的控件）。
  function probeChildFrames(step, iframeEls) {
    return new Promise((resolve) => {
      const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let settled = false;

      // 只传纯数据字段，避免把内部运行时状态（如上一次匹配残留的resolvedSelector）带出去
      const serializedStep = {
        title: step.title,
        description: step.description,
        selector: step.selector,
        tipPosition: step.tipPosition,
        highlightStyle: step.highlightStyle,
      };

      function onMessage(event) {
        const data = event.data;
        if (!data || data.__appguide !== true || data.type !== "find-result") return;
        if (data.requestId !== requestId) {
          // 收到的是别的探测请求的回复（比如上一步还没超时就来了新一步的探测），正常现象，忽略即可
          return;
        }
        if (!data.found) {
          console.log("[BusinessGuide] 收到某个iframe的回复：没找到，继续等其它iframe或超时。");
          return;
        }
        const matchedIframe = iframeEls.find((el) => el.contentWindow === event.source);
        if (!matchedIframe) {
          // 理论上不该发生：收到了found:true，但反查不到是哪个<iframe>标签发的。
          // 常见原因：这个iframe在探测过程中被重新导航/刷新了，导致contentWindow引用已经变了；
          // 或者页面里的<iframe>是脚本动态创建/替换的，探测发出后到回复回来之间DOM结构变了。
          console.warn(
            "[BusinessGuide] 收到found:true的回复，但反查不到对应的<iframe>标签，本次判定为未找到。" +
            "event.source:", event.source
          );
          return;
        }
        if (!settled) {
          settled = true;
          console.log("[BusinessGuide] 探测成功：目标元素位于某个子iframe内，已收到其回复。");
          window.removeEventListener("message", onMessage);
          resolve(matchedIframe);
        }
      }
      window.addEventListener("message", onMessage);

      let sentCount = 0;
      iframeEls.forEach((el, idx) => {
        try {
          if (!el.contentWindow) {
            console.warn(`[BusinessGuide] 第${idx + 1}个<iframe>没有可用的contentWindow（可能跨域被浏览器拦截，或还没加载完成），跳过。`);
            return;
          }
          el.contentWindow.postMessage(
            { __appguide: true, type: "find", requestId, step: serializedStep },
            "*"
          );
          sentCount++;
        } catch (e) {
          console.warn(`[BusinessGuide] 向第${idx + 1}个<iframe>广播探测请求失败:`, e);
        }
      });
      console.log(`[BusinessGuide] 已向 ${sentCount}/${iframeEls.length} 个<iframe>广播探测请求"${step.title}"，requestId=${requestId}，最多等待${IFRAME_PROBE_TIMEOUT_MS}ms`);

      setTimeout(() => {
        if (!settled) {
          console.warn(`[BusinessGuide] 探测超时（${IFRAME_PROBE_TIMEOUT_MS}ms内没有任何iframe回复找到目标），requestId=${requestId}`);
          settled = true;
          window.removeEventListener("message", onMessage);
          resolve(null);
        }
      }, IFRAME_PROBE_TIMEOUT_MS);
    });
  }

  // 目标元素彻底匹配失败（本文档selector+语义匹配都没找到，iframe里也没找到）：
  // 不能再假装正常渲染这一步——那样气泡会悬浮在页面上却没有任何高亮，
  // 用户根本不知道该操作哪个控件，等于给了一个假的引导。
  // 这里改为：明确提示"未找到引导入口"，并中断本次渲染（不显示气泡、不高亮）。
  function handleTargetNotFound(step) {
    console.warn(`[BusinessGuide] 步骤"${step.title}"未能在页面中匹配到目标元素，引导已中断。`);
    cleanupUI();
    showToast(`⚠️ 未找到"${step.title}"对应的页面控件，引导已中断`);
    isGuideActive = false;
    activeGuide = null;
    flowMeta = null;
    // 注意：不清空跨页流程在storage里的进度。
    // 匹配失败很可能是页面还没渲染完全这类时序问题，而不是流程本身作废；
    // 保留进度，方便用户刷新页面或手动重试时能续接回同一步，而不是被迫从头再来。
  }

  // 在当前文档里为一个元素画高亮框。顶层和iframe worker共用——
  // iframe内部用 position:fixed 天然只相对自己的视口定位，不需要做任何跨frame坐标换算。
  function createHighlightForElement(element, style) {
    highlightElement = document.createElement("div");
    highlightElement.className = "guide-extension-highlight " + "guide-style-" + (style || "pulse");
    document.body.appendChild(highlightElement);

    updateHighlightPosition(element);

    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(() => {
        updateHighlightPosition(element);
      });
      resizeObserver.observe(element);
      resizeObserver.observe(document.body);
    }
  }

  // 渲染气泡（顶层专用）。anchorElement 可以是本文档里的真实目标元素，
  // 也可以是"目标其实在某个iframe里"时，用来占位定位的那个 <iframe> 标签本身——
  // 两种情况气泡的摆放逻辑完全一样，都是贴着 anchorElement 的边界走 positionBubble 那套贴边翻转规则。
  function renderBubble(step, anchorElement) {
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

    positionBubble(anchorElement, step.tipPosition);
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
      if (!isGuideActive || !activeGuide) return; // 上一步的目标元素没匹配到，已中断
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
      if (!isGuideActive || !activeGuide) return; // 下一步的目标元素没匹配到，已中断
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
      showToast("✅ 本页操作已完成，请前往下一步骤对应页面，按 Alt+G 继续引导。");
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

    // 顶层每次清理UI时，顺带广播给所有子iframe：把你们各自可能画着的高亮也清掉。
    // 这样即使上一步的目标在某个iframe里，切到下一步/关闭引导时也不会留下一个擦不掉的高亮框。
    if (IS_TOP_FRAME) {
      document.querySelectorAll("iframe").forEach((el) => {
        try {
          el.contentWindow && el.contentWindow.postMessage({ __appguide: true, type: "clear-highlight" }, "*");
        } catch (e) {
          // 跨域/未就绪等情况忽略即可
        }
      });
    }
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