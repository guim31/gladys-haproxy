# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- the optional **user and password** of the statistics page (`stats auth`) or
  of the Data Plane API, stored by Gladys in the integration configuration
  (never written to `/data`, never logged); they are only sent, in the
  `Authorization` header, to the address configured, and redirects are not
  followed so they never reach another host;
- the statistics of HAProxy (names, statuses and counters of the frontends,
  backends and servers; the Data Plane API also gives server addresses): kept
  in memory, only the names, statuses, health check results and counters are
  used, published to Gladys or logged;
- `/data/haproxy-state.json`: the source and address of HAProxy, the last
  state of each backend and server and since when (no secret);
- network: HTTP(S) requests to the statistics page or the Data Plane API, or
  one `show stat` command on the runtime API in TCP — a read-only command; the
  integration never sends any other command. No port is opened.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the third-party services and devices the integration talks to.
