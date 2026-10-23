import "dotenv/config";
import express from "express";
import * as mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { Readable } from "stream";

const app = express();
const PORT = 3010;

// ============================================================
// RPA 桥（③）—— 插件只连智导服务端；智导服务端持 API_KEY 代理到
// guidedatamanager，后者独家持 RPA_INTERNAL_TOKEN。RPA 令牌永不进浏览器。
//   RPA_BRIDGE_BASE_URL   guidedatamanager 基址（本机 http://127.0.0.1:3333）
//   RPA_BRIDGE_API_KEY    = guidedatamanager 的 API_KEY（走 X-API-Key）
//   RPA_BRIDGE_TIMEOUT_MS 代理超时，缺省 30s
// 二者缺一即视为「桥未配置」，4 个 appguide.rpa.* method 直接 503。
// ============================================================
const RPA_BRIDGE_BASE_URL = String(process.env.RPA_BRIDGE_BASE_URL || "").replace(/\/+$/, "");
const RPA_BRIDGE_API_KEY = String(process.env.RPA_BRIDGE_API_KEY || "");
const RPA_BRIDGE_TIMEOUT_MS = Number(process.env.RPA_BRIDGE_TIMEOUT_MS || 30000);

// 解析 JSON 请求体
app.use(express.json());

// ============================================================
// 数据类型
// ============================================================

interface RawStep {
  title: string;
  description: string;
  selector?: string;
  actionType?: string;
  tipPosition?: string;
  highlightStyle?: string;
}

interface RawPage {
  url: string;
  title: string;
  description: string;
  steps: RawStep[];
}

interface FlowRecord {
  id: string;
  class?: string;
  subclass?: string;
  title: string;
  starturl: string;
  approval: 0 | 1;
  pages: RawPage[];
  // RPA 能力展示列（appguide 表）——老库/本地 JSON 没有则为 undefined。
  // 只用于 by-pattern 下发给插件，决定是否渲染 RPA 图标。
  rpa_ready?: number | boolean;
  rpa_script_stale?: number | boolean;
}

// ============================================================
// 数据访问层
// steps 列（JSON类型）中存储了 title 和 pages，映射为 FlowRecord。
// /api/guide 使用 loadFlowById / loadFlowsByStarturl 按需查询。
// ============================================================

const SKIP_DB = process.env.SKIP_DB === "true";
if (SKIP_DB) {
  console.warn("[guide-server] SKIP_DB=true，所有流程数据将从本地文件 api/flows/*.json 加载，数据库不会被连接。");
}

const pool = SKIP_DB
  ? null
  : mysql.createPool({
      host: process.env.DB_HOST || "81.69.17.148",
      port: parseInt(process.env.DB_PORT || "3306", 10),
      database: process.env.DB_DATABASE || "wuzi",
      user: process.env.DB_USERNAME || "webapp_user",
      password: process.env.DB_PASSWORD || "StrongPass123!",
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 4000,
    });

// approval 列：1=已审核，0/NULL/字段缺失=未审核。DB 可能回 number 也可能回 string，
// 本地 api/flows/*.json 则根本没这一列，统一归一化成 0 | 1 再往外发。
function toApproval(v: unknown): 0 | 1 {
  return Number(v) === 1 ? 1 : 0;
}

function loadAllFlowsFromFiles(): FlowRecord[] {
  const flowsDir = path.resolve("api/flows");
  const files = fs.readdirSync(flowsDir).filter((f: string) => f.endsWith(".json"));
  return files.map((f: string) => {
    const raw = JSON.parse(fs.readFileSync(path.join(flowsDir, f), "utf-8"));
    if (!raw.id) raw.id = path.basename(f, ".json");
    raw.approval = toApproval(raw.approval);
    return raw as FlowRecord;
  });
}

async function loadFlowById(id: string): Promise<FlowRecord | null> {
  if (SKIP_DB || !pool) return null;
  try {
    const [rows] = await pool.query(
      "SELECT id, class, subclass, starturl, steps, approval FROM appguide WHERE id = ?",
      [id]
    );
    if ((rows as any[]).length === 0) return null;
    const row = (rows as any[])[0];
    const stepsData = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
    return {
      id: row.id,
      class: row.class || "",
      subclass: row.subclass || "",
      title: row.title || stepsData.title || "",
      starturl: row.starturl,
      approval: toApproval(row.approval),
      pages: stepsData.pages || [],
    } as FlowRecord;
  } catch (err) {
    console.warn("[guide_server] loadFlowById DB 不可用:", (err as Error).message);
    return null;
  }
}

async function loadFlowsByStarturl(rawUrl: string): Promise<FlowRecord[] | null> {
  if (SKIP_DB || !pool) return null;
  try {
    const host = normalizeHost(rawUrl);
    // SQL层只用域名做粗筛，缩小从DB传回来的候选数量——这一步纯粹是性能优化，
    // 不承担正确性：哪怕粗筛进来了域名相同但路径结构不同的记录，下面urlsMatch()
    // 那层精确过滤（含动态ID识别）会正确排除掉。真正的"能不能算同一个页面"
    // 这种需要逐段判断的逻辑，SQL的LIKE做不了，只能在JS里做。
    const [rows] = await pool.query(
      "SELECT id, class, subclass, title, starturl, steps, approval FROM appguide WHERE starturl LIKE ?",
      [`%${host}%`]
    );
    const flows = (rows as any[]).map((row) => {
      const stepsData = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
      return {
        id: row.id,
        class: row.class || "",
        subclass: row.subclass || "",
        title: row.title || stepsData.title || "",
        starturl: row.starturl,
        approval: toApproval(row.approval),
        pages: stepsData.pages || [],
      } as FlowRecord;
    });
    return flows.filter((f) => urlsMatch(f.starturl, rawUrl));
  } catch (err) {
    console.warn("[guide_server] loadFlowsByStarturl DB 不可用:", (err as Error).message);
    return null;
  }
}

// ============================================================
// URL 匹配：不能再用简单的字符串相等或"包含"判断了——
// 数据库里的 starturl 是从某一次真实访问里截下来的完整URL，路径里可能带着
// 会话ID/对话ID这类每次都不一样的动态片段（比如 kimi.com/chat/cou7r1qInI9eq53jqdd0），
// 别的用户访问同一个功能页时这个ID必然不同，但页面本质上是"同一个页面"。
//
// 处理思路：host单独归一化比较（顺带解决 www. 有无不一致的问题）；
// 路径按 "/" 分段，段数必须相等，每一段要么完全相同、要么两边都"长得像动态ID"才放行——
// 不能用简单的字符串包含判断，那样太松，会把结构完全不同的页面也误判成同一个。
// ============================================================

// 统一、安全地解析URL——特别处理"没有协议头"的情况。
// content.js 发过来的url经过 getCleanPath() 处理，协议头(https://)已经被strip掉了，
// 格式类似 "kimi.com/chat/xxx"。如果直接丢给 new URL(rawUrl, base) 解析，
// 因为字符串本身不像一个"绝对URL"（没有 scheme），会被当成"相对路径"去拼接base，
// 得到类似 "http://placeholder.local/kimi.com/chat/xxx" 这种域名被错误折进path里的结果——
// host比较会直接失效。这里统一在解析前补上协议头，确保域名总是被正确识别。
function parseUrlSafely(rawUrl: string): URL {
  const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  try {
    return new URL(withScheme);
  } catch {
    // 极端情况下（比如rawUrl本身就不是合法URL格式）兜底返回一个空白URL，
    // 让上层的host/path都是空值，自然匹配不上任何记录，不会抛错崩掉整个请求。
    return new URL("https://invalid.invalid");
  }
}

function normalizeHost(rawUrl: string): string {
  try {
    return parseUrlSafely(rawUrl).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizePathSegments(rawUrl: string): string[] {
  try {
    return parseUrlSafely(rawUrl).pathname.split("/").filter(Boolean);
  } catch {
    return rawUrl.split("/").filter(Boolean);
  }
}

// 判断一段路径是不是"看起来像动态生成的ID"，不是就当作普通静态路径词处理。
// 规则都是经验性的，业务URL分布不一样可能需要调阈值：
// - 长度够长(>=8)且字母数字混排：典型的会话ID/token长相
// - 纯数字且位数够多(>=6位)：典型的自增主键/时间戳类ID
// - 标准UUID格式(8-4-4-4-12的十六进制)
function looksLikeDynamicId(segment: string): boolean {
  if (!segment) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^\d{6,}$/.test(segment)) return true;
  if (segment.length >= 8 && /[a-zA-Z]/.test(segment) && /[0-9]/.test(segment)) return true;
  return false;
}

// 两个URL是否指向"同一个页面"：host归一化后必须相等；路径分段数必须相等；
// 每一段要么原文完全相同，要么两边都长得像动态ID（这种情况下视为等价，跳过精确比较）。
function urlsMatch(rawUrlA: string, rawUrlB: string): boolean {
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
// ============================================================
// 核心：在指定flow内，用pathname匹配某一页，并算出
// pageIndex / globalStepNumber(每一步) / totalSteps
// ============================================================

interface ResolvedPage {
  flowId: string;
  flowTitle: string;
  approval: 0 | 1;
  pageIndex: number;
  totalPages: number;
  globalStepOffset: number; // 该页第一步之前，已经过去的步数
  totalSteps: number; // 整个flow的步数总和
  page: {
    url: string;
    title: string;
    description: string;
    steps: Array<RawStep & { localIndex: number; globalStepNumber: number }>;
  };
}

function resolvePageInFlow(flow: FlowRecord, rawUrl: string): ResolvedPage | null {
  let pageIndex = flow.pages.findIndex((p) => urlsMatch(p.url, rawUrl));

  // 兜底：pages[].url 里没找到，但当前url其实就是这个flow的starturl——
  // 说明用户是从这个流程的入口进来的，理应对应pages[0]，
  // 只是starturl字段和pages[0].url字段的字符串写法有细微出入（多余斜杠/大小写等）。
  // 这个兜底尤其重要：用户在"多候选"弹窗里选中某个流程后，插件会带着选中的flowId
  // 重新请求同一个url；如果这里不兜底，一旦两个字段没有严格一致，
  // 就会匹配失败、重新掉回分支B、又弹出一模一样的候选列表，表现成"点击没反应"。
  if (pageIndex === -1 && flow.pages.length > 0 && urlsMatch(flow.starturl, rawUrl)) {
    pageIndex = 0;
  }

  if (pageIndex === -1) return null;

  let globalStepOffset = 0;
  for (let i = 0; i < pageIndex; i++) {
    globalStepOffset += flow.pages[i].steps.length;
  }
  const totalSteps = flow.pages.reduce((sum, p) => sum + p.steps.length, 0);

  const page = flow.pages[pageIndex];
  const steps = page.steps.map((s, localIndex) => ({
    ...s,
    localIndex,
    globalStepNumber: globalStepOffset + localIndex + 1,
  }));

  return {
    flowId: flow.id,
    flowTitle: flow.title,
    approval: flow.approval,
    pageIndex,
    totalPages: flow.pages.length,
    globalStepOffset,
    totalSteps,
    page: {
      url: page.url,
      title: page.title,
      description: page.description,
      steps,
    },
  };
}

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// 预检请求直接 204（新增 POST /rest 后，插件后台会先发 OPTIONS）
app.options("*", (_req, res) => res.sendStatus(204));

// ============================================================
// GET /api/guide?url=<当前pathname>&flowId=<可选,客户端storage里正在进行的flowId>
//
// 分支A：flowId 存在 → 先尝试在该flow内匹配当前url
//   - 匹配到 → mode: "resume"，正常续接
//   - 没匹配到 → 静默掉入分支B（不对分支A的flowId做任何清空处理，
//     那是客户端storage的职责，服务端这次请求只是不返回resume结果）
//
// 分支B：按 starturl 匹配所有记录
//   - 0条 → success:false, reason:"not_found"
//   - 1条 → mode:"new"，直接初始化
//   - 多条 → mode:"choose"，返回候选列表，不做偏好记忆
// ============================================================

app.get("/api/guide", async (req, res) => {
  try {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
    const inProgressFlowId = typeof req.query.flowId === "string" ? req.query.flowId : "";

    if (!rawUrl) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 url 参数。" });
      return;
    }

    // 实际匹配统一走 urlsMatch(rawUrl, ...)，不再需要单独维护一个pathname变量

    // 分支A：有进行中的 flowId，按主键查询该条记录
    if (inProgressFlowId) {
      let currentFlow = await loadFlowById(inProgressFlowId);
      // DB 不可用时回退本地文件
      if (currentFlow === null) {
        const fileFlows = loadAllFlowsFromFiles();
        currentFlow = fileFlows.find((f) => f.id === inProgressFlowId) || null;
      }
      if (currentFlow) {
        const resolved = resolvePageInFlow(currentFlow, rawUrl);
        if (resolved) {
          res.json({ success: true, mode: "resume", ...resolved });
          return;
        }
      }
      // 没匹配到，不 return，继续往下走分支B
    }

    // 分支B：按 starturl 匹配（host归一化 + 路径动态ID识别）
    let candidates = await loadFlowsByStarturl(rawUrl);
    // DB 不可用时回退本地文件
    if (candidates === null) {
      candidates = loadAllFlowsFromFiles().filter((f) => urlsMatch(f.starturl, rawUrl));
    }

    if (candidates.length === 0) {
      res.json({ success: false, reason: "not_found", message: "没有找到相应引导指南。" });
      return;
    }

    if (candidates.length > 1) {
      res.json({
        success: true,
        mode: "choose",
        candidates: candidates.map((f) => ({
          flowId: f.id,
          title: f.title,
          description: f.pages[0]?.description ?? "",
          approval: f.approval,
        })),
      });
      return;
    }

    // 命中1条
    const resolved = resolvePageInFlow(candidates[0], rawUrl);
    if (!resolved) {
      // 理论上 starturl 应当等于 pages[0].url，这里做个兜底
      res.json({ success: false, reason: "not_found", message: "没有找到相应引导指南。" });
      return;
    }
    res.json({ success: true, mode: "new", ...resolved });
  } catch (err) {
    console.error("[guide_server] /api/guide 处理出错:", err);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端处理引导数据时出错。" });
  }
});

// ============================================================
// GET /api/flows/by-starturl?starturl=<url>
// 通过 starturl 获取所有匹配记录（可能多条），返回全部字段
// ============================================================

app.get("/api/flows/by-starturl", async (req, res) => {
  try {
    const starturl = typeof req.query.starturl === "string" ? req.query.starturl : "";
    if (!starturl) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 starturl 参数。" });
      return;
    }
    if (SKIP_DB || !pool) {
      res.status(503).json({ success: false, reason: "db_unavailable", message: "数据库未连接，请使用 /api/guide 端点。" });
      return;
    }
    const [rows] = await pool.query("SELECT * FROM appguide WHERE starturl LIKE ?", [starturl]);
    const results = (rows as any[]).map((row) => ({
      id: row.id,
      class: row.class,
      subclass: row.subclass,
      starturl: row.starturl,
      steps: typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps,
      updated_date: row.updated_date,
    }));
    res.json({ success: true, data: results });
  } catch (err) {
    console.error("[guide_server] /api/flows/by-starturl 处理出错:", err);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端查询数据时出错。" });
  }
});

// ============================================================
// GET /api/flows/by-id?id=<uuid>
// 通过 id 获取唯一记录，返回全部字段；未找到则 404
// ============================================================

app.get("/api/flows/by-id", async (req, res) => {
  try {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (!id) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 id 参数。" });
      return;
    }
    if (SKIP_DB || !pool) {
      res.status(503).json({ success: false, reason: "db_unavailable", message: "数据库未连接，请使用 /api/guide 端点。" });
      return;
    }
    const [rows] = await pool.query("SELECT * FROM appguide WHERE id = ?", [id]);
    const row = (rows as any[])[0];
    if (!row) {
      res.status(404).json({ success: false, reason: "not_found", message: "未找到指定 ID 的记录。" });
      return;
    }
    res.json({
      success: true,
      data: {
        id: row.id,
        class: row.class,
        subclass: row.subclass,
        starturl: row.starturl,
        steps: typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps,
        // 插件把它缓存为 cachedFlow，跨页续接 / 按课件启动都靠它做审核门禁，缺了会被当成未审核
        approval: toApproval(row.approval),
        updated_date: row.updated_date,
      },
    });
  } catch (err) {
    console.error("[guide_server] /api/flows/by-id 处理出错:", err);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端查询数据时出错。" });
  }
});

// ============================================================
// GET /api/flows/by-ocid?ocid=<OC课件ID>
// 通过 OC 课件 ID 获取记录，返回全部字段；未找到则 404。
// OC 课件 ID 存放在 subclass 列（生产库约定，与本地 api/flows/*.json 里
// "子分类"语义的 subclass 不是一回事——所以 SKIP_DB 时不回退到文件，直接 503）。
// subclass 上没有唯一约束，因此必须 ORDER BY + LIMIT 1，否则命中多行时
// MySQL 返回哪一行是不确定的。updated_date 是 date（只有天粒度），同一天的
// 多条记录光靠它分不出先后，所以再用 id 兜一层，保证结果完全确定。
// 返回体字段与 /api/flows/by-id 保持一致，供插件复用同一套归一化逻辑。
// ============================================================

app.get("/api/flows/by-ocid", async (req, res) => {
  try {
    const ocid = typeof req.query.ocid === "string" ? req.query.ocid : "";
    if (!ocid) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 ocid 参数。" });
      return;
    }
    if (SKIP_DB || !pool) {
      res.status(503).json({ success: false, reason: "db_unavailable", message: "数据库未连接，按 OC 课件 ID 查询不可用。" });
      return;
    }
    const [rows] = await pool.query(
      "SELECT * FROM appguide WHERE subclass = ? ORDER BY updated_date DESC, id ASC LIMIT 1",
      [ocid]
    );
    const row = (rows as any[])[0];
    if (!row) {
      res.status(404).json({ success: false, reason: "not_found", message: "未找到指定 OC 课件 ID 的记录。" });
      return;
    }
    res.json({
      success: true,
      data: {
        id: row.id,
        class: row.class,
        subclass: row.subclass,
        starturl: row.starturl,
        steps: typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps,
        // 插件把它缓存为 cachedFlow，跨页续接 / 按课件启动都靠它做审核门禁，缺了会被当成未审核
        approval: toApproval(row.approval),
        updated_date: row.updated_date,
      },
    });
  } catch (err) {
    console.error("[guide_server] /api/flows/by-ocid 处理出错:", err);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端查询数据时出错。" });
  }
});

// ============================================================
// GET /api/flows/by-pattern?url=<cleanPath>
// 去掉 url 中的疑似动态ID片段后，用剩余静态路径做 LIKE 粗筛，
// 返回当前页面及子页面下所有匹配流程的 id / title / starturl。
// 用于插件在页面加载时静默检测，无需用户按 Alt+G 即可展示可用引导数量。
// ============================================================

app.get("/api/flows/by-pattern", async (req, res) => {
  try {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
    if (!rawUrl) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 url 参数。" });
      return;
    }

    // 去掉路径中疑似动态ID的片段，只保留静态部分作为匹配模式
    // 注意：这里必须用 host（含端口）而不是 hostname，因为数据库中 starturl
    // 可能带有非默认端口（如 :8080），用 hostname 会导致 LIKE 模式丢端口从而匹配失败。
    const url = parseUrlSafely(rawUrl);
    const host = url.host; // 含端口
    const segs = normalizePathSegments(rawUrl);
    const staticSegs = segs.filter(s => !looksLikeDynamicId(s));
    const pattern = staticSegs.length > 0 ? `${host}/${staticSegs.join("/")}` : host;

    if (SKIP_DB || !pool) {
      const fileFlows = loadAllFlowsFromFiles();
      const matched = fileFlows.filter(f => f.starturl.includes(pattern));
      res.json({
        success: true,
        data: matched.map(f => ({
          id: f.id, title: f.title, starturl: f.starturl, approval: f.approval,
          rpa: { ready: !!f.rpa_ready, stale: !!f.rpa_script_stale },
        }))
      });
      return;
    }

    const [rows] = await pool.query(
      "SELECT id, title, starturl, steps, approval, rpa_ready, rpa_script_stale FROM appguide WHERE starturl LIKE ?",
      [`%${pattern}%`]
    );
    const data = (rows as any[]).map(row => {
      const stepsData = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
      return {
        id: row.id,
        title: row.title || (stepsData && stepsData.title) || "",
        starturl: row.starturl,
        approval: toApproval(row.approval),
        // 插件据此决定是否渲染 RPA 图标：ready = 「verify(write_keep) 真跑通过」；
        // stale = 「脚本已过期，建议先重生成」（只提示不拦截）。
        // 老库无这两列时 row.rpa_ready 为 undefined → false，对老插件/老库无害。
        rpa: { ready: !!row.rpa_ready, stale: !!row.rpa_script_stale },
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[guide_server] /api/flows/by-pattern 处理出错:", err);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端查询数据时出错。" });
  }
});

// ============================================================
// RPA 桥（③）—— 把 4 个 method 代理到 guidedatamanager。
//
//   appguide.rpa.spec      GET  ?appguideId=            -> GET  /api/rpa/param-spec
//   appguide.rpa.run       POST {appguideId,params,...} -> POST /api/rpa/runs（固定 write_keep）
//   appguide.rpa.status    GET  ?runId=                 -> GET  /api/rpa/runs/:runId
//   appguide.rpa.artifact  GET  ?runId=&name=           -> GET  /api/rpa/runs/:runId/artifacts/:name
//
// 前三个返回 { success, data } 信封（与 /api/* 一致）；artifact 是二进制
// （video.webm / 截图 / report），透传字节与 Range，不做 JSON 信封。
// ============================================================

function rpaBridgeConfigured(): boolean {
  return Boolean(RPA_BRIDGE_BASE_URL && RPA_BRIDGE_API_KEY);
}

function sendBridgeUnconfigured(res: any) {
  res.status(503).json({
    success: false,
    reason: "rpa_bridge_unconfigured",
    message: "RPA 桥未配置（请设置 RPA_BRIDGE_BASE_URL 与 RPA_BRIDGE_API_KEY）。",
  });
}

function bridgeBadRequest(res: any, message: string) {
  res.status(400).json({ success: false, reason: "bad_request", message });
}

function sendBridgeFailure(res: any, status: number, body: any) {
  const upstreamMsg = (body && (body.error || body.message)) || `RPA 桥返回 ${status}`;
  const reason =
    status === 400 ? "bad_request" :
    status === 403 ? "forbidden" :
    status === 404 ? "not_found" :
    status === 409 ? "not_synced" :
    "rpa_error";
  const payload: any = { success: false, reason, message: upstreamMsg };
  if (body && body.code) payload.code = body.code;
  res.status(status).json(payload);
}

async function rpaBridgeJson(pathname: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPA_BRIDGE_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${RPA_BRIDGE_BASE_URL}${pathname}`, {
      ...init,
      headers: {
        "X-API-Key": RPA_BRIDGE_API_KEY,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...((init.headers as Record<string, string>) || {}),
      },
      signal: ctrl.signal,
    });
    const text = await upstream.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: upstream.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON 代理：2xx 包成 {success,data}，其余翻译成 {success:false,reason,message} */
async function proxyRpaJson(res: any, pathname: string, init: RequestInit = {}) {
  if (!rpaBridgeConfigured()) return sendBridgeUnconfigured(res);
  try {
    const r = await rpaBridgeJson(pathname, init);
    if (r.status >= 200 && r.status < 300) {
      res.status(200).json({ success: true, data: r.body });
    } else {
      sendBridgeFailure(res, r.status, r.body);
    }
  } catch (err) {
    const msg = /abort|timeout/i.test(String((err as Error)?.message))
      ? "RPA 桥（guidedatamanager）响应超时。"
      : `RPA 桥不可达：${(err as Error)?.message}`;
    res.status(502).json({ success: false, reason: "rpa_bridge_error", message: msg });
  }
}

/**
 * 产物代理：video.webm / 截图 / report。
 * 录像是十几 MB 的二进制，且 <video> 回放会发 Range —— 必须原样透传字节与
 * content-range，不能读进内存也不能包 JSON。
 */
async function proxyRpaArtifact(req: any, res: any) {
  if (!rpaBridgeConfigured()) return sendBridgeUnconfigured(res);
  const runId = Number(req.query.runId);
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!Number.isFinite(runId) || runId <= 0 || !name) {
    return bridgeBadRequest(res, "缺少或非法的 runId / name 参数。");
  }

  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPA_BRIDGE_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(
      `${RPA_BRIDGE_BASE_URL}/api/rpa/runs/${runId}/artifacts/${encodeURIComponent(name)}`,
      {
        headers: { "X-API-Key": RPA_BRIDGE_API_KEY, ...(range ? { Range: range } : {}) },
        signal: ctrl.signal,
      }
    );
  } catch (err) {
    return res.status(502).json({
      success: false,
      reason: "rpa_bridge_error",
      message: `RPA 桥不可达：${(err as Error)?.message}`,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status === 404 ? 404 : 502).json({
      success: false,
      reason: upstream.status === 404 ? "not_found" : "rpa_error",
      // RPA 会按 RPA_RETENTION_RUNS 清理旧工作区，此时产物 404；元数据仍在库里。
      message: upstream.status === 404 ? "产物不存在或已被保留策略清理。" : "产物下载失败。",
    });
  }

  res.status(upstream.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) return res.end();
  // 头一拿到就取消超时（上面 finally 已 clear），流式转发不受 30s 限制
  Readable.fromWeb(upstream.body as any).on("error", () => res.end()).pipe(res);
}

// ============================================================
// GET /rest?method=appguide.flows.xxx  — 兼容生产环境统一入口
// 将 method 参数映射到对应的 /api/* 路由，方便插件在同一种 URL
// 格式下切换本地/云端端点。
// ============================================================

app.get("/rest", async (req, res) => {
  const method = typeof req.query.method === "string" ? req.query.method : "";

  if (method === "appguide.flows.guide") {
    // 直接复用 /api/guide 的核心逻辑
    req.url = `/api/guide?url=${req.query.url || ""}&flowId=${req.query.flowId || ""}`;
    // app.handle 是 Express 运行时方法，@types/express 未声明 → 断言放行
    return (app as any).handle(req, res);
  }

  if (method === "appguide.flows.bystarturl") {
    req.url = `/api/flows/by-starturl?starturl=${req.query.starturl || ""}`;
    return (app as any).handle(req, res);
  }

  if (method === "appguide.flows.byid") {
    req.url = `/api/flows/by-id?id=${req.query.id || ""}`;
    return (app as any).handle(req, res);
  }

  if (method === "appguide.flows.byocid") {
    req.url = `/api/flows/by-ocid?ocid=${req.query.ocid || ""}`;
    return (app as any).handle(req, res);
  }

  if (method === "appguide.flows.bypattern") {
    req.url = `/api/flows/by-pattern?url=${req.query.url || ""}`;
    return (app as any).handle(req, res);
  }

  // 审核版插件的 track-stats 走 GET /rest?method=appguide.flows.stats&id=..&type=..
  // （plugin-review/background.js 用 fetch 直接拼 URL，不带 body），与
  // POST /api/flows/stats 的 JSON body 形态并存，这里转成同一个实现。
  if (method === "appguide.flows.stats") {
    const r = await applyFlowStat(req.query.id, req.query.type);
    return res.status(r.status).json(r.body);
  }

  // ---- RPA 桥（GET 部分）----
  if (method === "appguide.rpa.spec") {
    const appguideId = typeof req.query.appguideId === "string" ? req.query.appguideId : "";
    if (!appguideId) return bridgeBadRequest(res, "缺少 appguideId 参数。");
    return proxyRpaJson(res, `/api/rpa/param-spec?appguideId=${encodeURIComponent(appguideId)}`, { method: "GET" });
  }

  if (method === "appguide.rpa.status") {
    const runId = Number(req.query.runId);
    if (!Number.isFinite(runId) || runId <= 0) return bridgeBadRequest(res, "缺少或非法的 runId 参数。");
    return proxyRpaJson(res, `/api/rpa/runs/${runId}`, { method: "GET" });
  }

  if (method === "appguide.rpa.artifact") {
    return proxyRpaArtifact(req, res);
  }

  res.status(400).json({ success: false, reason: "bad_request", message: `未知的 method: ${method}` });
});

/**
 * 统一取 method：query 优先，其次 JSON body。
 * 审核版插件（GuideManage/plugin-review/background.js）把 method 和参数一起
 * 塞进 JSON body、不写 query，而该客户端已冻结、不允许改动 —— 两种形态都得认。
 */
function resolveRestMethod(req: any): string {
  if (typeof req.query?.method === "string" && req.query.method) return req.query.method;
  const body = req.body as any;
  if (body && typeof body.method === "string" && body.method) return body.method;
  return "";
}

// ============================================================
// POST /rest —— 需要请求体的 method 走这里。
// 目前有：
//   appguide.rpa.run            插件动作固定 mode=write_keep（= 管理端「快速运行」，
//                               只运行不推送），透传 params / requestedBy（经办人，用于运行审计）。
//   appguide.flows.updatesteps  审核版插件的「审核完成回填」，见 handleUpdateSteps。
//   appguide.rpa.asset          文件参数上传：body = 原始字节（application/octet-stream），
//                               appguideId / name 在 query；回 RPA 容器内路径，即该参数的值。
// 插件 background.js 用 proxyPostRequest 发 JSON body，proxyAssetUpload 发原始字节。
// ============================================================
// 路由级 raw 解析：只认 octet-stream，JSON body 仍由全局 express.json() 处理。
// 上限与插件端 RPA_FILE_MAX_BYTES 一致。
app.post("/rest", express.raw({ type: "application/octet-stream", limit: "20mb" }), async (req, res) => {
  const method = resolveRestMethod(req);

  if (method === "appguide.flows.updatesteps") {
    return handleUpdateSteps(req, res);
  }

  if (method === "appguide.rpa.asset") {
    const appguideId = typeof req.query.appguideId === "string" ? req.query.appguideId.trim() : "";
    const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (!appguideId || !name) return bridgeBadRequest(res, "缺少 appguideId / name 参数。");
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return bridgeBadRequest(res, "请求体为空（需要 application/octet-stream 原始字节）。");
    }
    return proxyRpaJson(
      res,
      `/api/rpa/asset?appguideId=${encodeURIComponent(appguideId)}&name=${encodeURIComponent(name)}`,
      { method: "POST", body: req.body, headers: { "Content-Type": "application/octet-stream" } }
    );
  }

  if (method === "appguide.rpa.run") {
    if (!rpaBridgeConfigured()) return sendBridgeUnconfigured(res);
    const body = (req.body || {}) as any;
    const appguideId = typeof body.appguideId === "string" ? body.appguideId.trim() : "";
    if (!appguideId) return bridgeBadRequest(res, "缺少 appguideId 参数。");

    const payload: any = {
      appguideId,
      // 固定 write_keep —— 不信任调用方传来的 mode
      mode: "write_keep",
      params: body.params && typeof body.params === "object" ? body.params : {},
    };
    if (typeof body.requestedBy === "string" && body.requestedBy.trim()) {
      payload.requestedBy = body.requestedBy.trim().slice(0, 64);
    }
    if (typeof body.record === "boolean") payload.record = body.record;

    return proxyRpaJson(res, "/api/rpa/runs", { method: "POST", body: JSON.stringify(payload) });
  }

  res.status(400).json({ success: false, reason: "bad_request", message: `未知的 method: ${method}` });
});

// ============================================================
// 流程单击计数 —— POST /api/flows/stats 与 GET /rest?method=appguide.flows.stats 共用
// body: { id: string, type: "process" | "step" }
// type=process → process_count+1（激活流程时）
// type=step    → steps_count+1   （步骤导航时）
// ============================================================

async function applyFlowStat(idRaw: unknown, typeRaw: unknown): Promise<{ status: number; body: any }> {
  const id = typeof idRaw === "string" ? idRaw : "";
  const type = typeof typeRaw === "string" ? typeRaw : "";
  if (!id || !type) {
    return { status: 400, body: { success: false, reason: "bad_request", message: "缺少 id 或 type 参数。" } };
  }
  const column = type === "process" ? "process_count" : type === "step" ? "steps_count" : null;
  if (!column) {
    return { status: 400, body: { success: false, reason: "bad_request", message: `无效的 type: ${type}` } };
  }

  if (SKIP_DB || !pool) {
    return { status: 200, body: { success: true } };
  }

  try {
    await pool.query(`UPDATE appguide SET ${column} = COALESCE(${column}, 0) + 1 WHERE id = ?`, [id]);
    return { status: 200, body: { success: true } };
  } catch (err) {
    console.error("[guide_server] stats 更新出错:", (err as Error).message);
    return { status: 500, body: { success: false, reason: "server_error", message: "更新统计数据时出错。" } };
  }
}

app.post("/api/flows/stats", async (req, res) => {
  const r = await applyFlowStat(req.body?.id, req.body?.type);
  res.status(r.status).json(r.body);
});

// ============================================================
// POST /api/flows/updatesteps —— 审核回填（审核版插件的唯一写库动作）
// 同时通过 POST /rest?method=appguide.flows.updatesteps 暴露（见上方 POST /rest）。
//
// 调用方：审核版 Chrome 插件 GuideManage/plugin-review
//   content.js submitFullFlow() 审核收尾 → background.js submit-full-flow
//   → POST {base}/rest   body: { method, flowId, steps }
//
// 入参（JSON body，也兼容 query 传参以便与生产/curl 对齐）：
//   flowId: string            被审核的流程 id
//   steps:  string | object   插件会先 JSON.stringify 再发，所以「已序列化的
//                             JSON 字符串」和「已解析对象」两种形态都要兼容
//
// steps 落库规范（以服务端为准，与生产存储一致）：
//   { title, startUrl, pages: [ { url, title, description,
//     steps: [ { title, description, highlightStyle, titlePath, fromHtml,
//     selector, ... } ] } ] }
//   客户端专有字段（resolvedSelector / controlType / frameSelector / parameters）
//   原样保留，不做白名单裁剪 —— 多存无害，漏删比误删安全。
//
// 副作用：approval **无条件置 1**（= 已审核）。消费端插件（APPGuide/plugin）
// 的入口门禁只放行 approval === 1 的流程，不置 1 等于审核白做。
// 已知取舍：插件的「审核尚未完成 → 保存并关闭」走的是同一个 submitFullFlow()，
// 因此半途保存也会被标记为已审核 —— 这是客户端既定行为，服务端不区分。
//
// 只更新 steps 与 approval；starturl / title / class / subclass 列一律不动。
// ============================================================

/**
 * 解析插件送来的 steps：兼容 JSON 字符串与已解析对象两种形态。
 * 只做「能不能用」的最小校验（必须是对象且带 pages 数组），不逐字段校验——
 * 步骤字段是可扩展的（titlePath / fromHtml / clickText …），服务端不该当白名单。
 */
function parseIncomingSteps(raw: unknown): { steps?: any; error?: string } {
  let steps: any = raw;
  if (typeof steps === "string") {
    try {
      steps = JSON.parse(steps);
    } catch {
      return { error: "steps 不是合法的 JSON 字符串。" };
    }
  }
  if (!steps || typeof steps !== "object" || Array.isArray(steps) || !Array.isArray(steps.pages)) {
    return { error: "steps 非法：必须是带 pages 数组的 JSON 对象。" };
  }
  return { steps };
}

async function handleUpdateSteps(req: any, res: any) {
  try {
    const body = (req.body || {}) as any;
    const flowId = typeof body.flowId === "string" && body.flowId ? body.flowId :
      (typeof req.query.flowId === "string" ? req.query.flowId : "");
    const rawSteps = body.steps !== undefined && body.steps !== null && body.steps !== ""
      ? body.steps
      : req.query.steps;

    if (!flowId || rawSteps === undefined || rawSteps === null || rawSteps === "") {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 flowId 或 steps 参数。" });
      return;
    }

    const parsed = parseIncomingSteps(rawSteps);
    if (parsed.error) {
      res.status(400).json({ success: false, reason: "bad_request", message: parsed.error });
      return;
    }
    const stepsData = parsed.steps as { title?: string; startUrl?: string; pages: any[] };

    // ---- 分支A：无数据库模式，直接改写本地 JSON 文件（api/flows/{flowId}.json）----
    if (SKIP_DB || !pool) {
      const filePath = path.join(path.resolve("api/flows"), `${flowId}.json`);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ success: false, reason: "not_found", message: `未找到 flowId=${flowId} 的记录。` });
        return;
      }
      const record = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      // 本地文件是「扁平记录」（id/class/subclass/title/starturl/pages），没有 steps 列，
      // 所以只覆盖 title / pages，并补上 approval=1；starturl 保持原样。
      if (typeof stepsData.title === "string" && stepsData.title) record.title = stepsData.title;
      record.pages = stepsData.pages;
      record.approval = 1;
      fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
      console.log(`[guide_server] 审核回填(文件): flowId=${flowId}, pages=${stepsData.pages.length}, approval=1`);
      res.json({ success: true, message: `已回填 ${stepsData.pages.length} 页步骤，并标记为已审核。` });
      return;
    }

    // ---- 分支B：数据库模式 ----
    // 先取一次原 steps：既用来判存在（不存在直接 404，不做 upsert），
    // 也用来兜住客户端漏传的顶层字段（title / startUrl）。
    const [rows] = await pool.query("SELECT id, steps FROM appguide WHERE id = ?", [flowId]);
    if ((rows as any[]).length === 0) {
      res.status(404).json({ success: false, reason: "not_found", message: `未找到 flowId=${flowId} 的记录。` });
      return;
    }
    const row = (rows as any[])[0];
    let oldSteps: any = {};
    try {
      oldSteps = typeof row.steps === "string" ? JSON.parse(row.steps) : (row.steps || {});
    } catch {
      oldSteps = {};
    }
    const mergedSteps: any = { ...oldSteps, ...stepsData };
    if (!mergedSteps.title && oldSteps.title) mergedSteps.title = oldSteps.title;
    if (!mergedSteps.startUrl && oldSteps.startUrl) mergedSteps.startUrl = oldSteps.startUrl;

    const stepsJson = JSON.stringify(mergedSteps);
    try {
      await pool.query("UPDATE appguide SET steps = ?, approval = 1 WHERE id = ?", [stepsJson, flowId]);
    } catch (err) {
      // 老库可能没有 approval 列 —— 退化成只回填 steps，别把整次审核结果丢掉。
      if (/approval/i.test(String((err as Error)?.message))) {
        console.warn("[guide_server] appguide.approval 列不存在，仅回填 steps:", (err as Error).message);
        await pool.query("UPDATE appguide SET steps = ? WHERE id = ?", [stepsJson, flowId]);
      } else {
        throw err;
      }
    }
    console.log(`[guide_server] 审核回填(DB): flowId=${flowId}, pages=${stepsData.pages.length}, approval=1`);
    res.json({ success: true, message: `已回填 ${stepsData.pages.length} 页步骤，并标记为已审核。` });
  } catch (err) {
    console.error("[guide_server] 审核回填出错:", (err as Error).message);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端回填审核结果时出错。" });
  }
}

app.post("/api/flows/updatesteps", async (req, res) => {
  await handleUpdateSteps(req, res);
});

app.listen(PORT, () => {
  console.log(`Guide server running on http://localhost:${PORT}`);
});
