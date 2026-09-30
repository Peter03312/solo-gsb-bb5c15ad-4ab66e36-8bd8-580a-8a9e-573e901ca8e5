'use strict';
// 一键端到端：在临时 SQLite 库上启动服务，依次跑 e2e.js 与 preview.e2e.js 后退出。
// 用法：npm run test:e2e
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmpDb = path.join(os.tmpdir(), `charter-e2e-${process.pid}.db`);
const port = process.env.E2E_PORT || '3999';
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
  cwd: root,
  env: { ...process.env, DB_PATH: tmpDb, PORT: port },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function waitForServer(retries = 40) {
  return new Promise((resolve, reject) => {
    const tick = async (left) => {
      try {
        const res = await fetch(base + '/api/overview');
        if (res.ok) return resolve();
      } catch {}
      if (left <= 0) return reject(new Error('测试服务启动超时'));
      setTimeout(() => tick(left - 1), 100);
    };
    tick(retries);
  });
}

function run(suite) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, suite)], {
      env: { ...process.env, E2E_BASE: base },
      stdio: 'inherit',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${suite} 失败（exit ${code}）`))));
  });
}

async function main() {
  let server3 = null;
  try {
    await waitForServer();
    await run('e2e.js');
    // 各套套件各自要求空库：换库重启
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmpDb, { force: true });
    for (const ext of ['-wal', '-shm']) fs.rmSync(tmpDb + ext, { force: true });
    const server2 = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      cwd: root,
      env: { ...process.env, DB_PATH: tmpDb, PORT: port },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await new Promise((r) => setTimeout(r, 600));
    try {
      await waitForServer();
      await run('preview.e2e.js');
    } finally {
      server2.kill();
    }
    // 历史/撤销/重做套件：再换空库
    fs.rmSync(tmpDb, { force: true });
    for (const ext of ['-wal', '-shm']) fs.rmSync(tmpDb + ext, { force: true });
    server3 = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      cwd: root,
      env: { ...process.env, DB_PATH: tmpDb, PORT: port },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForServer();
    await run('history.e2e.js');
    console.log('\n端到端测试全部通过');
  } catch (err) {
    console.error(err.message);
    server.kill();
    process.exit(1);
  } finally {
    if (server3) server3.kill();
    fs.rmSync(tmpDb, { force: true });
    for (const ext of ['-wal', '-shm']) fs.rmSync(tmpDb + ext, { force: true });
  }
}

main();
