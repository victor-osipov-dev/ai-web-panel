import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { JcodeClient } from '@1jehuang/jcode-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT || 8193);
const DEFAULT_CWD = process.env.JCODE_WEB_CWD || '/root';

const client = await JcodeClient.connect({ clientName: 'jcode-web/0.1' });
const sockets = new Set();
const attached = new Set();

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  for (const ws of sockets) wsSend(ws, obj);
}

function watchSession(sessionId) {
  if (attached.has(sessionId)) return;
  attached.add(sessionId);
  (async () => {
    try {
      for await (const ev of client.events(sessionId)) {
        broadcast({ type: 'event', sessionId, event: ev });
        if (ev.ev === 'sessions') broadcast({ type: 'sessions', sessions: ev.sessions });
        if (ev.ev === 'session_forked' || ev.ev === 'attached') {
          broadcast({ type: 'sessions', sessions: await client.listSessions() });
        }
      }
    } catch (err) {
      attached.delete(sessionId);
      broadcast({ type: 'notice', text: `event stream: ${err.message}` });
    }
  })();
}

async function handleCommand(msg) {
  const { id, cmd, args = {} } = msg;
  try {
    let result;
    switch (cmd) {
      case 'ping':
        result = { ok: true };
        break;
      case 'list_sessions':
        result = await client.listSessions({ includeArchived: false });
        break;
      case 'create_session': {
        const s = await client.createSession(args.workingDir || DEFAULT_CWD);
        watchSession(s.session_id);
        result = s;
        broadcast({ type: 'sessions', sessions: await client.listSessions() });
        break;
      }
      case 'attach':
        await client.attachSession(args.sessionId);
        watchSession(args.sessionId);
        result = { ok: true };
        break;
      case 'detach':
        await client.detachSession(args.sessionId);
        attached.delete(args.sessionId);
        result = { ok: true };
        break;
      case 'history':
        result = await client.getHistory(args.sessionId);
        break;
      case 'send':
        result = await client.sendMessage(args.sessionId, args.content, { waitForAccept: false });
        break;
      case 'cancel':
        result = await client.cancel(args.sessionId);
        break;
      case 'models':
        result = await client.listModels(args.sessionId);
        break;
      case 'set_model':
        result = await client.setModel(args.sessionId, args.model);
        break;
      case 'set_effort':
        result = await client.setReasoningEffort(args.sessionId, args.effort);
        break;
      case 'compact':
        result = await client.compact(args.sessionId);
        break;
      case 'permission':
        result = await client.respondToPermission(args.sessionId, args.requestId, args.decision);
        break;
      case 'rename':
        result = await client.renameSession(args.sessionId, args.title);
        broadcast({ type: 'sessions', sessions: await client.listSessions() });
        break;
      case 'rewind':
        result = await client.rewind(args.sessionId, args.index);
        break;
      case 'clear':
        result = await client.clear(args.sessionId);
        break;
      case 'runtime':
        result = await client.getRuntimeInfo(args.sessionId);
        break;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
    return { id, ok: true, result };
  } catch (err) {
    return { id, ok: false, error: err?.message || String(err) };
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404).end('not built');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  wsSend(ws, { type: 'hello', server: 'jcode-web', version: '0.1.0' });
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg && msg.id !== undefined && msg.cmd) {
      wsSend(ws, await handleCommand(msg));
    }
  });
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => sockets.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`jcode-web listening on http://127.0.0.1:${PORT}`);
});
