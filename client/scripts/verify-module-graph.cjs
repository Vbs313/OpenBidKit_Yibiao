'use strict';

// 模块依赖图门禁：证明「层次、依赖清晰」。
//
// 校验范围：electron/ 与 src/ 下的全部相对导入（require / import / export ... from / 动态 import）。
// 通过条件：模块图无环，且每个相对导入都能解析到真实文件。
// 非相对导入（npm 包、node: 内置、css/svg 等资源）不参与建图。
//
// 用法：node scripts/verify-module-graph.cjs
// 退出码：0 = 无环；1 = 存在环或悬空相对导入。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = ['electron', 'src'];
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

function featureOf(file) {
  const relative = path.relative(path.join(ROOT, 'src', 'features'), file).split(path.sep).join('/');
  if (relative.startsWith('..')) return null;
  const [name] = relative.split('/');
  return name || null;
}

function findCycles(graph) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seenCycleKeys = new Set();

  function recordCycle(entry) {
    const start = stack.indexOf(entry);
    const loop = stack.slice(start);
    // 归一化：从最小文件名开始，保证同一环只报一次。
    let pivot = 0;
    for (let index = 1; index < loop.length; index += 1) {
      if (loop[index] < loop[pivot]) pivot = index;
    }
    const normalized = [...loop.slice(pivot), ...loop.slice(0, pivot)];
    const key = normalized.map((file) => path.relative(ROOT, file)).join(' -> ');
    if (seenCycleKeys.has(key)) return;
    seenCycleKeys.add(key);
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

function main() {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const absolute = path.join(ROOT, sourceRoot);
    if (fs.existsSync(absolute)) walk(absolute, files);
  }
  files.sort();

  const graph = new Map();
  const dangling = [];

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const dependencies = [];
    for (const specifier of collectSpecifiers(code)) {
      if (!specifier.startsWith('.')) continue;
      const extension = path.extname(specifier).toLowerCase();
      if (ASSET_EXTENSIONS.has(extension)) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved) dependencies.push(resolved);
      else if (!extension || JS_EXTENSIONS.includes(extension)) dangling.push({ file, specifier });
    }
    graph.set(file, [...new Set(dependencies)]);
  }

  const edgeCount = [...graph.values()].reduce((sum, list) => sum + list.length, 0);
  const cycles = findCycles(graph);

  // 跨 feature 引用只做可见化，不判失败：features 之间共享 UI 组件是允许的，
  // 但数量长期上升通常意味着该把共享部分下沉到 shared/。
  const crossFeature = [];
  for (const [file, dependencies] of graph) {
    const fromFeature = featureOf(file);
    if (!fromFeature) continue;
    for (const dependency of dependencies) {
      const toFeature = featureOf(dependency);
      if (toFeature && toFeature !== fromFeature) crossFeature.push([file, dependency]);
    }
  }

  const relative = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
  console.log(`[module-graph] files=${files.length} edges=${edgeCount} cycles=${cycles.length} dangling=${dangling.length}`);
  if (crossFeature.length) {
    console.log(`[module-graph] 跨 feature 引用 ${crossFeature.length} 处（提示，不判失败）：`);
    for (const [from, to] of crossFeature) {
      console.log(`  ${relative(from)} -> ${relative(to)}`);
    }
  }

  if (dangling.length) {
    console.error('');
    console.error('[module-graph] 悬空相对导入（导入的目标文件不存在）：');
    for (const item of dangling) console.error(`  ${relative(item.file)} -> ${item.specifier}`);
  }

  if (cycles.length) {
    console.error('');
    console.error('[module-graph] 检测到循环依赖：');
    for (const cycle of cycles) console.error(`  ${cycle.map(relative).join(' -> ')}`);
  }

  if (dangling.length || cycles.length) {
    console.error('');
    console.error('[module-graph] FAILED');
    process.exit(1);
  }

  console.log('[module-graph] 无环、无悬空相对导入');
}

main();