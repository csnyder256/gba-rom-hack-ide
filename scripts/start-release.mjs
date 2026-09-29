import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 22) {
  console.error('This release requires Node.js 22.');
  process.exit(1);
}
for (const file of ['engine/dist/index.js', 'app/backend/dist/index.js', 'app/frontend/dist/index.html']) {
  if (!existsSync(resolve(root, file))) {
    console.error(`Missing built release file: ${file}. Download the prebuilt bundle or build from source.`);
    process.exit(1);
  }
}
const windows = process.platform === 'win32';
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (windows && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  }
  process.exitCode = code;
}
for (const [entry, args, cwd] of [
  ['app/backend/dist/index.js', [], 'app/backend'],
  ['app/node_modules/vite/bin/vite.js', ['preview'], 'app/frontend'],
]) {
  const child = spawn(process.execPath, [resolve(root, entry), ...args], {
    cwd: resolve(root, cwd), stdio: 'inherit', detached: !windows,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '8717', BACKEND_PORT: '8717' },
  });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
console.log('ROM Hack IDE: http://127.0.0.1:5173 (Ctrl+C stops both services)');
