#!/usr/bin/env node
/**
 * 桥接链路自测：本地起一个假的 Telegram API，跑通 收消息→调agent→发回复 全流程。
 * 用法：node mock-test.js
 */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HERE = __dirname;
const PORT = 18923;
const TOKEN = 'TESTTOKEN';
let sent = [];
let pollCount = 0;

const updates = [
  {
    update_id: 1001,
    message: {
      message_id: 1,
      chat: { id: 424242, type: 'private' },
      from: { id: 424242, username: 'tester', first_name: 'Test' },
      text: '你好桥',
    },
  },
  { update_id: 1002, message: { message_id: 2, chat: { id: 424242, type: 'private' }, from: { id: 424242, username: 'tester' }, text: '/status' } },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const url = req.url;
    if (!url.startsWith(`/bot${TOKEN}/`)) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false })); return;
    }
    const method = url.slice((`/bot${TOKEN}/`).length);
    const reply = obj => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (method === 'getMe') {
      reply({ ok: true, result: { id: 999, username: 'mock_bot' } });
    } else if (method === 'getUpdates') {
      pollCount++;
      if (pollCount === 1) reply({ ok: true, result: updates });
      else setTimeout(() => reply({ ok: true, result: [] }), 200);
    } else if (method === 'sendMessage' || method === 'sendChatAction') {
      if (method === 'sendMessage') {
        sent.push(JSON.parse(body));
        console.log(`  [mock] sendMessage -> chat=${JSON.parse(body).chat_id} text=${JSON.parse(body).text.slice(0, 60)}`);
      }
      reply({ ok: true, result: {} });
    } else {
      reply({ ok: true, result: {} });
    }
  });
});

server.listen(PORT, async () => {
  console.log(`[mock] 假 TG API 已启动: http://127.0.0.1:${PORT}`);

  const child = spawn(process.execPath, [path.join(HERE, 'bridge.js')], {
    env: {
      ...process.env,
      TG_BOT_TOKEN: TOKEN,
      TG_API_BASE: `http://127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => process.stdout.write(`  [bridge] ${d}`));
  child.stderr.on('data', d => process.stdout.write(`  [bridge:err] ${d}`));

  // 等两条消息都回复完（最多 30s）
  const deadline = Date.now() + 30000;
  const tick = setInterval(() => {
    const texts = sent.filter(s => s.text && s.text !== '🟢 桥已启动').map(s => s.text);
    const done = texts.length >= 2;
    if (done || Date.now() > deadline) {
      clearInterval(tick);
      child.kill('SIGKILL');
      server.close();
      const ok1 = texts.some(t => t.includes('ECHO:你好桥'));
      const ok2 = texts.some(t => t.includes('桥在运行'));
      console.log('');
      console.log(`agent 回复测试: ${ok1 ? 'PASS' : 'FAIL'}`);
      console.log(`命令测试(/status): ${ok2 ? 'PASS' : 'FAIL'}`);
      console.log(`owner 认领测试: ${JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')).ownerChatIds.includes(424242) ? 'PASS' : 'FAIL'}`);
      process.exit(ok1 && ok2 ? 0 : 1);
    }
  }, 500);
});
