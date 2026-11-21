import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';

const PORT = Number(process.env.PROXY_PORT || 8118);
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const STATE = process.env.VPN_STATE_FILE || '/root/.jcode/vpn-port';
const SOCKS_USER = process.env.SOCKS_USER || 'user';
const SOCKS_PASS = process.env.SOCKS_PASS || '12345';

function currentUpstream() {
  try {
    const p = Number(fs.readFileSync(STATE, 'utf8').trim());
    return Number.isInteger(p) && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

function socks5(host, port, upstreamPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(upstreamPort, '127.0.0.1');
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (msg) => {
      socket.destroy();
      reject(new Error(msg));
    };

    socket.on('connect', () => {
      socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
    });
    socket.on('error', (e) => reject(e));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail('bad socks greeting');
        if (buf[1] === 0xff) return fail('no acceptable socks method');
        buf = buf.subarray(2);
        stage = 1;
        const u = Buffer.from(SOCKS_USER);
        const p = Buffer.from(SOCKS_PASS);
        socket.write(Buffer.concat([
          Buffer.from([0x01, u.length]), u,
          Buffer.from([p.length]), p,
        ]));
      }
      if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail('socks auth failed');
        buf = buf.subarray(2);
        stage = 2;
        const h = Buffer.from(host);
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]));
      }
      if (stage === 2) {
        if (buf.length < 4) return;
        if (buf[1] !== 0) return fail(`socks connect failed (${buf[1]})`);
        const atyp = buf[3];
        let need = 4;
        if (atyp === 1) need = 4 + 4 + 2;
        else if (atyp === 3) need = 4 + 1 + buf[4] + 2;
        else if (atyp === 4) need = 4 + 16 + 2;
        else return fail('bad socks reply');
        if (buf.length < need) return;
        stage = 3;
        socket.removeAllListeners('data');
        if (buf.length > need) socket.unshift(buf.subarray(need));
        resolve(socket);
      }
    });
  });
}

function directConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host, () => resolve(s));
    s.on('error', reject);
  });
}

async function checkUpstream(port, host = 'api.nano-gpt.com') {
  const started = Date.now();
  let socket;
  let secure;
  try {
    socket = port > 0 ? await socks5(host, 443, port) : await directConnect(host, 443);
    socket.setTimeout(8000, () => socket.destroy(new Error('connect timeout')));
    secure = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket, servername: host }, () => resolve(t));
      t.on('error', reject);
    });
    const status = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('no HTTP response')), 6000);
      const onData = (chunk) => {
        buf += chunk.toString();
        const i = buf.indexOf('\r\n');
        if (i > 0) {
          clearTimeout(timer);
          resolve(buf.slice(0, i));
        }
      };
      secure.on('data', onData);
      secure.on('error', reject);
      secure.write(`HEAD /v1/models HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    return { ok: true, ms: Date.now() - started, status };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e?.message || e) };
  } finally {
    try { secure?.destroy(); } catch { /* ignore */ }
    try { socket?.destroy(); } catch { /* ignore */ }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/check') {
    try {
      const body = await readJson(req);
      const port = Number(body.port || 0);
      const result = await checkUpstream(port, body.host || 'api.nano-gpt.com');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }
  res.writeHead(405).end('CONNECT only');
});

server.on('connect', async (req, client, head) => {
  const [host, portStr] = (req.url || '').split(':');
  const port = Number(portStr || 443);
  const upstream = currentUpstream();
  let remote;
  try {
    remote = upstream
      ? await socks5(host, port, upstream)
      : await directConnect(host, port);
  } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head?.length) remote.write(head);
  client.pipe(remote).pipe(client);
  client.on('error', () => remote.destroy());
  remote.on('error', () => client.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(`jcode provider proxy on http://${HOST}:${PORT} (socks upstream port from ${STATE})`);
});
