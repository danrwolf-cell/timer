// Web design preview: expo-sqlite on web needs SharedArrayBuffer, which
// browsers only expose on cross-origin-isolated pages. Expo's dev server
// serves the HTML document without COOP/COEP headers, so this proxy sits in
// front of it (PORT -> TARGET_PORT) and adds them. Websocket upgrades are
// piped through so fast refresh keeps working.
//
//   npm run web:preview        # starts Metro on 8081 and this proxy on 8080
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const TARGET_PORT = Number(process.env.TARGET_PORT || 8081);

// sql.js's wasm, for src/db/open-db.web.ts.
const SQLJS_WASM = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

const server = http.createServer((req, res) => {
  if (req.url === '/__sqljs/sql-wasm.wasm') {
    res.writeHead(200, { 'Content-Type': 'application/wasm' });
    fs.createReadStream(SQLJS_WASM).pipe(res);
    return;
  }
  const upstream = http.request(
    { host: 'localhost', port: TARGET_PORT, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode, {
        ...up.headers,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      });
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('Metro is not up yet on port ' + TARGET_PORT);
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, 'localhost', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => console.log(`web preview: http://localhost:${PORT} -> :${TARGET_PORT}`));
