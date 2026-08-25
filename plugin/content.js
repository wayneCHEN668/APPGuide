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
  let confirmDialogEl = null;
  let flowNotificationEl = null;

  // 本次页面加载内，已经被某一步选中/高亮过的元素——用于"重复label去重"（见 findBestSemanticMatch）。
  // 用WeakSet是因为不需要手动清理，元素被移出DOM后会自动被垃圾回收。
  // 作用域仅限"当前这一个文档"，不跨iframe/跨页面共享。
  let usedElements = new WeakSet();

  // 每个步骤上一轮匹配到的元素（步骤对象 → 元素）。同一步骤重渲染时先把它从 usedElements 里放回去，
  // 免得自己占的坑把自己挡住（见 renderGuideUI）。
  // 用WeakMap而不是往step上挂属性：step对象可能与 flowMeta.cachedFlow 里的步骤是同一个引用，
  // 而 cachedFlow 会被 persistFlowState 写进 chrome.storage——DOM元素不可结构化克隆，挂上去会写失败。
  const stepMatchedElements = new WeakMap();

  // 顶层文档 vs iframe worker 身份判定。
  // 顶层：持有引导状态、渲染气泡、读写storage、调用API——唯一的"指挥官"。
  // iframe：只被动响应顶层广播的"帮我找这个控件"指令，自己画高亮，不渲染气泡、不碰API/storage。
  // （当前只处理单层嵌套：iframe内部再嵌套iframe的情况不在这次范围内）
  const IS_TOP_FRAME = (window === window.top);
  const IFRAME_PROBE_TIMEOUT_MS = 800;

  // 气泡标题栏图标（需在 manifest.json 的 web_accessible_resources 中声明）
  const ICON_URL = chrome.runtime.getURL("icons/icon_16t.png");

  // 跨页流程运行时状态：存在 chrome.storage.local，仅记录"进行到哪一步了"，
  // 不存具体steps内容（那些每次都从API重新拉取，保证内容永远最新）
  const FLOW_STATE_KEY = "appguide_flowState";
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
        try { return localStorage.getItem("appguide_debug") === "1"; } catch (e) { return false; }
      },
      set(val) {
        try {
          if (val) localStorage.setItem("appguide_debug", "1");
          else localStorage.removeItem("appguide_debug");
        } catch (e) {
          // localStorage不可用（极少数受限环境），静默忽略，退回当次页面临时生效
        }
      },
    });
  } catch (e) {
    // 极少数情况下defineProperty失败，不影响主流程
  }

//   console.log(
//     IS_TOP_FRAME
//       ? "[BusinessGuide] 引导插件内容脚本已成功注入目标系统（顶层）。引导模式已就绪，快捷键：Alt+G"
//       : "[BusinessGuide] 引导插件内容脚本已注入iframe子文档，作为顶层的控件探测worker运行。"
//   );

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

      // 缓存优先：以 state.pageIndex 为目标页，只比对这一页的 URL，避免跳到流程中其他页
      if (state.cachedFlow) {
        var targetIdx = (typeof state.pageIndex === "number") ? state.pageIndex : 0;
        if (targetIdx >= 0 && targetIdx < state.cachedFlow.pages.length) {
          var expectedPage = state.cachedFlow.pages[targetIdx];
          if (urlsMatchClient(expectedPage.url, window.location.href)) {
            var resolved = resolvePageByIndex(state.cachedFlow, targetIdx);
//             console.log("[BusinessGuide] 从本地缓存续接跨页流程：", state.flowId,
//               "（第" + (targetIdx + 1) + "/" + state.cachedFlow.pages.length + "页）");
            startGuideFromResolved(resolved, state);
            return;
          }
          // URL 不匹配 → 直接按继续引导处理
//           console.log("[BusinessGuide] 当前 URL 与流程预期页面不匹配，直接继续引导");
          var resolved = resolvePageByIndex(state.cachedFlow, targetIdx);
          if (resolved) {
            startGuideFromResolved(resolved, state);
          } else {
            showToast("❌ 无法加载预期页面数据");
          }
          return;
        }
        // pageIndex 异常，回退 API
      }

      try {
        const data = await fetchGuideFromApi(getCleanPath(), state.flowId);
        if (data && data.success && data.mode === "resume") {
//           console.log("[BusinessGuide] 检测到进行中的跨页流程，自动续接：", state.flowId);
          startGuideFromResolved(data, state);
        }
      } catch (e) {
//         console.warn("[BusinessGuide] 自动续接检测失败（静默忽略，不打扰用户）:", e);
      }
    })();

    // ------------------ 页面加载时静默检测可用引导流程 ------------------
    // 提取为可复用的函数，页面跳转后也需要重新检测
    let flowNotifyRequestToken = 0; // 防止快速连续跳转时过期的流程通知覆盖当前页面
    async function refreshFlowNotification() {
      // 先清掉旧通知，避免短暂残留上一页的结果
      removeFlowNotification();
      flowNotifyRequestToken++;
      const myToken = flowNotifyRequestToken;
      try {
        const flows = await fetchFlowsByPattern(getCleanPath());
        if (myToken !== flowNotifyRequestToken) return; // 丢弃过期响应
        if (flows && flows.length > 0) {
//           console.log("[BusinessGuide] 检测到", flows.length, "个可用引导流程");
          renderFlowNotification(flows);
        }
        else {
          // 结果为 0 时不渲染任何东西（旧通知已在上面清掉）
//           console.log("[BusinessGuide] 检测到", flows.length, "个可用引导流程 " + getCleanPath());
        }
      } catch (e) {
//         console.warn("[BusinessGuide] refreshFlowNotification 失败:", e);        
      }
    }

    // 页面首次加载时检测
    refreshFlowNotification();

    // 监听 URL 变化（SPA 路由跳转 / pushState / popstate），重新检测当前页的可用流程
    let lastCheckedPath = getCleanPath();
    const checkUrlChange = () => {
      const currentPath = getCleanPath();
      if (currentPath !== lastCheckedPath) {
        lastCheckedPath = currentPath;
        refreshFlowNotification();
      }
    };
    window.addEventListener("popstate", checkUrlChange);
    // 拦截 pushState / replaceState 以覆盖 SPA 路由跳转
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function (...args) {
      origPushState.apply(this, args);
      checkUrlChange();
    };
    history.replaceState = function (...args) {
      origReplaceState.apply(this, args);
      checkUrlChange();
    };
    // 兜底：每 2 秒轮询检查（部分 SPA 用 hash 跳转不会触发上述事件）
    setInterval(checkUrlChange, 2000);

    // 监听页面元素焦点的捕获（自动流程流转）
    document.addEventListener("focus", (e) => {
      if (!isGuideActive || !activeGuide) return;

      const step = activeGuide.steps[currentStepIndex];
      if (!step) return;

      try {
        const activeSelector = step.resolvedSelector || step.selector;
        // 步骤可能压根没配selector（服务端下发的步骤只有title/description），
        // 语义匹配没落地时 resolvedSelector 也会是 null/空串。
        // 空串传给 querySelector 会直接抛 SyntaxError（每次焦点事件都刷一条），
        // undefined 则会被当成 "undefined" 标签名白查一次——两种都没有意义，直接跳过。
        if (!activeSelector) return;
        const target = document.querySelector(activeSelector);
        if (target && (target === e.target || target.contains(e.target))) {
//           console.log("[BusinessGuide] 操作员精准定位到当前目标：", activeSelector);

          if (step.actionType === "focus") {
            setTimeout(() => {
              advanceStep();
            }, 800);
          }
        }
      } catch(err) {
//         console.error(err);
      }
    }, true);
  } else {
    // ------------------ 以下只在 iframe worker 身份下生效 ------------------
    // 被动等待顶层广播的指令：找一个目标元素 / 清除当前高亮。
    // 不主动发起任何请求，不持有引导状态。
//     console.log("[BusinessGuide][iframe] worker已就绪，等待顶层指令。当前文档URL:", window.location.href);

    // 同一个步骤会被顶层探测多次（超时重试 + S0→S3逐级联配各来一轮），而每次收到的 step 都是
    // 顶层新拼的纯数据对象，没法像顶层那样把"上一轮占用的元素"挂在 step 上。这里按步骤标题记住，
    // 下一次针对同一步骤的探测先释放它，否则第二轮探测会因为"已被占用"而被迫换成另一个元素。
    const iframeStepMatched = new Map();

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.__appguide !== true) {
        return; // 不是我们自己的协议消息，绝大多数postMessage流量都会走这条，不打日志避免刷屏
      }

      // 单层嵌套场景下，只信任直属父frame发来的指令，避免被页面自身脚本的postMessage干扰
      if (event.source !== window.parent) {
//         console.warn(
//           "[BusinessGuide][iframe] 收到__appguide协议消息，但event.source不是window.parent，已丢弃。" +
//           "如果顶层确实发了指令但这里一直丢弃，通常是嵌套层级超过1层，或者浏览器对这个跨域iframe的source标识有特殊处理。",
//           { messageType: data.type, hasParent: window.parent !== window }
//         );
        return;
      }

//       console.log("[BusinessGuide][iframe] 收到顶层指令:", data.type, data.type === "find" ? `(步骤: "${data.step && data.step.title}")` : "");

      if (data.type === "clear-highlight") {
        cleanupUI();
        return;
      }

      if (data.type === "find") {
        cleanupUI(); // 开始新一轮查找前，先清掉自己可能还留着的旧高亮
        const stepKey = (data.step && data.step.title) || "";
        const prevMatched = iframeStepMatched.get(stepKey);
        if (prevMatched) {
          usedElements.delete(prevMatched);
          iframeStepMatched.delete(stepKey);
        }
        const local = resolveLocalTarget(data.step, false, data.step.strategyLevel);
        if (local) {
          usedElements.add(local.element);
          iframeStepMatched.set(stepKey, local.element);
          createHighlightForElement(local.element, data.step.highlightStyle);
//           console.log(`[BusinessGuide][iframe] 本文档内找到匹配元素，已画高亮，回复顶层 found:true`);
        } else {
//           console.log(`[BusinessGuide][iframe] 本文档内没有找到"${data.step && data.step.title}"对应的元素，回复顶层 found:false`);
        }
        try {
          window.parent.postMessage({
            __appguide: true,
            type: "find-result",
            requestId: data.requestId,
            found: !!local,
            score: local ? local.scorePercent : 0,
          }, "*");
        } catch (e) {
//           console.error("[BusinessGuide][iframe] 回复顶层失败（parent可能已不可达）:", e);
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
      // input 零尺寸豁免是有条件的：只对"自身0×0但父容器正常尺寸"的 input
      // （典型如 file upload 的隐藏 input + 可见父容器）保留豁免；
      // 如果父容器也 0×0，说明整个组件都处于收起/隐藏态，不应进候选池。
      try {
        const cs = getComputedStyle(el);
        const tag = el.tagName.toLowerCase();
        const isHiddenByStyle = cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0;
        if (isHiddenByStyle) {
          return;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          if (tag !== "input") {
            return;
          }
          const parent = el.parentElement;
          if (parent) {
            const pr = parent.getBoundingClientRect();
            if (pr.width === 0 && pr.height === 0) {
              return;
            }
          }
        }

        // 排除"被折叠容器裁掉"的元素：手风琴菜单收起时的典型实现不是 display:none，
        // 而是给容器 max-height:0 / height:0 + overflow:hidden——被收起的子项自己依然有
        // 完整的布局尺寸（rect 照样是 208×40），上面那几道检查一个都拦不住，
        // 于是"收起的子菜单项"会照常进候选池，把可见的父级菜单顶掉。
        // 只对"尺寸为0的祖先"才去算样式，正常情况下不会有额外开销。
        let clipAncestor = el.parentElement;
        for (let lv = 0; lv < 8 && clipAncestor && clipAncestor !== document.body; lv++) {
          const ar = clipAncestor.getBoundingClientRect();
          if (ar.height === 0 || ar.width === 0) {
            const acs = getComputedStyle(clipAncestor);
            if (acs.overflow !== "visible" || acs.overflowX !== "visible" || acs.overflowY !== "visible") {
              return;
            }
          }
          clipAncestor = clipAncestor.parentElement;
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

      // 寻找对应的 Label 文字。
      // labelFromSelf 记录这个label是"元素自己就带着的"（自身文字 / label[for] 绑定 / aria-label），
      // 还是"从旁边推导借来的"（sibling walk / 父容器文本）。下面过滤空壳图标元素时要用：
      // 只有"借来的"才该被过滤，自带标签的图标按钮必须留在候选池里。
      let labelText = "";
      let labelFromSelf = false;
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) {
          labelText = labelEl.textContent || "";
          labelFromSelf = true; // <label for> 是显式绑定到这个控件的，等同于它自己的标签
        }
      }

      if (!labelText) {
        // <button> 和 <a> 是自标注元素，优先使用自身文本作为标签；
        // 只有自身无文本（如图标按钮）时才走后续的向上查找逻辑
        if ((tagName === "button" || tagName === "a" || el.getAttribute("role") === "button") && textContent) {
          labelText = textContent;
          labelFromSelf = true;
        }
      }

      if (!labelText) {
        // 元素自己就带着文字时（比如 <span class="menu-title">企业数据管理</span>），
        // 这段文字才是它真正的语义标签，必须优先于下面的 sibling-walk。
        // 否则同一个分组里的每一项都会被上方那行分组标题（"企业管理"之类）覆盖成同一个label，
        // 彼此再也区分不开，匹配只能靠并列取舍去猜，必然选错。
        // 只认"直接文本节点"：容器套着一堆后代文字的情况仍然走下面的原有逻辑。
        let ownText = "";
        for (let ci = 0; ci < el.childNodes.length; ci++) {
          const child = el.childNodes[ci];
          if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
            ownText += child.textContent.trim();
          }
        }
        if (ownText && ownText.length < 30) {
          labelText = ownText;
          labelFromSelf = true;
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
          labelFromSelf = !!textContent;
        } else if ((tagName === "div" || tagName === "span" || tagName === "p" || /^h[3-6]$/.test(tagName)) && textContent && textContent.length < 30) {
          // 类按钮容器（如"创建任务"/"创建一个语料库"）及标题元素，优先用自身文本
          labelText = textContent;
          labelFromSelf = true;
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

      // aria-label 兜底：纯图标按钮（如侧边栏展开/收起）通常只有 aria-label 作为
      // 唯一可识别的文本标签，但上面那套 sibling/parent walk 拿不到它——因为
      // aria-label 不是可见文本节点，只能通过 getAttribute 获取。
      // 这里如果 labelText 还为空就用 ariaLabel；如果不为空但不包含 ariaLabel
      // （说明 sibling walk 拿到的只是附近无关文字），就把 ariaLabel 前置优先。
      if (ariaLabel && !textContent) {
        // 纯图标控件（自身一个字都没有）：aria-label 就是它唯一且正确的语义标签，
        // 必须整个替换掉上面 sibling/parent walk 借来的邻居文字——那些文字属于别的控件，
        // 拼进来会让这个按钮的label塞进半个侧边栏的内容，从而在别人的匹配里冒名顶替。
        labelText = ariaLabel;
        labelFromSelf = true;
      } else if (!labelText && ariaLabel) {
        labelText = ariaLabel;
        labelFromSelf = true; // aria-label 是写在这个元素自己身上的，属于自带标签
      } else if (labelText && ariaLabel && !labelText.includes(ariaLabel)) {
        labelText = ariaLabel + " " + labelText;
        labelFromSelf = true;
      }

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
        // 过滤空壳图标元素：自身无直接文本节点，仅包含svg/img等图标子节点，
        // 且label是从旁边"借"来的（sibling walk / 父容器文本），比如 "<span class="icon"><svg>…</svg></span>"
        // 借用了隔壁的字段名——这种要过滤掉，高亮应落在文字元素本身而非图标壳子上。
        //
        // 但"自带标签"的元素不在此列（labelFromSelf）：纯图标按钮（侧边栏收起、关闭X、汉堡菜单）
        // 的 aria-label 就写在它自己身上，是它唯一也是正确的语义标签。
        // 之前这里只看元素长相不看label来源，把上面那段 aria-label 兜底逻辑的成果又一把丢掉，
        // 导致这类控件永远进不了候选池、永远匹配不上——两段代码互相打架。
        if (labelText && !labelFromSelf) {
          var hasOwnDirectText = false;
          for (var ci = 0; ci < el.childNodes.length; ci++) {
            var child = el.childNodes[ci];
            if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
              hasOwnDirectText = true;
              break;
            }
          }
          if (!hasOwnDirectText && el.querySelector && el.querySelector("svg, img, i[class*='icon'], span[class*='icon']")) {
            return; // 空图标壳子，不纳入候选池
          }
        }

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
      "input, select, textarea, button, a, [role='button'], div[class*='submit'], div[class*='btn'], div[class*='Btn'], [class*='submit-btn'], div[class*='switch'], div[class*='icon-button'], [class*='cursor-pointer']"
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

    // 第4层：cursor:pointer 兜底——开销最大，放最后，且只对已经"结构上比较像"的元素才计算样式，
    // 不会对全页面所有div暴力调用getComputedStyle。
    // 注意：这里不要求元素自身必须有文字——像开关(toggle switch)这类控件，
    // 本身通常是纯CSS画出来的空容器（没有文字也没有图标），完全靠旁边的字段标签
    // （走前面label推导那套sibling-walk逻辑）才能关联上语义。如果这里卡"必须有自身文字"，
    // 这类控件永远进不了候选池。
    // h3-h6也放在这一层：标题标签本身不代表"可交互"（不像button/input/a那样天然可交互），
    // 有没有点击行为完全看有没有设cursor:pointer——不能像真正的表单控件那样无条件收录，
    // 否则会跟旁边真正的控件（比如这次的开关）打平手，抢了不该抢的匹配。
    document.querySelectorAll("div, span, p, h3, h4, h5, h6").forEach(el => {
      if (seen.has(el)) return;
      if (el.querySelector("input, select, textarea, button, a[href]")) return;
      const text = (el.textContent || "").trim();
      if (text.length > 30) return; // 自身文字太长（一大段说明文字）大概率不是单个控件，跳过
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
  // 从一组"打分相同"的候选里做二次筛选：
  // 1) 优先只保留"最精确"的那些——如果A是B的外层容器（A.contains(B)），
  //    候选里同时出现A和B时，只保留B（更具体、更贴近真正要操作的控件，
  //    不要选中一个大容器，哪怕它文字上也对得上）。
  // 2) 在这批精确候选里，再优先挑一个本次页面还没被别的步骤用过的；
  //    如果全都用过了（大概率是想回头再强调同一个元素），就退回原来的行为——选第一个。
  function pickPreferUnused(items) {
    const mostSpecific = items.filter((it) =>
      !items.some((other) => other !== it && it.element.contains(other.element))
    );
    const pool = mostSpecific.length > 0 ? mostSpecific : items;
    const unused = pool.find((it) => !usedElements.has(it.element));
    return unused || pool[0];
  }

  // ---- 语义匹配预处理工具 ----

  // 清洗文本中的非文字符号和占位填充词
  function stripSymbols(str) {
    return str.replace(/[^\w一-鿿\s]/g, '').replace(/(?:一个|一下|一份|一次)/g, '').replace(/\s+/g, '').trim();
  }

  // 从步骤中提取用于匹配的核心文本
  function getMatchText(step) {
    var rawText = step.clickText || step.title;
    var spaceIdx = rawText.indexOf(" ");
    return spaceIdx > 0 ? rawText.substring(0, spaceIdx) : rawText;
  }

  // ---- 独立策略函数 (S0-S3) ----
  // 每个接收 (step, scanned)，返回 {element, selector, label, score} 或 null

  // S0: 完整标题精确匹配 (最高优先级)
  function tryS0Match(step, scanned) {
    var isDebug = !!window.__appguideDebug;
    var matchText = getMatchText(step);
    var normalizedTitle = stripSymbols(matchText);
//     if (isDebug) console.log("[DEBUG] S0 完整标题匹配: matchText =", JSON.stringify(matchText), "(来源:", step.clickText ? "clickText" : "title", ")", "normalized =", JSON.stringify(normalizedTitle));
    if (normalizedTitle.length === 0) {
//       if (isDebug) console.log("[DEBUG] S0 标题清洗后为空字符串，跳过");
      return null;
    }
    var s0Matches = [];
    for (var i = 0; i < scanned.length; i++) {
      var item = scanned[i];
      var normalizedLabel = stripSymbols(item.label);
      if (normalizedLabel === normalizedTitle) {
        s0Matches.push(item);
      }
    }
    if (s0Matches.length > 0) {
      var chosen = pickPreferUnused(s0Matches);
//       if (isDebug) console.log("[DEBUG] S0 命中! label:", chosen.label.substring(0, 30), "(候选数:" + s0Matches.length + ")");
      return { element: chosen.element, selector: chosen.selector, label: chosen.label, score: 0.95 };
    }
//     if (isDebug) console.log("[DEBUG] S0 未命中");
    return null;
  }

  // S1: 标题关键词子串匹配
  function tryS1Match(step, scanned) {
    var isDebug = !!window.__appguideDebug;
    var matchText = getMatchText(step);
    var titleChars = matchText.replace(/^(设置|选择|找到|点击|上传|提交|填写|添加|输入|创建)/, '').trim();
//     if (isDebug) console.log("[DEBUG] S1 关键词:", JSON.stringify(titleChars));
    var s1Matches = [];
    for (var i = 0; i < scanned.length; i++) {
      var item = scanned[i];
      var labelInTitle = titleChars.length >= 2 && item.label.includes(titleChars);
      if (labelInTitle) {
        s1Matches.push(item);
      }
    }
    if (s1Matches.length > 0) {
      var chosen = pickPreferUnused(s1Matches);
//       if (isDebug) console.log("[DEBUG] S1 命中! label:", chosen.label.substring(0,30), "(候选数:" + s1Matches.length + ")");
      return {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: 0.90 + (Math.min(chosen.label.length, 6) / Math.max(chosen.label.length, 6)) * 0.10
      };
    }
//     if (isDebug) console.log("[DEBUG] S1 未命中");
    return null;
  }

  // S2: 标题全字符双向重叠检测
  function tryS2Match(step, scanned) {
    var isDebug = !!window.__appguideDebug;
    var matchText = getMatchText(step);
//     if (isDebug) console.log("[DEBUG] S2 开始扫描...");
    var s2Top = [];
    var s2Matches = [];
    for (var i = 0; i < scanned.length; i++) {
      var item = scanned[i];
      var labelLen = item.label.replace(/\s/g, '').length;
      if (labelLen > 8) continue;
      var titleSet = new Set(matchText.replace(/\s/g, '').split(''));
      var labelSet = new Set(item.label.replace(/\s/g, '').split(''));
      var overlap = 0;
      titleSet.forEach(function(c) { if (labelSet.has(c)) overlap++; });
      var titleOverlap = overlap / titleSet.size;
      var labelOverlap = labelSet.size > 0 ? overlap / labelSet.size : 0;
      var bestOverlap = Math.max(titleOverlap, labelOverlap);
      if (isDebug && bestOverlap > 0.3) {
        s2Top.push({label: item.label.substring(0,30), selector: item.selector, overlap: overlap, titleOverlap: titleOverlap.toFixed(2), labelOverlap: labelOverlap.toFixed(2), best: bestOverlap.toFixed(2)});
      }
      if (bestOverlap >= 0.5 && titleSet.size >= 2 && overlap >= 2) {
        s2Matches.push({ element: item.element, selector: item.selector, label: item.label, bestOverlap: bestOverlap });
      }
    }
    if (s2Matches.length > 0) {
      // 只在"重叠度最高的那一档"里做取舍。pickPreferUnused 只看包含关系和有没有被用过、
      // 不看分数，所以不能把所有过线(>=0.5)的候选一股脑丢给它——否则一个重叠度更低、
      // 但恰好在候选池里排得更靠前的元素（扫描分层决定了<a>永远排在<span>前面，
      // 跟它在页面上的先后没关系）就会顶掉真正最像的那个。
      var maxOverlap = 0;
      for (var m = 0; m < s2Matches.length; m++) {
        if (s2Matches[m].bestOverlap > maxOverlap) maxOverlap = s2Matches[m].bestOverlap;
      }
      var s2Best = s2Matches.filter(function (it) { return it.bestOverlap === maxOverlap; });
      var chosen = pickPreferUnused(s2Best);
//       if (isDebug) console.log("[DEBUG] S2 命中! label:", chosen.label.substring(0,30), "bestOverlap:", chosen.bestOverlap.toFixed(2), "(候选数:" + s2Matches.length + ")");
      return {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: 0.70 + chosen.bestOverlap * 0.30
      };
    }
//     if (isDebug) console.log("[DEBUG] S2 未命中 (bestOverlap>=0.5)。高重叠候选:", s2Top.sort(function(a,b) { return parseFloat(b.best)-parseFloat(a.best); }).slice(0,5));
    return null;
  }

  // S3: 加权 TF 余弦相似度 (标题3份 + 描述1份)
  function tryS3Match(step, scanned) {
    var isDebug = !!window.__appguideDebug;
    var matchText = getMatchText(step);
    var query = matchText + " " + matchText + " " + matchText + " " + step.description;
    var highestScore = 0;
    var secondBestScore = 0;
    var bestCandidates = [];
    var s3Top = [];

    for (var i = 0; i < scanned.length; i++) {
      var item = scanned[i];
      var score = computeSimilarity(
        query,
        item.label + " " + item.label + " " + item.placeholder + " " + item.ariaLabel
      );
      if (score > highestScore) {
        secondBestScore = highestScore;
        highestScore = score;
        bestCandidates = [item];
      } else if (score === highestScore && score > 0) {
        bestCandidates.push(item);
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
      if (isDebug && score > 0.1) {
        s3Top.push({label: item.label.substring(0,30), selector: item.selector, score: score.toFixed(4)});
      }
    }

    var bestMatch = null;
    if (bestCandidates.length > 0) {
      var chosen = pickPreferUnused(bestCandidates);
      bestMatch = {
        element: chosen.element,
        selector: chosen.selector,
        label: chosen.label,
        score: highestScore
      };
    }

    if (isDebug) {
//       console.log("[DEBUG] S3 结果: score=", bestMatch ? bestMatch.score.toFixed(4) : "N/A", "次高分=", secondBestScore.toFixed(4), "label:", bestMatch ? bestMatch.label.substring(0,30) : "N/A", "selector:", bestMatch ? bestMatch.selector : "N/A", "(候选数:" + bestCandidates.length + ")");
//       if (s3Top.length > 1) console.log("[DEBUG] S3 Top5:", s3Top.sort(function(a,b) { return parseFloat(b.score)-parseFloat(a.score); }).slice(0,5));
    }

    var S3_MARGIN = 0.08;
    var hasMargin = secondBestScore === 0 || (highestScore - secondBestScore) >= S3_MARGIN;
    if (bestMatch && bestMatch.score >= 0.50) {
      if (!hasMargin) {
//         if (isDebug) console.log("[DEBUG] S3 最高分与次高分差距不足" + S3_MARGIN + "（" + (highestScore - secondBestScore).toFixed(4) + "），判定为不可靠匹配，视为未找到");
        return null;
      }
      return bestMatch;
    }
    return null;
  }

  // 对特定步骤指南执行本地语义匹配，返回最匹配的页面 DOM 元素
  // strategyLevel: 0|1|2|3 只跑指定策略；不传或 -1 跑全部 S0→S3
  function findBestSemanticMatch(step, strategyLevel) {
    const scanned = scanDOM();
    if (scanned.length === 0) return null;

    const isDebug = !!window.__appguideDebug;
    if (isDebug && (typeof strategyLevel !== "number" || strategyLevel < 0)) {
//       console.log("[DEBUG] === 匹配步骤:", step.title, "===", IS_TOP_FRAME ? "(顶层文档)" : "(iframe worker: " + window.location.href + ")");
//       console.log("[DEBUG] 扫描到", scanned.length, "个控件");
//       console.log("[DEBUG] 全部控件:", scanned.map(function(it) { return {
//         tag: it.type, selector: it.selector, label: it.label.substring(0,40)
//       }; }));
    }

    // strategyLevel: 0|1|2|3 只跑指定策略；不传或 -1 跑全部 S0→S3
    var sl = (typeof strategyLevel === "number" && strategyLevel >= 0) ? strategyLevel : -1;

    var result;

    if (sl === -1 || sl === 0) {
      result = tryS0Match(step, scanned);
      if (result) return result;
    }

    if (sl === -1 || sl === 1) {
      result = tryS1Match(step, scanned);
      if (result) return result;
    }

    if (sl === -1 || sl === 2) {
      result = tryS2Match(step, scanned);
      if (result) return result;
    }

    if (sl === -1 || sl === 3) {
      result = tryS3Match(step, scanned);
      if (result) return result;
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
  // 直接传原始url，不需要包通配符——host归一化(去www.)、路径里动态ID(比如会话ID/对话ID)
  // 的识别，都在服务端urlsMatch()里统一处理了，客户端这边不用配合做任何特殊处理。
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

  // 通过 background worker 查询当前页面及子页面的所有可用引导流程
  function fetchFlowsByPattern(pathname) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "fetch-flows-by-pattern", url: pathname },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            // response.data 是服务端返回的 { success, data }，取内部的 data 数组
            resolve(response.data && response.data.data ? response.data.data : []);
          } else {
            reject(new Error((response && response.error) || "API 请求失败"));
          }
        }
      );
    });
  }

  // 通过 /rest?method=appguide.flows.byid 获取完整 flow 数据并缓存到本地
  // 返回归一化后的 { id, title, starturl, pages } 或 null（失败时）
  function fetchFlowById(flowId) {
    return new Promise(function(resolve) {
      try {
        chrome.runtime.sendMessage(
          { action: "fetch-flow-by-id", flowId: flowId },
          function(response) {
            if (chrome.runtime.lastError) {
//               console.warn("[BusinessGuide] fetchFlowById 通信失败:", chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            if (response && response.success && response.data && response.data.success) {
              resolve(normalizeFlowData(response.data.data));
            } else {
//               console.warn("[BusinessGuide] fetchFlowById API 返回失败，将回退到 API 续接");
              resolve(null);
            }
          }
        );
      } catch (e) {
//         console.warn("[BusinessGuide] fetchFlowById 异常:", e.message);
        resolve(null);
      }
    });
  }

  // 归一化 /api/flows/by-id 返回的原始数据为标准格式
  // rawData.steps 可能是：字符串(JSON)、数组(pages)、对象({pages:[],title:""})
  function normalizeFlowData(rawData) {
    if (!rawData) return null;
    var stepsData = rawData.steps;
    if (typeof stepsData === "string") {
      try { stepsData = JSON.parse(stepsData); } catch (e) { stepsData = {}; }
    }
    var pages;
    if (Array.isArray(stepsData)) {
      pages = stepsData;
    } else if (stepsData && Array.isArray(stepsData.pages)) {
      pages = stepsData.pages;
    } else {
      pages = [];
    }
    return {
      id: rawData.id,
      title: (stepsData && stepsData.title) || rawData.class || "",
      starturl: rawData.starturl || "",
      pages: pages
    };
  }

  // 读取跨页流程运行时状态，并做TTL过期判断（过期则顺手清空，返回null）
  function getFlowStateIfValid() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([FLOW_STATE_KEY], (result) => {
          if (chrome.runtime.lastError) {
//             console.warn("[BusinessGuide] 读取流程状态失败:", chrome.runtime.lastError.message);
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
//         console.warn("[BusinessGuide] chrome.storage 不可用（扩展上下文已失效）:", e.message);
        resolve(null);
      }
    });
  }

  // 记录"接下来应该显示第几步"（globalStepNumber + pageIndex），每次渲染/翻页都要调用
  // nextPageIndex: 可选，跨页过渡时传入下一页索引；未传则使用当前 flowMeta.pageIndex
  function persistFlowState(nextGlobalStepNumber, nextPageIndex) {
    if (!flowMeta) return;
    var pageIndex = (nextPageIndex !== undefined) ? nextPageIndex : flowMeta.pageIndex;
    try {
      chrome.storage.local.set({
        [FLOW_STATE_KEY]: {
          flowId: flowMeta.flowId,
          pageIndex: pageIndex,
          globalStepNumber: nextGlobalStepNumber,
          lastActiveAt: Date.now(),
          cachedFlow: flowMeta.cachedFlow || null,
        },
      });
    } catch (e) {
//       console.warn("[BusinessGuide] 保存流程状态失败（扩展上下文已失效）:", e.message);
    }
  }

  function clearFlowState() {
    try {
      chrome.storage.local.remove(FLOW_STATE_KEY);
    } catch (e) {
//       console.warn("[BusinessGuide] 清除流程状态失败（扩展上下文已失效）:", e.message);
    }
  }

  // 统一归一化：去协议 + 去query/hash + 去尾斜杠 + 小写，与服务端 normalizeUrl 保持一致
  function getCleanPath() {
    return window.location.href
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
      //.toLowerCase() || "/";
  }

  // ------------------ 客户端 URL 匹配引擎（移植自 guide_server.ts）------------------
  // 使客户端可以在不调用 API 的情况下，本地完成 URL→页面匹配，实现离线续接。

  function parseUrlSafely(rawUrl) {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    try {
      return new URL(withScheme);
    } catch {
      return new URL("https://invalid.invalid");
    }
  }

  function normalizeHost(rawUrl) {
    try {
      return parseUrlSafely(rawUrl).host.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function normalizePathSegments(rawUrl) {
    try {
      return parseUrlSafely(rawUrl).pathname.split("/").filter(Boolean);
    } catch {
      return rawUrl.split("/").filter(Boolean);
    }
  }

  function looksLikeDynamicId(segment) {
    if (!segment) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
    if (/^\d{6,}$/.test(segment)) return true;
    if (segment.length >= 8 && /[a-zA-Z]/.test(segment) && /[0-9]/.test(segment)) return true;
    return false;
  }

  function urlsMatchClient(rawUrlA, rawUrlB) {
    if (normalizeHost(rawUrlA) !== normalizeHost(rawUrlB)) return false;
    const segsA = normalizePathSegments(rawUrlA);
    const segsB = normalizePathSegments(rawUrlB);
    if (segsA.length !== segsB.length) return false;
    for (let i = 0; i < segsA.length; i++) {
      if (segsA[i] === segsB[i]) continue;
      if (looksLikeDynamicId(segsA[i]) && looksLikeDynamicId(segsB[i])) continue;
      return false;
    }
    return true;
  }

  // 在缓存的完整 flow 数据中，用当前 URL 匹配某一页，返回与 API 同构的 ResolvedPage
  function resolvePageInFlowClient(cachedFlow, rawUrl) {
    if (!cachedFlow || !cachedFlow.pages) return null;

    let pageIndex = cachedFlow.pages.findIndex(function(p) { return urlsMatchClient(p.url, rawUrl); });

    // 兜底：pages[].url 里没找到，但当前url就是 starturl
    if (pageIndex === -1 && cachedFlow.pages.length > 0 && urlsMatchClient(cachedFlow.starturl, rawUrl)) {
      pageIndex = 0;
    }

    if (pageIndex === -1) return null;

    var globalStepOffset = 0;
    for (var i = 0; i < pageIndex; i++) {
      globalStepOffset += cachedFlow.pages[i].steps.length;
    }
    var totalSteps = cachedFlow.pages.reduce(function(sum, p) { return sum + p.steps.length; }, 0);

    var page = cachedFlow.pages[pageIndex];
    var steps = page.steps.map(function(s, localIndex) {
      return Object.assign({}, s, {
        localIndex: localIndex,
        globalStepNumber: globalStepOffset + localIndex + 1
      });
    });

    return {
      flowId: cachedFlow.id,
      flowTitle: cachedFlow.title,
      pageIndex: pageIndex,
      totalPages: cachedFlow.pages.length,
      globalStepOffset: globalStepOffset,
      totalSteps: totalSteps,
      page: {
        url: page.url,
        title: page.title,
        description: page.description,
        steps: steps
      }
    };
  }

  // 不做 URL 匹配，直接按 pageIndex 返回该页的 ResolvedPage
  // 用于 URL 不匹配但用户选择"继续引导"的场景
  function resolvePageByIndex(cachedFlow, pageIndex) {
    if (!cachedFlow || !cachedFlow.pages) return null;
    if (pageIndex < 0 || pageIndex >= cachedFlow.pages.length) return null;

    var globalStepOffset = 0;
    for (var i = 0; i < pageIndex; i++) {
      globalStepOffset += cachedFlow.pages[i].steps.length;
    }
    var totalSteps = cachedFlow.pages.reduce(function(sum, p) { return sum + p.steps.length; }, 0);

    var page = cachedFlow.pages[pageIndex];
    var steps = page.steps.map(function(s, localIndex) {
      return Object.assign({}, s, {
        localIndex: localIndex,
        globalStepNumber: globalStepOffset + localIndex + 1
      });
    });

    return {
      flowId: cachedFlow.id,
      flowTitle: cachedFlow.title,
      pageIndex: pageIndex,
      totalPages: cachedFlow.pages.length,
      globalStepOffset: globalStepOffset,
      totalSteps: totalSteps,
      page: {
        url: page.url,
        title: page.title,
        description: page.description,
        steps: steps
      }
    };
  }

  // 核心功能：开关引导（用户手动按 Alt+G 触发）
  async function enableGuide() {
    const cleanPath = getCleanPath();
//     console.log("[BusinessGuide] 正在检测页面并获取 API 校验...", cleanPath);

    const state = await getFlowStateIfValid();

    // 缓存优先：以 state.pageIndex 为目标页，只比对这一页的 URL，避免跳到流程中其他页
    if (state && state.cachedFlow) {
      var targetIdx = (typeof state.pageIndex === "number") ? state.pageIndex : 0;
      if (targetIdx >= 0 && targetIdx < state.cachedFlow.pages.length) {
        var expectedPage = state.cachedFlow.pages[targetIdx];
        if (urlsMatchClient(expectedPage.url, window.location.href)) {
          var resolved = resolvePageByIndex(state.cachedFlow, targetIdx);
//           console.log("[BusinessGuide] 从本地缓存续接跨页流程（手动 Alt+G）：", state.flowId,
//             "（第" + (targetIdx + 1) + "/" + state.cachedFlow.pages.length + "页）");
          startGuideFromResolved(resolved, state);
          return;
        }
        // URL 不匹配 → 直接按继续引导处理
//         console.log("[BusinessGuide] 手动 Alt+G：当前 URL 与流程预期页面不匹配，直接继续引导");
        var resolved = resolvePageByIndex(state.cachedFlow, targetIdx);
        if (resolved) {
          startGuideFromResolved(resolved, state);
        } else {
          showToast("❌ 无法加载预期页面数据");
        }
        return;
      }
      // pageIndex 异常，回退 API
    }

    try {
      const data = await fetchGuideFromApi(cleanPath, state ? state.flowId : null);
      handleGuideApiResult(data, cleanPath, state, true);
    } catch (e) {
//       console.error("[BusinessGuide] 无法连接到 API 配置端点:", e);
      showToast("❌ 业务指南网络服务端点连接失败");
    }
  }

  // 统一处理 /api/guide 的四种返回结果：resume / new / choose / not_found(或其它失败)
  // manual=true 表示这是用户主动触发的（Alt+G 或候选选择），所有结果都要给出UI反馈；
  // manual=false 表示这是页面加载时的被动自动检测，只在 resume 时才动作，其余情况保持安静。
  function handleGuideApiResult(data, cleanPath, state, manual) {
    if (!data) {
      if (manual) showToast("❌ 引导步骤数据解析失败");
      return;
    }

    if (data.success && data.mode === "resume") {
      startGuideFromResolved(data, state);
      return;
    }

    if (!manual) return; // 被动检测：非resume结果一律静默忽略

    // 如果有进行中的流程但 API 返回的不是 resume，阻止回退到"启动新流程"路径
    if (state) {
      showToast("💡 当前页面不在流程路径中，请导航到正确页面后重试。");
      return;
    }

    if (data.success && data.mode === "new") {
      startGuideFromResolved(data, null);
      return;
    }
    if (data.success && data.mode === "choose") {
      renderCandidateChooser(data.candidates, cleanPath);
      return;
    }
    if (!data.success && data.reason === "not_found") {
      showToast("💡 " + (data.message || "当前页面未配置特定的业务操作指南入口"));
      return;
    }
    showToast("❌ 未知错误，请检查控制台日志");
//     console.error("[BusinessGuide] 未知错误:", data);
  }

  // 根据 /api/guide 返回的已解析页面数据（或客户端本地解析结果），启动/续接引导渲染
  // resumeState：仅当data.mode==="resume"且是从storage续接来的时候传入，
  // 用于把之前存的globalStepNumber换算成这一页内的localIndex，从而精确停在原来的步骤上；
  // 否则（全新流程/用户手动选择流程）一律从这一页第一步开始。
  function startGuideFromResolved(data, resumeState) {
    // 优先继承已有缓存，其次从本次 API 响应中获取（暂未有 fullFlow 字段，预留）
    var inheritedCache = (resumeState && resumeState.cachedFlow) || data.fullFlow || null;
    flowMeta = {
      flowId: data.flowId,
      pageIndex: data.pageIndex,
      totalPages: data.totalPages,
      globalStepOffset: data.globalStepOffset,
      totalSteps: data.totalSteps,
      cachedFlow: inheritedCache,
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

    // 每次开始/续接一次引导，都要把"本页已被占用的元素"清空重来。
    // usedElements 只在脚本加载时创建过一次，如果不在这里重置，
    // 上一个流程（或上一轮同一流程）占用过的元素会一直被当成"已用"而跳过。
    usedElements = new WeakSet();

    // 统计：流程被激活（新流程或续接）
    trackFlowStat(data.flowId, "process");

    renderGuideUI();

    if (!isGuideActive || !activeGuide) {
      // renderGuideUI 因为匹配不到目标元素而中断了（已经处理过toast提示），
      // 这里不能再往下访问 activeGuide，直接结束
      return;
    }

    persistFlowState(activeGuide.steps[currentStepIndex].globalStepNumber);
//     console.log("[BusinessGuide] 已加载业务流程指南：" + activeGuide.title +
//       `（第${data.pageIndex + 1}/${data.totalPages}页，步骤${activeGuide.steps[currentStepIndex].globalStepNumber}/${data.totalSteps}）`);

    // 如果还没有缓存完整流程数据，异步获取并缓存（fire-and-forget，不阻塞当前渲染）
    if (!flowMeta.cachedFlow && data.flowId) {
      fetchFlowById(data.flowId).then(function(cached) {
        if (cached && flowMeta) {
          flowMeta.cachedFlow = cached;
          // 更新存储中的 cachedFlow
          persistFlowState(activeGuide.steps[currentStepIndex].globalStepNumber);
//           console.log("[BusinessGuide] 完整流程数据已缓存到本地，共 " + cached.pages.length + " 页");
        }
      }).catch(function() {
        // 静默忽略，续接时回退 API
      });
    }
  }

  // 使浮动窗口可拖动：给 header 区域绑定 pointerdown/move/up 事件
  function makeDraggable(dragHandle, targetElement) {
    var startX, startY, startLeft, startTop;
    var activePointerId = null;

    dragHandle.style.cursor = "move";

    // 指针捕获后该 pointer 的事件全部重定向到 dragHandle，因此监听器挂在
    // dragHandle 而非 document：拖到跨域 iframe 上方或窗口外松手都不会丢事件，
    // 且监听器随元素移除自动回收。
    function onPointerMove(e) {
      if (e.pointerId !== activePointerId) return;
      if (e.buttons === 0) { endDrag(); return; } // 按键已松开却仍有事件：收尾兜底
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      targetElement.style.left = Math.max(0, startLeft + dx) + "px";
      targetElement.style.top = Math.max(0, startTop + dy) + "px";
    }

    function endDrag() {
      if (activePointerId === null) return;
      dragHandle.removeEventListener("pointermove", onPointerMove);
      dragHandle.removeEventListener("pointerup", endDrag);
      dragHandle.removeEventListener("pointercancel", endDrag);
      if (dragHandle.hasPointerCapture(activePointerId)) {
        dragHandle.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
    }

    dragHandle.addEventListener("pointerdown", function(e) {
      if (e.button !== 0) return; // 只响应左键，右键/中键不启动拖拽
      if (e.target.tagName === "BUTTON") return; // 不拦截按钮点击
      if (activePointerId !== null) return; // 已有拖拽进行中
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(targetElement.style.left, 10) || 0;
      startTop = parseInt(targetElement.style.top, 10) || 0;
      targetElement.style.transform = ""; // 清除居中偏移
      dragHandle.setPointerCapture(e.pointerId);
      dragHandle.addEventListener("pointermove", onPointerMove);
      dragHandle.addEventListener("pointerup", endDrag);
      dragHandle.addEventListener("pointercancel", endDrag);
      e.preventDefault();
    });
  }

  // URL 不匹配确认框：缓存续接时当前页面 URL 与流程预期页面不一致，让用户选择继续或放弃
  function showUrlMismatchDialog(cachedFlow, expectedPageIndex, state) {
    cleanupUI();

    var expectedPage = cachedFlow.pages[expectedPageIndex];
    var expectedUrl = expectedPage ? expectedPage.url : "（未知）";
    var currentUrl = window.location.href;

    bubbleElement = document.createElement("div");
    bubbleElement.className = "guide-extension-bubble";
    bubbleElement.innerHTML =
      '<div class="guide-header">' +
        '<span><img src="' + ICON_URL + '" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">智导业务操作领航</span>' +
        '<button id="guide-close-btn" class="guide-btn-close">×</button>' +
      '</div>' +
      '<div class="guide-body">' +
        '<h3 class="guide-step-title">⚠ 页面不匹配</h3>' +
        '<p class="guide-step-desc">当前页面 URL 与流程预期不符：</p>' +
        '<div style="margin:8px 0;padding:8px;border-radius:4px;font-size:12px;line-height:1.6;">' +
          '<div><strong>流程：</strong>' + escapeHtml(cachedFlow.title) + '</div>' +
          '<div><strong>预期页面（第' + (expectedPageIndex + 1) + '/' + cachedFlow.pages.length + '页）：</strong>' + escapeHtml(expectedUrl) + '</div>' +
          '<div style="word-break:break-all;"><strong>当前页面：</strong>' + escapeHtml(currentUrl) + '</div>' +
        '</div>' +
        '<p class="guide-step-desc">是否仍要继续引导？</p>' +
        '<div class="guide-mismatch-actions">' +
          '<button id="guide-mismatch-abort" class="guide-mismatch-btn">中止引导流程</button>' +
          '<button id="guide-mismatch-continue" class="guide-mismatch-btn-primary">继续当前页面</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bubbleElement);

    document.getElementById("guide-close-btn").onclick = function() {
      // 关闭 = 放弃，保留进度
      cleanupUI();
      showToast("引导已取消，请导航到正确页面后重试。");
    };

    document.getElementById("guide-mismatch-abort").onclick = function() {
      cleanupUI();
      clearFlowState();
      showToast("引导流程已中止，本地进度已清除。");
    };

    document.getElementById("guide-mismatch-continue").onclick = function() {
      cleanupUI();
      var resolved = resolvePageByIndex(cachedFlow, expectedPageIndex);
      if (resolved) {
//         console.log("[BusinessGuide] 用户选择在 URL 不匹配的情况下继续引导");
        startGuideFromResolved(resolved, state);
      } else {
        showToast("❌ 无法加载预期页面数据");
      }
    };

    positionBubble(null, "top");

    // 启用拖动：按住标题栏可拖动整个浮动窗口
    var headerEl = bubbleElement.querySelector(".guide-header");
    if (headerEl) makeDraggable(headerEl, bubbleElement);
  }

  // 多个流程共享同一起始页时，展示候选列表让用户选择
  function renderCandidateChooser(candidates, cleanPath) {
    cleanupUI();

    bubbleElement = document.createElement("div");
    bubbleElement.className = "guide-extension-bubble";
    bubbleElement.innerHTML = `
      <div class="guide-header">
        <span><img src="${ICON_URL}" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">智导业务操作领航</span>
        <button id="guide-close-btn" class="guide-btn-close">×</button>
      </div>
      <div class="guide-body">
        <h3 class="guide-step-title">当前页检测到${candidates.length}个可用引导流程</h3>
        <p class="guide-step-desc">请选择要开始的流程：</p>
        <div class="guide-candidate-list">
          ${candidates.map((c, i) => `
            <button class="guide-candidate-item" data-flow-id="${c.flowId}">
              <strong>${i + 1}. ${escapeHtml(c.title)}</strong>
              <span>${escapeHtml(c.description || "")}</span>
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
//         console.log("[BusinessGuide] 用户选择了流程, flowId:", chosenFlowId, "title:", btn.querySelector("strong")?.textContent);
        try {
          const data = await fetchGuideFromApi(cleanPath, chosenFlowId);
          handleGuideApiResult(data, cleanPath, null, true);
        } catch (e) {
//           console.error("[BusinessGuide] 选择流程后拉取指南失败:", e);
          showToast("❌ 具体业务指南获取失败");
        }
      };
    });

    positionBubble(null, "top");

    // 启用拖动
    var headerEl2 = bubbleElement.querySelector(".guide-header");
    if (headerEl2) makeDraggable(headerEl2, bubbleElement);
  }

  function disableGuide() {
    isGuideActive = false;
    activeGuide = null;
    flowMeta = null;
    cleanupUI();
    clearFlowState();
    usedElements = new WeakSet();
//     console.log("[BusinessGuide] 业务操作引导已关闭，进行中的流程状态已清除。");
  }

  // 渲染/重绘 高亮框与浮窗气泡
  let renderRequestToken = 0; // 每次渲染自增，用于让过期的异步重试/iframe探测结果自动作废

  const LOCAL_RETRY_COUNT = 2;
  const LOCAL_RETRY_DELAY_MS = 400;

  // 等"DOM发生变化"或者"到时间了"，两者谁先发生就算——
  // SPA页面路由跳转后表单控件经常是异步渲染出来的，晚个几百毫秒才挂载到DOM上很常见。
  // 如果这段等待期间DOM真的变了，能提前重试，不用傻等满时长；DOM一直没变化就等满时长再重试。
  function waitForDomSettleOrTimeout(ms) {
    return new Promise((resolve) => {
      let done = false;
      let observer = null;
      try {
        observer = new MutationObserver(() => {
          if (done) return;
          done = true;
          if (observer) observer.disconnect();
          resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      } catch (e) {
        // MutationObserver不可用的极端情况，退化成纯定时器等待
      }
      setTimeout(() => {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        resolve();
      }, ms);
    });
  }

  // 尝试在本文档里解析目标元素，找不到时给几次"等一等再重试"的机会，
  // 而不是扫一次没找到就直接判失败——之前的实现对"页面还在异步渲染"这类纯时序问题
  // 完全没有容错。本地重试次数用完，才轮到"顶层向子iframe广播探测"这条路径。
  function attemptResolveStep(step, myToken, retriesLeft) {
    if (myToken !== renderRequestToken) return; // 状态已经变了（用户点了下一步/关闭引导），这次尝试作废

    const local = resolveLocalTarget(step);
    if (local) {
      // 低置信度（<80%）且页面有iframe时，不立即采纳本地结果，
      // 而是并行探测iframe，取置信度最高的那个——避免主页低分匹配截胡iframe里的正确目标。
      const LOW_CONFIDENCE = 80;
      const iframeEls = IS_TOP_FRAME ? Array.from(document.querySelectorAll("iframe")) : [];
      if (local.scorePercent < LOW_CONFIDENCE && iframeEls.length > 0) {
//         console.log(`[BusinessGuide] 本地匹配到"${step.title}"，置信度仅${local.scorePercent}%，并行探测iframe以比较...`);
        probeChildFrames(step, iframeEls).then((bestIframe) => {
          if (myToken !== renderRequestToken) return;
          if (!isGuideActive || !activeGuide || activeGuide.steps[currentStepIndex] !== step) return;

          if (bestIframe && bestIframe.score > local.scorePercent) {
//             console.log(`[BusinessGuide] iframe匹配(${bestIframe.score}%)优于本地(${local.scorePercent}%)，采用iframe结果`);
            // 高亮已由匹配到的iframe自己画好（见顶部iframe worker消息处理），
            // 顶层这里只需要把气泡贴着iframe边界摆放
            renderBubble(step, bestIframe.iframeEl);
          } else {
//             console.log(`[BusinessGuide] 本地匹配(${local.scorePercent}%)优于或等于iframe，采用本地结果`);
            usedElements.add(local.element);
            stepMatchedElements.set(step, local.element);
            createHighlightForElement(local.element, step.highlightStyle);
            renderBubble(step, local.element);
          }
        });
        return;
      }

      usedElements.add(local.element);
      stepMatchedElements.set(step, local.element);
      createHighlightForElement(local.element, step.highlightStyle);
      renderBubble(step, local.element);
      return;
    }

    if (retriesLeft > 0) {
//       console.log(`[BusinessGuide] 本文档内暂未找到"${step.title}"，${LOCAL_RETRY_DELAY_MS}ms后重试（剩余${retriesLeft}次机会，可能是页面还在异步渲染）...`);
      waitForDomSettleOrTimeout(LOCAL_RETRY_DELAY_MS).then(() => {
        attemptResolveStep(step, myToken, retriesLeft - 1);
      });
      return;
    }

    // 本文档没找到：如果是顶层且页面里确实有iframe，启动逐级联配（S0→S3 主页+iframe交替）；
    // 否则（不是顶层，或者顶层但没有iframe）直接判定未找到。
    // 注：当前只处理单层嵌套，不会让子iframe再往下递归探测自己的子iframe。
    const iframeEls = IS_TOP_FRAME ? Array.from(document.querySelectorAll("iframe")) : [];
//     console.log(
//       `[BusinessGuide] 本文档内未找到"${step.title}"（已重试${LOCAL_RETRY_COUNT}次），` +
//       (IS_TOP_FRAME
//         ? `检测到页面内共有 ${iframeEls.length} 个<iframe>` + (iframeEls.length > 0 ? "，启动逐级联配..." : "，无iframe可探测，直接判定未找到。")
//         : "（当前是iframe worker身份，不会再往下探测子iframe）")
//     );
    if (iframeEls.length === 0) {
      handleTargetNotFound(step);
      return;
    }

    resolveStepInterleaved(step, myToken).then(function(interleaved) {
      // 逐级联配是异步的，用token校验过期结果
      if (myToken !== renderRequestToken) return;
      if (!isGuideActive || !activeGuide || activeGuide.steps[currentStepIndex] !== step) return;

      if (interleaved) {
        if (interleaved.source === "iframe") {
          // 高亮已由匹配到的iframe自己画好，顶层只需把气泡贴着iframe边界摆放
//           console.log(`[BusinessGuide] 逐级联配命中iframe目标，置信度: ${interleaved.scorePercent}%`);
          renderBubble(step, interleaved.element);
        } else {
          // 主页匹配：画高亮 + 气泡
//           console.log(`[BusinessGuide] 逐级联配命中主页目标: ${interleaved.matchMethod}，置信度: ${interleaved.scorePercent}%`);
          usedElements.add(interleaved.element);
          stepMatchedElements.set(step, interleaved.element);
          createHighlightForElement(interleaved.element, step.highlightStyle);
          renderBubble(step, interleaved.element);
        }
      } else {
//         console.log(`[BusinessGuide] 逐级联配也未找到"${step.title}"，所有策略已穷尽`);
        handleTargetNotFound(step);
      }
    });
  }

  function renderGuideUI() {
    cleanupUI();
    renderRequestToken++;
    const myToken = renderRequestToken;

    if (!isGuideActive || !activeGuide) return;

    const step = activeGuide.steps[currentStepIndex];
    if (!step) return;

    // 同一个步骤被重渲染（上一步/下一步来回切、异步重试、低置信度时的iframe并行探测）时，
    // 先把它自己上一轮占用的元素释放掉——否则 pickPreferUnused 会把它当成"别的步骤已经用过"
    // 而跳过，同一个步骤第二次渲染就会跳到另一个元素上。
    const prevMatched = stepMatchedElements.get(step);
    if (prevMatched) {
      usedElements.delete(prevMatched);
      stepMatchedElements.delete(step);
    }

    attemptResolveStep(step, myToken, LOCAL_RETRY_COUNT);
  }

  // 只在"当前文档自己的DOM"里找目标元素（不涉及iframe）。
  // 顶层和iframe worker共用这一份逻辑：顶层用它来处理本页字段，
  // iframe worker收到顶层探测请求时，也是调用这个函数来判断自己是否有匹配的控件。
  // skipSelector: 为true时跳过显式selector查找，直接进入语义匹配（供上层在iframe探测失败后回调使用）
  // strategyLevel: 0|1|2|3 限定语义匹配的策略级别；不传则跑全部 S0→S3
  function resolveLocalTarget(step, skipSelector, strategyLevel) {
    let targetElement = null;
    let matchMethod = "精确选择器定位";
    let scorePercent = 100;

    if (!skipSelector && step.selector && step.selector !== "auto") {
      targetElement = document.querySelector(step.selector);
      if (targetElement) {
        step.resolvedSelector = step.selector;
        return { element: targetElement, matchMethod, scorePercent };
      }
      // 显式selector未命中：
      // 顶层且有iframe → 返回null，由上层 resolveStepInterleaved 控制逐级联配；
      // 无iframe或iframe worker → fall through到下方语义匹配
      if (IS_TOP_FRAME && document.querySelectorAll("iframe").length > 0) {
//         console.log(`[BusinessGuide] 选择器 "${step.selector}" 在当前文档未命中，页面有iframe，交由逐级联配...`);
        return null;
      }
      // 无iframe或iframe worker：继续往下走语义匹配
    }

    // 无显式selector（或selector为auto）且顶层有iframe：
    // 不在主页单独跑语义匹配，返回null交由上层 resolveStepInterleaved 做主页+iframe逐级联配，
    // 避免主页低分匹配截胡iframe里的正确目标
    if (!skipSelector && IS_TOP_FRAME && document.querySelectorAll("iframe").length > 0) {
//       console.log(`[BusinessGuide] 无显式selector且页面有iframe，交由逐级联配处理...`);
      return null;
    }

    if (!targetElement) {
//       console.log(`[BusinessGuide] 选择器 "${step.selector}" 缺失或未命中，正在启动本地语义匹配...`);
      const semanticMatch = findBestSemanticMatch(step, strategyLevel);

      if (semanticMatch) {
        targetElement = semanticMatch.element;
        step.resolvedSelector = semanticMatch.selector;
        matchMethod = `语义模糊对齐 [${semanticMatch.label}]`;
        scorePercent = Math.round(semanticMatch.score * 100);
//         console.log(`[BusinessGuide] 语义对齐成功！绑定到 "${semanticMatch.selector}"，置信度 ${scorePercent}%`);
        try {
          const rect = targetElement.getBoundingClientRect();
          const cs = getComputedStyle(targetElement);
//           console.log(
//             `[BusinessGuide] 匹配元素详情 —— 位置:(${Math.round(rect.left)},${Math.round(rect.top)}) ` +
//             `尺寸:${Math.round(rect.width)}×${Math.round(rect.height)} ` +
//             `display:${cs.display} visibility:${cs.visibility} opacity:${cs.opacity}` +
//             (rect.width === 0 || rect.height === 0 ? " ⚠️ 尺寸为0，可能是不可见元素" : ""),
//             targetElement
//           );
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
//             console.log(`[BusinessGuide] 自动升级目标: input → .el-select 容器`);
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
//                   console.log(`[BusinessGuide] 自动升级目标: 零尺寸input → 可见父容器 ${step.resolvedSelector}`);
                  break;
                }
                parent = parent.parentElement;
              }
            }
          }
        }
      } else {
//         console.warn("[BusinessGuide] 未能在页面中匹配到符合要求的元素");
        step.resolvedSelector = null;
      }
    }

    if (!targetElement) return null;
    return { element: targetElement, matchMethod, scorePercent };
  }

  const IFRAME_PROBE_MAX_ATTEMPTS = 2; // 超时不代表iframe里真的没有，很可能是iframe自己还没加载完，给一次重试机会

  // 顶层专用：向所有直属子iframe广播"帮我找这个步骤的目标元素"，等待第一个回复"找到了"的iframe，
  // 或者超时（说明没有任何iframe里有匹配的控件）。超时后会自动重试一次，不是第一次没等到就直接放弃——
  // iframe本身加载慢（比如嵌入的是个较重的第三方应用）时，第一轮800ms很可能不够它把DOM挂载完。
  function probeChildFrames(step, iframeEls, attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = IFRAME_PROBE_MAX_ATTEMPTS;

    return new Promise((resolve) => {
      const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let settled = false;
      let bestResult = null; // { iframeEl, score }

      // 只传纯数据字段，避免把内部运行时状态（如上一次匹配残留的resolvedSelector）带出去。
      // 注意：clickText/actionType 必须带上——Strategy0现在优先用clickText匹配，
      // 之前漏传这两个字段，导致目标在iframe里时永远退化成只用title匹配，clickText形同虚设。
      const serializedStep = {
        title: step.title,
        description: step.description,
        selector: step.selector,
        tipPosition: step.tipPosition,
        highlightStyle: step.highlightStyle,
        clickText: step.clickText,
        actionType: step.actionType,
      };

      function onMessage(event) {
        const data = event.data;
        if (!data || data.__appguide !== true || data.type !== "find-result") return;
        if (data.requestId !== requestId) {
          // 收到的是别的探测请求的回复（比如上一步还没超时就来了新一步的探测），正常现象，忽略即可
          return;
        }
        if (!data.found) {
//           console.log("[BusinessGuide] 收到某个iframe的回复：没找到，继续等其它iframe或超时。");
          return;
        }
        const matchedIframe = iframeEls.find((el) => el.contentWindow === event.source);
        if (!matchedIframe) {
          // 理论上不该发生：收到了found:true，但反查不到是哪个<iframe>标签发的。
          // 常见原因：这个iframe在探测过程中被重新导航/刷新了，导致contentWindow引用已经变了；
          // 或者页面里的<iframe>是脚本动态创建/替换的，探测发出后到回复回来之间DOM结构变了。
//           console.warn(
//             "[BusinessGuide] 收到found:true的回复，但反查不到对应的<iframe>标签，本次判定为未找到。" +
//             "event.source:", event.source
//           );
          return;
        }
        const score = typeof data.score === "number" ? data.score : 0;
//         console.log(`[BusinessGuide] iframe回复找到目标，置信度: ${score}%`);
        if (!bestResult || score > bestResult.score) {
          bestResult = { iframeEl: matchedIframe, score };
        }
      }
      window.addEventListener("message", onMessage);

      let sentCount = 0;
      iframeEls.forEach((el, idx) => {
        try {
          if (!el.contentWindow) {
//             console.warn(`[BusinessGuide] 第${idx + 1}个<iframe>没有可用的contentWindow（可能跨域被浏览器拦截，或还没加载完成），跳过。`);
            return;
          }
          el.contentWindow.postMessage(
            { __appguide: true, type: "find", requestId, step: serializedStep },
            "*"
          );
          sentCount++;
        } catch (e) {
//           console.warn(`[BusinessGuide] 向第${idx + 1}个<iframe>广播探测请求失败:`, e);
        }
      });
//       console.log(`[BusinessGuide] 已向 ${sentCount}/${iframeEls.length} 个<iframe>广播探测请求"${step.title}"，requestId=${requestId}，第${IFRAME_PROBE_MAX_ATTEMPTS - attemptsLeft + 1}/${IFRAME_PROBE_MAX_ATTEMPTS}次尝试，最多等待${IFRAME_PROBE_TIMEOUT_MS}ms`);

      setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener("message", onMessage);
          if (bestResult) {
//             console.log(`[BusinessGuide] 探测结束，选取最佳iframe结果，置信度: ${bestResult.score}%`);
            resolve(bestResult);
          } else if (attemptsLeft > 1) {
//             console.warn(`[BusinessGuide] 探测超时（${IFRAME_PROBE_TIMEOUT_MS}ms内没有任何iframe回复找到目标），还有${attemptsLeft - 1}次重试机会，可能是iframe自己还在加载，正在重试...`);
            resolve(probeChildFrames(step, iframeEls, attemptsLeft - 1));
          } else {
//             console.warn(`[BusinessGuide] 探测超时且重试次数已用完，requestId=${requestId}`);
            resolve(null);
          }
        }
      }, IFRAME_PROBE_TIMEOUT_MS);
    });
  }

  // 逐级策略专用：向所有直属子iframe广播探测，每个iframe只运行指定策略级别。
  // 与 probeChildFrames 不同：单轮探测（不重试），携带 strategyLevel 让 iframe worker 限制匹配范围。
  function probeChildFramesWithStrategy(step, iframeEls, strategyLevel) {
    return new Promise(function(resolve) {
      var requestId = "req_s" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var settled = false;
      var bestResult = null; // { iframeEl, score }
      // 已经回过话的iframe（按contentWindow去重，同一个iframe重复回复不会把计数刷爆）。
      // 这一轮的语义是"等所有iframe都回复完，再从中挑分最高的"，所以需要知道还差几份回复。
      var repliedSources = new Set();
      var sentCount = 0;
      var timeoutId = null;

      var serializedStep = {
        title: step.title,
        description: step.description,
        selector: step.selector,
        tipPosition: step.tipPosition,
        highlightStyle: step.highlightStyle,
        clickText: step.clickText,
        actionType: step.actionType,
        strategyLevel: strategyLevel,
      };

      // 收工：收齐全部回复、或等待超时，两条路都走这里
      function finish(reason) {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        if (bestResult) {
//           console.log("[BusinessGuide][S" + strategyLevel + "] 探测结束（" + reason + "），选取最佳iframe结果，置信度: " + bestResult.score + "%");
        } else {
//           console.warn("[BusinessGuide][S" + strategyLevel + "] 探测结束（" + reason + "），无iframe回复找到目标");
        }
        resolve(bestResult);
      }

      function onMessage(event) {
        var data = event.data;
        if (!data || data.__appguide !== true || data.type !== "find-result") return;
        if (data.requestId !== requestId) return;

        if (event.source) repliedSources.add(event.source);
        var progress = "已收 " + repliedSources.size + "/" + sentCount + " 份回复";

        if (data.found) {
          var matchedIframe = iframeEls.find(function(el) { return el.contentWindow === event.source; });
          if (matchedIframe) {
            var score = typeof data.score === "number" ? data.score : 0;
//             console.log("[BusinessGuide][S" + strategyLevel + "] 某个iframe回复找到目标，置信度: " + score + "%（" + progress + "）");
            if (!bestResult || score > bestResult.score) {
              bestResult = { iframeEl: matchedIframe, score: score };
            }
          } else {
//             console.warn("[BusinessGuide][S" + strategyLevel + "] 收到found:true但反查不到对应iframe，已丢弃。（" + progress + "）");
          }
        } else {
//           console.log("[BusinessGuide][S" + strategyLevel + "] 某个iframe回复没找到（" + progress +
//             (bestResult ? "，当前最佳 " + bestResult.score + "%" : "，暂无iframe找到") + "）");
        }

        // 这一轮要的是"所有iframe里分最高的那个"，回复收齐了就没必要再空等剩下的超时时间——
        // 逐级联配最多跑S0→S3四轮，每轮白等800ms的话用户能明显感觉到引导卡顿。
        if (repliedSources.size >= sentCount) {
          finish("已收齐全部回复");
        }
      }
      window.addEventListener("message", onMessage);

      iframeEls.forEach(function(el, idx) {
        try {
          if (!el.contentWindow) {
//             console.warn("[BusinessGuide][S" + strategyLevel + "] 第" + (idx + 1) + "个<iframe>无可用contentWindow，跳过。");
            return;
          }
          el.contentWindow.postMessage(
            { __appguide: true, type: "find", requestId: requestId, step: serializedStep },
            "*"
          );
          sentCount++;
        } catch (e) {
//           console.warn("[BusinessGuide][S" + strategyLevel + "] 向第" + (idx + 1) + "个<iframe>广播失败:", e);
        }
      });
//       console.log("[BusinessGuide][S" + strategyLevel + "] 已向 " + sentCount + "/" + iframeEls.length + " 个<iframe>广播探测（单轮），最多等待" + IFRAME_PROBE_TIMEOUT_MS + "ms");

      // 一个都没发出去（iframe全都拿不到contentWindow/postMessage全失败）：不可能有回复，直接收工
      if (sentCount === 0) {
        finish("没有可探测的iframe");
        return;
      }

      timeoutId = setTimeout(function() {
        finish("等待超时");
      }, IFRAME_PROBE_TIMEOUT_MS);
    });
  }

  // 逐级联配编排函数：主页 S0 → iframe S0 → 主页 S1 → iframe S1 → ... → S3
  // 返回 { element, matchMethod, scorePercent, source: 'main'|'iframe' } 或 null
  async function resolveStepInterleaved(step, myToken) {
    var scanned = scanDOM();

    // 逐级联配是直接调 tryS*Match 的，不走 findBestSemanticMatch，
    // 那边的"全部控件"调试输出在这条路径上永远打不出来——排查时看不到候选池等于抓瞎。
    if (window.__appguideDebug) {
//       console.log("[DEBUG] 逐级联配 步骤:", step.title, "扫描到", scanned.length, "个控件:",
//         scanned.map(function (it) { return { tag: it.type, selector: it.selector, label: it.label.substring(0, 40) }; }));
    }

    var iframeEls = IS_TOP_FRAME
      ? Array.from(document.querySelectorAll("iframe")).filter(function(el) { return el.contentWindow; })
      : [];

    var strategies = [
      { level: 0, fn: tryS0Match, name: "S0" },
      { level: 1, fn: tryS1Match, name: "S1" },
      { level: 2, fn: tryS2Match, name: "S2" },
      { level: 3, fn: tryS3Match, name: "S3" },
    ];

    for (var i = 0; i < strategies.length; i++) {
      var strategy = strategies[i];

      // 令牌检查：用户是否已经点了下一步/关闭了引导
      if (myToken !== renderRequestToken) return null;

//       console.log("[BusinessGuide] " + strategy.name + " 主页尝试匹配...");

      // 1. 主页尝试
      var mainResult = strategy.fn(step, scanned);
      if (mainResult) {
        usedElements.add(mainResult.element);
        stepMatchedElements.set(step, mainResult.element);
        step.resolvedSelector = mainResult.selector;
//         console.log("[BusinessGuide] " + strategy.name + " 主页命中! label: " + mainResult.label.substring(0, 30) + " score: " + mainResult.score);
        return {
          element: mainResult.element,
          matchMethod: "语义-" + strategy.name + " [主页]",
          scorePercent: Math.round(mainResult.score * 100),
          source: "main"
        };
      }

//       console.log("[BusinessGuide] " + strategy.name + " 主页未命中");

      // 2. 主页失败，探测 iframe（单轮，不重试）
      if (iframeEls.length > 0) {
//         console.log("[BusinessGuide] " + strategy.name + " 探测iframe...");
        var bestIframe = await probeChildFramesWithStrategy(step, iframeEls, strategy.level);

        if (myToken !== renderRequestToken) return null;

        if (bestIframe) {
//           console.log("[BusinessGuide] " + strategy.name + " iframe命中! score: " + bestIframe.score + "%");
          return {
            element: bestIframe.iframeEl,
            matchMethod: "语义-" + strategy.name + " [iframe]",
            scorePercent: bestIframe.score,
            source: "iframe"
          };
        }

//         console.log("[BusinessGuide] " + strategy.name + " iframe也未命中，降级下一策略");
      }
    }

//     console.warn("[BusinessGuide] 全部策略（S0-S3）主页+iframe均已耗尽，未找到目标");
    return null;
  }

  // 弹出确认对话框：询问用户是否跳过当前未找到控件的步骤，继续下一步。
  // onContinue：用户选择"继续下一步"；onAbort：用户选择"中止引导"。
  function showConfirmDialog(step, onContinue, onAbort) {
    const dialog = document.createElement("div");
    dialog.className = "guide-confirm-dialog";
    confirmDialogEl = dialog;
    dialog.innerHTML = `
      <div class="guide-confirm-header">
        <p class="guide-confirm-title">请确认操作节点</p>
        <p class="guide-confirm-desc">
          当前领航步骤 <span class="guide-confirm-step-name">"${escapeHtml(step.title)}"</span> 与页面流程节点未对齐。点击 下一步 可继续领航。
        </p>
      </div>
      <div class="guide-confirm-actions">
        <button class="guide-btn-skip" id="guide-confirm-skip">下一步</button>
        <button class="guide-btn-abort" id="guide-confirm-abort">退出领航</button>
      </div>
    `;

    document.body.appendChild(dialog);

    // 无遮罩，页面保持可交互；用像素坐标定位，makeDraggable 依赖 style.left/top
    dialog.style.left = Math.max(0, (window.innerWidth - dialog.offsetWidth) / 2) + "px";
    dialog.style.top = Math.max(0, (window.innerHeight - dialog.offsetHeight) / 3) + "px";
    makeDraggable(dialog.querySelector(".guide-confirm-header"), dialog);

    const cleanup = () => {
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      confirmDialogEl = null;
    };

    document.getElementById("guide-confirm-skip").onclick = () => {
      cleanup();
      if (onContinue) onContinue();
    };

    document.getElementById("guide-confirm-abort").onclick = () => {
      cleanup();
      if (onAbort) onAbort();
    };
  }

  // 目标元素彻底匹配失败（本文档selector+语义匹配都没找到，iframe里也没找到）：
  // 弹出确认对话框，让用户决定是跳过当前步骤继续，还是中止整个引导流程。
  function handleTargetNotFound(step) {
//     console.warn(`[BusinessGuide] 步骤"${step.title}"未能在页面中匹配到目标元素，等待用户决策。`);
    cleanupUI();

    showConfirmDialog(step,
      // 继续下一步
      () => {
//         console.log(`[BusinessGuide] 用户选择跳过"${step.title}"，继续下一步。`);
        advanceStep();
      },
      // 中止引导
      () => {
//         console.log(`[BusinessGuide] 用户选择中止引导（步骤"${step.title}"未命中）。`);
        showToast("引导已中止，流程进度已清除。");
        disableGuide();
      }
    );
  }

  // 在当前文档里为一个元素画高亮框。顶层和iframe worker共用——
  // iframe内部用 position:fixed 天然只相对自己的视口定位，不需要做任何跨frame坐标换算。
  function createHighlightForElement(element, style) {
    // 命中元素可能落在首屏之外（如页面底部），先让浏览器滚到该元素，
    // 否则下面按"绝对页面坐标"画的高亮框会被画到视口外，用户会误以为没找到。
    // behavior:"instant" 强制立即滚动，避开页面自身 scroll-behavior:smooth 导致的坐标读到旧值。
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });

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
        <span><img src="${ICON_URL}" style="width:16px;height:16px;vertical-align:middle;margin-right:6px;">智导业务操作领航：${escapeHtml(activeGuide.title)}</span>
        <button id="guide-close-btn" class="guide-btn-close">×</button>
      </div>
      <div class="guide-body">
        <h3 class="guide-step-title">
          <span class="guide-step-num">步骤 ${globalNum}</span>
          ${escapeHtml(step.title)}
        </h3>
        <p class="guide-step-desc">${escapeHtml(step.description)}</p>
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

    // 气泡同样按绝对页面坐标定位；anchor 元素（或承载目标的 iframe）在首屏外时先滚到可见位置。
    anchorElement.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
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
      // 统计：步骤导航
      if (flowMeta) trackFlowStat(flowMeta.flowId, "step");
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
      // 统计：步骤导航（下一步 / 前往下一页）
      if (flowMeta) trackFlowStat(flowMeta.flowId, "step");
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
      persistFlowState(lastGlobalNum + 1, flowMeta.pageIndex + 1);
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

    if (confirmDialogEl && confirmDialogEl.parentNode) {
      confirmDialogEl.parentNode.removeChild(confirmDialogEl);
      confirmDialogEl = null;
    }

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

  // ------------------ 可用流程浮动通知 ------------------

  function renderFlowNotification(flows) {
    if (flowNotificationEl) {
      flowNotificationEl.parentNode && flowNotificationEl.parentNode.removeChild(flowNotificationEl);
      flowNotificationEl = null;
    }

    const container = document.createElement("div");
    container.className = "guide-extension-flow-notify";
    container.innerHTML =
      `<div class="gf-notify-header">
        <span>当前页及子页面有 <strong>${flows.length}</strong> 个引导流程</span>
        <div class="gf-notify-header-right">
          <span class="gf-notify-arrow">▾</span>
          <button class="gf-notify-close-btn" title="关闭">×</button>
        </div>
      </div>
      <div class="gf-notify-list">
        ${flows.map((f, i) => `
          <div class="gf-notify-item" data-flowid="${escapeHtml(f.id)}" data-starturl="${escapeHtml(f.starturl)}">
            <span class="gf-notify-index">${i + 1}.</span>
            <span class="gf-notify-title">${escapeHtml(f.title)}</span>
          </div>
        `).join("")}
        <div class="gf-notify-hint">单击需要完成的流程前往该页面，然后请按<br/> <kbd>ALT</kbd> + <kbd>G</kbd> 开始页面流程引导。 如果页面不支持自动跳转，请自行前往。</div>
      </div>`;
    document.body.appendChild(container);
    flowNotificationEl = container;

    const header = container.querySelector(".gf-notify-header");
    const list = container.querySelector(".gf-notify-list");

    // 浮动窗口拖拽：按住标题栏拖动整个窗口，与"点击展开/收起列表"区分开
    var drag = { moved: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };
    header.style.cursor = "move";

    // 指针捕获后事件重定向到 header，因此监听器挂在 header 而非 document：
    // 拖到跨域 iframe 上方或窗口外松手都不会丢事件；本面板每次 SPA 路由跳转都会
    // 重建，元素级监听器随之回收，不会堆积。
    var activeNotifyPointerId = null;

    function onNotifyPointerMove(e) {
      if (e.pointerId !== activeNotifyPointerId) return;
      if (e.buttons === 0) { endNotifyDrag(); return; } // 按键已松开却仍有事件：收尾兜底
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
      container.style.left = Math.max(0, drag.startLeft + dx) + "px";
      container.style.top = Math.max(0, drag.startTop + dy) + "px";
    }

    function endNotifyDrag() {
      if (activeNotifyPointerId === null) return;
      header.removeEventListener("pointermove", onNotifyPointerMove);
      header.removeEventListener("pointerup", endNotifyDrag);
      header.removeEventListener("pointercancel", endNotifyDrag);
      if (header.hasPointerCapture(activeNotifyPointerId)) {
        header.releasePointerCapture(activeNotifyPointerId);
      }
      activeNotifyPointerId = null;
    }

    header.addEventListener("pointerdown", function(e) {
      if (e.button !== 0) return; // 只响应左键，右键/中键不启动拖拽
      if (e.target.tagName === "BUTTON") return; // 不拦截关闭按钮
      if (activeNotifyPointerId !== null) return; // 已有拖拽进行中
      activeNotifyPointerId = e.pointerId;
      drag.moved = false;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      var rect = container.getBoundingClientRect();
      drag.startLeft = rect.left;
      drag.startTop = rect.top;
      container.style.left = rect.left + "px";
      container.style.top = rect.top + "px";
      container.style.right = "auto";
      header.setPointerCapture(e.pointerId);
      header.addEventListener("pointermove", onNotifyPointerMove);
      header.addEventListener("pointerup", endNotifyDrag);
      header.addEventListener("pointercancel", endNotifyDrag);
      e.preventDefault();
    });

    header.addEventListener("click", function() {
      if (drag.moved) { drag.moved = false; return; } // 拖拽结束的 click 不切换列表
      const isOpen = list.classList.toggle("gf-open");
      container.querySelector(".gf-notify-arrow").textContent = isOpen ? "▴" : "▾";
    });

    const closeBtn = container.querySelector(".gf-notify-close-btn");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFlowNotification();
    });

    list.querySelectorAll(".gf-notify-item").forEach(item => {
      item.addEventListener("click", async () => {
        const starturl = item.getAttribute("data-starturl");
        const flowId = item.getAttribute("data-flowid");
        if (starturl) {
          // 归一化比较 startUrl 与当前页面 URL：
          // 若一致则无需跳转浏览器，直接启动该流程的页面引导
          if (urlsMatchClient(starturl, window.location.href)) {
            // 收起列表而非关闭整个浮动窗口，方便用户后续选择其他流程
            collapseFlowNotification();
            try {
              const data = await fetchGuideFromApi(getCleanPath(), flowId);
              handleGuideApiResult(data, getCleanPath(), null, true);
            } catch (e) {
//               console.error("[BusinessGuide] 通知入口启动引导失败:", e);
              showToast("❌ 业务指南网络服务端点连接失败");
            }
            return;
          }
          // 点击后收起浮动框（保留在页面上），再导航
          collapseFlowNotification();
          window.location.href = /^https?:\/\//i.test(starturl)
            ? starturl
            : `${window.location.protocol}//${starturl}`;
        }
      });
    });
  }

  function removeFlowNotification() {
    if (flowNotificationEl && flowNotificationEl.parentNode) {
      flowNotificationEl.parentNode.removeChild(flowNotificationEl);
      flowNotificationEl = null;
    }
  }

  // 收起流程通知列表（不关闭整个浮动窗口），方便用户在启动一个引导后还能看到其他可用流程
  function collapseFlowNotification() {
    if (!flowNotificationEl) return;
    var list = flowNotificationEl.querySelector(".gf-notify-list");
    var arrow = flowNotificationEl.querySelector(".gf-notify-arrow");
    if (list) list.classList.remove("gf-open");
    if (arrow) arrow.textContent = "▾";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // 向后台发送流程统计（fire-and-forget，不阻塞主流程）
  function trackFlowStat(flowId, type) {
    try {
      chrome.runtime.sendMessage({ action: "track-stats", flowId, type }, () => {
        // 忽略 chrome.runtime.lastError
      });
    } catch (e) {
      // 静默忽略
    }
  }
})();