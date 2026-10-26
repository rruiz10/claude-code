#!/usr/bin/env node
// A small forward HTTP/HTTPS proxy with no dependencies.
//
// Plain HTTP requests are relayed; HTTPS is tunneled with CONNECT, so the
// proxy never sees decrypted traffic. Run `node proxy.js --help` for options.

'use strict';

const http = require('node:http');
const net = require('node:net');
const { parseArgs } = require('node:util');

// Headers that apply to a single connection and must not be forwarded (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers) {
  const out = { ...headers };
  const listed = String(headers.connection || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP, ...listed]) delete out[name];
  return out;
}

// A pattern is either an exact host or "*.example.com", which matches
// example.com and every subdomain of it.
function hostMatches(host, pattern) {
  host = host.toLowerCase();
  pattern = pattern.toLowerCase();
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === pattern;
}

function isHostAllowed(host, { allow, block }) {
  if (block.some((p) => hostMatches(host, p))) return false;
  if (allow.length === 0) return true;
  return allow.some((p) => hostMatches(host, p));
}

function checkAuth(req, auth) {
  if (!auth) return true;
  const header = req.headers['proxy-authorization'] || '';
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'basic' || !value) return false;
  return Buffer.from(value, 'base64').toString() === auth;
}

// Splits "host:port" or "[v6]:port" into its parts.
function splitHostPort(authority, defaultPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority) || /^([^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: m[1], port: Number(m[2] || defaultPort) };
}

function createProxy(options = {}) {
  const opts = {
    allow: [],
    block: [],
    auth: null,
    timeout: 30_000,
    log: (line) => console.log(line),
    ...options,
  };

  const log = (client, method, target, status) =>
    opts.log(`${new Date().toISOString()} ${client} ${method} ${target} ${status}`);

  const server = http.createServer((req, res) => {
    const client = req.socket.remoteAddress;

    if (!checkAuth(req, opts.auth)) {
      log(client, req.method, req.url, 407);
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy"' });
      return res.end('Proxy authentication required\n');
    }

    let target;
    try {
      target = new URL(req.url);
    } catch {
      target = null;
    }
    if (!target || target.protocol !== 'http:') {
      log(client, req.method, req.url, 400);
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('This is a proxy: send absolute http:// URLs, or use CONNECT for https.\n');
    }

    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!isHostAllowed(host, opts)) {
      log(client, req.method, req.url, 403);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end(`Blocked by proxy: ${host}\n`);
    }

    const headers = stripHopByHop(req.headers);
    headers.host = target.host;

    const upstream = http.request(
      {
        host,
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers,
        timeout: opts.timeout,
      },
      (upRes) => {
        log(client, req.method, req.url, upRes.statusCode);
        res.writeHead(upRes.statusCode, upRes.statusMessage, stripHopByHop(upRes.headers));
        upRes.pipe(res);
      },
    );

    upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
    upstream.on('error', (err) => {
      log(client, req.method, req.url, `502 (${err.message})`);
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Bad gateway: ${err.message}\n`);
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    const client = clientSocket.remoteAddress;
    const fail = (status, text) => {
      log(client, 'CONNECT', req.url, status);
      const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="proxy"\r\n' : '';
      clientSocket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Content-Length: 0\r\n\r\n`);
    };

    if (!checkAuth(req, opts.auth)) return fail(407, 'Proxy Authentication Required');

    const dest = splitHostPort(req.url, 443);
    if (!dest) return fail(400, 'Bad Request');
    if (!isHostAllowed(dest.host, opts)) return fail(403, 'Forbidden');

    const upstream = net.connect(dest.port, dest.host);
    upstream.setTimeout(opts.timeout, () => upstream.destroy(new Error('upstream timed out')));

    let established = false;
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(0);
      log(client, 'CONNECT', req.url, 200);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      // Once the tunnel is up we can't send an HTTP error, so just hang up.
      if (established) return clientSocket.destroy();
      fail(502, `Bad Gateway (${err.message})`);
    });
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

const HELP = `Usage: node proxy.js [options]

  -p, --port <n>        Port to listen on (default 8080, or $PORT)
  -H, --host <addr>     Address to bind (default 127.0.0.1)
      --allow <host>    Only allow these hosts; repeatable. "*.example.com" matches subdomains
      --block <host>    Block these hosts; repeatable. Checked before --allow
      --auth <u:p>      Require Basic proxy auth (or set $PROXY_AUTH)
      --timeout <ms>    Upstream connect/idle timeout (default 30000)
  -q, --quiet           Don't log requests
  -h, --help            Show this help
`;

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H', default: '127.0.0.1' },
      allow: { type: 'string', multiple: true, default: [] },
      block: { type: 'string', multiple: true, default: [] },
      auth: { type: 'string' },
      timeout: { type: 'string', default: '30000' },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const port = Number(values.port || process.env.PORT || 8080);
  const auth = values.auth || process.env.PROXY_AUTH || null;

  if (values.host !== '127.0.0.1' && values.host !== 'localhost' && values.host !== '::1' && !auth) {
    console.warn(
      `Warning: listening on ${values.host} without --auth. Anyone who can reach this port can use the proxy.`,
    );
  }

  const server = createProxy({
    allow: values.allow,
    block: values.block,
    auth,
    timeout: Number(values.timeout),
    log: values.quiet ? () => {} : (line) => console.log(line),
  });

  server.listen(port, values.host, () => {
    console.log(`Proxy listening on http://${values.host}:${port}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createProxy, hostMatches, isHostAllowed, stripHopByHop };
