// Model Context Protocol over streamable HTTP at /mcp: the modern 2026-07-28 discover
// path first, the legacy initialize handshake as a fallback, and six tools over the same
// store the REST and GraphQL surfaces read. No sessions are ever handed out, so no
// session id is ever echoed and DELETE /mcp has nothing to close.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, isRecord, parseJsonBody, readBody, sendJson, sendMessage } from './http-util.ts';
import type { Store } from './store.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolResult(value: Record<string, unknown>, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function missingArg(tool: string, arg: string): Record<string, unknown> {
  return toolResult({ error: `Missing required argument: ${arg} for tool ${tool}` }, true);
}

function repoOf(store: Store, args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const viewer = store.viewer.login;
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return missingArg(name, 'name');
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : viewer;
      const repo = store.createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      if ('error' in repo) return toolResult({ error: repo.error }, true);
      return toolResult(store.repoRest(repo) as Record<string, unknown>);
    }
    case 'get_repo': {
      const target = repoOf(store, args);
      if (!target) return missingArg(name, 'repo');
      const repo = target.owner === viewer ? store.getRepo(target.owner, target.repo) : undefined;
      if (!repo) return toolResult({ error: `Repository ${target.owner}/${target.repo} not found` }, true);
      return toolResult(store.repoRest(repo) as Record<string, unknown>);
    }
    case 'create_issue': {
      const target = repoOf(store, args);
      if (!target) return missingArg(name, 'repo');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return missingArg(name, 'title');
      const repo = target.owner === viewer ? store.getRepo(target.owner, target.repo) : undefined;
      if (!repo) return toolResult({ error: `Repository ${target.owner}/${target.repo} not found` }, true);
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in issue) return toolResult({ error: issue.error }, true);
      return toolResult(store.issueRest(repo, issue) as Record<string, unknown>);
    }
    case 'list_issues': {
      const target = repoOf(store, args);
      if (!target) return missingArg(name, 'repo');
      const repo = target.owner === viewer ? store.getRepo(target.owner, target.repo) : undefined;
      if (!repo) return toolResult({ error: `Repository ${target.owner}/${target.repo} not found` }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult({ issues: issues.map((issue) => store.issueRest(repo, issue)) });
    }
    case 'create_pull_request': {
      const target = repoOf(store, args);
      if (!target) return missingArg(name, 'repo');
      for (const required of ['title', 'head', 'base']) {
        if (typeof args[required] !== 'string' || args[required] === '') return missingArg(name, required);
      }
      const repo = target.owner === viewer ? store.getRepo(target.owner, target.repo) : undefined;
      if (!repo) return toolResult({ error: `Repository ${target.owner}/${target.repo} not found` }, true);
      const pull = store.createPull(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        args.head as string,
        args.base as string,
      );
      if ('error' in pull) return toolResult({ error: pull.error }, true);
      return toolResult(store.pullRest(repo, pull) as Record<string, unknown>);
    }
    case 'merge_pull_request': {
      const target = repoOf(store, args);
      if (!target) return missingArg(name, 'repo');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(number) || number < 1) return missingArg(name, 'pull_number');
      const repo = target.owner === viewer ? store.getRepo(target.owner, target.repo) : undefined;
      if (!repo) return toolResult({ error: `Repository ${target.owner}/${target.repo} not found` }, true);
      const pull = repo.pulls.get(number);
      if (!pull) return toolResult({ error: `Pull request #${number} not found` }, true);
      const result = store.mergePull(repo, pull);
      if ('error' in result) return toolResult({ error: result.error }, true);
      return toolResult({ merged: true, number, state: 'closed', sha: result.sha });
    }
    default:
      return toolResult({ error: `Unknown tool: ${name}` }, true);
  }
}

function handleOne(request: unknown, store: Store): { status: number; body: unknown } | { status: 202; body: null } {
  if (!isRecord(request)) {
    return { status: 400, body: rpcError(null, { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' }) };
  }
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
      }),
    };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = LEGACY_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }

  if (method === 'notifications/initialized') {
    return { status: 202, body: null };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (toolName === '' || !known) {
      return { status: 200, body: rpcError(id, { code: -32602, message: `Unknown tool: ${toolName === '' ? '(missing name)' : toolName}` }) };
    }
    return { status: 200, body: rpcResult(id, callTool(store, toolName, args)) };
  }

  if (method === '') {
    return { status: 400, body: rpcError(id, { code: -32600, message: 'Invalid Request: missing method' }) };
  }
  return { status: 200, body: rpcError(id, { code: -32601, message: `Method not found: ${method}` }) };
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    sendMessage(res, store, 405, 'Method not allowed');
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!authorized(req)) {
    sendJson(res, store, 401, rpcError(null, { code: -32000, message: 'Unauthorized' }));
    return true;
  }
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, store, 400, rpcError(null, { code: -32700, message: 'Parse error' }));
    return true;
  }
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((entry) => {
      const outcome = handleOne(entry, store);
      return outcome.status === 202 ? null : outcome.body;
    }).filter((entry) => entry !== null);
    sendJson(res, store, 200, results);
    return true;
  }
  const outcome = handleOne(parsed.value, store);
  if (outcome.status === 202) {
    res.writeHead(202, { 'x-github-request-id': store.nextRequestId() });
    res.end();
    return true;
  }
  sendJson(res, store, outcome.status, outcome.body);
  return true;
}
