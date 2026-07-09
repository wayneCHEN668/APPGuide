/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { Guide, GuideStep, MockPage } from "../types";
import { 
  Code, 
  Settings, 
  Sparkles, 
  Terminal, 
  Plus, 
  Trash2, 
  Save, 
  RefreshCw, 
  AlertTriangle, 
  Check, 
  ArrowRight,
  Info,
  Layers,
  Sparkle,
  Search,
  Eye,
  CheckCircle2
} from "lucide-react";
import { ExtensionExporter } from "./ExtensionExporter";

interface DevCenterProps {
  currentUrl: string;
  activeGuide: Guide | null;
  onGuideSaved: (updatedGuide: Guide) => void;
  mockPages: MockPage[];
  onRefresh: () => void;
  isLoadingGuide: boolean;
  focusedSelector?: string;
  onFocusedSelectorChange?: (selector: string) => void;
}

export const DevCenter: React.FC<DevCenterProps> = ({
  currentUrl,
  activeGuide,
  onGuideSaved,
  mockPages,
  onRefresh,
  isLoadingGuide,
  focusedSelector,
  onFocusedSelectorChange
}) => {
  const [activeTab, setActiveTab] = useState<"visual" | "json" | "ai" | "export" | "semantic">("visual");
  
  // Local states for editing
  const [guideTitle, setGuideTitle] = useState("");
  const [guideDesc, setGuideDesc] = useState("");
  const [steps, setSteps] = useState<GuideStep[]>([]);
  
  // JSON view state
  const [rawJson, setRawJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // AI draft states
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Semantic Debugger States
  interface ScannedElement {
    selector: string;
    label: string;
    placeholder: string;
    className: string;
    ariaLabel: string;
    type: string;
  }
  
  interface MatchedStepResult {
    stepIndex: number;
    rawTitle: string;
    rawDesc: string;
    matchedSelector: string;
    matchedLabel: string;
    confidence: number;
    allMatches: Array<{ selector: string; label: string; score: number }>;
  }

  const [semanticInput, setSemanticInput] = useState("");
  const [matchedResults, setMatchedResults] = useState<MatchedStepResult[]>([]);
  const [scannedElements, setScannedElements] = useState<ScannedElement[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  // Sync editor with activeGuide when activeGuide or currentUrl changes
  useEffect(() => {
    if (activeGuide) {
      setGuideTitle(activeGuide.title);
      setGuideDesc(activeGuide.description || "");
      setSteps(activeGuide.steps);
      setRawJson(JSON.stringify(activeGuide, null, 2));
      setJsonError(null);
    } else {
      // Create empty template for current url
      setGuideTitle(`针对 ${currentUrl} 的全新向导`);
      setGuideDesc("请在这里录入对此页面业务操作流程的细致引导...");
      setSteps([]);
      setRawJson(JSON.stringify({
        url: currentUrl,
        title: `针对 ${currentUrl} 的全新向导`,
        description: "请在这里录入对此页面业务操作流程的细致引导...",
        steps: []
      }, null, 2));
      setJsonError(null);
    }
  }, [activeGuide, currentUrl]);

  // Prepopulate natural language steps based on active URL
  useEffect(() => {
    if (currentUrl === "/erp/loans/apply") {
      setSemanticInput(
`### 第 1 步：填写客户姓名
- 录入法定姓名，确保和身份证件一致

### 第 2 步：身份证查验
- 输入18位身份证号码进行风险库黑名单筛查

### 第 3 步：设定月核定收入
- 填写流水审查核定后的净收入数额

### 第 4 步：录入申请额度
- 输入申请借款本金，注意不能超过最高50万限制

### 第 5 步：抵押担保选择
- 设定本单贷款的担保或者抵押类别

### 第 6 步：执行表单提交
- 点击提交初审申请书按钮完成初审进件`
      );
    } else if (currentUrl === "/erp/loans/review") {
      setSemanticInput(
`### 第 1 步：核对风险评分
- 检查自动化系统的征信建议分值

### 第 2 步：核算负债比
- 输入月偿债总额除以收入的负债收入比值数

### 第 3 步：下达审核决定
- 下拉选择最终的风控核批结论决定

### 第 4 步：签署批注意见
- 撰写风控授信批注意见，说明主要潜在风险

### 第 5 步：完成单据签署
- 点击签署确认风控单按钮完成签署与风控流转`
      );
    } else if (currentUrl === "/erp/customer/onboarding") {
      setSemanticInput(
`### 第 1 步：录入企业姓名
- 输入需要开户的企业法定全称

### 第 2 步：信用代码
- 填写18位统一社会信用代码

### 第 3 步：企业法人
- 填写企业法定代表人姓名

### 第 4 步：经办人电话
- 输入接收初始激活短信的经办人手机号

### 第 5 步：手机密保
- 输入短信验证密保

### 第 6 步：发起开户
- 点击提交开户合规审核按钮`
      );
    } else {
      setSemanticInput(
`### 第 1 步：示例步骤标题
- 选择输入或者交互对象说明文案`
      );
    }
    // Clear results on page change
    setMatchedResults([]);
    setScannedElements([]);
  }, [currentUrl]);

  // Clean and tokenize text for vector space cosine matching
  const tokenize = (text: string): string[] => {
    if (!text) return [];
    const lowercase = text.toLowerCase();
    
    // Remove common Chinese formatting or prompt framing words
    const clean = lowercase
      .replace(/(第\s*\d+\s*[步级])|流程|操作|设置|选择|找到|点击|按钮|输入|输入框|下拉框|区域|展开/g, "")
      .trim();
    
    const tokens: string[] = [];
    
    // 1. Character Unigrams (ideal for fine-grained Chinese character match)
    for (let i = 0; i < clean.length; i++) {
      tokens.push(clean[i]);
    }
    
    // 2. Character Bigrams (excellent for Chinese token structures)
    for (let i = 0; i < clean.length - 1; i++) {
      tokens.push(clean.substring(i, i + 2));
    }
    
    // 3. English word tokens (split on non-alphanumeric and keep words)
    const words = clean.split(/[^a-z0-9]+/i).filter(w => w.length > 0);
    tokens.push(...words);
    
    return tokens;
  };

  // Cosine Similarity between term frequency vectors
  const computeSimilarity = (textA: string, textB: string): number => {
    const tokensA = tokenize(textA);
    const tokensB = tokenize(textB);
    
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    
    const countsA: Record<string, number> = {};
    const countsB: Record<string, number> = {};
    
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
  };

  // Traverses the actual active simulator page elements
  const scanSimulatedDOM = (): ScannedElement[] => {
    const list: ScannedElement[] = [];
    
    // Real DOM scanning within our simulation viewport
    const container = document.getElementById("browser-simulator-root") || document.body;
    const inputs = container.querySelectorAll("input, select, textarea, button");
    
    if (inputs && inputs.length > 0) {
      inputs.forEach(el => {
        const id = el.id || "";
        const type = el.tagName.toLowerCase();
        const placeholder = (el as HTMLInputElement).placeholder || "";
        const className = el.className || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        
        let labelText = "";
        if (id) {
          const labelEl = container.querySelector(`label[for="${id}"]`);
          if (labelEl) {
            labelText = labelEl.textContent || "";
          }
        }
        
        if (!labelText) {
          if (type === "button") {
            labelText = el.textContent || "";
          } else {
            const parent = el.parentElement;
            labelText = parent?.textContent || "";
          }
        }
        
        // Remove helper labels displayed inside the sandbox
        labelText = labelText.replace(/SELECTOR:.*/gi, "").trim();
        
        let selector = "";
        if (id) {
          selector = `#${id}`;
        } else {
          selector = `${type}.${className.split(" ")[0] || ""}`;
        }
        
        if (selector) {
          list.push({
            selector,
            label: labelText || id || type,
            placeholder,
            className,
            ariaLabel,
            type
          });
        }
      });
    }
    
    // Supplement from mockPages data structure to guarantee all controls are fully captured
    const activePage = mockPages.find(p => p.url === currentUrl);
    if (activePage) {
      activePage.fields.forEach(f => {
        const existingIdx = list.findIndex(item => item.selector === f.selector);
        if (existingIdx === -1) {
          list.push({
            selector: f.selector,
            label: f.label,
            placeholder: f.placeholder || "",
            className: f.type === "button" ? "bg-cyan-600 font-semibold" : "border-zinc-800",
            ariaLabel: f.label,
            type: f.type
          });
        } else {
          if (!list[existingIdx].label) {
            list[existingIdx].label = f.label;
          }
          if (f.placeholder) {
            list[existingIdx].placeholder = f.placeholder;
          }
        }
      });
    }
    
    return list;
  };

  // Perform vector fuzzy parsing and auto mapping
  const handleAutoMatch = () => {
    setIsScanning(true);
    
    setTimeout(() => {
      const scanned = scanSimulatedDOM();
      setScannedElements(scanned);
      
      if (scanned.length === 0) {
        setIsScanning(false);
        alert("❌ 未找到页面元素，请确保浏览器模拟器已装载。");
        return;
      }
      
      // Parse MD steps
      const blocks = semanticInput.split(/(?=###|第\s*\d+\s*步)/);
      const parsedSteps: Array<{ title: string; desc: string }> = [];
      
      blocks.forEach(block => {
        const lines = block.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return;
        
        let stepTitle = "";
        let stepDesc = "";
        
        const firstLine = lines[0];
        if (firstLine.startsWith("###") || firstLine.includes("步：") || firstLine.includes("步:")) {
          stepTitle = firstLine.replace(/^###\s*/, "").trim();
          stepDesc = lines.slice(1).join("\n").replace(/^[-*\s+]+/, "").trim();
        } else {
          stepTitle = firstLine;
          stepDesc = lines.slice(1).join("\n");
        }
        
        if (stepTitle) {
          parsedSteps.push({ title: stepTitle, desc: stepDesc || stepTitle });
        }
      });
      
      if (parsedSteps.length === 0) {
        setIsScanning(false);
        alert("⚠️ 未解析到任何步骤。请确保您的文本包含类似 '### 第 1 步：标题' 的 Markdown 格式。");
        return;
      }
      
      const results: MatchedStepResult[] = parsedSteps.map((pStep, index) => {
        const query = `${pStep.title} ${pStep.desc}`;
        
        const matches = scanned.map(item => {
          // Weight factors: label is primary, placeholder is secondary
          const score = computeSimilarity(
            query, 
            `${item.label} ${item.label} ${item.label} ${item.placeholder} ${item.placeholder} ${item.ariaLabel} ${item.className}`
          );
          return {
            selector: item.selector,
            label: item.label,
            score: score
          };
        });
        
        matches.sort((a, b) => b.score - a.score);
        const bestMatch = matches[0];
        
        return {
          stepIndex: index,
          rawTitle: pStep.title,
          rawDesc: pStep.desc,
          matchedSelector: bestMatch && bestMatch.score > 0.01 ? bestMatch.selector : "",
          matchedLabel: bestMatch && bestMatch.score > 0.01 ? bestMatch.label : "未找到匹配项",
          confidence: bestMatch ? Math.round(bestMatch.score * 100) : 0,
          allMatches: matches.slice(0, 5)
        };
      });
      
      setMatchedResults(results);
      setIsScanning(false);
    }, 400); // Slight delay for professional feel
  };

  // Apply the matched steps to active guide and save
  const handleApplySemanticGuide = async () => {
    if (matchedResults.length === 0) {
      alert("⚠️ 请先进行语义向量扫描匹配！");
      return;
    }
    
    // Guess action values and create GuideStep objects
    const compiledSteps: GuideStep[] = matchedResults.map((res, index) => {
      // Determine action type based on selector/type
      let guessedAction: "focus" | "input" | "click" | "any" = "focus";
      const lowerSel = res.matchedSelector.toLowerCase();
      
      if (lowerSel.includes("btn") || lowerSel.includes("submit") || lowerSel.includes("confirm")) {
        guessedAction = "click";
      } else if (lowerSel.includes("comments") || lowerSel.includes("input") || lowerSel.includes("name") || lowerSel.includes("card")) {
        guessedAction = "input";
      }
      
      return {
        id: `step-sem-${Date.now()}-${index}`,
        title: res.rawTitle,
        description: res.rawDesc || res.rawTitle,
        selector: res.matchedSelector || "#customer-name",
        actionType: guessedAction,
        tipPosition: "bottom",
        highlightStyle: guessedAction === "click" ? "glow" : "pulse"
      };
    });
    
    // Save to server
    setSteps(compiledSteps);
    
    const activePage = mockPages.find(p => p.url === currentUrl);
    const newTitle = activePage ? `${activePage.title} - 实操引导指南` : `针对 ${currentUrl} 的全新向导`;
    const newDesc = activePage ? `根据业务手册一键自动映射编译的 ${activePage.title} 实操合规引导方案。` : "请在这里录入对此页面业务操作流程的细致引导...";
    
    setGuideTitle(newTitle);
    setGuideDesc(newDesc);
    syncJsonFromVisual(newTitle, newDesc, compiledSteps);
    
    await handleSaveGuide(compiledSteps, newTitle, newDesc);
    
    setActiveTab("visual");
  };

  // Keep rawJson in sync with steps/title changes in visual builder
  const syncJsonFromVisual = (updatedTitle: string, updatedDesc: string, updatedSteps: GuideStep[]) => {
    const obj = {
      url: currentUrl,
      title: updatedTitle,
      description: updatedDesc,
      steps: updatedSteps
    };
    setRawJson(JSON.stringify(obj, null, 2));
    setJsonError(null);
  };

  // Handle saving via API
  const handleSaveGuide = async (finalSteps = steps, finalTitle = guideTitle, finalDesc = guideDesc) => {
    try {
      const response = await fetch("/api/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: currentUrl,
          title: finalTitle,
          description: finalDesc,
          steps: finalSteps
        })
      });
      const data = await response.json();
      if (data.success && data.guide) {
        onGuideSaved(data.guide);
        alert(`🎉 成功保存至 API 端点！\n现在插件已自动通过 GET /api/guide?url=${encodeURIComponent(currentUrl)} 实时获取最新版本。`);
      } else {
        alert("保存失败: " + (data.error || "未知原因"));
      }
    } catch (e: any) {
      alert("保存失败，无法连接 to API 端点: " + e.message);
    }
  };

  // Raw JSON parser and applier
  const handleApplyJson = () => {
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed.title || !Array.isArray(parsed.steps)) {
        setJsonError("JSON 格式错误：必须包含 'title' 字段并且 'steps' 必须为数组。");
        return;
      }
      
      setJsonError(null);
      setGuideTitle(parsed.title);
      setGuideDesc(parsed.description || "");
      setSteps(parsed.steps);
      
      // Save changes to backend API
      handleSaveGuide(parsed.steps, parsed.title, parsed.description);
    } catch (e: any) {
      setJsonError(`JSON 语法解析错误: ${e.message}`);
    }
  };

  // Visual editors helpers
  const handleStepFieldChange = (index: number, field: keyof GuideStep, value: any) => {
    const updatedSteps = [...steps];
    updatedSteps[index] = { ...updatedSteps[index], [field]: value };
    setSteps(updatedSteps);
    syncJsonFromVisual(guideTitle, guideDesc, updatedSteps);
  };

  const handleAddStep = () => {
    // Pick the first mock field of current page as default selector
    const activePage = mockPages.find((p) => p.url === currentUrl);
    const defaultSelector = activePage?.fields[0]?.selector || "#customer-name";
    
    const newStep: GuideStep = {
      id: `step-${Date.now()}`,
      title: "新引导操作",
      description: "请用简洁明了的语言向业务员解释当前位置应该怎么填、有什么风控注意事项。",
      selector: defaultSelector,
      actionType: "focus",
      tipPosition: "bottom",
      highlightStyle: "pulse"
    };

    const updatedSteps = [...steps, newStep];
    setSteps(updatedSteps);
    syncJsonFromVisual(guideTitle, guideDesc, updatedSteps);
  };

  const handleDeleteStep = (index: number) => {
    const updatedSteps = steps.filter((_, i) => i !== index);
    setSteps(updatedSteps);
    syncJsonFromVisual(guideTitle, guideDesc, updatedSteps);
  };

  // Gemini AI automatic generator
  const handleGenerateAiGuide = async () => {
    const activePage = mockPages.find((p) => p.url === currentUrl);
    if (!activePage) return;

    setAiGenerating(true);
    setAiError(null);

    try {
      const response = await fetch("/api/generate-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: currentUrl,
          title: activePage.title,
          pageDescription: activePage.description,
          fields: activePage.fields.map(f => ({ label: f.label, selector: f.selector }))
        })
      });

      const data = await response.json();
      if (data.success && data.guide) {
        setGuideTitle(data.guide.title);
        setGuideDesc(data.guide.description || "");
        setSteps(data.guide.steps);
        setRawJson(JSON.stringify(data.guide, null, 2));
        
        // Auto-save generated guide to API
        onGuideSaved(data.guide);
        
        setActiveTab("visual");
        alert("✨ AI 专家已成功为您生成了贴合当前界面的业务合规引导！\n已自动应用并注入到仿真模拟器中。");
      } else {
        setAiError(data.error || "生成失败，未提供原因。");
      }
    } catch (e: any) {
      setAiError(`API 连通失败: ${e.message}`);
    } finally {
      setAiGenerating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0c0c0e] border border-zinc-800/80 rounded-xl overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.6)] font-sans glow-cyan-sm">
      {/* 头部导航/页签 */}
      <div className="bg-[#09090b] px-4 py-3 border-b border-zinc-800/80 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Settings className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-bold text-zinc-200">API 决策中心 & 开发者控制台</h2>
        </div>
        <button 
          onClick={onRefresh}
          disabled={isLoadingGuide}
          className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 rounded transition-all cursor-pointer"
          title="重新请求 API 以拉取最新步骤"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoadingGuide ? "animate-spin text-cyan-400" : ""}`} />
        </button>
      </div>

      {/* Tab菜单 */}
      <div className="flex bg-[#0c0c0e] border-b border-zinc-800 text-xs text-zinc-400 font-medium overflow-x-auto shrink-0 select-none">
        <button
          onClick={() => setActiveTab("visual")}
          className={`flex-1 py-3 text-center border-b-2 transition-all shrink-0 cursor-pointer ${
            activeTab === "visual" 
              ? "text-cyan-400 border-cyan-500 bg-zinc-900/60 shadow-[inset_0_-2px_0_rgba(34,211,238,1)] font-semibold" 
              : "border-transparent hover:text-zinc-200 hover:bg-zinc-900/20"
          }`}
        >
          ✍️ 可视化设计器
        </button>
        <button
          onClick={() => setActiveTab("json")}
          className={`flex-1 py-3 text-center border-b-2 transition-all shrink-0 cursor-pointer ${
            activeTab === "json" 
              ? "text-cyan-400 border-cyan-500 bg-zinc-900/60 shadow-[inset_0_-2px_0_rgba(34,211,238,1)] font-semibold" 
              : "border-transparent hover:text-zinc-200 hover:bg-zinc-900/20"
          }`}
        >
          <Code className="w-3.5 h-3.5 inline mr-1" /> API JSON
        </button>
        <button
          onClick={() => setActiveTab("ai")}
          className={`flex-1 py-3 text-center border-b-2 transition-all shrink-0 cursor-pointer ${
            activeTab === "ai" 
              ? "text-cyan-400 border-cyan-500 bg-zinc-900/60 shadow-[inset_0_-2px_0_rgba(34,211,238,1)] font-semibold" 
              : "border-transparent hover:text-zinc-200 hover:bg-zinc-900/20"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5 inline mr-1 text-amber-400" /> AI 智能起草
        </button>
        <button
          onClick={() => setActiveTab("export")}
          className={`flex-1 py-3 text-center border-b-2 transition-all shrink-0 cursor-pointer ${
            activeTab === "export" 
              ? "text-cyan-400 border-cyan-500 bg-zinc-900/60 shadow-[inset_0_-2px_0_rgba(34,211,238,1)] font-semibold" 
              : "border-transparent hover:text-zinc-200 hover:bg-zinc-900/20"
          }`}
        >
          📦 扩展包构建
        </button>
        <button
          onClick={() => setActiveTab("semantic")}
          className={`flex-1 py-3 text-center border-b-2 transition-all shrink-0 cursor-pointer ${
            activeTab === "semantic" 
              ? "text-cyan-400 border-cyan-500 bg-zinc-900/60 shadow-[inset_0_-2px_0_rgba(34,211,238,1)] font-semibold" 
              : "border-transparent hover:text-zinc-200 hover:bg-zinc-900/20"
          }`}
        >
          🔍 语义匹配调试
        </button>
      </div>

      {/* 滚动区域 */}
      <div className="flex-1 p-4 overflow-y-auto bg-gradient-to-b from-[#0c0c0e] to-[#08080a] text-zinc-300">
        
        {/* ======================================================== TAB 1: VISUAL DESIGNER ======================================================== */}
        {activeTab === "visual" && (
          <div className="space-y-4">
            {/* 顶栏信息 */}
            <div className="p-3.5 bg-zinc-950/60 border border-zinc-800 rounded-xl space-y-3 shadow-[inset_0_1px_12px_rgba(255,255,255,0.02)]">
              <div>
                <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wide mb-1">
                  业务规则标题 (Guide Title)
                </label>
                <input
                  type="text"
                  value={guideTitle}
                  onChange={(e) => {
                    setGuideTitle(e.target.value);
                    syncJsonFromVisual(e.target.value, guideDesc, steps);
                  }}
                  className="w-full bg-[#050505] border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-xs px-3 py-2 rounded-lg font-sans focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 transition-all"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wide mb-1">
                  总流程业务概述 (Description)
                </label>
                <textarea
                  rows={2}
                  value={guideDesc}
                  onChange={(e) => {
                    setGuideDesc(e.target.value);
                    syncJsonFromVisual(guideTitle, e.target.value, steps);
                  }}
                  className="w-full bg-[#050505] border border-zinc-800 hover:border-zinc-700 text-zinc-200 text-xs px-3 py-1.5 rounded-lg font-sans focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 transition-all resize-none"
                />
              </div>
            </div>

            {/* 步骤列表 */}
            <div className="space-y-3.5">
              <div className="flex items-center justify-between select-none">
                <span className="text-xs font-semibold text-zinc-400">步骤流程明细 ({steps.length})</span>
                <button
                  onClick={handleAddStep}
                  className="flex items-center space-x-1 px-2.5 py-1.5 bg-cyan-500/10 hover:bg-cyan-600 text-cyan-400 hover:text-black rounded-lg text-[11px] font-bold border border-cyan-500/20 hover:border-cyan-500 transition-all cursor-pointer shadow-[0_2px_8px_rgba(34,211,238,0.1)]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>新增步骤</span>
                </button>
              </div>

              {steps.length === 0 ? (
                <div className="py-8 text-center bg-zinc-950/40 border border-dashed border-zinc-800 rounded-xl flex flex-col items-center justify-center space-y-2 select-none">
                  <Info className="w-8 h-8 text-zinc-600" />
                  <p className="text-xs font-medium text-zinc-500">当前 URL 尚未注册任何引导步骤</p>
                  <button 
                    onClick={handleAddStep}
                    className="text-[11px] text-cyan-400 hover:underline font-semibold cursor-pointer"
                  >
                    立即手动创建一个
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {steps.map((step, index) => (
                    <div 
                      key={step.id} 
                      className="p-3.5 bg-zinc-950/40 border border-zinc-850 rounded-xl space-y-3 hover:border-zinc-800 transition-all relative group"
                    >
                      {/* 步骤索引和删除按钮 */}
                      <div className="flex items-center justify-between pb-1 border-b border-zinc-900 select-none">
                        <span className="text-xs font-bold text-zinc-400 flex items-center">
                          <span className="w-4 h-4 bg-zinc-900 text-cyan-400 border border-cyan-500/15 rounded-full flex items-center justify-center text-[10px] mr-1.5 font-mono">
                            {index + 1}
                          </span>
                          步骤设置
                        </span>
                        <button
                          onClick={() => handleDeleteStep(index)}
                          className="p-1 text-zinc-600 hover:text-rose-400 rounded transition-colors cursor-pointer"
                          title="删除当前步骤"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* 步骤标题 */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                            步骤标题
                          </label>
                          <input
                            type="text"
                            value={step.title}
                            onChange={(e) => handleStepFieldChange(index, "title", e.target.value)}
                            className="w-full bg-[#050505] border border-zinc-850 text-zinc-200 text-xs px-2.5 py-1.5 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500"
                          />
                        </div>

                        {/* 选择器 */}
                        <div>
                          <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                            控件 CSS 选择器
                          </label>
                          <input
                            type="text"
                            value={step.selector}
                            onChange={(e) => handleStepFieldChange(index, "selector", e.target.value)}
                            className="w-full bg-[#050505] border border-zinc-850 text-zinc-200 text-xs px-2.5 py-1.5 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                          />
                        </div>
                      </div>

                      {/* 详细描述 */}
                      <div>
                        <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                          业务说明文本 (规程合规指引)
                        </label>
                        <textarea
                          rows={2}
                          value={step.description}
                          onChange={(e) => handleStepFieldChange(index, "description", e.target.value)}
                          className="w-full bg-[#050505] border border-zinc-850 text-zinc-200 text-xs px-2.5 py-1.5 rounded-md focus:outline-none focus:ring-1 focus:ring-cyan-500"
                        />
                      </div>

                      {/* 参数配置：动作、高亮、气泡方向 */}
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                            推进条件
                          </label>
                          <select
                            value={step.actionType}
                            onChange={(e) => handleStepFieldChange(index, "actionType", e.target.value)}
                            className="w-full bg-[#050505] border border-zinc-850 text-zinc-300 text-xs px-2 py-1.5 rounded-md focus:outline-none cursor-pointer"
                          >
                            <option value="focus" className="bg-[#0c0c0e]">元素聚焦 (Focus)</option>
                            <option value="input" className="bg-[#0c0c0e]">填写输入 (Input)</option>
                            <option value="click" className="bg-[#0c0c0e]">按钮点击 (Click)</option>
                            <option value="any" className="bg-[#0c0c0e]">无约束手动推进</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                            高亮框视觉
                          </label>
                          <select
                            value={step.highlightStyle}
                            onChange={(e) => handleStepFieldChange(index, "highlightStyle", e.target.value)}
                            className="w-full bg-[#050505] border border-zinc-850 text-zinc-300 text-xs px-2 py-1.5 rounded-md focus:outline-none cursor-pointer"
                          >
                            <option value="pulse" className="bg-[#0c0c0e]">青色呼吸 (Pulse)</option>
                            <option value="solid" className="bg-[#0c0c0e]">红色防错 (Solid)</option>
                            <option value="glow" className="bg-[#0c0c0e]">橙色警告 (Glow)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                            气泡弹出方位
                          </label>
                          <select
                            value={step.tipPosition}
                            onChange={(e) => handleStepFieldChange(index, "tipPosition", e.target.value)}
                            className="w-full bg-[#050505] border border-zinc-850 text-zinc-300 text-xs px-2 py-1.5 rounded-md focus:outline-none cursor-pointer"
                          >
                            <option value="bottom" className="bg-[#0c0c0e]">下方 (Bottom)</option>
                            <option value="top" className="bg-[#0c0c0e]">上方 (Top)</option>
                            <option value="left" className="bg-[#0c0c0e]">左侧 (Left)</option>
                            <option value="right" className="bg-[#0c0c0e]">右侧 (Right)</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* 保存大按钮 */}
              {steps.length > 0 && (
                <button
                  onClick={() => handleSaveGuide(steps)}
                  className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-black rounded-xl text-xs font-bold transition-all shadow-[0_4px_12px_rgba(34,211,238,0.2)] flex items-center justify-center space-x-2 select-none cursor-pointer mt-4"
                >
                  <Save className="w-4 h-4" />
                  <span>保存配置至 API 数据库端点</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* ======================================================== TAB 2: RAW JSON CODE ======================================================== */}
        {activeTab === "json" && (
          <div className="space-y-4 h-full flex flex-col">
            <div className="p-3 bg-cyan-950/10 border border-cyan-800/20 rounded-xl flex items-start space-x-2.5">
              <Info className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
              <div className="text-xs text-zinc-300 leading-normal font-sans">
                <span className="font-semibold text-zinc-100">API 模拟交互说明：</span>
                当前浏览器在检测到 URL 发生变更时，会实时访问您的模拟后端路径 
                <code className="text-cyan-400 font-mono bg-[#050505] px-1 py-0.5 rounded text-[10px] mx-1 border border-zinc-800">GET /api/guide?url={currentUrl}</code>
                。在这里修改并应用 JSON 将直接覆盖服务器数据库中对该 URL 的反馈结果。
              </div>
            </div>

            <div className="flex-1 min-h-[300px] flex flex-col">
              <label className="block text-[10px] font-bold text-zinc-500 uppercase tracking-wide mb-1 select-none">
                JSON Payload (实时响应格式)
              </label>
              <textarea
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                className="w-full flex-1 min-h-[250px] bg-[#050505] border border-zinc-850 hover:border-zinc-700 text-emerald-400 text-xs px-3 py-2 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>

            {jsonError && (
              <div className="p-3 bg-rose-950/40 border border-rose-900/50 rounded-xl flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5 animate-bounce" />
                <p className="text-[11px] text-rose-300 leading-normal">{jsonError}</p>
              </div>
            )}

            <button
              onClick={handleApplyJson}
              className="w-full py-2.5 bg-zinc-900 hover:bg-zinc-800 hover:text-cyan-400 text-zinc-100 rounded-lg text-xs font-bold border border-zinc-800 transition-all flex items-center justify-center space-x-2 shrink-0 cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
            >
              <Check className="w-4 h-4" />
              <span>校验并写入后台 API 数据库</span>
            </button>
          </div>
        )}

        {/* ======================================================== TAB 3: AI GENERATOR ======================================================== */}
        {activeTab === "ai" && (
          <div className="space-y-4">
            <div className="p-4 bg-[#09090b] border border-zinc-800/80 rounded-xl space-y-3 relative overflow-hidden shadow-[0_4px_20px_rgba(0,0,0,0.4)]">
              <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none" />
              
              <div className="flex items-center space-x-2 text-cyan-400">
                <Sparkle className="w-4 h-4 animate-spin-slow text-cyan-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider">AI 辅助行业知识注入中心</h3>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed font-sans">
                当您需要为极其繁琐复杂的金融授信、进件、ERP 系统编写合规及业务手册时，无需人脑耗时苦思！
                AI 专家可分析当前仿真页面中定义的控件和输入结构，一键生成极为严谨的实操指南方案。
              </p>

              <div className="pt-2">
                <span className="text-[10px] text-zinc-500 block mb-1">即将解析的字段结构：</span>
                <div className="flex flex-wrap gap-1.5 max-h-[100px] overflow-y-auto p-2 bg-[#050505] rounded-lg border border-zinc-850">
                  {mockPages.find(p => p.url === currentUrl)?.fields.map(f => (
                    <span key={f.id} className="text-[9px] px-1.5 py-0.5 bg-zinc-900 text-zinc-400 border border-zinc-800 rounded font-mono">
                      {f.label} ({f.selector})
                    </span>
                  )) || <span className="text-[10px] text-zinc-600">无可用字段</span>}
                </div>
              </div>

              {aiError && (
                <div className="p-3.5 bg-amber-950/20 border border-amber-900/40 rounded-lg space-y-2">
                  <div className="flex items-center space-x-1.5 text-amber-400 text-xs font-bold">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>Gemini API 未完全就绪</span>
                  </div>
                  <p className="text-[11px] text-amber-300/90 leading-relaxed font-sans">
                    {aiError.includes("GEMINI_API_KEY") 
                      ? "未检测到有效的 GEMINI_API_KEY。请先通过主控制台左侧/右侧设置面板中的“Secrets”选项卡配置您的 Gemini 密钥，并确保其名为 GEMINI_API_KEY 即可畅快体验 AI 一键智能起草引导！"
                      : aiError}
                  </p>
                </div>
              )}

              <button
                disabled={aiGenerating}
                onClick={handleGenerateAiGuide}
                className="w-full py-3 bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-black font-extrabold rounded-xl text-xs shadow-[0_4px_15px_rgba(34,211,238,0.2)] flex items-center justify-center space-x-2 transition-all cursor-pointer disabled:opacity-50"
              >
                <Sparkles className={`w-4 h-4 ${aiGenerating ? "animate-spin" : ""}`} />
                <span>
                  {aiGenerating ? "正在利用 Gemini 智能引擎起草业务步骤..." : "一键用 AI 编制当前页面合规步骤"}
                </span>
              </button>
            </div>

            <div className="bg-[#09090b] border border-zinc-800/85 p-3 rounded-lg">
              <h4 className="text-[10px] font-bold text-zinc-400 uppercase mb-1 flex items-center">
                <Info className="w-3.5 h-3.5 mr-1 text-cyan-400" />
                为何选择 AI 生成？
              </h4>
              <ul className="text-[10px] text-zinc-500 space-y-1 list-disc list-inside font-sans">
                <li>自动适配特定行业的专业词汇（如 KYC、合规性审计、征信防洗钱）。</li>
                <li>自动关联 input / select 的交互逻辑，智能分配最优的高亮显示风格。</li>
                <li>完美确保生成出来的 CSS 选择器与底层真实代码完全匹配。</li>
              </ul>
            </div>
          </div>
        )}

        {/* ======================================================== TAB 4: CHROM EXTENSION CODE EXPORT ======================================================== */}
        {activeTab === "export" && (
          <ExtensionExporter currentUrl={currentUrl} steps={steps} />
        )}

        {/* ======================================================== TAB 5: SEMANTIC DEBUGGER ======================================================== */}
        {activeTab === "semantic" && (
          <div className="space-y-4">
            {/* 顶栏说明 */}
            <div className="p-4 bg-zinc-950/60 border border-zinc-800 rounded-xl space-y-2 shadow-[inset_0_1px_12px_rgba(255,255,255,0.02)]">
              <h3 className="text-xs font-bold text-cyan-400 flex items-center space-x-1.5 uppercase tracking-wide">
                <Search className="w-4 h-4 text-cyan-400" />
                <span>自然语言语义匹配调试引擎 (Semantic Vector Matcher)</span>
              </h3>
              <p className="text-[11px] text-zinc-400 leading-relaxed font-sans">
                解决系统在极度复杂的实际项目中<strong>“获取控件 ID 或 Selector 异常困难”</strong>的行业痛点。通过对当前页面的 DOM 树结构、标签名（label）、占位符（placeholder）、类名（className）及 aria-label 进行本地字符级向量分词并计算 TF-IDF 模糊余弦相似度，自动将纯文本的操作指南绑定到最优的选择器上，无需写一行代码！
              </p>
            </div>

            {/* 核心工作流双栏布局 */}
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
              {/* 左侧：输入框 */}
              <div className="xl:col-span-2 space-y-3">
                <div className="bg-zinc-950/40 border border-zinc-800 p-3 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">
                      ① 输入业务操作指南文本 (Markdown)
                    </label>
                    <span className="text-[9px] font-mono text-zinc-500 bg-zinc-900 border border-zinc-800 px-1 py-0.2 rounded">
                      支持 ### 分割步骤
                    </span>
                  </div>
                  <textarea
                    value={semanticInput}
                    onChange={(e) => setSemanticInput(e.target.value)}
                    placeholder="请输入操作指南，例如：
### 第 1 步：核对风险评分
- 检查自动化系统的征信建议分值..."
                    className="w-full h-[320px] bg-[#050505] border border-zinc-800 hover:border-zinc-700 text-zinc-100 font-mono text-xs px-3 py-3 rounded-lg focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 transition-all leading-relaxed resize-none"
                  />
                  
                  <button
                    onClick={handleAutoMatch}
                    disabled={isScanning || !semanticInput}
                    className="w-full py-2.5 bg-cyan-600 hover:bg-cyan-500 text-black font-extrabold rounded-lg text-xs transition-all cursor-pointer flex items-center justify-center space-x-1.5 disabled:opacity-40 disabled:hover:bg-cyan-600"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? "animate-spin" : ""}`} />
                    <span>{isScanning ? "正在提取 DOM 向量并运行相似度计算..." : "一键分析并执行模糊向量对齐"}</span>
                  </button>
                </div>
              </div>

              {/* 右侧：匹配结果 */}
              <div className="xl:col-span-3 space-y-3">
                <div className="bg-[#09090b] border border-zinc-800 p-3.5 rounded-xl space-y-3 flex flex-col h-[400px]">
                  <div className="flex items-center justify-between shrink-0">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide">
                      ② 智能绑定结果预览 ({matchedResults.length} 步已关联)
                    </span>
                    {scannedElements.length > 0 && (
                      <span className="text-[9px] text-cyan-400 bg-cyan-950/20 border border-cyan-900/30 px-1.5 py-0.5 rounded font-mono">
                        已检索到 {scannedElements.length} 个页面节点
                      </span>
                    )}
                  </div>

                  {/* 结果显示 */}
                  {matchedResults.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-zinc-800 rounded-xl p-6 text-center">
                      <div className="p-3 bg-zinc-950 rounded-full border border-zinc-800 mb-3 shadow-[0_0_15px_rgba(0,0,0,0.4)]">
                        <Search className="w-5 h-5 text-zinc-600 animate-pulse" />
                      </div>
                      <p className="text-xs text-zinc-400 font-bold mb-1">等待执行相似度匹配</p>
                      <p className="text-[10px] text-zinc-500 max-w-[280px] leading-relaxed">
                        请在左侧输入纯文本操作指南，点击“一键分析并执行模糊向量对齐”按钮，系统将自动扫描 DOM 树并建议关联项。
                      </p>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 font-sans">
                      {matchedResults.map((res, index) => {
                        const isHighConf = res.confidence >= 55;
                        const isLowConf = res.confidence < 15;
                        
                        return (
                          <div 
                            key={index}
                            className={`p-3 bg-zinc-950 border rounded-lg transition-all ${
                              isHighConf 
                                ? "border-emerald-950 bg-emerald-950/5 hover:bg-emerald-950/10" 
                                : isLowConf 
                                  ? "border-zinc-800 bg-zinc-950 hover:bg-zinc-900/20" 
                                  : "border-amber-950 bg-amber-950/5 hover:bg-amber-950/10"
                            }`}
                          >
                            {/* 步骤标头与置信度 */}
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs font-bold text-zinc-200 flex items-center">
                                <span className="w-1.5 h-3 bg-cyan-500 rounded-sm mr-1.5 shrink-0 inline-block"></span>
                                {res.rawTitle}
                              </span>
                              
                              <span className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded shrink-0 ${
                                isHighConf 
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                                  : isLowConf
                                    ? "bg-zinc-900 text-zinc-500 border border-zinc-800"
                                    : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                              }`}>
                                置信度: {res.confidence}%
                              </span>
                            </div>

                            {/* 自然语言要求 */}
                            <p className="text-[11px] text-zinc-400 leading-relaxed pl-3 border-l border-zinc-800 mb-2">
                              {res.rawDesc}
                            </p>

                            {/* 绑定对象详情 */}
                            <div className="bg-zinc-950 border border-zinc-900/80 p-2 rounded flex items-center justify-between">
                              <div className="space-y-0.5 min-w-0">
                                <div className="text-[10px] text-zinc-500 font-sans">
                                  🎯 推荐匹配控件
                                </div>
                                <div className="text-xs text-zinc-300 font-medium truncate flex items-center">
                                  <span className="text-cyan-400 mr-1 font-bold">▶</span>
                                  {res.matchedLabel}
                                  {res.matchedSelector && (
                                    <code className="ml-1.5 text-[9px] font-mono text-cyan-400/80 bg-cyan-950/35 border border-cyan-900/30 px-1 rounded shrink-0">
                                      {res.matchedSelector}
                                    </code>
                                  )}
                                </div>
                              </div>

                              <button
                                onClick={() => {
                                  if (res.matchedSelector && onFocusedSelectorChange) {
                                    onFocusedSelectorChange(res.matchedSelector);
                                  }
                                }}
                                disabled={!res.matchedSelector}
                                className="p-1.5 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 rounded-lg transition-all cursor-pointer disabled:opacity-25"
                                title="在左侧真实表单中对齐闪烁高亮该控件"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {/* 手动纠偏下拉框 */}
                            <div className="flex items-center space-x-1.5 mt-2 pt-2 border-t border-zinc-900/60 text-[11px]">
                              <span className="text-zinc-500 text-[10px] shrink-0 font-sans">选择偏差纠正:</span>
                              <select
                                value={res.matchedSelector}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  const matchedItem = scannedElements.find(s => s.selector === val);
                                  const updated = [...matchedResults];
                                  updated[res.stepIndex] = {
                                    ...updated[res.stepIndex],
                                    matchedSelector: val,
                                    matchedLabel: matchedItem ? matchedItem.label : val,
                                    confidence: 100 // Force manually approved
                                  };
                                  setMatchedResults(updated);
                                }}
                                className="flex-1 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 rounded px-1.5 py-0.5 focus:outline-none text-[10px] font-sans"
                              >
                                <option value="">-- 手动修正为此页面的其他控件 --</option>
                                {scannedElements.map((el) => (
                                  <option key={el.selector} value={el.selector}>
                                    {el.label} ({el.selector})
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 提交至本地数据库 */}
            {matchedResults.length > 0 && (
              <div className="p-3.5 bg-gradient-to-r from-emerald-950/20 to-zinc-950 border border-emerald-900/30 rounded-xl flex flex-col md:flex-row items-center justify-between space-y-3 md:space-y-0 gap-4 shadow-[inset_0_1px_12px_rgba(16,185,129,0.01)] shrink-0">
                <div className="flex items-center space-x-2.5">
                  <div className="p-1.5 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-zinc-100">语义绑定成功编译</h4>
                    <p className="text-[10px] text-zinc-400">已将所有自然语言步骤编译转化为带有标准 CSS Selector 的指引步骤结构。</p>
                  </div>
                </div>
                
                <button
                  onClick={handleApplySemanticGuide}
                  className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold rounded-lg text-xs transition-all cursor-pointer flex items-center space-x-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>一键编译并覆盖激活为当前页面引导流程</span>
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
};
