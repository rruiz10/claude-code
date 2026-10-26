'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { createProxy, normalizeInput, isPrivateAddress } = require('../server.js');

let origin;
let site; // http://127.0.0.1:<port>
let proxy;
let proxyUrl;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(path, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/':
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'none'",
          'X-Frame-Options': 'DENY',
          'Set-Cookie': ['sid=1; Path=/; HttpOnly', 'pref=dark; Domain=127.0.0.1; Path=/settings'],
        });
        return res.end('<html><head></head><body><a href="/about">About</a><img src="logo.png"></body></html>');
      case '/gzip.html':
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync('<a href="/zipped">z</a>'));
      case '/latin1.html':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.from('<p>caf\xe9</p>', 'latin1'));
      case '/style.css':
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end('body{background:url(/bg.png)}');
      case '/redirect':
        res.writeHead(302, { Location: '/landing' });
        return res.end();
      case '/image.png':
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 4 });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/echo': {
        let body = '';
        req.on('data', (c) => (body += c));
        return req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
        });
      }
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('nope');
    }
  });
  site = `http://127.0.0.1:${await listen(origin)}`;
  proxy = createProxy({ allowPrivate: true, log: () => {} });
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

after(() => {
  origin.close();
  proxy.close();
});

test('serves the home page', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.body.toString(), /<form action="\/go"/);
});

test('/go turns addresses and searches into proxy URLs', async () => {
  assert.strictEqual((await get('/go?url=example.com')).headers.location, '/p/https://example.com');
  assert.strictEqual(normalizeInput('https://a.b/c'), 'https://a.b/c');
  assert.strictEqual(normalizeInput('localhost:3000/x'), 'https://localhost:3000/x');
  assert.match(normalizeInput('how do proxies work'), /duckduckgo\.com\/html\/\?q=how%20do%20proxies%20work$/);
});

test('rewrites HTML, strips blocking headers and scopes cookies', async () => {
  const res = await get(`/p/${site}/`);
  const body = res.body.toString();
  assert.strictEqual(res.status, 200);
  assert.match(body, /<head><script src="\/__proxy\/client\.js"><\/script><\/head>/);
  assert.ok(body.includes(`href="/p/${site}/about"`));
  assert.ok(body.includes(`src="/p/${site}/logo.png"`));
  assert.strictEqual(res.headers['content-security-policy'], undefined);
  assert.strictEqual(res.headers['x-frame-options'], undefined);
  assert.deepStrictEqual(res.headers['set-cookie'], [
    `sid=1; Path=/p/${site}/; HttpOnly`,
    `pref=dark; Path=/p/${site}/settings`,
  ]);
});

test('decompresses and re-encodes text bodies', async () => {
  const gz = await get(`/p/${site}/gzip.html`);
  assert.strictEqual(gz.headers['content-encoding'], undefined);
  assert.ok(gz.body.toString().includes(`href="/p/${site}/zipped"`));

  const latin1 = await get(`/p/${site}/latin1.html`);
  assert.strictEqual(latin1.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(latin1.body.toString('utf8').includes('café'));
});

test('rewrites CSS', async () => {
  const res = await get(`/p/${site}/style.css`);
  assert.strictEqual(res.body.toString(), `body{background:url(/p/${site}/bg.png)}`);
});

test('rewrites redirects', async () => {
  const res = await get(`/p/${site}/redirect`);
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, `/p/${site}/landing`);
});

test('streams binary bodies untouched', async () => {
  const res = await get(`/p/${site}/image.png`);
  assert.strictEqual(res.headers['content-length'], '4');
  assert.deepStrictEqual([...res.body], [0x89, 0x50, 0x4e, 0x47]);
});

test('forwards bodies and translates cookies, referer and origin', async () => {
  const res = await get(
    `/p/${site}/echo`,
    {
      Cookie: '__pHost-t=1; sid=1',
      Referer: `${proxyUrl}/p/${site}/form`,
      Origin: proxyUrl,
      'Content-Type': 'text/plain',
    },
    'POST',
    'hello',
  );
  const echoed = JSON.parse(res.body);
  assert.strictEqual(echoed.method, 'POST');
  assert.strictEqual(echoed.body, 'hello');
  assert.strictEqual(echoed.headers.cookie, '__Host-t=1; sid=1');
  assert.strictEqual(echoed.headers.referer, `${site}/form`);
  assert.strictEqual(echoed.headers.origin, site);
});

test('redirects stray root-relative requests using the Referer', async () => {
  const res = await get('/api/data?x=1', { Referer: `${proxyUrl}/p/${site}/page` });
  assert.strictEqual(res.status, 307);
  assert.strictEqual(res.headers.location, `/p/${site}/api/data?x=1`);
  assert.strictEqual((await get('/nothing')).status, 404);
});

test('passes upstream errors through and reports unreachable sites', async () => {
  assert.strictEqual((await get(`/p/${site}/missing`)).status, 404);
  assert.strictEqual((await get('/p/http://127.0.0.1:1/')).status, 502);
});

test('blocks private addresses by default', async () => {
  const strict = createProxy({ log: () => {} });
  const port = await listen(strict);
  try {
    const res = await new Promise((resolve) =>
      http.get(`http://127.0.0.1:${port}/p/${site}/`, resolve),
    );
    assert.strictEqual(res.statusCode, 403);
    res.resume();
  } finally {
    strict.close();
  }
  assert.ok(isPrivateAddress('10.1.2.3'));
  assert.ok(isPrivateAddress('::1'));
  assert.ok(isPrivateAddress('::ffff:192.168.0.1'));
  assert.ok(!isPrivateAddress('93.184.216.34'));
});

test('requires a password when auth is set', async () => {
  const locked = createProxy({ auth: 'u:p', allowPrivate: true, log: () => {} });
  const port = await listen(locked);
  const status = (headers) =>
    new Promise((resolve) =>
      http.get(`http://127.0.0.1:${port}/p/${site}/echo`, { headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }),
    );
  try {
    assert.strictEqual(await status({}), 401);
    assert.strictEqual(await status({ Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') }), 200);
  } finally {
    locked.close();
  }
});
