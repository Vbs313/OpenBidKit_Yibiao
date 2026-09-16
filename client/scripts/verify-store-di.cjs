/**
 * Store 工厂依赖注入完整性门禁。
 *
 * 背景：createTenderSourceFiles / createDownstreamCleanup 曾因生产接线漏注
 * readMetaRow、db 等，导入招标整包不可用，且现有单测/冒烟拦不住。
 *
 * 规则：technicalPlanStore 里 `= createXxx({ ... })` 传入的键
 *       必须覆盖工厂解构参数里的全部标识符。
 */
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(CLIENT_ROOT, 'electron', 'services', 'stores');
const STORE_PATH = path.join(STORE_DIR, 'technicalPlanStore.cjs');

/** 只审计这些「从 technicalPlanStore 组装」的工厂。 */
const FACTORY_FILES = {
  createIllustrationFiles: 'illustrationFiles.cjs',
  createContentPersistence: 'contentPersistence.cjs',
  createTenderSourceFiles: 'tenderSourceFiles.cjs',
  createTaskPersistence: 'taskPersistence.cjs',
  createDownstreamCleanup: 'downstreamCleanup.cjs',
  createTenderDocumentLifecycle: 'tenderDocumentLifecycle.cjs',
};

function extractDestructuredKeys(source, factoryName) {
  // 形态：function createXxx(deps) { const { a, b } = deps; ...
  const head = `function ${factoryName}(`;
  const fnIndex = source.indexOf(head);
  if (fnIndex < 0) return null;
  const destructMatch = /const\s*\{/.exec(source.slice(fnIndex, fnIndex + 4000));
  if (!destructMatch) return null;
  const openBrace = fnIndex + destructMatch.index + destructMatch[0].length - 1;
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace < 0) return null;
  const block = source.slice(openBrace + 1, closeBrace);
  const keys = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line || line.startsWith('//')) continue;
    const match = line.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (match) keys.push(match[1]);
  }
  return [...new Set(keys)];
}

function extractCallKeys(storeSource, factoryName) {
  const pattern = new RegExp(`=\\s*${factoryName}\\(\\{`);
  const match = pattern.exec(storeSource);
  if (!match) return null;
  const openBrace = storeSource.indexOf('{', match.index + match[0].length - 1);
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < storeSource.length; i += 1) {
    const ch = storeSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace < 0) return null;
  const block = storeSource.slice(openBrace + 1, closeBrace);
  const keys = [];
  for (const part of block.split(',')) {
    const matchKey = part.trim().match(/^([A-Za-z_$][\w$]*)/);
    if (matchKey) keys.push(matchKey[1]);
  }
  return [...new Set(keys)];
}

function main() {
  const storeSource = fs.readFileSync(STORE_PATH, 'utf8');
  const failures = [];

  for (const [factoryName, fileName] of Object.entries(FACTORY_FILES)) {
    const factorySource = fs.readFileSync(path.join(STORE_DIR, fileName), 'utf8');
    const required = extractDestructuredKeys(factorySource, factoryName);
    if (!required || !required.length) {
      failures.push(`${factoryName}: 无法从 ${fileName} 解析工厂依赖`);
      continue;
    }
    const passed = extractCallKeys(storeSource, factoryName);
    if (!passed) {
      failures.push(`${factoryName}: technicalPlanStore 中未找到调用`);
      continue;
    }
    const missing = required.filter((key) => !passed.includes(key));
    if (missing.length) {
      failures.push(`${factoryName}: 漏注入 ${missing.join(', ')}`);
    }
  }

  if (failures.length) {
    console.error('[store-di] 失败：');
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }

  console.log(`[store-di] ${Object.keys(FACTORY_FILES).length} 个工厂接线完整`);
}

main();
