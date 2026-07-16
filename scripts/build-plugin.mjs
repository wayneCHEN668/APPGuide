/**
 * 插件构建脚本：混淆 JS + 压缩 CSS → 输出到 dist/plugin/
 * 用法：node scripts/build-plugin.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, cpSync } from 'fs';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';
import CleanCSS from 'clean-css';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'plugin');
const outDir = join(rootDir, 'dist', 'plugin');

// ── 跨文件共享的字符串字面量：必须保留原文，否则 background↔content↔popup 通信断裂 ──
const RESERVED_STRINGS = [
  'toggle-guide',
  'fetch-guide',
  'apiBaseUrl',
];

// ── 混淆器配置（中等强度） ──
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  identifierNamesGenerator: 'mangled',
  renameGlobals: false,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.5,
  reservedStrings: RESERVED_STRINGS,
  selfDefending: false,
  debugProtection: false,
};

// ── CSS 压缩器 ──
const cleanCSS = new CleanCSS({ level: 2 });

// ── 主流程 ──
function main() {
  if (!existsSync(srcDir)) {
    console.error(`❌ 源目录不存在: ${srcDir}`);
    process.exit(1);
  }

  // 确保输出目录存在
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(srcDir);
  let jsCount = 0;
  let cssCount = 0;
  let copyCount = 0;

  for (const file of files) {
    const srcPath = join(srcDir, file);
    const ext = extname(file).toLowerCase();

    if (ext === '.js') {
      // ── JavaScript 混淆 ──
      const code = readFileSync(srcPath, 'utf-8');
      const result = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);
      const outPath = join(outDir, file);
      writeFileSync(outPath, result.getObfuscatedCode(), 'utf-8');
      const ratio = ((result.getObfuscatedCode().length / code.length) * 100).toFixed(0);
      console.log(`  🔒 ${file} → ${(code.length / 1024).toFixed(1)}KB → ${(result.getObfuscatedCode().length / 1024).toFixed(1)}KB (${ratio}%)`);
      jsCount++;
    } else if (ext === '.css') {
      // ── CSS 压缩 ──
      const code = readFileSync(srcPath, 'utf-8');
      const result = cleanCSS.minify(code);
      if (result.errors.length > 0) {
        console.error(`  ⚠️  ${file} CSS 压缩出错:`, result.errors);
      }
      const outPath = join(outDir, file);
      writeFileSync(outPath, result.styles, 'utf-8');
      console.log(`  🎨 ${file} → ${(code.length / 1024).toFixed(1)}KB → ${(result.styles.length / 1024).toFixed(1)}KB`);
      cssCount++;
    } else {
      // ── 其他文件直接复制（manifest.json, popup.html 等） ──
      const outPath = join(outDir, file);
      cpSync(srcPath, outPath);
      console.log(`  📄 ${file} → 直接复制`);
      copyCount++;
    }
  }

  console.log(`\n✅ 完成！${jsCount} 个 JS 混淆, ${cssCount} 个 CSS 压缩, ${copyCount} 个文件复制 → ${outDir}`);
}

main();
