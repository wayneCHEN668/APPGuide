import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

// Default Guide Step interface
interface GuideStep {
  id: string;
  title: string;
  description: string;
  selector: string; // CSS selector of target element
  actionType: "focus" | "input" | "click" | "any";
  actionValue?: string; // Optional target value to proceed
  tipPosition: "top" | "bottom" | "left" | "right";
  highlightStyle: "pulse" | "solid" | "glow";
}

// Guide interface
interface Guide {
  url: string; // Path without query params, e.g., "/erp/loans/apply"
  title: string;
  description: string;
  steps: GuideStep[];
}

// In-memory store for guides
const guidesDb: Record<string, Guide> = {
  "/erp/loans/apply": {
    url: "/erp/loans/apply",
    title: "个人信用贷款申请引导",
    description: "本指南用于辅助信贷专员快速、准确地完成新客户的个人信用贷款申请录入。",
    steps: [
      {
        id: "step-apply-name",
        title: "填写客户法定姓名",
        description: "请输入客户身份证上的完整姓名。系统将自动进行大数据征信库的初步筛查，请确保字形拼写无误。",
        selector: "#customer-name",
        actionType: "input",
        tipPosition: "bottom",
        highlightStyle: "pulse"
      },
      {
        id: "step-apply-idcard",
        title: "录入18位身份证号",
        description: "请输入符合国标的18位身份证号码。输入完成后，系统会自动校验格式并填充出生日期及性别信息。",
        selector: "#id-card",
        actionType: "input",
        tipPosition: "bottom",
        highlightStyle: "glow"
      },
      {
        id: "step-apply-income",
        title: "填写月度核定收入",
        description: "请输入经由流水核实的个人税后月收入（单位：元）。此数据将直接影响借款人的最高授信额度评估。",
        selector: "#monthly-income",
        actionType: "input",
        tipPosition: "right",
        highlightStyle: "solid"
      },
      {
        id: "step-apply-amount",
        title: "输入申请借款金额",
        description: "在此处输入申请的借款本金。注意：当前信用标最高额度为 500,000 元，超过此额度需补充抵押件。",
        selector: "#loan-amount",
        actionType: "input",
        tipPosition: "top",
        highlightStyle: "pulse"
      },
      {
        id: "step-apply-collateral",
        title: "选择担保抵押类型",
        description: "根据客户提供的资产证明，选择最匹配的抵押类型（如无抵押、房产抵押、车辆抵押等）。",
        selector: "#collateral-type",
        actionType: "focus",
        tipPosition: "top",
        highlightStyle: "glow"
      },
      {
        id: "step-apply-submit",
        title: "提交初审申请书",
        description: "确认上述所有信息录入无误后，点击该按钮提交至风控审批中心进行第二阶段授信审查。",
        selector: "#btn-submit-loan",
        actionType: "click",
        tipPosition: "left",
        highlightStyle: "solid"
      }
    ]
  },
  "/erp/loans/review": {
    url: "/erp/loans/review",
    title: "信贷风控审批初核指南",
    description: "本指南帮助风控审计员审核贷款申请，评估借款人风险等级，并做出初审决定。",
    steps: [
      {
        id: "step-review-score",
        title: "核对自动化征信评分",
        description: "检查系统拉取的自动化征信得分。分数低于 600 分属于高风险，需要补充连带担保人证明。",
        selector: "#risk-score-display",
        actionType: "focus",
        tipPosition: "bottom",
        highlightStyle: "pulse"
      },
      {
        id: "step-review-dti",
        title: "核算负债收入比 (DTI)",
        description: "确保计算所得的 DTI (负债/收入比) 不高于 55%。若高于此比例，系统会强制触发人工详查。",
        selector: "#dti-ratio-input",
        actionType: "input",
        tipPosition: "right",
        highlightStyle: "glow"
      },
      {
        id: "step-review-decision",
        title: "录入风控审批结论",
        description: "根据审核情况，选择‘通过授信’、‘退回修改’或‘直接拒绝’。一经提交将无法人工撤回。",
        selector: "#audit-decision",
        actionType: "focus",
        tipPosition: "top",
        highlightStyle: "pulse"
      },
      {
        id: "step-review-comments",
        title: "撰写详细风控批注",
        description: "详细记录授信意见、潜在风险点及额度计算依据。批注字数不少于 20 字以供复审参考。",
        selector: "#audit-comments",
        actionType: "input",
        tipPosition: "top",
        highlightStyle: "solid"
      },
      {
        id: "step-review-confirm",
        title: "签署确认风控单",
        description: "点击‘确认签署’按钮，系统将使用电子签章对本笔贷款审核结论进行数字存证并推送到终审队列。",
        selector: "#btn-confirm-review",
        actionType: "click",
        tipPosition: "left",
        highlightStyle: "glow"
      }
    ]
  },
  "/erp/customer/onboarding": {
    url: "/erp/customer/onboarding",
    title: "企业客户合规入驻指引",
    description: "协助客户服务专员，按照 KYC (了解你的客户) 与合规要求，为新客户开通业务系统访问权限。",
    steps: [
      {
        id: "step-ob-company",
        title: "输入企业法定全称",
        description: "请输入工商执照上的完整全称。请避免缩写，输入后系统会自动联网查询最新的统一社会信用代码。",
        selector: "#company-name",
        actionType: "input",
        tipPosition: "bottom",
        highlightStyle: "pulse"
      },
      {
        id: "step-ob-code",
        title: "填写统一社会信用代码",
        description: "输入18位统一社会信用代码。若联网自动查询失败，请手动在此处录入并核对无误。",
        selector: "#social-credit-code",
        actionType: "input",
        tipPosition: "bottom",
        highlightStyle: "solid"
      },
      {
        id: "step-ob-legal",
        title: "录入企业法定代表人",
        description: "填写该企业法人的法定姓名，必须与工商登记及营业执照上的姓名严格一致。",
        selector: "#legal-representative",
        actionType: "input",
        tipPosition: "right",
        highlightStyle: "glow"
      },
      {
        id: "step-ob-contact",
        title: "填写经办人联系电话",
        description: "录入业务授权经办人的 11 位手机号码。此号码将作为短信动态验证及业务联络的唯一主号。",
        selector: "#contact-phone",
        actionType: "input",
        tipPosition: "top",
        highlightStyle: "pulse"
      },
      {
        id: "step-ob-verify",
        title: "获取并输入短信验证码",
        description: "点击发送验证码，向经办人手机发送 6 位数字验证码，以确保联系电话的真实性及即时可达性。",
        selector: "#phone-verify-code",
        actionType: "input",
        tipPosition: "top",
        highlightStyle: "glow"
      },
      {
        id: "step-ob-submit",
        title: "提交开户合规审核",
        description: "检查营业执照电子版已上传，确认全部合规项勾选，最后点击此处提交资质审查。",
        selector: "#btn-submit-onboarding",
        actionType: "click",
        tipPosition: "left",
        highlightStyle: "solid"
      }
    ]
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Clean and match URL helper
  const getCleanUrlPath = (urlStr: string): string => {
    try {
      // Handle fully qualified URLs or path strings
      let pathName = urlStr;
      if (urlStr.includes("://") || urlStr.startsWith("//")) {
        // Simple parsed URL
        const matched = urlStr.match(/:\/\/[^/]+(\/[^?#]*)/);
        if (matched && matched[1]) {
          pathName = matched[1];
        } else {
          // If no matching slash found after hostname
          pathName = "/";
        }
      } else {
        // Strip query string and hash
        pathName = urlStr.split("?")[0].split("#")[0];
      }
      
      // Ensure it starts with / and remove trailing slash if any (unless it's just "/")
      if (!pathName.startsWith("/")) {
        pathName = "/" + pathName;
      }
      if (pathName.length > 1 && pathName.endsWith("/")) {
        pathName = pathName.slice(0, -1);
      }
      return pathName;
    } catch (e) {
      return urlStr;
    }
  };

  // API 1: Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // API 2: Get Guide for a specific URL
  app.get("/api/guide", (req, res) => {
    const rawUrl = req.query.url as string;
    if (!rawUrl) {
      res.status(400).json({ error: "Missing 'url' query parameter" });
      return;
    }

    const cleanUrl = getCleanUrlPath(rawUrl);
    console.log(`[API] Fetching guide for rawUrl: "${rawUrl}" -> cleanUrl: "${cleanUrl}"`);

    const guide = guidesDb[cleanUrl];
    if (guide) {
      res.json({ success: true, cleanUrl, guide });
    } else {
      res.json({
        success: false,
        cleanUrl,
        message: `No business guide found for URL: "${cleanUrl}"`,
        guide: null
      });
    }
  });

  // API 3: Get all guides
  app.get("/api/guides", (req, res) => {
    res.json({ success: true, guides: Object.values(guidesDb) });
  });

  // API 4: Save or Update a guide
  app.post("/api/guide", (req, res) => {
    const { url, title, description, steps } = req.body;
    if (!url || !title || !Array.isArray(steps)) {
      res.status(400).json({ error: "Missing required fields (url, title, steps)" });
      return;
    }

    const cleanUrl = getCleanUrlPath(url);
    const updatedGuide: Guide = {
      url: cleanUrl,
      title,
      description: description || "",
      steps: steps.map((s, index) => ({
        id: s.id || `step-${Date.now()}-${index}`,
        title: s.title || `步骤 ${index + 1}`,
        description: s.description || "",
        selector: s.selector || "",
        actionType: s.actionType || "focus",
        actionValue: s.actionValue || "",
        tipPosition: s.tipPosition || "bottom",
        highlightStyle: s.highlightStyle || "pulse"
      }))
    };

    guidesDb[cleanUrl] = updatedGuide;
    console.log(`[API] Saved guide for URL: "${cleanUrl}"`);
    res.json({ success: true, cleanUrl, guide: updatedGuide });
  });

  // API 5: Delete a guide
  app.delete("/api/guide", (req, res) => {
    const rawUrl = req.query.url as string;
    if (!rawUrl) {
      res.status(400).json({ error: "Missing 'url' parameter to delete" });
      return;
    }
    const cleanUrl = getCleanUrlPath(rawUrl);
    if (guidesDb[cleanUrl]) {
      delete guidesDb[cleanUrl];
      res.json({ success: true, message: `Guide for "${cleanUrl}" deleted.` });
    } else {
      res.status(404).json({ error: `Guide for "${cleanUrl}" not found.` });
    }
  });

  // API 6: AI-powered Guide Generation (optional, falls back gracefully)
  app.post("/api/generate-guide", async (req, res) => {
    const { url, title, pageDescription, fields } = req.body;
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      res.status(400).json({
        success: false,
        error: "GEMINI_API_KEY is not configured. Please add it to your environment secrets or .env file."
      });
      return;
    }

    try {
      const cleanUrl = getCleanUrlPath(url || "/erp/custom-page");
      const pageTitle = title || "自定义业务界面";
      const desc = pageDescription || "一个企业级业务系统操作界面";
      const fieldsList = fields || [
        { label: "字段1", selector: "#field-1" },
        { label: "字段2", selector: "#field-2" }
      ];

      console.log(`[API AI] Generating guide via Gemini for: ${cleanUrl}`);

      // Initialize the SDK lazily as per rules
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `
你是一位专门为复杂企业业务系统（ERP、CRM、信贷、审批系统）编写业务操作指南的资深专家。
我们需要根据用户提供的页面信息，自动生成一份专业的业务操作指南步骤。
生成的步骤应该能让业务操作员了解每一步该填写什么、有什么规则。

页面URL: ${cleanUrl}
页面标题: ${pageTitle}
页面业务说明: ${desc}
页面主要表单字段/操作控件:
${JSON.stringify(fieldsList, null, 2)}

请生成一个符合以下JSON格式的业务指南数据。返回结果必须直接是 JSON，不要用 \`\`\`json 开头包裹，直接输出 JSON 字符串：
{
  "url": "${cleanUrl}",
  "title": "${pageTitle}操作指南",
  "description": "基于AI生成的流程，引导您快速完成 ${pageTitle} 录入。",
  "steps": [
    {
      "id": "自动生成唯一ID(如 step-ob-1)",
      "title": "简短的步骤标题(如：输入客户姓名)",
      "description": "详细的业务规则说明，例如为什么要填这个，有什么需要注意的防错和合规性规则",
      "selector": "对应的CSS选择器(请从上面给出的字段列表中选择匹配的 selector，必须精准一致)",
      "actionType": "操作类型，只能是 'focus', 'input', 'click', 'any' 之一",
      "tipPosition": "气泡框弹出位置，只能是 'top', 'bottom', 'left', 'right' 之一",
      "highlightStyle": "高亮样式，只能是 'pulse', 'solid', 'glow' 之一"
    }
  ]
}

请对每个字段生成合理的、极具行业真实业务感的详细业务描述和规则。
`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text || "";
      // Strip markdown code blocks if the model returned them anyway
      let cleanJsonStr = responseText.trim();
      if (cleanJsonStr.startsWith("```")) {
        cleanJsonStr = cleanJsonStr.replace(/^```json\s*/, "").replace(/```$/, "").trim();
      }

      const generatedGuide = JSON.parse(cleanJsonStr);
      // Ensure the generated guide has correct structures
      generatedGuide.url = cleanUrl; // Force exact URL matching

      res.json({ success: true, guide: generatedGuide });
    } catch (error: any) {
      console.error("[API AI Error]:", error);
      res.status(500).json({
        success: false,
        error: error.message || "Failed to generate guide with AI."
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
