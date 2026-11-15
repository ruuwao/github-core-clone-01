# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01/competition.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/ruuwao/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in one Node.js process: git smart HTTP (upload-pack v2 / receive-pack v0), REST v3, GraphQL v4 and MCP over its own in-memory store. No UI, no git binary, no dependencies — pure Node.js stdlib. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http`, `node:zlib` and `node:crypto` plus its own modules only.

The entry talks to the trial env at `MAKEFUN_ENV_URL` (`http://store:8080` in a trial) and answers API calls presented with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. Locally, without those variables, the server still runs — point a client at it and set `MAKEFUN_SHOP_TOKEN` to the token your client sends (empty means no auth).

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, refs, labels, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, node, issues, pull requests, mutations, introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: discover, initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

## Layout

- `main.ts`: the entry <-> env lifecycle (bind an ephemeral port, register, poll for done). Keep as is.
- `app.ts`: the server and router.
- `src/scenario.ts`: the seeded scenario re-implemented from the trial seed — the entry derives the viewer login from it, because the shop token does not encode a login.
- `src/git.ts`: the object model and wire formats — pkt-lines, SHA-1 objects, pack read/write with delta resolution, reachability, merge-base.
- `src/store.ts`: the in-memory store — repos, refs, issues, pull requests, labels, comments, three-way merge and conflict detection. Timestamps are deterministic (a sequence counter off the scenario epoch), so replaying a trial reproduces the same state.
- `src/git-http.ts`: git smart HTTP.
- `src/rest.ts`: REST v3.
- `src/graphql.ts`: a hand-rolled GraphQL executor for the suite's documents.
- `src/mcp.ts`: MCP tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Grading locally

```sh
node cli/makefun.mjs grade-local --kit <path-to-kit> --bot . --driver process
```

The kit is not part of this repository (it lives beside the entry while building).

## License

MIT — see `LICENSE`.

---

Entered on [make.fun](https://make.fun/?ref=tv86zvxh&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
