#!/usr/bin/env node
// A web-based browsing proxy with no dependencies: open the home page, type a
// URL, and the site is fetched by this server and shown with its links
// rewritten to keep going through the proxy. Run `node server.js --help`.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const { Readable } = require('node:stream');
const { parseArgs } = require('node:util');
const {
  PREFIX,
  proxify,
  parseTarget,
  rewriteHtml,
  rewriteCss,
  rewriteSetCookie,
  cookieHeaderToUpstream,
} = require('./rewrite.js');

const HOME_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const CLIENT_JS = fs.readFileSync(path.join(__dirname, 'public', 'client.js'));
const INJECT = '<script src="/__proxy/client.js"></script>';
const DEFAULT_SEARCH = 'https://html.duckduckgo.com/html/?q=';

// Request headers that are not passed on to the site. Cookie, Referer and
// Origin are passed on after being translated.
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
  'content-length',
  'cookie',
  'referer',
  'origin',
  'forwarded',
  'x-real-ip',
]);

// Response headers that would stop the page working under the proxy's origin,
// or that no longer describe the body once it has been decoded or rewritten.
const DROP_RESPONSE = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'referrer-policy',
  'clear-site-data',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
  'link',
  'report-to',
  'nel',
  'alt-svc',
]);

// Addresses the proxy refuses to fetch unless started with --allow-private,
// so it can't be used to reach your own machine or local network.
const PRIVATE = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
]) {
  PRIVATE.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
]) {
  PRIVATE.addSubnet(addr, bits, 'ipv6');
}

function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  return PRIVATE.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

async function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateAddress(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.some(({ address }) => isPrivateAddress(address));
  } catch {
    return false; // Let the fetch fail and report it.
  }
}

// Turns what someone typed in the address box into a URL, or a search.
function normalizeInput(input, searchUrl = DEFAULT_SEARCH) {
  const q = input.trim();
  if (/^https?:\/\//i.test(q)) return q;
  if (/^(?:localhost|[^\s/]+\.[a-z]{2,}|\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:[/?#]\S*)?$/i.test(q)) return 'https://' + q;
  return searchUrl + encodeURIComponent(q);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendPage(res, status, title, message) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>${escapeHtml(title)}</title>` +
      `<body style="font:16px system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 16px">` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to the proxy home page</a></p>`,
  );
}

// Decodes a text body using its declared charset, so pages that aren't UTF-8
// survive being rewritten and re-sent as UTF-8.
function decodeText(buf, contentType, isHtml) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset && isHtml) {
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function checkAuth(req, auth) {
  if (!auth) return true;
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  return scheme?.toLowerCase() === 'basic' && !!value && Buffer.from(value, 'base64').toString() === auth;
}

// The page a request came from, as the real URL it stands for.
function refererTarget(req) {
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    return parseTarget(new URL(referer).pathname + new URL(referer).search);
  } catch {
    return null;
  }
}

function createProxy(options = {}) {
  const opts = {
    auth: null,
    allowPrivate: false,
    search: DEFAULT_SEARCH,
    timeout: 30_000,
    log: (line) => console.log(line),
    ...options,
  };

  const log = (req, status, note = '') =>
    opts.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${status}${note}`);

  async function proxyRequest(req, res, target) {
    if (!opts.allowPrivate && (await isPrivateHost(target.hostname))) {
      log(req, 403);
      return sendPage(res, 403, 'Blocked', `${target.hostname} is a private or local address.`);
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (DROP_REQUEST.has(key) || key.startsWith('x-forwarded-')) continue;
      if (key === 'authorization' && opts.auth) continue;
      headers[key] = value;
    }
    if (req.headers.cookie) headers.cookie = cookieHeaderToUpstream(req.headers.cookie);
    const from = refererTarget(req);
    if (from) headers.referer = from.href;
    if (req.headers.origin) headers.origin = (from || target).origin;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timed out')), opts.timeout);
    res.on('close', () => controller.abort());

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? req : undefined,
        duplex: 'half',
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err.cause?.code || err.cause?.message || err.message;
      log(req, 502, ` (${reason})`);
      return sendPage(res, 502, "Couldn't load that page", `${target.href}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const type = contentType.toLowerCase();
    const isHtml = type.includes('text/html') || type.includes('application/xhtml');
    const isCss = type.includes('text/css');
    const hasContent = req.method !== 'HEAD' && upstream.status !== 204 && upstream.status !== 304;
    const rewrite = (isHtml || isCss) && hasContent;

    const out = {};
    upstream.headers.forEach((value, key) => {
      if (!DROP_RESPONSE.has(key)) out[key] = value;
    });
    // fetch() has already decompressed the body, so a length is only still
    // right for bodies that were sent uncompressed and aren't rewritten.
    if (!rewrite && !upstream.headers.has('content-encoding') && upstream.headers.has('content-length')) {
      out['content-length'] = upstream.headers.get('content-length');
    }
    if (out.location) out.location = proxify(out.location, target.href);
    if (out.refresh) out.refresh = out.refresh.replace(/(url\s*=\s*)(\S+)/i, (_, p, u) => p + proxify(u, target.href));
    const cookies = upstream.headers.getSetCookie().map((c) => rewriteSetCookie(c, target));
    if (cookies.length) out['set-cookie'] = cookies;
    // Lets the proxy tell which site a stray request like /favicon.ico belongs to.
    out['referrer-policy'] = 'same-origin';

    log(req, upstream.status);

    if (rewrite) {
      const text = decodeText(Buffer.from(await upstream.arrayBuffer()), contentType, isHtml);
      const body = isHtml ? rewriteHtml(text, target.href, INJECT) : rewriteCss(text, target.href);
      out['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
      res.writeHead(upstream.status, out);
      return res.end(body);
    }

    res.writeHead(upstream.status, out);
    if (!hasContent || !upstream.body) return res.end();
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  async function handle(req, res) {
    if (!checkAuth(req, opts.auth)) {
      log(req, 401);
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="web proxy"' });
      return res.end('Authentication required\n');
    }

    const url = new URL(req.url, 'http://proxy');

    if (url.pathname === '/' && !url.search) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HOME_HTML);
    }
    if (url.pathname === '/__proxy/client.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(CLIENT_JS);
    }
    if (url.pathname === '/go') {
      const q = url.searchParams.get('url') || '';
      res.writeHead(302, { Location: q.trim() ? PREFIX + normalizeInput(q, opts.search) : '/' });
      return res.end();
    }
    if (req.url.startsWith(PREFIX)) {
      const target = parseTarget(req.url);
      if (!target) {
        log(req, 400);
        return sendPage(res, 400, 'Bad address', `Couldn't read a URL from ${req.url}.`);
      }
      return proxyRequest(req, res, target);
    }

    // A root-relative URL the rewriter missed, like a fetch('/api') built at
    // runtime. Send it to the same path on the site the request came from.
    const from = refererTarget(req);
    if (from) {
      res.writeHead(307, { Location: PREFIX + new URL(req.url, from).href });
      return res.end();
    }
    log(req, 404);
    sendPage(res, 404, 'Not found', 'Enter an address on the home page to start browsing.');
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(req, 500, ` (${err.message})`);
      if (!res.headersSent) sendPage(res, 500, 'Proxy error', err.message);
      else res.destroy();
    });
  });
}

const HELP = `Usage: node server.js [options]

  -p, --port <n>        Port to listen on (default 8080, or $PORT)
  -H, --host <addr>     Address to bind (default 127.0.0.1)
      --auth <u:p>      Require a username and password (or set $PROXY_AUTH)
      --allow-private   Allow fetching localhost and private network addresses
      --search <url>    Search URL that typed words are appended to
                        (default ${DEFAULT_SEARCH})
      --timeout <ms>    Time to wait for a site to respond (default 30000)
  -q, --quiet           Don't log requests
  -h, --help            Show this help
`;

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H', default: '127.0.0.1' },
      auth: { type: 'string' },
      'allow-private': { type: 'boolean', default: false },
      search: { type: 'string', default: DEFAULT_SEARCH },
      timeout: { type: 'string', default: '30000' },
      quiet: { type: 'boolean', short: 'q', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) return process.stdout.write(HELP);

  const port = Number(values.port || process.env.PORT || 8080);
  const auth = values.auth || process.env.PROXY_AUTH || null;
  if (!['127.0.0.1', 'localhost', '::1'].includes(values.host) && !auth) {
    console.warn(`Warning: listening on ${values.host} without --auth. Anyone who can reach this port can use it.`);
  }

  const server = createProxy({
    auth,
    allowPrivate: values['allow-private'],
    search: values.search,
    timeout: Number(values.timeout),
    log: values.quiet ? () => {} : (line) => console.log(line),
  });
  server.listen(port, values.host, () => {
    const shown = values.host.includes(':') ? `[${values.host}]` : values.host;
    console.log(`Web proxy running at http://${shown}:${port}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { createProxy, normalizeInput, isPrivateAddress };
