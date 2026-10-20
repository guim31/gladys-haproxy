# HAProxy

[HAProxy](https://www.haproxy.org) is the load balancer and reverse proxy in
front of many services: it spreads the requests over several servers, checks
that each one still answers, and takes a server out when it fails. This
integration brings its statistics into Gladys: an "HAProxy" device with the
frontends open and the servers up, and one device per backend with its
servers, sessions and share of 5xx errors. Scenes can react when **any**
server goes down or comes back, when a backend has no server left, or when
HAProxy itself no longer answers; a dashboard widget lists the backends down
first. Read-only: nothing is ever changed in HAProxy.

Tested against a real HAProxy 3.2 (Docker, the three sources below, two
backends behind HTTP health checks, servers stopped and started again on
purpose, basic auth). HAProxy 2.x has the same statistics and should work,
untested: feedback welcome on
[the issues](https://github.com/guim31/gladys-haproxy/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- HAProxy reachable from the Gladys machine through **one** of these sources:
  - **Statistics page (HTTP)**, the simplest: a frontend with the statistics
    page, optionally behind a user and password:

    ```
    frontend stats
      bind :8404
      stats enable
      stats uri /stats
      stats auth gladys:a-long-password
    ```

  - **Data Plane API**, if it already runs next to HAProxy (port 5555 by
    default): enter its user and password;
  - **Runtime API in TCP**: a statistics socket exposed on the network,
    `stats socket ipv4@0.0.0.0:9999 level user`. It has no password: only on
    a trusted network.
- To know whether a server is **down**, a health check on it (`check` on the
  `server` line, `option httpchk` for HTTP). Without one, HAProxy shows the
  server as "no check" and the integration counts it up.

## Getting started

### 1. Open the statistics of HAProxy

Add the statistics page above to `haproxy.cfg` (or the socket line in
`global`), reload HAProxy, and open `http://<HAProxy machine>:8404/stats` in a
browser: the page lists the frontends, backends and servers.

### 2. Configure the integration

In Gladys, open **Integrations → HAProxy → Configuration**:

- **Source**: Statistics page (HTTP), Data Plane API, or Runtime API in TCP
  (show stat).
- **Address**: the URL of the statistics page as in the browser
  (`http://192.168.1.2:8404/stats`), the base URL of the Data Plane API
  (`http://192.168.1.2:5555`), or `host:port` of the socket
  (`192.168.1.2:9999`).
- **User** and **Password**: those of `stats auth`, or of the Data Plane API.
  Leave empty otherwise.
- **One device per server**: also propose each server in the Discover tab.
- **Refresh interval**: 15 seconds to 5 minutes, 30 seconds by default. One
  light request each time.
- **Language of the names**: the language of the feature names and of the
  scene results.

Save, then press **Test the connection**: the answer gives the number of
backends and of servers up.

### 3. Add the devices

Open the **Discover** tab and add the HAProxy device and the backends to
follow. The scene triggers and the widget work for every backend, added or
not.

## The devices

**HAProxy**

| Feature          | Meaning                                                |
| ---------------- | ------------------------------------------------------ |
| Reachable        | 1 when the statistics answer, 0 after two failed reads |
| Frontends open   | frontends accepting connections (not stopped)          |
| Backends down    | backends without any server available                  |
| Servers up       | servers taking traffic, every backend                  |
| Servers in total | servers declared, every backend                        |
| Current sessions | sessions open on the frontends                         |

**One device per backend** (with at least one server), named as in HAProxy

| Feature          | Meaning                                                           |
| ---------------- | ----------------------------------------------------------------- |
| Available        | 1 when HAProxy has a server for it (backups included)             |
| Servers up       | servers taking traffic: UP, or without health check               |
| Servers in total | servers declared, backups included                                |
| Current sessions | sessions open on the backend                                      |
| 5xx errors       | share of 5xx among the HTTP answers since the previous read, in % |

**One device per server** (option), named `backend/server`: **Online**, 1 when
the server is UP or has no health check, 0 when DOWN, in maintenance (MAINT)
or draining.

## Dashboard

The **HAProxy** widget shows three tiles (backends down, servers out, backends
OK), then the backends — down first, then degraded, then the others — with
their servers up, and the servers out with their HAProxy status and last
health check (`DOWN · L4TOUT`). The **Refresh** button reads HAProxy at once.
Its settings can limit it to some backends (devices added to Gladys).

## Scenes

### Triggers

- **A server goes down**: a server stops taking traffic (DOWN, MAINT, drain).
  Variables: backend name, server name, HAProxy status, last health check.
- **A server is back up**: with the outage length in minutes.
- **A backend has no server left**: HAProxy has no server for it, backups
  included: its clients get 503 errors.
- **HAProxy is unreachable**: two reads in a row without answer, with the
  reason.

The first three can be limited to some backends (empty: any). Nothing fires
at the first read: only changes are announced, also those that happened while
Gladys or the integration restarted.

### Actions

- **State of a backend**: available or not, state, servers up and in total,
  current sessions, the servers out with their status, and a ready-made
  sentence ("app: Degraded, 1/2 server(s) up (app2: DOWN).").
- **State of HAProxy**: reachable or not, backends down with their names,
  servers up, and a sentence. "HAProxy does not answer" is an answer: the
  scene goes on.

### Scene ideas

- **A server goes down** → send a Telegram message "{{server}} of
  {{backend_name}}: {{status}} ({{check}})".
- **A backend has no server left** → a notification to every user, and a red
  light in the office.
- Every morning at 8:00 → **State of HAProxy** → send its sentence.

## Troubleshooting

- **"no HAProxy statistics at this address"**: check the source and the
  address. For the statistics page, open the same address followed by `;csv`
  in a browser: it must show lines starting with `# pxname,svname`.
- **"user or password refused"**: the user of `stats auth`, or of the Data
  Plane API.
- **"the address redirects"**: the page is served in HTTPS: enter the
  `https://` address.
- **A server stays up although its service is stopped**: it has no health
  check (`check` on the `server` line).
- **5xx errors stay empty**: the share needs two reads, and a backend in TCP
  mode has no HTTP answers (0 %).
- Logs: **Integrations → HAProxy → Logs**; `LOG_LEVEL=debug` shows every read.

## Limits

- Read-only: no server is put in maintenance or drained from Gladys.
- One HAProxy per integration. With several processes (`nbproc` of old
  versions), the first one is read.
- Backends without server (redirects, the statistics page) are not proposed.
- A self-signed HTTPS certificate is not accepted (use `http://` on the local
  network).
- The runtime API in TCP has no password: keep it on a trusted network.
