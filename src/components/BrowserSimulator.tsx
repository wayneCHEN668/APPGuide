/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { Guide, GuideStep, MockPage } from "../types";
import { 
  Globe, 
  RotateCw, 
  ArrowLeft, 
  ArrowRight, 
  Sparkles, 
  HelpCircle, 
  Layers, 
  AlertCircle, 
  CornerDownRight, 
  Check, 
  X, 
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Keyboard
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface BrowserSimulatorProps {
  currentUrl: string;
  onUrlChange: (url: string) => void;
  mockPages: MockPage[];
  activeGuide: Guide | null;
  isGuideActive: boolean;
  setIsGuideActive: (active: boolean) => void;
  focusedSelector: string;
  onFocusedSelectorChange: (selector: string) => void;
  triggerShortcut: () => void;
}

export const BrowserSimulator: React.FC<BrowserSimulatorProps> = ({
  currentUrl,
  onUrlChange,
  mockPages,
  activeGuide,
  isGuideActive,
  setIsGuideActive,
  focusedSelector,
  onFocusedSelectorChange,
  triggerShortcut
}) => {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  
  // Simulated form states
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");

  const pageViewportRef = useRef<HTMLDivElement>(null);
  const [highlightCoords, setHighlightCoords] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  // Active page object
  const activePage = mockPages.find((p) => p.url === currentUrl) || mockPages[0];

  // Sync internal page index when url prop changes
  useEffect(() => {
    const idx = mockPages.findIndex((p) => p.url === currentUrl);
    if (idx !== -1) {
      setCurrentPageIndex(idx);
    }
    // Reset steps and highlight when page changes
    setCurrentStepIndex(0);
    setHighlightCoords(null);
  }, [currentUrl, mockPages]);

  // Handle step index bound when activeGuide changes
  useEffect(() => {
    setCurrentStepIndex(0);
    setHighlightCoords(null);
  }, [activeGuide]);

  // Recalculate coordinates of the currently highlighted element
  const updateHighlightCoords = () => {
    if (!isGuideActive || !activeGuide || !activeGuide.steps[currentStepIndex]) {
      setHighlightCoords(null);
      return;
    }

    const step = activeGuide.steps[currentStepIndex];
    if (!pageViewportRef.current) return;

    // Use querySelector to locate element inside the viewport ref
    const element = pageViewportRef.current.querySelector(step.selector) as HTMLElement;
    if (element) {
      const containerRect = pageViewportRef.current.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();

      setHighlightCoords({
        top: elementRect.top - containerRect.top + pageViewportRef.current.scrollTop,
        left: elementRect.left - containerRect.left + pageViewportRef.current.scrollLeft,
        width: elementRect.width,
        height: elementRect.height
      });
    } else {
      // Element not found
      setHighlightCoords(null);
    }
  };

  // Run calculation on changes
  useEffect(() => {
    updateHighlightCoords();
    
    // Setup resize observer on container to keep highlights positioned correctly
    if (!pageViewportRef.current) return;
    const observer = new ResizeObserver(() => {
      updateHighlightCoords();
    });
    observer.observe(pageViewportRef.current);
    
    return () => {
      observer.disconnect();
    };
  }, [isGuideActive, activeGuide, currentStepIndex, currentUrl]);

  // Handle simulated field focusing
  const handleFieldFocus = (selector: string) => {
    onFocusedSelectorChange(selector);
    
    // Check if focusing this field satisfies the current step action
    if (isGuideActive && activeGuide) {
      const currentStep = activeGuide.steps[currentStepIndex];
      if (currentStep && currentStep.selector === selector && currentStep.actionType === "focus") {
        // Auto advance after brief delay
        setTimeout(() => {
          advanceStep();
        }, 800);
      }
    }
  };

  // Handle simulated field input changes
  const handleFieldChange = (selector: string, value: string) => {
    setFormValues(prev => ({ ...prev, [selector]: value }));
    
    // Check if inputting satisfies current step
    if (isGuideActive && activeGuide) {
      const currentStep = activeGuide.steps[currentStepIndex];
      if (currentStep && currentStep.selector === selector && currentStep.actionType === "input") {
        // We'll let them type, and maybe they can click Next, or we can highlight completeness
      }
    }
  };

  // Handle simulated button clicks
  const handleBtnClick = (selector: string, label: string) => {
    if (isGuideActive && activeGuide) {
      const currentStep = activeGuide.steps[currentStepIndex];
      if (currentStep && currentStep.selector === selector && currentStep.actionType === "click") {
        advanceStep();
      }
    }

    setToastMessage(`成功执行动作："${label}" (通过 ${selector} 触发)`);
    setShowSuccessToast(true);
    setTimeout(() => {
      setShowSuccessToast(false);
    }, 4000);
  };

  const advanceStep = () => {
    if (!activeGuide) return;
    if (currentStepIndex < activeGuide.steps.length - 1) {
      setCurrentStepIndex(prev => prev + 1);
    } else {
      // Completed last step!
      setToastMessage(`恭喜！您已顺利完成 [${activeGuide.title}] 的全部引导流程！`);
      setShowSuccessToast(true);
      setIsGuideActive(false);
      setCurrentStepIndex(0);
      setTimeout(() => {
        setShowSuccessToast(false);
      }, 4000);
    }
  };

  const prevStep = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex(prev => prev - 1);
    }
  };

  // Determine tooltip placement styles
  const getTooltipStyle = () => {
    if (!highlightCoords) {
      // Center in viewport if element is missing
      return {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        position: "absolute" as const,
        zIndex: 50,
        width: "320px"
      };
    }

    const { top, left, width, height } = highlightCoords;
    const step = activeGuide?.steps[currentStepIndex];
    const pos = step?.tipPosition || "bottom";
    const gap = 12;

    switch (pos) {
      case "top":
        return {
          top: `${top - gap}px`,
          left: `${left + width / 2}px`,
          transform: "translate(-50%, -100%)",
          position: "absolute" as const,
          zIndex: 50,
          width: "320px"
        };
      case "bottom":
        return {
          top: `${top + height + gap}px`,
          left: `${left + width / 2}px`,
          transform: "translate(-50%, 0)",
          position: "absolute" as const,
          zIndex: 50,
          width: "320px"
        };
      case "left":
        return {
          top: `${top + height / 2}px`,
          left: `${left - gap}px`,
          transform: "translate(-100%, -50%)",
          position: "absolute" as const,
          zIndex: 50,
          width: "300px"
        };
      case "right":
        return {
          top: `${top + height / 2}px`,
          left: `${left + width + gap}px`,
          transform: "translate(0, -50%)",
          position: "absolute" as const,
          zIndex: 50,
          width: "300px"
        };
      default:
        return {
          top: `${top + height + gap}px`,
          left: `${left + width / 2}px`,
          transform: "translate(-50%, 0)",
          position: "absolute" as const,
          zIndex: 50,
          width: "320px"
        };
    }
  };

  return (
    <div id="browser-simulator-root" className="flex flex-col h-full bg-[#0c0c0e] border border-zinc-800/80 rounded-xl overflow-hidden shadow-[0_10px_30px_rgba(0,0,0,0.6)] glow-cyan-sm">
      {/* 浏览器标题栏 / 头部 */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#09090b] border-b border-zinc-800/80 select-none">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 rounded-full bg-rose-500/80"></div>
          <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
          <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
          <span className="text-xs text-zinc-400 font-medium pl-2 font-sans">企业核心业务网络 (ERP Host)</span>
        </div>

        {/* 浏览器快捷键模拟与激活指示器 */}
        <div className="flex items-center space-x-3">
          <button
            onClick={triggerShortcut}
            title="模拟按下键盘快捷键 Alt + G"
            className="flex items-center space-x-1.5 px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 hover:text-cyan-300 text-zinc-300 rounded text-xs border border-zinc-800 transition-all font-mono shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
          >
            <Keyboard className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>Alt + G</span>
          </button>

          {/* 插件图标模拟 */}
          <button
            onClick={() => setIsGuideActive(!isGuideActive)}
            title={isGuideActive ? "关闭引导悬浮窗" : "开启引导悬浮窗"}
            className={`relative p-1.5 rounded transition-all shadow-[0_2px_8px_rgba(0,0,0,0.4)] ${
              isGuideActive 
                ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-[0_0_12px_rgba(34,211,238,0.3)]" 
                : activeGuide 
                  ? "bg-zinc-900 text-amber-400 hover:text-amber-300 border border-zinc-800" 
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-400 border border-zinc-800"
            }`}
          >
            <Sparkles className={`w-4 h-4 ${isGuideActive ? "animate-spin-slow text-cyan-400" : ""}`} />
            {activeGuide && (
              <span className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full ${isGuideActive ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" : "bg-amber-400 animate-pulse"}`} />
            )}
          </button>
        </div>
      </div>

      {/* 浏览器地址栏栏 */}
      <div className="flex items-center px-4 py-2 bg-[#09090b] border-b border-zinc-800/80 space-x-2">
        <div className="flex space-x-1 text-zinc-500">
          <button 
            disabled={currentPageIndex === 0}
            onClick={() => onUrlChange(mockPages[currentPageIndex - 1].url)}
            className="p-1.5 hover:bg-zinc-800 hover:text-cyan-400 rounded disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button 
            disabled={currentPageIndex === mockPages.length - 1}
            onClick={() => onUrlChange(mockPages[currentPageIndex + 1].url)}
            className="p-1.5 hover:bg-zinc-800 hover:text-cyan-400 rounded disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
          <button className="p-1.5 hover:bg-zinc-800 hover:text-cyan-400 rounded transition-colors">
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* URL 地址框 */}
        <div className="flex-1 flex items-center bg-[#050505] px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-300 text-xs font-mono select-none">
          <Globe className="w-3.5 h-3.5 text-zinc-500 mr-2 shrink-0" />
          <span className="text-zinc-600">https://erp.corp/</span>
          <span className="text-cyan-400 font-bold">{currentUrl}</span>
          <span className="text-zinc-700">?session_token=u9a2x8f&comp=auth</span>
        </div>

        {/* 页面快速切换 */}
        <select
          value={currentUrl}
          onChange={(e) => onUrlChange(e.target.value)}
          className="bg-zinc-900 text-zinc-200 text-xs px-2.5 py-1.5 rounded-lg border border-zinc-800 font-sans focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500 transition-all cursor-pointer"
        >
          {mockPages.map((page) => (
            <option key={page.url} value={page.url} className="bg-zinc-950 text-zinc-200">
              切换：{page.title}
            </option>
          ))}
        </select>
      </div>

      {/* 网页渲染主体区域 */}
      <div 
        ref={pageViewportRef}
        className="flex-1 relative bg-[#050505] p-6 overflow-y-auto select-none"
        style={{ minHeight: "420px" }}
      >
        {/* 企业后台标头 */}
        <div className="mb-6 pb-4 border-b border-zinc-800/60">
          <div className="flex items-center space-x-2 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-1">
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>Enterprise Business Suite v4.8</span>
          </div>
          <h1 className="text-xl font-bold text-zinc-100 font-sans">{activePage.title}</h1>
          <p className="text-xs text-zinc-400 mt-1">{activePage.description}</p>
        </div>

        {/* 表单渲染 */}
        <div className="space-y-4 max-w-xl">
          {activePage.fields.map((field) => (
            <div key={field.id} className="flex flex-col space-y-1.5">
              <label 
                htmlFor={field.id} 
                className="text-xs font-medium text-zinc-300 flex items-center justify-between"
              >
                <span>{field.label}</span>
                <span className="text-[10px] text-zinc-600 font-mono font-normal">
                  SELECTOR: <span className="text-zinc-500 font-bold">{field.selector}</span>
                </span>
              </label>

              {field.type === "select" ? (
                <select
                  id={field.id}
                  value={formValues[field.selector] || field.defaultValue || ""}
                  onFocus={() => handleFieldFocus(field.selector)}
                  onChange={(e) => handleFieldChange(field.selector, e.target.value)}
                  className={`w-full bg-[#0a0a0c] border text-zinc-200 text-sm px-3 py-2 rounded-lg font-sans transition-all focus:outline-none ${
                    focusedSelector === field.selector 
                      ? "border-cyan-500/80 bg-[#0c0c10] ring-2 ring-cyan-950/50 shadow-[0_0_10px_rgba(34,211,238,0.15)]" 
                      : "border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  {field.options?.map((opt) => (
                    <option key={opt} value={opt} className="bg-zinc-950 text-zinc-200">{opt}</option>
                  ))}
                </select>
              ) : field.type === "textarea" ? (
                <textarea
                  id={field.id}
                  rows={3}
                  placeholder={field.placeholder}
                  value={formValues[field.selector] || ""}
                  onFocus={() => handleFieldFocus(field.selector)}
                  onChange={(e) => handleFieldChange(field.selector, e.target.value)}
                  className={`w-full bg-[#0a0a0c] border text-zinc-200 text-sm px-3 py-2 rounded-lg font-sans transition-all focus:outline-none resize-none ${
                    focusedSelector === field.selector 
                      ? "border-cyan-500/80 bg-[#0c0c10] ring-2 ring-cyan-950/50 shadow-[0_0_10px_rgba(34,211,238,0.15)]" 
                      : "border-zinc-800 hover:border-zinc-700"
                  }`}
                />
              ) : field.type === "button" ? (
                <button
                  id={field.id}
                  onClick={() => handleBtnClick(field.selector, field.label)}
                  className="w-full sm:w-auto px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 text-black font-semibold text-sm rounded-lg transition-all shadow-[0_4px_12px_rgba(34,211,238,0.2)] flex items-center justify-center space-x-2 cursor-pointer"
                >
                  <span>{field.label}</span>
                </button>
              ) : (
                <input
                  id={field.id}
                  type={field.type}
                  placeholder={field.placeholder}
                  value={formValues[field.selector] || ""}
                  onFocus={() => handleFieldFocus(field.selector)}
                  onChange={(e) => handleFieldChange(field.selector, e.target.value)}
                  className={`w-full bg-[#0a0a0c] border text-zinc-200 text-sm px-3 py-2 rounded-lg font-sans transition-all focus:outline-none ${
                    focusedSelector === field.selector 
                      ? "border-cyan-500/80 bg-[#0c0c10] ring-2 ring-cyan-950/50 shadow-[0_0_10px_rgba(34,211,238,0.15)]" 
                      : "border-zinc-800 hover:border-zinc-700"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* -------------------- 实时绘制：高亮遮罩/框框 -------------------- */}
        {isGuideActive && highlightCoords && activeGuide && activeGuide.steps[currentStepIndex] && (
          <motion.div
            layoutId="guide-highlight-box"
            className={`absolute pointer-events-none rounded transition-all duration-300 z-40 ${
              activeGuide.steps[currentStepIndex].highlightStyle === "solid"
                ? "guide-highlight-solid"
                : activeGuide.steps[currentStepIndex].highlightStyle === "glow"
                  ? "guide-highlight-glow"
                  : "guide-highlight-pulse"
            }`}
            style={{
              top: `${highlightCoords.top - 4}px`,
              left: `${highlightCoords.left - 4}px`,
              width: `${highlightCoords.width + 8}px`,
              height: `${highlightCoords.height + 8}px`
            }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
          />
        )}

        {/* -------------------- 实时绘制：引导悬浮窗气泡 (React-based Simulator overlay) -------------------- */}
        <AnimatePresence>
          {isGuideActive && activeGuide && (
            <motion.div
              style={getTooltipStyle()}
              className="absolute bg-zinc-950/95 border border-cyan-500/30 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.8)] p-4 flex flex-col space-y-3 z-50 overflow-hidden backdrop-blur"
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.25 }}
            >
              {/* 斑斓的光影效果 */}
              <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/10 rounded-full blur-xl pointer-events-none" />

              {/* 头部：当前指南标题与关闭 */}
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2 select-none relative z-10">
                <div className="flex items-center space-x-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                  <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">
                    流程向导：{activeGuide.title}
                  </span>
                </div>
                <button
                  onClick={() => setIsGuideActive(false)}
                  className="p-1 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* 步骤内容 */}
              <div className="space-y-2 relative z-10">
                {activeGuide.steps[currentStepIndex] ? (
                  <>
                    <h3 className="text-sm font-bold text-zinc-100 flex items-center space-x-1">
                      <span className="text-cyan-400 font-mono text-xs bg-cyan-950/80 px-1.5 py-0.5 rounded border border-cyan-800/40 mr-1.5 shadow-[0_0_8px_rgba(34,211,238,0.1)]">
                        步骤 {currentStepIndex + 1}
                      </span>
                      <span>{activeGuide.steps[currentStepIndex].title}</span>
                    </h3>
                    <p className="text-xs text-zinc-300 leading-relaxed font-sans">
                      {activeGuide.steps[currentStepIndex].description}
                    </p>

                    {/* 目标检测指示器 */}
                    <div className="mt-2.5 pt-2 border-t border-zinc-850 flex items-center justify-between">
                      <span className="text-[10px] text-zinc-500 font-mono">
                        TARGET: <span className="text-zinc-400 font-bold">{activeGuide.steps[currentStepIndex].selector}</span>
                      </span>
                      <div className="flex items-center space-x-1 text-[10px] bg-[#050505] px-2 py-0.5 rounded border border-zinc-800">
                        {focusedSelector === activeGuide.steps[currentStepIndex].selector ? (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                            <span className="text-emerald-400 font-medium">已聚焦此元素</span>
                          </>
                        ) : (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                            <span className="text-zinc-500">等待操作中...</span>
                          </>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="py-4 text-center text-zinc-500 flex flex-col items-center space-y-2">
                    <AlertCircle className="w-8 h-8 text-zinc-600" />
                    <span className="text-xs font-medium">本指南中暂无步骤</span>
                  </div>
                )}
              </div>

              {/* 底部导航 */}
              {activeGuide.steps.length > 0 && (
                <div className="flex items-center justify-between border-t border-zinc-800 pt-2.5 select-none relative z-10">
                  <span className="text-[10px] text-zinc-500 font-mono">
                    进度: {currentStepIndex + 1} / {activeGuide.steps.length}
                  </span>
                  
                  <div className="flex space-x-1.5">
                    <button
                      disabled={currentStepIndex === 0}
                      onClick={prevStep}
                      className="p-1 px-2.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-zinc-300 text-xs rounded border border-zinc-800 flex items-center space-x-1 transition-colors"
                    >
                      <ChevronLeft className="w-3 h-3" />
                      <span>上一步</span>
                    </button>
                    
                    <button
                      onClick={advanceStep}
                      className="p-1 px-2.5 bg-cyan-600 hover:bg-cyan-500 text-black text-xs font-semibold rounded flex items-center space-x-1 transition-all shadow-[0_2px_8px_rgba(34,211,238,0.25)] cursor-pointer"
                    >
                      <span>
                        {currentStepIndex === activeGuide.steps.length - 1 ? "完成流程" : "下一步"}
                      </span>
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* -------------------- 引导关闭状态下的操作提示 -------------------- */}
        {!isGuideActive && activeGuide && (
          <div className="absolute bottom-4 right-4 bg-zinc-950/95 border border-zinc-800 text-zinc-300 px-4 py-2.5 rounded-xl shadow-2xl flex items-center space-x-3 max-w-sm backdrop-blur select-none z-30 glow-cyan-sm">
            <div className="p-1.5 bg-cyan-500/10 rounded border border-cyan-500/20">
              <Sparkles className="w-4 h-4 text-cyan-400 animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-zinc-100 truncate">已加载业务指南</p>
              <p className="text-[10px] text-zinc-400 truncate">按 <span className="font-mono bg-zinc-900 px-1 py-0.2 rounded text-cyan-400 font-bold border border-zinc-800">Alt+G</span> 键开启步骤引导</p>
            </div>
            <button
              onClick={() => setIsGuideActive(true)}
              className="px-2.5 py-1 bg-cyan-600 hover:bg-cyan-500 text-black text-[11px] font-semibold rounded-lg transition-colors cursor-pointer"
            >
              开启
            </button>
          </div>
        )}

        {/* 提示无可用指南 */}
        {!activeGuide && (
          <div className="absolute bottom-4 right-4 bg-zinc-950/95 border border-zinc-800 text-zinc-300 px-4 py-2.5 rounded-xl shadow-2xl flex items-center space-x-3 max-w-sm backdrop-blur select-none z-30 glow-cyan-sm">
            <div className="p-1.5 bg-zinc-900 rounded border border-zinc-800">
              <HelpCircle className="w-4 h-4 text-zinc-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-zinc-100">当前页面无操作指南</p>
              <p className="text-[10px] text-zinc-400">请在右侧控制台为该 URL 创建一个步骤指南</p>
            </div>
          </div>
        )}

        {/* -------------------- 操作成功气泡 Toast -------------------- */}
        <AnimatePresence>
          {showSuccessToast && (
            <motion.div
              initial={{ opacity: 0, y: 20, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: -20, x: "-50%" }}
              className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-emerald-950/90 border border-emerald-500/50 px-4 py-2.5 rounded-xl shadow-[0_10px_30px_rgba(16,185,129,0.3)] flex items-center space-x-2.5 max-w-md backdrop-blur text-white z-50 font-sans"
            >
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
              <span className="text-xs font-medium">{toastMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* 浏览器底部状态栏 */}
      <div className="px-4 py-2 bg-[#09090b] border-t border-zinc-800/80 select-none flex items-center justify-between text-[11px] text-zinc-500 font-mono">
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
            <span className="text-zinc-400">模拟端点正常</span>
          </div>
          <span className="text-zinc-800">|</span>
          <span>当前焦点: <span className="text-cyan-400 font-semibold">{focusedSelector || "无 (点击输入框触发)"}</span></span>
        </div>
        <div className="text-zinc-600">
          SECURE CONNECTION (SSL)
        </div>
      </div>
    </div>
  );
};
