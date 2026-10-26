# web-proxy

A web-based browsing proxy for Node.js 20+, with no dependencies. Open its
home page, type an address or some search words, and the site loads through
the server, so the site sees the server's IP address instead of yours.

```sh
node server.js            # then open http://127.0.0.1:8080
```

Pages are shown at addresses like `http://127.0.0.1:8080/p/https://example.com/`.
While browsing, the round button in the bottom-right corner opens an address
bar for going somewhere else.

## How it works

- `server.js` fetches the page. It rewrites every URL in the HTML and CSS to go
  back through `/p/`. It also removes headers that would stop the page from
  working under the proxy's address, such as Content-Security-Policy and
  X-Frame-Options.
- `public/client.js` is injected at the top of every page. It catches URLs that
  scripts build while the page runs: `fetch`, XHR, new elements, `innerHTML`,
  inserted `<style>` text, `history.pushState` and `location` changes. It also
  adds the address bar.
- Each site's cookies are stored under that site's own path, such as
  `/p/https://example.com/`, so they don't mix between sites.
- Requests to the server's own local network are refused. Sites can't be used
  to reach `localhost`, `192.168.x.x` and so on unless you pass `--allow-private`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `-p, --port <n>` | `8080` or `$PORT` | Port to listen on |
| `-H, --host <addr>` | `127.0.0.1` | Address to bind. Use `0.0.0.0` to reach it from other devices |
| `--auth <user:pass>` | `$PROXY_AUTH` | Require a username and password |
| `--allow-private` | off | Allow fetching localhost and private network addresses |
| `--search <url>` | DuckDuckGo HTML | URL that search words are appended to |
| `--timeout <ms>` | `30000` | How long to wait for a site to respond |
| `-q, --quiet` | off | Don't log requests |

To use it from your phone or another computer, run it on a machine they can
reach:

```sh
node server.js --host 0.0.0.0 --auth me:a-long-password
```

## Limits

Rewriting pages is best-effort, the same as with any proxy of this kind.

- **Simple and mostly static sites work well.** Wikipedia, news sites and
  forums, for example.
- **Heavy web apps may partly break.** Some fail because they check which
  domain they're running on, or because they use WebSockets, which aren't
  proxied.
- **Sign-ins through Google, Apple and similar** often fail.
- **Some sites show a CAPTCHA or block traffic** from server and data-center IP
  addresses.

## Security

- **Every site shares one origin.** All sites you visit run under the proxy's
  address, so they share one browser origin. A malicious site could read the
  cookies and storage that other sites left under the proxy. Don't sign in to
  anything important through it.
- **The proxy can see all your traffic.** It decrypts and re-encrypts every
  page, so whoever runs it can read everything. Use HTTPS in front of it
  (for example a reverse proxy with TLS) if you reach it over a network you
  don't trust.
- **Set `--auth` before exposing it.** If you bind to `0.0.0.0` without
  `--auth`, anyone who finds the port can browse through your server.
- **The private-address check has a small gap.** It runs on the site's DNS
  answer before the request. A site that changes its DNS answer between the
  check and the request (DNS rebinding) could slip past it.

## Test

```sh
npm test
```
