# HAProxy for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings the statistics of an [HAProxy](https://www.haproxy.org) load
balancer into Gladys: which backends have their servers, which server is out,
how many 5xx errors, and whether HAProxy itself answers.

- **An HAProxy device**: reachable, frontends open, backends down, servers up
  and in total, current sessions.
- **One device per backend** (with servers): available, servers up, servers in
  total, current sessions, share of 5xx errors since the previous read.
- **Optionally, one device per server**: online or not.
- **Scene triggers**: a server goes down (with its HAProxy status and last
  health check), is back up (with the outage length), a backend has no server
  left, HAProxy is unreachable — for any backend, added to Gladys or not.
- **Scene actions**: state of a backend and state of HAProxy, each with a
  ready-made sentence.
- **Dashboard widget**: backends down first, then degraded, then the others,
  and the servers out.
- Three sources: the statistics page (`stats uri`, CSV), the Data Plane API
  (v2 or v3), or the runtime API in TCP (`show stat`). Read-only.
- Texts in English, French, German and Spanish.

Tested against a real HAProxy 3.2 (Docker, `haproxytech/haproxy-alpine:3.2`
with its Data Plane API, two backends behind HTTP health checks on
`traefik/whoami` servers, one server that never resolves, servers stopped and
started again on purpose, basic auth). HAProxy 2.x has the same statistics but
was not tested: feedback welcome on
[the issues](https://github.com/guim31/gladys-haproxy/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- HAProxy reachable from the Gladys machine through one of: a statistics page
  (`stats enable` + `stats uri`, optionally `stats auth`), the Data Plane API,
  or a statistics socket in TCP (`stats socket ipv4@0.0.0.0:9999 level user`,
  trusted network only: it has no password).
- A health check (`check`) on the servers that should be watched: without one,
  HAProxy reports them "no check", counted up.

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-haproxy`. Then open its configuration,
choose the source, enter the address (and the user and password if any), and
add the devices from the Discover tab.

The full guide: [docs/en.md](docs/en.md) (also in [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

The container reads the statistics at the chosen interval (30 seconds by
default): one request, the same CSV for the statistics page (`<stats uri>;csv`)
and the runtime API (`show stat`), the same fields in JSON for the Data Plane
API (`/v3/services/haproxy/stats/native`, `/v2/…` as a fallback). It publishes
the states of the devices added to Gladys when they change, and fires the
scene events on the transitions. The last state of each backend and server and
the reachability of HAProxy are kept in `/data`, so a change during a restart
is announced once. Redirects are not followed, so the basic auth credentials
never reach another host.

## Limits

- Read-only: no server is put in maintenance or drained from Gladys.
- Backends without server (redirects, the statistics page) are not proposed.
- The 5xx share needs two reads, and starts again after a reload of HAProxy.
- A self-signed HTTPS certificate is not accepted (use `http://` on the local
  network).

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on the
statistics of HAProxy.

## Credits

- [HAProxy](https://www.haproxy.org) by Willy Tarreau and contributors (GPL
  2.0): the statistics in `test/fixtures/haproxy` come from the
  [HAProxy Technologies image](https://hub.docker.com/r/haproxytech/haproxy-alpine)
  with its Data Plane API (Apache-2.0), with
  [traefik/whoami](https://github.com/traefik/whoami) (Apache-2.0) as servers.
- Cover: the HAProxy logo by HAProxy Technologies,
  [from Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Haproxy-logo.png)
  (CC BY-SA 4.0); the cover itself is shared under the same license.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and on the architecture of
  [gladys-traefik](https://github.com/guim31/gladys-traefik).

Not affiliated with HAProxy Technologies.

## License

Apache-2.0, see [LICENSE](LICENSE).
