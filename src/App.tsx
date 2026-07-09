/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from "react";
import { Guide, MockPage } from "./types";
import { MOCK_PAGES } from "./mockPages";
import { BrowserSimulator } from "./components/BrowserSimulator";
import { DevCenter } from "./components/DevCenter";
import { 
  Sparkles, 
  HelpCircle, 
  Globe, 
  Settings, 
  BookOpen, 
  Play, 
  Check, 
  Code,
  FileCode2,
  FileText,
  AlertCircle
} from "lucide-react";

export default function App() {
  const [currentUrl, setCurrentUrl] = useState<string>("/erp/loans/apply");
  const [activeGuide, setActiveGuide] = useState<Guide | null>(null);
  const [isGuideActive, setIsGuideActive] = useState<boolean>(true); // Active by default for optimal preview
  const [focusedSelector, setFocusedSelector] = useState<string>("");
  const [isLoadingGuide, setIsLoadingGuide] = useState<boolean>(false);

  // Load guide from server API
  const fetchGuideForUrl = async (urlPath: string) => {
    setIsLoadingGuide(true);
    try {
      const response = await fetch(`/api/guide?url=${encodeURIComponent(urlPath)}`);
      const data = await response.json();
      if (data.success && data.guide) {
        setActiveGuide(data.guide);
      } else {
        setActiveGuide(null);
      }
    } catch (e) {
      console.error("Failed to fetch guide from API endpoint:", e);
      setActiveGuide(null);
    } finally {
      setIsLoadingGuide(false);
    }
  };

  // Initial load and URL sync
  useEffect(() => {
    fetchGuideForUrl(currentUrl);
    // Reset focus whenever page switches
    setFocusedSelector("");
  }, [currentUrl]);

  // Handle actual keyboard shortcut Alt+G (to make the simulator completely immersive!)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Check for Alt+G (or Alt+g)
      if (e.altKey && (e.key === "g" || e.key === "G" || e.key === "9")) {
        e.preventDefault();
        triggerShortcutToggle();
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
    };
  }, [isGuideActive, activeGuide]);

  const triggerShortcutToggle = () => {
    if (!activeGuide) {
      alert("💡 当前页面暂无步骤指南。请先在右侧控制台配置或通过 AI 智能生成指南！");
      return;
    }
    setIsGuideActive(prev => !prev);
  };

  const handleGuideSaved = (updatedGuide: Guide) => {
    // Sync the local active state immediately with saved data
    setActiveGuide(updatedGuide);
    setIsGuideActive(true);
  };

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 flex flex-col font-sans select-none antialiased selection:bg-cyan-500/20 selection:text-cyan-300">
      {/* 顶部标头栏 (Humble, professional, literal - styled in Immersive theme) */}
      <header className="px-6 py-4 bg-[#09090b] border-b border-zinc-800/60 flex items-center justify-between shrink-0 select-none shadow-[0_4px_20px_rgba(0,0,0,0.4)]">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-cyan-500/10 rounded-xl border border-cyan-500/30 shadow-[0_0_15px_rgba(34,211,238,0.15)]">
            <Sparkles className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-base font-bold text-zinc-100 tracking-tight flex items-center space-x-2">
              <span className="bg-gradient-to-r from-zinc-100 via-zinc-200 to-cyan-400 bg-clip-text text-transparent">业务系统引导插件开发套件</span>
              <span className="text-[10px] font-mono font-normal bg-zinc-900 border border-zinc-800 text-cyan-400 px-1.5 py-0.5 rounded shadow-[0_0_10px_rgba(34,211,238,0.05)]">
                Guide DevKit v1.0
              </span>
            </h1>
            <p className="text-xs text-zinc-400">服务于复杂行业系统的轻量级步骤高亮指引及 API 联动解决方案</p>
          </div>
        </div>

        {/* 核心亮点 */}
        <div className="hidden lg:flex items-center space-x-4 text-xs font-mono text-zinc-500">
          <div className="flex items-center space-x-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
            <span>实时焦点抓取</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
            <span>无污染 DOM 气泡</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" />
            <span>API 步骤热加载</span>
          </div>
        </div>
      </header>

      {/* 主界面分栏 */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-5 gap-6 overflow-hidden min-h-0 bg-radial from-[#0c0c0e] to-[#050505]">
        
        {/* 左侧：浏览器仿真与引导浮窗 (佔比 3/5) */}
        <section className="lg:col-span-3 flex flex-col h-full space-y-4">
          <div className="flex items-center justify-between shrink-0 select-none">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 font-sans flex items-center space-x-2">
              <span className="w-1.5 h-3 bg-cyan-500 rounded-sm inline-block"></span>
              <span>1. 业务端点模拟运行沙箱 (Simulator Box)</span>
            </span>
            <div className="text-[11px] text-zinc-500 flex items-center space-x-1">
              <span className="font-mono bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-800 text-cyan-400 font-bold shadow-[0_0_8px_rgba(34,211,238,0.05)]">
                Alt+G
              </span>
              <span>即可呼出悬浮球</span>
            </div>
          </div>

          <div className="flex-1 min-h-[450px]">
            <BrowserSimulator
              currentUrl={currentUrl}
              onUrlChange={setCurrentUrl}
              mockPages={MOCK_PAGES}
              activeGuide={activeGuide}
              isGuideActive={isGuideActive}
              setIsGuideActive={setIsGuideActive}
              focusedSelector={focusedSelector}
              onFocusedSelectorChange={setFocusedSelector}
              triggerShortcut={triggerShortcutToggle}
            />
          </div>
        </section>

        {/* 右侧：API 设计、AI 灵感、以及 Chrome 插件导出 (佔比 2/5) */}
        <section className="lg:col-span-2 flex flex-col h-full space-y-4">
          <div className="flex items-center justify-between shrink-0 select-none">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 font-sans flex items-center space-x-2">
              <span className="w-1.5 h-3 bg-violet-500 rounded-sm inline-block"></span>
              <span>2. 本地决策控制台 (API Dashboard)</span>
            </span>
            <span className="text-[11px] text-zinc-500">
              数据源: <code className="text-cyan-400 bg-zinc-900 px-1 py-0.2 rounded text-[10px] border border-zinc-800">express-sqlite</code>
            </span>
          </div>

          <div className="flex-1 min-h-[450px]">
            <DevCenter
              currentUrl={currentUrl}
              activeGuide={activeGuide}
              onGuideSaved={handleGuideSaved}
              mockPages={MOCK_PAGES}
              onRefresh={() => fetchGuideForUrl(currentUrl)}
              isLoadingGuide={isLoadingGuide}
              focusedSelector={focusedSelector}
              onFocusedSelectorChange={setFocusedSelector}
            />
          </div>
        </section>

      </main>

      {/* 页脚简要说明 */}
      <footer className="px-6 py-3 bg-[#09090b] border-t border-zinc-900 text-center select-none shrink-0 text-zinc-500">
        <p className="text-[11px] font-sans leading-relaxed">
          业务引导套件使用须知：仿真器内部使用 <code className="text-zinc-400">MutationObserver</code> 配合绝对坐标实时重绘高亮框以保持流畅体验。
          导出的代码完全支持 <span className="text-cyan-400">Chrome Extension Manifest V3</span> 机制。
        </p>
      </footer>
    </div>
  );
}
