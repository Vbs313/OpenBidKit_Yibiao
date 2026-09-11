'use strict';

// 模块依赖图门禁：把「层次、依赖清晰」变成可执行的检查。
//
// 1) 无环：全仓相对导入的模块图不允许有环。
// 2) 无悬空：每个相对导入都必须解析到真实文件。
// 3) 层次方向：
//      src:      shared 不得依赖 features / app；features 不得依赖 app
//      electron: utils 不得依赖 services
// 4) 提示项（不判失败）：跨 feature 引用、被非路由入口引用的 pages/*。
//
// 用法：node scripts/verify-module-graph.cjs
// 退出码：0 = 全部通过；1 = 存在环、悬空导入或层次方向违规。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS_EXTENSIONS = ['.cjs', '.mjs', '.js', '.tsx', '.ts', '.jsx'];
const ASSET_EXTENSIONS = new Set(['.json', '.css', '.scss', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.md', '.html']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.vite', '__pycache__', 'vendor', 'release', 'build']);
const SKIP_FILE_RE = /\.(test|spec)\./;

const SPECIFIER_PATTERNS = [
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILE_RE.test(entry.name)) continue;
    if (JS_EXTENSIONS.includes(path.extname(entry.name))) out.push(path.join(dir, entry.name));
  }
  return out;
}

function collectSpecifiers(code) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) found.add(match[1]);
  }
  return [...found];
}

function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...JS_EXTENSIONS.map((extension) => base + extension)];
  if (!path.extname(base)) {
    candidates.push(...JS_EXTENSIONS.map((extension) => path.join(base, 'index' + extension)));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function findCycles(graph) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  function recordCycle(entry) {
    const start = stack.indexOf(entry);
    const loop = stack.slice(start);
    let pivot = 0;
    for (let index = 1; index < loop.length; index += 1) {
      if (loop[index] < loop[pivot]) pivot = index;
    }
    const normalized = [...loop.slice(pivot), ...loop.slice(0, pivot)];
    const key = normalized.map((file) => path.relative(ROOT, file)).join(' -> ');
    if (seen.has(key)) return;
    seen.add(key);
    cycles.push([...normalized, normalized[0]]);
  }

  function visit(file) {
    color.set(file, GREY);
    stack.push(file);
    for (const dependency of graph.get(file) || []) {
      const state = color.get(dependency) ?? WHITE;
      if (state === GREY) recordCycle(dependency);
      else if (state === WHITE) visit(dependency);
    }
    stack.pop();
    color.set(file, BLACK);
  }

  for (const file of [...graph.keys()].sort()) {
    if ((color.get(file) ?? WHITE) === WHITE) visit(file);
  }
  return cycles;
}

const relative = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

/** src 内的层次归属：shared / features / app / other */
function sourceLayerOf(file) {
  const rel = path.relative(path.join(ROOT, 'src'), file).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  if (rel.startsWith('shared/')) return 'shared';
  if (rel.startsWith('features/')) return 'features';
  if (rel.startsWith('app/')) return 'app';
  return 'other';
}

function featureOf(file) {
  const rel = path.relative(path.join(ROOT, 'src', 'features'), file).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  const [name] = rel.split('/');
  return name || null;
}

/** src 的层次方向规则：低层不得依赖高层 */
function isSourceLayerViolation(fromLayer, toLayer) {
  if (fromLayer === 'shared') return toLayer === 'features' || toLayer === 'app';
  if (fromLayer === 'features') return toLayer === 'app';
  return false;
}

/** electron 的层次方向规则：utils 不得依赖 services */
function isElectronLayerViolation(fromFile, toFile) {
  const from = path.relative(path.join(ROOT, 'electron'), fromFile).split(path.sep).join('/');
  const to = path.relative(path.join(ROOT, 'electron'), toFile).split(path.sep).join('/');
  if (from.startsWith('..') || to.startsWith('..')) return false;
  return from.startsWith('utils/') && to.startsWith('services/');
}

/** pages/* 只应由路由入口引用 */
function isFeaturePage(file) {
  const rel = path.relative(path.join(ROOT, 'src'), file).split(path.sep).join('/');
  return /^features\/[^/]+\/pages\//.test(rel);
}

function isRouteEntry(file) {
  const rel = path.relative(path.join(ROOT, 'src'), file).split(path.sep).join('/');
  return rel.startsWith('app/') || rel === 'main.tsx';
}

function main() {
  const files = [];
  for (const sourceRoot of ['electron', 'src']) {
    const absolute = path.join(ROOT, sourceRoot);
    if (fs.existsSync(absolute)) walk(absolute, files);
  }
  files.sort();

  const graph = new Map();
  const dangling = [];
  const layerViolations = [];
  const crossFeature = [];
  const pageImports = [];

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const dependencies = [];
    for (const specifier of collectSpecifiers(code)) {
      if (!specifier.startsWith('.')) continue;
      const extension = path.extname(specifier).toLowerCase();
      if (ASSET_EXTENSIONS.has(extension)) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (!resolved) {
        if (!extension || JS_EXTENSIONS.includes(extension)) dangling.push({ file, specifier });
        continue;
      }
      dependencies.push(resolved);

      const fromLayer = sourceLayerOf(file);
      const toLayer = sourceLayerOf(resolved);
      if (fromLayer && toLayer && isSourceLayerViolation(fromLayer, toLayer)) {
        layerViolations.push({ from: file, to: resolved, rule: `src: ${fromLayer} -> ${toLayer}` });
      }
      if (isElectronLayerViolation(file, resolved)) {
        layerViolations.push({ from: file, to: resolved, rule: 'electron: utils -> services' });
      }

      const fromFeature = featureOf(file);
      const toFeature = featureOf(resolved);
      if (fromFeature && toFeature && fromFeature !== toFeature) {
        crossFeature.push([file, resolved]);
      }
      if (isFeaturePage(resolved) && !isRouteEntry(file) && resolved !== file) {
        pageImports.push([file, resolved]);
      }
    }
    graph.set(file, [...new Set(dependencies)]);
  }

  const edgeCount = [...graph.values()].reduce((sum, list) => sum + list.length, 0);
  const cycles = findCycles(graph);

  console.log(`[module-graph] files=${files.length} edges=${edgeCount} cycles=${cycles.length} dangling=${dangling.length} layerViolations=${layerViolations.length}`);

  if (crossFeature.length) {
    console.log(`[module-graph] 提示：跨 feature 引用 ${crossFeature.length} 处`);
    for (const [from, to] of crossFeature) console.log(`  ${relative(from)} -> ${relative(to)}`);
  }

  if (pageImports.length) {
    console.log(`[module-graph] 提示：pages/* 被非路由入口引用 ${pageImports.length} 处（向导式页面组合，暂不判失败）`);
    for (const [from, to] of pageImports) console.log(`  ${relative(from)} -> ${relative(to)}`);
  }

  if (dangling.length) {
    console.error('');
    console.error('[module-graph] 悬空相对导入（目标文件不存在）：');
    for (const item of dangling) console.error(`  ${relative(item.file)} -> ${item.specifier}`);
  }

  if (layerViolations.length) {
    console.error('');
    console.error('[module-graph] 层次方向违规：');
    for (const item of layerViolations) console.error(`  [${item.rule}] ${relative(item.from)} -> ${relative(item.to)}`);
  }

  if (cycles.length) {
    console.error('');
    console.error('[module-graph] 循环依赖：');
    for (const cycle of cycles) console.error(`  ${cycle.map(relative).join(' -> ')}`);
  }

  if (dangling.length || layerViolations.length || cycles.length) {
    console.error('');
    console.error('[module-graph] FAILED');
    process.exit(1);
  }

  console.log('[module-graph] 无环、无悬空相对导入、层次方向正确');
}

main();