import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3010;

const guideJsonPath = path.resolve("api/guide.json");

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/api/guide", (req, res) => {
  try {
    const data = fs.readFileSync(guideJsonPath, "utf-8");
    const guide = JSON.parse(data);

    // Override url field with the query parameter if provided
    if (req.query.url && typeof req.query.url === "string") {
      guide.url = req.query.url;
    }

    res.json({ success: true, guide });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to read guide.json" });
  }
});

app.listen(PORT, () => {
  console.log(`Guide server running on http://localhost:${PORT}`);
});
