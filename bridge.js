#!/usr/bin/env node
/**
 * Telegram ⇄ WorkBuddy 桥
 *
 * - 零依赖，Node 22+（自带 fetch）
 * - 长轮询收 TG 消息 → 调本地 agent → 把回复发回 TG
 * - 每个聊天独立会话（session 持久化），/new 开新会话
 * - 首个给它发消息的聊天自动成为 owner（写入 config.json）
 *
 * 配置：同目录 config.json，或环境变量 TG_BOT_TOKEN / TG_API_BASE
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const CFG_PATH = path.join(HERE, 'config.json');
const SESSIONS_PATH = path.join(HERE, 'sessions.json');

// ---------- 配置 ----------

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch {
    cfg = {};
  }
  cfg.token = process.env.TG_BOT_TOKEN || cfg.token || '';
  cfg.apiBase = process.env.TG_API_BASE || cfg.apiBase || 'https://api.telegram.org';
  cfg.agentTimeoutMs = cfg.agentTimeoutMs || 10 * 60 * 1000;
  cfg.ownerChatIds = cfg.ownerChatIds || [];
  cfg.agent = cfg.agent || {
    // 默认值仅供示例，实际以 config.json 的 agent 段为准
    command: process.env.AGENT_COMMAND || 'node',
    args: (process.env.AGENT_ARGS || '-p,{prompt},--output-format,text').split(','),
    cwd: process.env.AGENT_CWD || process.cwd(),
    env: {},
  };
  return cfg;
}

const cfg = loadConfig();
if (!cfg.token) {
  console.error('[bridge] 缺少 bot token：请填 config.json 的 "token"，或设 TG_BOT_TOKEN');
  process.exit(1);
}

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8')); } catch { return {}; }
}
function saveSessions(s) {
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2));
}

const LOG_PATH = path.join(HERE, 'bridge.log');

const log = (...a) => {
  const line = new Date().toISOString() + ' ' + a.map(x => String(x)).join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* ignore */ }
};

// ---------- Telegram API ----------

const API = cfg.apiBase.replace(/\/+$/, '') + '/bot' + cfg.token;

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`TG ${method} failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.result;
}

async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch { /* ignore */ }
}

function splitMessage(text, max = 4000) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    // 尽量在换行处断开
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest || out.length === 0) out.push(rest);
  return out;
}

async function sendMessage(chatId, text) {
  for (const part of splitMessage(text)) {
    await tg('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
  }
}

// ---------- Agent 调用 ----------

function buildAgentArgs(chatId) {
  const sessions = loadSessions();
  const isNew = !sessions[chatId];
  const sessionId = sessions[chatId] || `tg-${chatId}-${Date.now().toString(36)}`;
  if (isNew) {
    sessions[chatId] = sessionId;
    saveSessions(sessions);
  }
  return { sessionId, isNew, resumeId: isNew ? null : sessionId };
}

function runAgent(prompt, chatId) {
  // 串行执行：多个聊天同时发消息时排队，避免端口/资源冲突
  agentQueue = agentQueue.then(() => runAgentOnce(prompt, chatId));
  return agentQueue;
}

let agentQueue = Promise.resolve();

function runAgentOnce(prompt, chatId) {
  return new Promise((resolve, reject) => {
    const { sessionId, isNew, resumeId } = buildAgentArgs(chatId);
    const tpl = [...cfg.agent.args];
    const hasResumeSlot = tpl.some(a => String(a).includes('{resume}'));
    let args = tpl
      .map(a => String(a).replace('{prompt}', prompt))
      .filter(a => {
        if (a === '{resume}') return false;
        return true;
      });
    if (hasResumeSlot && resumeId) {
      const i = args.indexOf('{resume}');
      // 占位符已过滤，直接追加
      args.push('--resume', resumeId);
    } else if (!isNew) {
      args.push('--resume', resumeId);
    } else {
      args.push('--session-id', sessionId);
    }

    log(`[agent] chat=${chatId} session=${sessionId} spawn`);
    const child = spawn(cfg.agent.command, args, {
      cwd: cfg.agent.cwd,
      env: { ...process.env, ...(cfg.agent.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agent 超时（${Math.round(cfg.agentTimeoutMs / 60000)} 分钟）`));
    }, cfg.agentTimeoutMs);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const text = (out || '').trim();
      if (code === 0 && text) resolve(text);
      else reject(new Error(`agent 退出码 ${code}：${(err || out || '(无输出)').slice(0, 500)}`));
    });
  });
}

// ---------- 主循环 ----------

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  if (!text) return;

  // owner 自动认领
  if (!cfg.ownerChatIds.includes(chatId)) {
    cfg.ownerChatIds.push(chatId);
    try {
      fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
      log(`[owner] 新 owner: ${chatId} (${msg.from?.username || msg.from?.first_name})`);
    } catch (e) {
      log(`[owner] 写入失败: ${e.message}`);
    }
  }

  log(`[msg] chat=${chatId} from=${msg.from?.username || msg.from?.id}: ${text.slice(0, 120)}`);

  if (text === '/new' || text.startsWith('/new ')) {
    const sessions = loadSessions();
    delete sessions[chatId];
    saveSessions(sessions);
    await sendMessage(chatId, '✅ 已开启新会话。');
    return;
  }
  if (text === '/status') {
    const sessions = loadSessions();
    await sendMessage(chatId, `🟢 桥在运行\n会话: ${sessions[chatId] || '（新会话，首次发言时创建）'}\nowner: ${cfg.ownerChatIds.join(', ')}`);
    return;
  }
  if (text.startsWith('/')) {
    await sendMessage(chatId, '命令：/new 新会话 · /status 状态');
    return;
  }

  let typingTimer = setInterval(() => sendTyping(chatId).catch(() => {}), 4000);
  sendTyping(chatId).catch(() => {});
  try {
    const reply = await runAgent(text, chatId);
    await sendMessage(chatId, reply);
    log(`[reply] chat=${chatId} len=${reply.length}`);
  } catch (e) {
    log(`[error] chat=${chatId}: ${e.message}`);
    await sendMessage(chatId, `⚠️ ${e.message}`).catch(() => {});
  } finally {
    clearInterval(typingTimer);
  }
}

async function main() {
  let offset = 0;
  log(`[bridge] 启动，API=${cfg.apiBase}`);
  const me = await tg('getMe');
  log(`[bridge] bot: @${me.username} (id=${me.id})`);
  await sendMessage(cfg.ownerChatIds[0] || me.id, '🟢 桥已启动').catch(() => {});

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let updates;
    try {
      updates = await tg('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message'],
      });
    } catch (e) {
      log(`[poll] 网络错误，3s 后重试: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message) handleMessage(u.message).catch(e => log(`[handle] ${e.message}`));
    }
  }
}

main().catch(e => {
  console.error('[bridge] 启动失败:', e.message);
  process.exit(1);
});
