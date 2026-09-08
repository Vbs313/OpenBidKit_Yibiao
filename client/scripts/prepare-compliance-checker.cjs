/*
 * 用 PyInstaller 把合规检查 Sidecar 打成免 Python 依赖的本地运行时。
 *
 * 默认 onedir：冷启动只做目录加载，不解压单文件，避免给标书流程再加一层启动延迟，
 * 同时比 onefile 更不容易触发杀软误报。产物为
 * client/vendor/compliance-checker/<platform>-<arch>/checker(.exe) + 同名依赖目录。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const CHECKER_ROOT = path.join(CLIENT_ROOT, 'electron', 'services', 'compliance', 'checker');
const ENTRY = path.join(CHECKER_ROOT, 'checker_sidecar.py');
const VENDOR_ROOT = path.join(CLIENT_ROOT, 'vendor', 'compliance-checker');
const OUTPUT_NAME = 'checker';

function readArg(name, fallback = '') {
  const prefix = `${name}=`;
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function executableName(platform) {
  return platform === 'win32' ? `${OUTPUT_NAME}.exe` : OUTPUT_NAME;
}

function resolvePython() {
  const configured = String(process.env.YIBIAO_PYTHON_PATH || '').trim();
  const candidates = configured
    ? [configured]
    : (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']);
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['-c', 'import sys; print(sys.version_info[0]*100 + sys.version_info[1])'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (Number(version.trim()) >= 310) {
        return { command: candidate, args: [] };
      }
    } catch {
      // 换下一个候选解释器。
    }
  }
  if (process.platform !== 'win32') return { command: 'python3', args: [] };
  throw new Error('未找到可用的 Python 3.10+，请安装 Python 或设置 YIBIAO_PYTHON_PATH');
}

function ensurePyInstaller(python) {
  try {
    execFileSync(python.command, ['-m', 'PyInstaller', '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  } catch {
    // 未安装则按项目当前解释器补装。
  }
  execFileSync(python.command, [
    '-m', 'pip', 'install', '--disable-pip-version-check',
    '--index-url', 'https://pypi.org/simple', 'pyinstaller',
  ], {
    cwd: CLIENT_ROOT,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

function buildTarget(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!fs.existsSync(ENTRY)) {
    throw new Error(`找不到合规检查 Sidecar 入口：${ENTRY}`);
  }
  const python = resolvePython();
  ensurePyInstaller(python);

  const outputDir = path.join(VENDOR_ROOT, key);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-compliance-build-'));
  const distDir = path.join(scratchRoot, 'dist');
  const workDir = path.join(scratchRoot, 'work');
  const specDir = path.join(scratchRoot, 'spec');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(specDir, { recursive: true });

  try {
    execFileSync(python.command, [
      '-m', 'PyInstaller',
      '--noconfirm',
      '--clean',
      '--onedir',
      '--console',
      '--name', OUTPUT_NAME,
      '--paths', CHECKER_ROOT,
      '--hidden-import', 'checks.pricing_arithmetic',
      '--hidden-import', 'checks.validity_check',
      '--hidden-import', 'checks.deposit_check',
      '--distpath', distDir,
      '--workpath', workDir,
      '--specpath', specDir,
      ENTRY,
    ], {
      cwd: CHECKER_ROOT,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });

    const builtDir = path.join(distDir, platform === 'win32' ? OUTPUT_NAME : `${OUTPUT_NAME}.dist`);
    const builtExe = path.join(builtDir, executableName(platform));
    if (!fs.existsSync(builtExe)) {
      throw new Error(`PyInstaller 未生成预期产物：${builtExe}`);
    }

    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.cpSync(builtDir, outputDir, { recursive: true });
    if (platform !== 'win32') {
      fs.chmodSync(path.join(outputDir, executableName(platform)), 0o755);
    }

    // 只保留 exe 与依赖目录；Python 源码由 electron-builder 单独映射，便于回落到解释器调试。
    verifyBuild(path.join(outputDir, executableName(platform)));
    console.log(`合规检查 Sidecar 已就绪：${path.join(outputDir, executableName(platform))}`);
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** 打出来的 exe 必须能按协议应答 ping，否则不允许进入安装包。 */
function verifyBuild(exePath) {
  const { spawnSync } = require('node:child_process');
  const request = `${JSON.stringify({ version: '1.0', job_id: 'build-verify', action: 'ping' })}\n`;
  const result = spawnSync(exePath, [], {
    input: request,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (result.status !== 0) {
    throw new Error(`Sidecar 构建校验失败（退出码 ${result.status}）：${result.stderr || result.stdout || ''}`);
  }
  const line = String(result.stdout || '').split(/\r?\n/).find((item) => item.trim());
  let parsed = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {
    // 下面统一按无效响应处理。
  }
  if (!parsed || parsed.status !== 'success' || !Array.isArray(parsed.checks) || !parsed.checks.length) {
    throw new Error(`Sidecar 构建校验未返回合法 ping 响应：${line || '(empty stdout)'}`);
  }
  const stderr = String(result.stderr || '');
  if (stderr.trim()) {
    throw new Error(`Sidecar 构建校验时 stdout 之外的输出必须为空，实际 stderr：${stderr.trim().slice(0, 400)}`);
  }
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  if (hasFlag('--clean-only')) {
    fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
    console.log(`已清理合规检查打包产物：${VENDOR_ROOT}`);
    return;
  }
  buildTarget(platform, arch);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
