# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- HAProxy in Gladys, read-only, from the statistics page (`stats uri`, CSV),
  the Data Plane API (v2 or v3) or the runtime API in TCP (`show stat`), with
  optional basic auth.
- An HAProxy device: reachable, frontends open, backends down, servers up and
  in total, current sessions.
- One device per backend with servers: available, servers up, servers in
  total, current sessions, share of 5xx errors since the previous read.
- Optionally, one device per server: online or not.
- Scene triggers: a server goes down, a server is back up (with the outage
  length), a backend has no server left, HAProxy is unreachable — for any
  backend, added to Gladys or not, also across restarts.
- Scene actions: state of a backend and state of HAProxy, with a ready-made
  sentence.
- Dashboard widget: backends down first, servers out with their status, a
  Refresh button.
- A "Test the connection" button, texts in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-haproxy/commits/main
