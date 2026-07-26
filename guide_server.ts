import "dotenv/config";
import express from "express";
import * as mysql from "mysql2/promise";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3010;

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
  pages: RawPage[];
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

function loadAllFlowsFromFiles(): FlowRecord[] {
  const flowsDir = path.resolve("api/flows");
  const files = fs.readdirSync(flowsDir).filter((f: string) => f.endsWith(".json"));
  return files.map((f: string) => {
    const raw = JSON.parse(fs.readFileSync(path.join(flowsDir, f), "utf-8"));
    if (!raw.id) raw.id = path.basename(f, ".json");
    return raw as FlowRecord;
  });
}

async function loadFlowById(id: string): Promise<FlowRecord | null> {
  if (SKIP_DB || !pool) return null;
  try {
    const [rows] = await pool.query(
      "SELECT id, class, subclass, starturl, steps FROM appguide WHERE id = ?",
      [id]
    );
    if ((rows as any[]).length === 0) return null;
    const row = (rows as any[])[0];
    const stepsData = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
    return {
      id: row.id,
      class: row.class || "",
      subclass: row.subclass || "",
      title: stepsData.title || "",
      starturl: row.starturl,
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
      "SELECT id, class, subclass, title, starturl, steps FROM appguide WHERE starturl LIKE ?",
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
  next();
});

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
        updated_date: row.updated_date,
      },
    });
  } catch (err) {
    console.error("[guide_server] /api/flows/by-id 处理出错:", err);
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
        data: matched.map(f => ({ id: f.id, title: f.title, starturl: f.starturl }))
      });
      return;
    }

    const [rows] = await pool.query(
      "SELECT id, title, starturl, steps FROM appguide WHERE starturl LIKE ?",
      [`%${pattern}%`]
    );
    const data = (rows as any[]).map(row => {
      const stepsData = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
      return {
        id: row.id,
        title: row.title || (stepsData && stepsData.title) || "",
        starturl: row.starturl,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error("[guide_server] /api/flows/by-pattern 处理出错:", err);
    res.status(500).json({ success: false, reason: "server_error", message: "服务端查询数据时出错。" });
  }
});

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
    return app.handle(req, res);
  }

  if (method === "appguide.flows.bystarturl") {
    req.url = `/api/flows/by-starturl?starturl=${req.query.starturl || ""}`;
    return app.handle(req, res);
  }

  if (method === "appguide.flows.byid") {
    req.url = `/api/flows/by-id?id=${req.query.id || ""}`;
    return app.handle(req, res);
  }

  if (method === "appguide.flows.bypattern") {
    req.url = `/api/flows/by-pattern?url=${req.query.url || ""}`;
    return app.handle(req, res);
  }

  res.status(400).json({ success: false, reason: "bad_request", message: `未知的 method: ${method}` });
});

// ============================================================
// POST /api/flows/stats  — 更新流程单击计数
// body: { id: string, type: "process" | "step" }
// type=process → process_count+1（激活流程时）
// type=step    → steps_count+1   （步骤导航时）
// ============================================================

app.post("/api/flows/stats", async (req, res) => {
  try {
    const { id, type } = req.body;
    if (!id || !type) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 id 或 type 参数。" });
      return;
    }
    const column = type === "process" ? "process_count" : type === "step" ? "steps_count" : null;
    if (!column) {
      res.status(400).json({ success: false, reason: "bad_request", message: `无效的 type: ${type}` });
      return;
    }

    if (SKIP_DB || !pool) {
      res.json({ success: true });
      return;
    }

    await pool.query(`UPDATE appguide SET ${column} = COALESCE(${column}, 0) + 1 WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("[guide_server] POST /api/flows/stats 出错:", (err as Error).message);
    res.status(500).json({ success: false, reason: "server_error", message: "更新统计数据时出错。" });
  }
});

app.listen(PORT, () => {
  console.log(`Guide server running on http://localhost:${PORT}`);
});
