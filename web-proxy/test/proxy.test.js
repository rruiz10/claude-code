'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const { createProxy, hostMatches, stripHopByHop } = require('../proxy.js');

let origin;
let originPort;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Starts a proxy with the given options and returns its port and a close function.
async function startProxy(options = {}) {
  const proxy = createProxy({ log: () => {}, ...options });
  const port = await listen(proxy);
  return { port, close: () => new Promise((r) => proxy.close(r)) };
}

// Sends a request through the proxy and resolves with { status, headers, body }.
function viaProxy(proxyPort, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Opens a CONNECT tunnel and resolves with the raw status line and the socket.
function connect(proxyPort, authority, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority, headers });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  origin = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  originPort = await listen(origin);
});

after(() => origin.close());

test('relays plain HTTP requests', async () => {
  const proxy = await startProxy();
  try {
    const res = await viaProxy(proxy.port, `http://127.0.0.1:${originPort}/hello?x=1`, {
      method: 'POST',
      headers: { 'X-Custom': 'yes', 'Proxy-Connection': 'keep-alive' },
      body: 'payload',
    });
    assert.strictEqual(res.status, 200);
    const echoed = JSON.parse(res.body);
    assert.strictEqual(echoed.method, 'POST');
    assert.strictEqual(echoed.url, '/hello?x=1');
    assert.strictEqual(echoed.body, 'payload');
    assert.strictEqual(echoed.headers['x-custom'], 'yes');
    assert.strictEqual(echoed.headers['proxy-connection'], undefined);
  } finally {
    await proxy.close();
  }
});

test('rejects non-proxy requests', async () => {
  const proxy = await startProxy();
  try {
    const res = await viaProxy(proxy.port, '/just-a-path');
    assert.strictEqual(res.status, 400);
  } finally {
    await proxy.close();
  }
});

test('returns 502 when upstream is unreachable', async () => {
  const closed = net.createServer();
  const deadPort = await listen(closed);
  await new Promise((r) => closed.close(r));
  const proxy = await startProxy();
  try {
    const res = await viaProxy(proxy.port, `http://127.0.0.1:${deadPort}/`);
    assert.strictEqual(res.status, 502);
  } finally {
    await proxy.close();
  }
});

test('blocks hosts on the block list and outside the allow list', async () => {
  const blocked = await startProxy({ block: ['127.0.0.1'] });
  const allowOnly = await startProxy({ allow: ['*.example.com'] });
  try {
    assert.strictEqual((await viaProxy(blocked.port, `http://127.0.0.1:${originPort}/`)).status, 403);
    assert.strictEqual((await viaProxy(allowOnly.port, `http://127.0.0.1:${originPort}/`)).status, 403);
    assert.strictEqual((await connect(blocked.port, `127.0.0.1:${originPort}`)).status, 403);
  } finally {
    await blocked.close();
    await allowOnly.close();
  }
});

test('requires proxy auth when configured', async () => {
  const proxy = await startProxy({ auth: 'user:secret' });
  const url = `http://127.0.0.1:${originPort}/`;
  const good = 'Basic ' + Buffer.from('user:secret').toString('base64');
  const bad = 'Basic ' + Buffer.from('user:wrong').toString('base64');
  try {
    const none = await viaProxy(proxy.port, url);
    assert.strictEqual(none.status, 407);
    assert.match(none.headers['proxy-authenticate'], /Basic/);
    assert.strictEqual((await viaProxy(proxy.port, url, { headers: { 'Proxy-Authorization': bad } })).status, 407);

    const ok = await viaProxy(proxy.port, url, { headers: { 'Proxy-Authorization': good } });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).headers['proxy-authorization'], undefined, 'credentials must not leak upstream');

    assert.strictEqual((await connect(proxy.port, `127.0.0.1:${originPort}`)).status, 407);
  } finally {
    await proxy.close();
  }
});

test('tunnels CONNECT traffic', async () => {
  const proxy = await startProxy();
  try {
    const { status, socket } = await connect(proxy.port, `127.0.0.1:${originPort}`);
    assert.strictEqual(status, 200);
    const reply = await new Promise((resolve) => {
      let data = '';
      socket.on('data', (c) => (data += c));
      socket.on('end', () => resolve(data));
      socket.write('GET /through-tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /"url":"\/through-tunnel"/);
  } finally {
    await proxy.close();
  }
});

test('hostMatches handles exact and wildcard patterns', () => {
  assert.ok(hostMatches('example.com', 'example.com'));
  assert.ok(hostMatches('Example.COM', 'example.com'));
  assert.ok(hostMatches('example.com', '*.example.com'));
  assert.ok(hostMatches('a.b.example.com', '*.example.com'));
  assert.ok(!hostMatches('badexample.com', '*.example.com'));
  assert.ok(!hostMatches('sub.example.com', 'example.com'));
});

test('stripHopByHop removes connection-scoped headers', () => {
  const out = stripHopByHop({ connection: 'close, x-foo', 'x-foo': '1', 'keep-alive': '5', accept: '*/*' });
  assert.deepStrictEqual(out, { accept: '*/*' });
});
