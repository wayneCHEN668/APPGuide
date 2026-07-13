import express from "express";
import * as mysql from "mysql2/promise";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3010;

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
// 已接入 MySQL 数据库。loadAllFlows() 改为异步，从 appguide 表读取所有记录。
// steps 列（JSON类型）中存储了 title 和 pages，映射为 FlowRecord。
// 下面的匹配/分支逻辑不需要改动（仅调用处加了 await）。
// ============================================================

const pool = mysql.createPool({
  host: process.env.DB_HOST || "81.69.17.148",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  database: process.env.DB_DATABASE || "wuzi",
  user: process.env.DB_USERNAME || "webapp_user",
  password: process.env.DB_PASSWORD || "StrongPass123!",
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 5000,
});

async function loadAllFlowsFromDB(): Promise<FlowRecord[] | null> {
  try {
    const [rows] = await pool.query("SELECT id, class, subclass, starturl, steps FROM appguide");
    return (rows as any[]).map((row) => {
      const stepsData = typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps;
      return {
        id: row.id,
        class: row.class || "",
        subclass: row.subclass || "",
        title: stepsData.title || "",
        starturl: row.starturl,
        pages: stepsData.pages || [],
      } as FlowRecord;
    });
  } catch (err) {
    console.warn("[guide_server] DB 不可用，回退到本地 JSON 文件:", (err as Error).message);
    return null;
  }
}

function loadAllFlowsFromFiles(): FlowRecord[] {
  const flowsDir = path.resolve("api/flows");
  const files = fs.readdirSync(flowsDir).filter((f: string) => f.endsWith(".json"));
  return files.map((f: string) => {
    const raw = JSON.parse(fs.readFileSync(path.join(flowsDir, f), "utf-8"));
    if (!raw.id) raw.id = path.basename(f, ".json");
    return raw as FlowRecord;
  });
}

async function loadAllFlows(): Promise<FlowRecord[]> {
  const dbResult = await loadAllFlowsFromDB();
  if (dbResult !== null) return dbResult;
  return loadAllFlowsFromFiles();
}

// ============================================================
// URL 归一化：只比较 pathname，忽略协议/host/query string/末尾斜杠，
// 避免因为格式细节差异导致本该匹配上的页面匹配失败。
// ============================================================

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, "http://placeholder.local");
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return rawUrl.replace(/\/+$/, "") || "/";
  }
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

function resolvePageInFlow(flow: FlowRecord, pathname: string): ResolvedPage | null {
  let pageIndex = flow.pages.findIndex((p) => normalizeUrl(p.url) === normalizeUrl(pathname));

  // 兜底：pages[].url 里没找到，但当前pathname其实就是这个flow的starturl——
  // 说明用户是从这个流程的入口进来的，理应对应pages[0]，
  // 只是starturl字段和pages[0].url字段的字符串写法有细微出入（多余斜杠/大小写等）。
  // 这个兜底尤其重要：用户在"多候选"弹窗里选中某个流程后，插件会带着选中的flowId
  // 重新请求同一个pathname；如果这里不兜底，一旦两个字段没有严格一致，
  // 就会匹配失败、重新掉回分支B、又弹出一模一样的候选列表，表现成"点击没反应"。
  if (pageIndex === -1 && flow.pages.length > 0 && normalizeUrl(flow.starturl) === normalizeUrl(pathname)) {
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
    const pathname = typeof req.query.url === "string" ? req.query.url : "";
    const inProgressFlowId = typeof req.query.flowId === "string" ? req.query.flowId : "";

    if (!pathname) {
      res.status(400).json({ success: false, reason: "bad_request", message: "缺少 url 参数。" });
      return;
    }

    const allFlows = await loadAllFlows();

    // 分支A
    if (inProgressFlowId) {
      const currentFlow = allFlows.find((f) => f.id === inProgressFlowId);
      if (currentFlow) {
        const resolved = resolvePageInFlow(currentFlow, pathname);
        if (resolved) {
          res.json({ success: true, mode: "resume", ...resolved });
          return;
        }
      }
      // 没匹配到，不 return，继续往下走分支B
    }

    // 分支B
    const candidates = allFlows.filter((f) => normalizeUrl(f.starturl) === normalizeUrl(pathname));

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
    const resolved = resolvePageInFlow(candidates[0], pathname);
    if (!resolved) {
      // 理论上starturl应当等于pages[0].url，这里做个兜底
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
    const [rows] = await pool.query("SELECT * FROM appguide WHERE starturl = ?", [starturl]);
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

app.listen(PORT, () => {
  console.log(`Guide server running on http://localhost:${PORT}`);
});
