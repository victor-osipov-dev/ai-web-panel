import net from 'node:net';
import http from 'node:http';
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

const server = http.createServer((req, res) => {
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
      : await new Promise((resolve, reject) => {
          const s = net.connect(port, host, () => resolve(s));
          s.on('error', reject);
        });
  } catch (e) {
    client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n`);
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
