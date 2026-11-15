// The forge's HTTP surface: a health probe, git smart HTTP, REST v3, GraphQL v4 and MCP,
// over one in-memory store. main.ts owns the lifecycle (bind, register, wait for done);
// this file is the server. Every reply carries a non-empty X-GitHub-Request-Id, and every
// error body is JSON {"message": string}.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './src/git-http.ts';
import { handleGraphql } from './src/graphql.ts';
import { pathOf, queryOf, sendJson, sendMessage } from './src/http-util.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const segments = path.split('/').filter((segment) => segment !== '');

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, store, 200, { ok: true });
          return;
        }

        // GraphQL v4.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (await handleGraphql(req, res, store)) return;
        }

        // MCP over streamable HTTP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (await handleMcp(req, res, store)) return;
        }

        // git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack.
        if (segments.length >= 3 && (segments[1] ?? '').endsWith('.git')) {
          if (await handleGitHttp(req, res, store, segments, method, queryOf(req))) return;
        }

        // REST v3 (includes the API root, /meta and the JSON 404 for unknown routes).
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          if (await handleRest(req, res, store, segments, method)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendMessage(res, store, 404, 'Not Found');
      } catch (err) {
        // A handler must never take the connection down without an answer.
        try {
          sendMessage(res, store, 500, err instanceof Error ? err.message : 'Internal error');
        } catch {
          // The socket is already gone; nothing left to answer.
        }
      }
    })();
  });
}
