'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  proxify,
  parseTarget,
  rewriteHtml,
  rewriteCss,
  rewriteSetCookie,
  cookieHeaderToUpstream,
} = require('../rewrite.js');

const PAGE = 'https://example.com/dir/page.html';

test('proxify resolves relative, root-relative, protocol-relative and absolute URLs', () => {
  assert.strictEqual(proxify('other.html', PAGE), '/p/https://example.com/dir/other.html');
  assert.strictEqual(proxify('/root?a=1', PAGE), '/p/https://example.com/root?a=1');
  assert.strictEqual(proxify('//cdn.example.net/x.js', PAGE), '/p/https://cdn.example.net/x.js');
  assert.strictEqual(proxify('http://other.org/', PAGE), '/p/http://other.org/');
});

test('proxify leaves fragments, special schemes and proxied URLs alone', () => {
  for (const url of ['#top', 'javascript:void(0)', 'data:image/png;base64,AA', 'mailto:a@b.c', '/p/https://x.com/', '']) {
    assert.strictEqual(proxify(url, PAGE), url);
  }
});

test('parseTarget reads the target URL from a proxy path', () => {
  assert.strictEqual(parseTarget('/p/https://example.com/a?b=1').href, 'https://example.com/a?b=1');
  assert.strictEqual(parseTarget('/p/https:/example.com/a').href, 'https://example.com/a');
  assert.strictEqual(parseTarget('/p/example.com').href, 'https://example.com/');
  assert.strictEqual(parseTarget('/other'), null);
});

test('rewriteHtml rewrites URL attributes and injects the client script into <head>', () => {
  const html = `<!doctype html><html><head><title>t</title>
    <link rel="stylesheet" href="/s.css" integrity="sha384-abc">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
    <meta http-equiv="refresh" content="5; url=/next">
    </head><body>
    <a href="a.html?x=1&amp;y=2">a</a>
    <a href='#frag'>f</a>
    <img src=/i.png srcset="/i1.png 1x, /i2.png 2x" style="background:url('/bg.png')">
    <form action="/search"><button formaction="/alt">go</button></form>
    <div title="has > inside" data-x="1"><a href="/b">b</a></div>
    <style>.c{background:url(/c.png)}</style>
    <script>var s = '<a href="/not-rewritten">';</script>
    <!-- <a href="/in-comment"> -->
    </body></html>`;
  const out = rewriteHtml(html, PAGE, '<script src="/__proxy/client.js"></script>');

  assert.match(out, /<head><script src="\/__proxy\/client\.js"><\/script><title>/);
  assert.match(out, /href="\/p\/https:\/\/example\.com\/s\.css"/);
  assert.doesNotMatch(out, /integrity/);
  assert.doesNotMatch(out, /Content-Security-Policy/);
  assert.match(out, /content="5; url=\/p\/https:\/\/example\.com\/next"/);
  assert.match(out, /href="\/p\/https:\/\/example\.com\/dir\/a\.html\?x=1&amp;y=2"/);
  assert.match(out, /href="#frag"/);
  assert.match(out, /src="\/p\/https:\/\/example\.com\/i\.png"/);
  assert.match(out, /srcset="\/p\/https:\/\/example\.com\/i1\.png 1x, \/p\/https:\/\/example\.com\/i2\.png 2x"/);
  assert.match(out, /url\('\/p\/https:\/\/example\.com\/bg\.png'\)/);
  assert.match(out, /action="\/p\/https:\/\/example\.com\/search"/);
  assert.match(out, /formaction="\/p\/https:\/\/example\.com\/alt"/);
  assert.match(out, /href="\/p\/https:\/\/example\.com\/b"/);
  assert.match(out, /url\(\/p\/https:\/\/example\.com\/c\.png\)/);
  assert.match(out, /'<a href="\/not-rewritten">'/);
  assert.match(out, /<!-- <a href="\/in-comment"> -->/);
});

test('rewriteHtml honors <base href>', () => {
  const out = rewriteHtml('<head><base href="https://cdn.example.net/assets/"></head><img src="x.png">', PAGE);
  assert.match(out, /<base href="\/p\/https:\/\/cdn\.example\.net\/assets\/">/);
  assert.match(out, /src="\/p\/https:\/\/cdn\.example\.net\/assets\/x\.png"/);
});

test('rewriteHtml injects the script even without a <head>', () => {
  assert.strictEqual(rewriteHtml('<html><p>hi</p>', PAGE, '<s>'), '<html><s><p>hi</p>');
  assert.strictEqual(rewriteHtml('<p>hi</p>', PAGE, '<s>'), '<s><p>hi</p>');
});

test('rewriteCss rewrites url() and @import', () => {
  const css = `@import "theme.css"; a{background:url( "/x.png" )} b{background:url(data:image/png;base64,AA)}`;
  const out = rewriteCss(css, PAGE);
  assert.match(out, /@import "\/p\/https:\/\/example\.com\/dir\/theme\.css"/);
  assert.match(out, /url\("\/p\/https:\/\/example\.com\/x\.png"\)/);
  assert.match(out, /url\(data:image\/png;base64,AA\)/);
});

test('rewriteSetCookie scopes cookies to the site under the proxy', () => {
  const target = new URL(PAGE);
  assert.strictEqual(
    rewriteSetCookie('sid=abc; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=None', target),
    'sid=abc; Path=/p/https://example.com/; HttpOnly; SameSite=Lax',
  );
  assert.strictEqual(rewriteSetCookie('__Host-t=1; Path=/; Secure', target), '__pHost-t=1; Path=/p/https://example.com/');
  assert.strictEqual(rewriteSetCookie('a=b', target), 'a=b');
});

test('cookieHeaderToUpstream restores disguised cookie names', () => {
  assert.strictEqual(cookieHeaderToUpstream('__pHost-t=1; a=b=c'), '__Host-t=1; a=b=c');
});
