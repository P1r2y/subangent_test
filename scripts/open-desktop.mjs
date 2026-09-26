import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
export async function openFloatingWindow({ stateDirectory, executable = process.env.SUBAGENT_CONTROL_ELECTRON } = {}) {
  if (process.platform !== 'win32') throw new Error('此桌面浮窗版本支持 Windows；其他系统请使用网页面板。');
  const stateRoot = stateDirectory || process.env.SUBAGENT_CONTROL_STATE_DIR || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'subagent-control');
  const runtimeRoot = process.env.SUBAGENT_CONTROL_RUNTIME_DIR || join(stateRoot, 'runtime');
  executable ||= join(runtimeRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!existsSync(executable)) throw new Error('未安装桌面运行时，请运行仓库中的 update-personal.ps1 -Launch 完成安装。网页面板仍可使用。');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.SUBAGENT_CONTROL_STATE_DIR = stateRoot;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [join(pluginRoot, 'desktop', 'main.cjs')], {
      cwd: pluginRoot, env, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const lines = createInterface({ input: child.stdout });
    let errors = '';
    let settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('浮窗启动超时，请检查桌面运行时。')); }, 15000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (error) reject(error); else resolve(result);
    };
    child.stderr.on('data', data => { errors = (errors + data).slice(-1500); });
    child.on('error', error => finish(error));
    child.on('close', code => { if (!settled) finish(new Error(`浮窗未能启动（${code}）。${errors}`)); });
    lines.on('line', line => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      if (['ready', 'activated'].includes(result.event)) finish(null, {
        opened: true, reused: result.event === 'activated', ...result,
        message: '半透明额度浮窗已打开；点击设置按钮调整透明度、置顶与子代理策略。拖动标题栏移动，右键可刷新或关闭。'
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await openFloatingWindow()) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
