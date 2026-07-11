# APPGuide 系统功能全景说明

> 面向：银行/ERP等复杂业务系统的实时操作引导 + 合规提示
> 更新时间：本次对话截止（含跨页流程改造）

---

## 一、系统定位

APPGuide 把"专家操作知识"编码成结构化 JSON（哪一步、点哪个控件、提示什么文案），再通过一个 Chrome 插件在真实业务系统页面上**实时高亮+浮窗提示**，引导操作员按合规步骤完成任务。核心卖点是"零代码接入"——不需要改造目标业务系统一行代码，指南靠插件在页面上动态匹配控件来实现。

---

## 二、四大组成部分

### 1. Guide DevKit（`src/`，React19 + Vite6 + Tailwind4）
面向指南编写者的可视化工作台，本次改造未涉及，包含三个组件：
- **BrowserSimulator.tsx**：模拟业务页面沙箱，用来预览高亮效果
- **DevCenter.tsx**：控制台主体，支持可视化编辑/JSON编辑/AI生成/导出/语义调试五个 Tab
- **ExtensionExporter.tsx**：一键把编辑好的指南打包导出成 Chrome 插件

### 2. 后端 API
- **`server.ts`**（端口3000，Express+Vite中间件）：完整 CRUD + 调用 Gemini 自动生成指南文案，服务于 DevKit 编辑场景
- **`guide_server.ts`**（端口3010，本次重写）：**生产环境实际对接插件的轻量端点**，职责是"给定当前页面 URL（+可选的进行中流程ID），判定应该返回哪个流程、哪一页、进度到第几步"

### 3. Chrome 插件（Manifest V3，`plugin/`）
真正跑在用户浏览器里、渲染高亮和提示气泡的部分，由三个文件构成：
- **`content.js`**：注入到目标页面的主逻辑（本次重写核心）
- **`background.js`**：Service Worker，代理 API 请求（绕过 Mixed Content 限制）+ 处理全局快捷键
- **`content.css`**：气泡/高亮/候选列表的视觉样式

### 4. 数据模型
- **`types.ts`**：DevKit 用的类型定义（`Guide`/`GuideStep`/`BusinessField`/`MockPage`）
- **`api/flows/*.json`**：本次新增，模拟"多条DB记录"，每条记录 = 一个完整业务流程（含多个页面）

---

## 三、核心能力一：本地语义匹配引擎（原有能力，未改动）

这是插件最初就有的"零代码自适应"能力，位于 `content.js`：

1. **三级匹配策略**，依次尝试，命中即返回：
   - 策略1：步骤标题关键词 ⊂ 控件文本（或反之），置信度最高（0.90+）
   - 策略2：标题与控件文本的字符集重叠度 ≥ 50%
   - 策略3：TF-IDF 余弦相似度兜底（标题权重×3 + 描述权重×1），中文按字符一元/二元分词，英文按单词分词
2. **DOM扫描**（`scanDOM`）：抓取页面所有可交互控件（input/select/button/a/自定义`div.btn`等），为每个控件推导出可读的"标签文本"（`label`标签 / Element Plus的`.selectLabel`兄弟节点 / 自身文本 / 父容器文本）
3. **目标升级**：匹配到零尺寸的隐藏 input（比如文件上传控件）或 Element Plus 的 `.el-select` 内部 input 时，自动把高亮目标升级到可见的父容器
4. **精确Selector优先**：如果指南JSON本身写死了 `selector`，直接用；只有查询失败或没配置时才启动语义匹配兜底

**触发方式**：`Alt+G` 快捷键，或点击插件图标后台转发的命令。

---

## 四、核心能力二：跨页多步骤流程（本次改造新增）

### 4.1 要解决的问题
原来"URL一变，引导就消失"——因为所有状态（`activeGuide`/`currentStepIndex`/`isGuideActive`）都是 `content.js` 闭包里的内存变量，页面一跳转，脚本被销毁重注入，状态归零。一个横跨2个URL、10个步骤的业务流程，走到第6步换页就断了。

### 4.2 数据模型：Flow（流程）
一条 DB 记录（本次用 `api/flows/*.json` 模拟）就是一个完整流程：

```
{
  id, class, subclass, title,
  starturl,                    // 流程入口页
  pages: [
    { url, title, description, steps: [...] },  // 第1页
    { url, title, description, steps: [...] },  // 第2页
    ...
  ]
}
```

`pageIndex`、每步的 `localIndex`、贯穿全流程的 `globalStepNumber` 都是 **`guide_server.ts` 在读取时动态计算**的，不需要在存储层维护顺序字段——`pages`数组本身的顺序就是业务顺序。

### 4.3 判定链路（`guide_server.ts` 的 `/api/guide` 接口）

请求：`GET /api/guide?url=<当前页pathname>&flowId=<可选,进行中流程id>`

```
分支A（flowId存在）：在该flow的pages里找当前url
  ├─ 匹配到 → mode:"resume"，返回该页steps+全局步数信息
  └─ 没匹配到 → 静默掉入分支B（不清空任何东西，只是这次请求走B的逻辑）

分支B（按starturl匹配所有记录）：
  ├─ 0条 → success:false, "没有找到相应引导指南。"
  ├─ 1条 → mode:"new"，初始化并返回第1页
  └─ 多条 → mode:"choose"，返回候选列表(flowId+title+description)，不做偏好记忆，每次都问
```

### 4.4 客户端：被动型自动续接（`content.js`）

- **运行时状态**只存 3 个字段在 `chrome.storage.local`：`{flowId, globalStepNumber, lastActiveAt}`（`globalStepNumber` 语义是"下一步应该显示第几步"）
- **TTL**：2小时不活跃自动判定放弃，读取时顺手清空，不影响正常使用
- **页面加载时**：静默检查 storage 里有没有未过期的流程状态，有就自动请求当前URL+该flowId；**只有服务端返回 `resume` 才自动渲染**，其余情况（用户其实是在逛无关页面）一律安静不打扰，也不清空已存状态（容错临时切走的场景）
- **续接精度**：靠 `globalStepNumber - 该页的globalStepOffset - 1` 换算出应该显示这一页的第几步，同时兼容"同页刷新"和"真正跳到下一页"两种场景，测试验证过没有偏移误差
- **翻页判定**：`advanceStep()` 区分三种情况——
  1. 本页内还有下一步 → 正常前进
  2. 本页最后一步，但流程还有后续页 → 存进度、收起UI、提示"请前往下一步骤对应页面"，等真实跳转发生后被动续接接上
  3. 本页最后一步 = 整个流程最后一步 → 提示完成、清空所有状态
- **多候选UI**：同一起始页对应多个流程时，弹出可点击列表，用户选完直接用选中的flowId重新拉取
- **手动退出**：点气泡右上角 × 号，无论流程进行到哪，立即清空 storage 里的流程状态（不会下次打开又莫名续接）

### 4.5 已知限制（有意为之，未来可扩展）
- "上一步"按钮只在本页内回退，不支持跨页回退到上一页最后一步
- 半路直接打开流程中间某一页（不从 `starturl` 进入）不会触发引导——这个约束反而符合"合规引导"产品本身想倒逼用户走标准入口的意图
- 多候选场景不记忆用户偏好，每次都问

---

## 五、Chrome插件基础设施

- **Manifest V3**，权限仅 `activeTab` + `storage`，`host_permissions` 限定在配置的API地址（本地3010 / 生产`81.69.17.148:3010`）
- **快捷键**：`Alt+G` 呼出/关闭
- **Mixed Content 绕过**：`content.js` 不直接fetch，而是通过 `chrome.runtime.sendMessage` 转发给 `background.js` 用扩展自身origin发起请求
- **API地址可配置**：存在 `chrome.storage.local` 的 `apiBaseUrl`，插件popup页面可改

---

## 六、本次改造的验证方式

写了一个 jsdom 集成测试（`test_content.mjs`），**直接加载真实的 `content.js` 源码**跑在模拟的 chrome/DOM 环境里（不是重新实现一遍逻辑去测），覆盖：
- 无进行中流程时页面加载保持安静
- 分支B单条命中 → 正确渲染 + 进度/按钮文案
- 跨页续接的步数换算精度（最容易出 off-by-one 的地方）
- 流程完成后状态清空
- 多候选选择 UI 与选择后的初始化
- 手动关闭清空状态
- 完全未命中时不渲染

15项断言全部通过。

---

## 七、目前的数据流全景图（文字版）

```
用户打开业务系统页面
        ↓
content.js 注入 → 静默检查storage有没有进行中的flow
        ↓（有,且未过期）                    ↓（没有）
  自动请求 /api/guide                  什么都不做,等用户按Alt+G
  (带flowId)                                  ↓
        ↓                              用户按Alt+G → enableGuide()
  mode=resume? ──否(静默)                      ↓
        ↓是                             请求 /api/guide (可能带flowId)
  自动渲染,续接到正确步骤                        ↓
                                    guide_server.ts 分支A/B判定
                                          ↓
                            resume / new / choose / not_found
                                          ↓
                          content.js 渲染气泡+高亮 / 弹候选 / toast提示
                                          ↓
                    用户点"下一步" → advanceStep() → 存globalStepNumber到storage
                                          ↓
                          本页未完/本页完但流程未完/全部完成 三选一处理
```

---

需要我把这份文档也整理成给业务方/领导看的PPT或Word版本吗？还是这份Markdown现在这个技术向的详细程度就够用？
