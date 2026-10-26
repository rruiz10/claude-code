'use strict';

// Rewrites URLs in HTML, CSS and cookies so that everything a proxied page
// loads goes back through the proxy. A proxied URL looks like
// /p/https://example.com/some/path.

const PREFIX = '/p/';

// URLs with these schemes are left alone.
const SKIP_SCHEMES = /^(?:data|javascript|mailto|tel|sms|blob|about):/i;

// Turns any URL found in a page into a proxy URL, resolving it against `base`.
function proxify(raw, base) {
  if (raw == null) return raw;
  const value = String(raw).trim();
  if (!value || value.startsWith('#') || value.startsWith(PREFIX) || SKIP_SCHEMES.test(value)) return raw;
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return raw;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
  return PREFIX + url.href;
}

// Reads the target URL out of a request path like /p/https://example.com/x.
// Accepts a missing scheme (/p/example.com) and a collapsed one (/p/https:/example.com).
function parseTarget(reqPath) {
  if (!reqPath.startsWith(PREFIX)) return null;
  let rest = reqPath.slice(PREFIX.length).replace(/^(https?):\/+/i, '$1://');
  if (!/^https?:\/\//i.test(rest)) rest = 'https://' + rest;
  try {
    return new URL(rest);
  } catch {
    return null;
  }
}

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };

function decodeEntities(s) {
  return s.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([0-9a-f]+));/gi, (m, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[m.toLowerCase()];
  });
}

const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => `url(${q}${proxify(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${proxify(u, base)}${q}`);
}

function rewriteSrcset(value, base) {
  // Commas inside data: URLs would break the split, and they need no rewriting anyway.
  if (/data:/i.test(value)) return value;
  return value
    .split(',')
    .map((part) => {
      const m = /^(\s*)(\S+)([\s\S]*)$/.exec(part);
      return m ? m[1] + proxify(m[2], base) + m[3] : part;
    })
    .join(',');
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background', 'data', 'cite', 'manifest']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
// An attribute with a quoted or unquoted value.
const ATTR_RE = /([^\s"'<>/=]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
// An opening tag, allowing ">" inside quoted attribute values.
const OPEN_TAG = `<[a-zA-Z](?:"[^"]*"|'[^']*'|[^'">])*>`;
const TOKEN_RE = new RegExp(
  `<!--[\\s\\S]*?-->|(${OPEN_TAG.replace('[a-zA-Z]', '(script|style)\\b')})([\\s\\S]*?)</\\2\\s*>|${OPEN_TAG}`,
  'gi',
);

function rewriteTag(tag, base) {
  const name = /^<([a-zA-Z][\w:-]*)/.exec(tag)[1].toLowerCase();
  if (name === 'meta' && /http-equiv\s*=\s*["']?content-security-policy/i.test(tag)) return '';
  const isRefresh = name === 'meta' && /http-equiv\s*=\s*["']?refresh/i.test(tag);

  return tag.replace(ATTR_RE, (m, attr, eq, dq, sq, uq) => {
    const key = attr.toLowerCase();
    // Subresource integrity hashes can't match once the proxy has rewritten a file.
    if (key === 'integrity') return '';
    const raw = decodeEntities(dq ?? sq ?? uq);
    let value;
    if (URL_ATTRS.has(key)) value = proxify(raw, base);
    else if (SRCSET_ATTRS.has(key)) value = rewriteSrcset(raw, base);
    else if (key === 'style') value = rewriteCss(raw, base);
    else if (key === 'content' && isRefresh) {
      value = raw.replace(/(url\s*=\s*['"]?)([^'"]+)/i, (_, p, u) => p + proxify(u.trim(), base));
    } else return m;
    return `${attr}="${escapeAttr(value)}"`;
  });
}

// Rewrites every URL in an HTML document and injects `inject` (the client
// script) as early in <head> as possible, so it runs before the page's own scripts.
function rewriteHtml(html, pageUrl, inject = '') {
  let base = pageUrl;
  let injected = !inject;

  let out = html.replace(TOKEN_RE, (tok, blockOpen, blockName, blockBody) => {
    if (tok.startsWith('<!--')) return tok;
    if (blockOpen) {
      const body = blockName.toLowerCase() === 'style' ? rewriteCss(blockBody, base) : blockBody;
      return `${rewriteTag(blockOpen, base)}${body}</${blockName}>`;
    }
    if (/^<base\b/i.test(tok)) {
      const m = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tok);
      if (m) {
        try {
          base = new URL(decodeEntities(m[1] ?? m[2] ?? m[3]), base).href;
        } catch {}
      }
    }
    let rewritten = rewriteTag(tok, base);
    if (!injected && /^<head\b/i.test(tok)) {
      injected = true;
      rewritten += inject;
    }
    return rewritten;
  });

  if (!injected) {
    const m = /<html\b(?:"[^"]*"|'[^']*'|[^'">])*>|<!doctype[^>]*>/i.exec(out);
    const at = m ? m.index + m[0].length : 0;
    out = out.slice(0, at) + inject + out.slice(at);
  }
  return out;
}

// Browsers only accept __Host- and __Secure- cookies with Path=/ and Secure,
// which the proxy can't keep, so their names are disguised on the way in.
const toBrowserName = (name) => name.replace(/^__(Host|Secure)-/, '__p$1-');
const toUpstreamName = (name) => name.replace(/^__p(Host|Secure)-/, '__$1-');

// Scopes a site's cookie to that site's path on the proxy, so cookies from
// different sites don't mix.
function rewriteSetCookie(cookie, target) {
  const [pair, ...attrs] = cookie.split(';');
  const eq = pair.indexOf('=');
  const name = eq === -1 ? '' : pair.slice(0, eq).trim();
  const out = [eq === -1 ? pair.trim() : `${toBrowserName(name)}=${pair.slice(eq + 1).trim()}`];

  for (const attr of attrs) {
    const [k, ...v] = attr.trim().split('=');
    const key = k.toLowerCase();
    const value = v.join('=').trim();
    if (key === 'domain' || key === 'secure' || key === 'partitioned' || !key) continue;
    if (key === 'path') out.push(`Path=${PREFIX}${target.origin}${value.startsWith('/') ? value : '/'}`);
    // SameSite=None needs Secure, which a plain-http proxy can't set.
    else if (key === 'samesite') out.push('SameSite=Lax');
    else out.push(attr.trim());
  }
  return out.join('; ');
}

function cookieHeaderToUpstream(header) {
  return header
    .split(';')
    .map((c) => {
      const eq = c.indexOf('=');
      return eq === -1 ? c.trim() : `${toUpstreamName(c.slice(0, eq).trim())}=${c.slice(eq + 1)}`;
    })
    .join('; ');
}

module.exports = {
  PREFIX,
  proxify,
  parseTarget,
  rewriteHtml,
  rewriteCss,
  rewriteSetCookie,
  cookieHeaderToUpstream,
};
