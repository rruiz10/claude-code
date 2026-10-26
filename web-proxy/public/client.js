// Injected at the top of every proxied page. The server rewrites the URLs it
// can see in the HTML and CSS; this catches the ones a page builds at runtime
// (fetch, XHR, new elements, navigation) and adds a small address bar.
(() => {
  'use strict';
  if (window.__webProxy) return;
  window.__webProxy = true;

  const PREFIX = '/p/';
  const ORIGIN = location.origin;
  const SKIP = /^(?:data|javascript|mailto|tel|sms|blob|about):/i;

  // The real URL a proxy URL stands for, or null.
  function unproxify(href) {
    if (!href || !href.startsWith(ORIGIN + PREFIX)) return null;
    return href.slice(ORIGIN.length + PREFIX.length);
  }

  const pageUrl = () => unproxify(location.href);
  const baseUrl = () => unproxify(document.baseURI) || pageUrl();

  function proxify(input) {
    if (input == null) return input;
    const value = String(input).trim();
    if (!value || value[0] === '#' || value.startsWith(PREFIX) || value.startsWith('/__proxy/') || SKIP.test(value)) {
      return input;
    }
    let url;
    try {
      url = new URL(value, baseUrl() || undefined);
    } catch {
      return input;
    }
    if (url.origin === ORIGIN) {
      if (url.pathname.startsWith(PREFIX) || url.pathname.startsWith('/__proxy/')) return url.href;
      // Something resolved against the proxy instead of the site; move it onto the site.
      const base = baseUrl();
      if (!base) return input;
      url = new URL(url.pathname + url.search + url.hash, base);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return input;
    return ORIGIN + PREFIX + url.href;
  }

  function proxifySrcset(value) {
    if (value == null || /data:/i.test(value)) return value;
    return String(value)
      .split(',')
      .map((part) => part.replace(/^(\s*)(\S+)/, (m, space, u) => space + proxify(u)))
      .join(',');
  }

  function proxifyCss(css) {
    return String(css)
      .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => `url(${q}${proxify(u)}${q})`)
      .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${proxify(u)}${q}`);
  }

  // Network APIs.
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    if (input instanceof Request) input = new Request(proxify(input.url), input);
    else input = proxify(input);
    return nativeFetch.call(this, input, init);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return nativeOpen.call(this, method, proxify(url), ...rest);
  };

  if (navigator.sendBeacon) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => nativeBeacon(proxify(url), data);
  }

  for (const name of ['EventSource', 'Worker', 'SharedWorker']) {
    const Native = window[name];
    if (!Native) continue;
    window[name] = new Proxy(Native, {
      construct: (Target, [url, ...rest]) => new Target(proxify(url), ...rest),
    });
  }

  // A service worker would control every proxied site at once, so don't allow one.
  if (navigator.serviceWorker) {
    try {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        value: () => Promise.reject(new DOMException('Service workers are disabled by the proxy', 'SecurityError')),
      });
    } catch {}
  }

  // Navigation.
  const nativeWindowOpen = window.open;
  window.open = function (url, ...rest) {
    return nativeWindowOpen.call(this, url == null ? url : proxify(url), ...rest);
  };

  for (const method of ['pushState', 'replaceState']) {
    const native = history[method];
    history[method] = function (state, title, url) {
      return url == null ? native.call(this, state, title) : native.call(this, state, title, proxify(url));
    };
  }

  // Catches location.href = '...' and similar, in browsers with the Navigation API.
  // `leaving` lets the address bar's own links out of the proxy through.
  let leaving = false;
  if (window.navigation) {
    navigation.addEventListener('navigate', (event) => {
      const dest = event.destination.url;
      if (leaving) return;
      if (dest.startsWith(ORIGIN + PREFIX) || dest.startsWith(ORIGIN + '/__proxy/') || !event.cancelable) return;
      const fixed = proxify(dest);
      if (fixed === dest) return;
      event.preventDefault();
      location.assign(fixed);
    });
  }

  // Elements. Property setters and setAttribute cover URLs set from script;
  // the MutationObserver covers markup inserted with innerHTML.
  const URL_PROPS = [
    ['HTMLAnchorElement', 'href'],
    ['HTMLAreaElement', 'href'],
    ['HTMLLinkElement', 'href'],
    ['HTMLBaseElement', 'href'],
    ['HTMLImageElement', 'src'],
    ['HTMLScriptElement', 'src'],
    ['HTMLIFrameElement', 'src'],
    ['HTMLFrameElement', 'src'],
    ['HTMLMediaElement', 'src'],
    ['HTMLSourceElement', 'src'],
    ['HTMLTrackElement', 'src'],
    ['HTMLEmbedElement', 'src'],
    ['HTMLInputElement', 'src'],
    ['HTMLFormElement', 'action'],
    ['HTMLInputElement', 'formAction'],
    ['HTMLButtonElement', 'formAction'],
    ['HTMLObjectElement', 'data'],
    ['HTMLVideoElement', 'poster'],
  ];
  for (const [cls, prop] of URL_PROPS) {
    const proto = window[cls]?.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.set) continue;
    Object.defineProperty(proto, prop, {
      ...desc,
      set(value) {
        desc.set.call(this, proxify(value));
      },
    });
  }
  for (const cls of ['HTMLImageElement', 'HTMLSourceElement']) {
    const proto = window[cls]?.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'srcset');
    if (!desc?.set) continue;
    Object.defineProperty(proto, 'srcset', {
      ...desc,
      set(value) {
        desc.set.call(this, proxifySrcset(value));
      },
    });
  }
  // Integrity hashes can't match files the proxy rewrites.
  const integrity = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'integrity');
  if (integrity?.set) Object.defineProperty(HTMLScriptElement.prototype, 'integrity', { ...integrity, set() {} });

  // CSS added from script: rules, constructed sheets and <style> text.
  const sheet = CSSStyleSheet.prototype;
  const nativeInsertRule = sheet.insertRule;
  sheet.insertRule = function (rule, ...rest) {
    return nativeInsertRule.call(this, proxifyCss(rule), ...rest);
  };
  for (const method of ['replace', 'replaceSync']) {
    const native = sheet[method];
    if (native) sheet[method] = function (text) { return native.call(this, proxifyCss(text)); };
  }

  function fixStyle(el) {
    const css = el.textContent;
    if (!/url\(|@import/i.test(css)) return;
    const fixed = proxifyCss(css);
    if (fixed !== css) el.textContent = fixed;
  }

  const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'data']);
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const key = String(name).toLowerCase();
    if (key === 'integrity') return;
    if (URL_ATTRS.has(key) && !(key === 'data' && !(this instanceof HTMLObjectElement))) value = proxify(value);
    else if (key === 'srcset' || key === 'imagesrcset') value = proxifySrcset(value);
    return nativeSetAttribute.call(this, name, value);
  };

  function fixElement(el) {
    for (const attr of ['href', 'src', 'action', 'formaction', 'poster']) {
      const value = el.getAttribute(attr);
      if (value == null) continue;
      const fixed = proxify(value);
      if (fixed !== value) nativeSetAttribute.call(el, attr, fixed);
    }
    const srcset = el.getAttribute('srcset');
    if (srcset != null) {
      const fixed = proxifySrcset(srcset);
      if (fixed !== srcset) nativeSetAttribute.call(el, 'srcset', fixed);
    }
    if (el.hasAttribute('integrity')) el.removeAttribute('integrity');
    if (el.tagName === 'STYLE') fixStyle(el);
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Text added to an existing <style>.
      if (m.target.nodeName === 'STYLE') {
        fixStyle(m.target);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        fixElement(node);
        for (const child of node.querySelectorAll('[href],[src],[action],[formaction],[poster],[srcset],[integrity],style')) {
          fixElement(child);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Cookies set from script get the same per-site path the server gives them.
  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookieDesc) {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: true,
      get() {
        return cookieDesc.get.call(this).replace(/(^|;\s*)__p(Host|Secure)-/g, '$1__$2-');
      },
      set(value) {
        const page = pageUrl();
        if (!page) return cookieDesc.set.call(this, value);
        const origin = new URL(page).origin;
        const [pair, ...attrs] = String(value).split(';');
        const out = [pair.trim().replace(/^__(Host|Secure)-/, '__p$1-')];
        for (const attr of attrs) {
          const [k, ...v] = attr.trim().split('=');
          const key = k.toLowerCase();
          const val = v.join('=').trim();
          if (!key || key === 'domain' || key === 'secure' || key === 'partitioned') continue;
          if (key === 'path') out.push(`path=${PREFIX}${origin}${val.startsWith('/') ? val : '/'}`);
          else if (key === 'samesite') out.push('samesite=lax');
          else out.push(attr.trim());
        }
        cookieDesc.set.call(this, out.join('; '));
      },
    });
  }

  // The address bar, in the top window only.
  if (window.top !== window) return;

  function addBar() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { --bg:#fff; --fg:#1c1c1e; --muted:#6b6b70; --line:#d5d5da; --accent:#2f6fde; }
        @media (prefers-color-scheme: dark) {
          :host { --bg:#1e1e20; --fg:#f2f2f4; --muted:#a0a0a6; --line:#3a3a3e; --accent:#6ea0ff; }
        }
        * { box-sizing:border-box; font:14px/1.2 system-ui,-apple-system,sans-serif; }
        .bar { display:flex; gap:6px; align-items:center; background:var(--bg); color:var(--fg);
               border:1px solid var(--line); border-radius:999px; padding:4px;
               box-shadow:0 4px 16px rgba(0,0,0,.18); }
        button, a { all:unset; cursor:pointer; color:var(--fg); width:32px; height:32px; border-radius:50%;
                    display:grid; place-items:center; }
        button:hover, a:hover { background:color-mix(in srgb, var(--fg) 8%, transparent); }
        button:focus-visible, a:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
        form { display:none; gap:6px; }
        .open form { display:flex; }
        input { all:unset; width:min(60vw, 420px); padding:0 10px; height:32px; color:var(--fg);
                border:1px solid var(--line); border-radius:999px; }
        svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:2;
              stroke-linecap:round; stroke-linejoin:round; }
      </style>
      <div class="bar">
        <form>
          <a href="/" title="Proxy home" aria-label="Proxy home">
            <svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg></a>
          <input name="url" aria-label="Address" spellcheck="false" autocomplete="off">
        </form>
        <button type="button" class="toggle" title="Show address bar" aria-label="Show address bar" aria-expanded="false">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
        </button>
      </div>`;

    const bar = root.querySelector('.bar');
    const input = root.querySelector('input');
    const toggle = root.querySelector('.toggle');
    root.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      leaving = true;
      if (input.value.trim()) location.assign('/go?url=' + encodeURIComponent(input.value));
    });
    root.querySelector('a').addEventListener('click', () => (leaving = true));
    toggle.addEventListener('click', () => {
      const open = bar.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        input.value = pageUrl() || '';
        input.focus();
        input.select();
      }
    });
    document.documentElement.appendChild(host);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBar);
  else addBar();
})();
