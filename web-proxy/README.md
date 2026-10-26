# web-proxy

A small forward HTTP/HTTPS proxy for Node.js 18+, in one file with no dependencies.

- Relays plain `http://` requests and strips hop-by-hop headers.
- Tunnels HTTPS with `CONNECT`, so it never decrypts your traffic.
- Optional Basic proxy authentication.
- Optional allow and block lists, with `*.example.com` wildcards.
- Logs one line per request.

## Run it

```sh
node proxy.js                    # listens on 127.0.0.1:8080
node proxy.js -p 3128 --auth alice:s3cret
node proxy.js --allow '*.github.com' --allow example.com
node proxy.js --block '*.doubleclick.net'
```

| Option | Default | Description |
| --- | --- | --- |
| `-p, --port <n>` | `8080` or `$PORT` | Port to listen on |
| `-H, --host <addr>` | `127.0.0.1` | Address to bind |
| `--allow <host>` | (all hosts) | Only allow these hosts. Repeatable |
| `--block <host>` | (none) | Block these hosts. Repeatable, checked before `--allow` |
| `--auth <user:pass>` | `$PROXY_AUTH` | Require Basic proxy auth |
| `--timeout <ms>` | `30000` | Upstream connect and idle timeout |
| `-q, --quiet` | off | Don't log requests |

## Use it

```sh
curl -x http://127.0.0.1:8080 https://example.com
export HTTP_PROXY=http://127.0.0.1:8080 HTTPS_PROXY=http://127.0.0.1:8080
```

For a browser, set the HTTP and HTTPS proxy to `127.0.0.1` port `8080`.

## Security

The proxy binds to `127.0.0.1` by default. If you bind it to another address
with `--host 0.0.0.0`, set `--auth` too, or anyone who can reach the port can
use your machine as an open proxy. Basic auth is sent in clear text between
the client and the proxy, so only use it on a network you trust.

Allow and block lists match the host name the client asked for. They don't
resolve DNS, so a block on a name doesn't block the same server reached by its
IP address.

## Use it as a library

```js
const { createProxy } = require('./proxy.js');
createProxy({ auth: 'u:p', block: ['*.ads.example'] }).listen(8080);
```

## Test

```sh
npm test
```
