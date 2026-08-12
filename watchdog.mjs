/**
 * 采集看门狗 v3：守护 4 个采集任务 + 完成自动转岗
 * - 每 5 分钟巡检：进程崩溃 → 重启；卡死（90 分钟无日志且非等待期）→ 强制重启
 * - 任务正常完成（日志含"全部题库完成/已补齐"）→ 自动转岗（nextArgs，如申论→综应自由人）或停止
 * 用法：node watchdog.mjs（挂后台常驻）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const WLOG = 'watchdog.log';
const LOG = (m) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}`;
  console.log(line);
  fs.appendFileSync(WLOG, line + '\n');
};

const EXCLUDE = '--exclude-cats=三支一扶,中国人民银行,其他';
const TASKS = [
  { name: '账号1申论', log: 'resume1.log', args: ['resume-backfill.mjs', '--subjects=shenlun', '--cookie=cookie.txt', '--log=resume1.log'],
    nextArgs: ['resume-backfill.mjs', '--subjects=zhyynl', '--cookie=cookie.txt', '--log=resume1.log', '--mode=fill', EXCLUDE], nextName: '账号1·自由人(综应)' },
  { name: '账号2综应', log: 'resume2.log', args: ['resume-backfill.mjs', '--subjects=zhyynl', '--cookie=cookie2.txt', '--log=resume2.log', '--shard=1', '--shards=3', '--exclude-cats=中国人民银行,其他'] },
  { name: '账号3综应', log: 'resume3.log', args: ['resume-backfill.mjs', '--subjects=zhyynl', '--cookie=cookie3.txt', '--log=resume3.log', '--shard=0', '--shards=3', '--exclude-cats=三支一扶'],
    nextArgs: ['resume-backfill.mjs', '--subjects=zhyynl', '--cookie=cookie3.txt', '--log=resume3.log', '--mode=fill', EXCLUDE], nextName: '账号3·自由人(综应)' },
  { name: '账号4综应', log: 'resume4.log', args: ['resume-backfill.mjs', '--subjects=zhyynl', '--cookie=cookie4.txt', '--log=resume4.log', '--shard=2', '--shards=3', '--exclude-cats=三支一扶,中国人民银行,其他'] },
].map((t) => ({ ...t, child: null, restarts: 0, done: false }));

function start(t) {
  const child = spawn(process.execPath, t.args, { stdio: 'ignore' });
  t.child = child;
  LOG(`🔁 启动 ${t.name}（pid ${child.pid}）`);
  child.on('exit', (code) => {
    // 判断是否"正常完成"（日志尾部有完成标记）
    let finished = false;
    try {
      const tail = fs.readFileSync(t.log, 'utf8').trim().split('\n').slice(-3).join(' ');
      finished = /全部题库完成|已补齐/.test(tail);
    } catch {}
    if (finished && t.nextArgs && !t.usedNext) {
      t.usedNext = true;
      t.args = [...t.nextArgs];
      const old = t.name;
      t.name = t.nextName || t.name;
      LOG(`🏁 ${old} 已完成 → 转岗为 ${t.name}，等待下轮重启`);
    } else if (finished) {
      t.done = true;
      LOG(`🏁 ${t.name} 全部完成，停止守护`);
    } else {
      LOG(`⚠️ ${t.name} 退出 code=${code}（未完成），等待下轮重启`);
    }
  });
  child.on('error', (e) => LOG(`✗ ${t.name} 启动错误: ${e.message}`));
}

// 首次启动
for (const t of TASKS) start(t);

// 巡检：每 5 分钟
setInterval(() => {
  const now = Date.now();
  for (const t of TASKS) {
    if (t.done) continue;
    // 进程退出 → 重启（转岗后 args 已更新）
    if (t.child && t.child.exitCode !== null) {
      if (t.lastRestart && now - t.lastRestart < 60_000) continue;
      t.lastRestart = now;
      t.restarts++;
      start(t);
      continue;
    }
    // 卡死检测：90 分钟无日志更新且非等待期
    try {
      const stat = fs.statSync(t.log);
      const ageMin = (now - stat.mtimeMs) / 60000;
      if (t.child && ageMin > 90) {
        const tail = fs.readFileSync(t.log, 'utf8').trim().split('\n').slice(-3).join(' ');
        if (!/冷却|暂停|风控/.test(tail)) {
          LOG(`⚠️ ${t.name} 疑似卡死（日志 ${Math.round(ageMin)} 分钟无更新），强制重启`);
          try { t.child.kill(); } catch {}
          t.lastRestart = now;
          t.restarts++;
          start(t);
        }
      }
    } catch {}
  }
}, 5 * 60 * 1000);

LOG('看门狗 v3 已启动：守护 4 任务 + 完成自动转岗（每 5 分钟巡检）');
process.on('SIGTERM', () => { LOG('看门狗收到终止信号'); process.exit(0); });
