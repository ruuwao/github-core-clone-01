// GitHub REST v3: repositories, branches, commits, contents, refs, labels, issues,
// comments and pull requests, over the in-memory store. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors are {"message": string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObjectId, parseCommit, parseTree } from './git.ts';
import {
  authorized,
  isRecord,
  paginate,
  parseJsonBody,
  queryOf,
  readBody,
  sendJson,
  sendMessage,
} from './http-util.ts';
import {
  commitTreeOid,
  flattenTree,
  writeFlatTree,
  type Issue,
  type Repo,
  type Store,
} from './store.ts';
import { SCENARIO_EPOCH_SEC } from './scenario.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  query: URLSearchParams;
}

function repoOf(ctx: Ctx, owner: string, name: string): Repo | undefined {
  if (owner !== ctx.store.viewer.login) return undefined;
  return ctx.store.getRepo(owner, name);
}

function parseAuthor(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  const [, name, email, ts] = match as [string, string, string, string, string];
  return { name, email, date: new Date(Number(ts) * 1000).toISOString() };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function jsonBody(ctx: Ctx): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const body = await readBody(ctx.req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendMessage(ctx.res, ctx.store, 400, 'Malformed JSON body');
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
}

function requireAuth(ctx: Ctx): boolean {
  if (!authorized(ctx.req)) {
    sendMessage(ctx.res, ctx.store, 401, 'Bad credentials');
    return false;
  }
  return true;
}

// --- contents -----------------------------------------------------------------------------

function contentFileResponse(repo: Repo, path: string, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const bytes = object ? object.data : Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name,
    path,
    sha: oid,
    content: bytes.toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.example/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
  };
}

function contentDirResponse(repo: Repo, path: string, treeOid: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(object.data)) {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path: childPath, sha: entry.oid, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` });
    } else if (entry.mode === '160000') {
      out.push({ type: 'file', name: entry.name, path: childPath, sha: entry.oid, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({
        type: 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: blob ? blob.data.length : 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      });
    }
  }
  return out;
}

function resolveContentsTarget(repo: Repo, ctx: Ctx): { tip: string | undefined } {
  const ref = ctx.query.get('ref') ?? undefined;
  if (ref === undefined) return { tip: ctx.store.headTip(repo) };
  return { tip: ctx.store.resolveRef(repo, ref) };
}

async function getContents(ctx: Ctx, repo: Repo, pathParts: string[]): Promise<void> {
  const { tip } = resolveContentsTarget(repo, ctx);
  if (tip === undefined) {
    sendMessage(ctx.res, ctx.store, 404, 'Not Found');
    return;
  }
  const treeOid = commitTreeOid(repo, tip);
  if (treeOid === null) {
    sendMessage(ctx.res, ctx.store, 404, 'Not Found');
    return;
  }
  const path = pathParts.join('/');
  if (path === '') {
    sendJson(ctx.res, ctx.store, 200, contentDirResponse(repo, '', treeOid));
    return;
  }
  const parts = path.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    const object = repo.objects.get(currentTree);
    if (!object || object.type !== 'tree') {
      sendMessage(ctx.res, ctx.store, 404, 'Not Found');
      return;
    }
    const entry = parseTree(object.data).find((candidate) => candidate.name === part);
    if (!entry) {
      sendMessage(ctx.res, ctx.store, 404, 'Not Found');
      return;
    }
    const isLast = i === parts.length - 1;
    if (entry.mode === '40000') {
      if (isLast) {
        sendJson(ctx.res, ctx.store, 200, contentDirResponse(repo, path, entry.oid));
        return;
      }
      currentTree = entry.oid;
    } else if (entry.mode === '160000') {
      sendMessage(ctx.res, ctx.store, 404, 'Not Found');
      return;
    } else {
      if (!isLast) {
        sendMessage(ctx.res, ctx.store, 404, 'Not Found');
        return;
      }
      sendJson(ctx.res, ctx.store, 200, contentFileResponse(repo, path, entry.oid));
      return;
    }
  }
  sendMessage(ctx.res, ctx.store, 404, 'Not Found');
}

async function putContents(ctx: Ctx, repo: Repo, pathParts: string[]): Promise<void> {
  const parsed = await jsonBody(ctx);
  if (!parsed.ok) return;
  const body = isRecord(parsed.value) ? parsed.value : {};
  const path = pathParts.join('/');
  const content = typeof body.content === 'string' ? body.content : null;
  if (content === null) {
    sendMessage(ctx.res, ctx.store, 422, 'content is required');
    return;
  }
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const isUnborn = tip === undefined && branch === repo.defaultBranch && repo.refs.size === 0;
  if (tip === undefined && !isUnborn) {
    sendMessage(ctx.res, ctx.store, 404, `Branch ${branch} not found`);
    return;
  }
  const treeOid = tip === undefined ? null : commitTreeOid(repo, tip);
  const files = flattenTree(repo, treeOid);
  const existing = files.get(path);
  if (sha !== undefined) {
    if (!existing || existing.oid !== sha) {
      sendMessage(ctx.res, ctx.store, 409, 'sha does not match the current file');
      return;
    }
  } else if (existing) {
    sendMessage(ctx.res, ctx.store, 422, 'File already exists; supply its sha to update it');
    return;
  }
  const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = ctx.store.putObject(repo, { type: 'blob', data: bytes });
  files.set(path, { mode: '100644', oid: blobOid });
  const newTree = writeFlatTree(repo, ctx.store, files);
  const commitOid = ctx.store.createCommit(repo, newTree, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  const status = existing ? 200 : 201;
  sendJson(ctx.res, ctx.store, status, {
    content: contentFileResponse(repo, path, blobOid),
    commit: { sha: commitOid },
  });
}

async function deleteContents(ctx: Ctx, repo: Repo, pathParts: string[]): Promise<void> {
  const parsed = await jsonBody(ctx);
  if (!parsed.ok) return;
  const body = isRecord(parsed.value) ? parsed.value : {};
  const path = pathParts.join('/');
  const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    sendMessage(ctx.res, ctx.store, 404, `Branch ${branch} not found`);
    return;
  }
  const treeOid = commitTreeOid(repo, tip);
  const files = flattenTree(repo, treeOid);
  const existing = files.get(path);
  if (!existing) {
    sendMessage(ctx.res, ctx.store, 404, 'Not Found');
    return;
  }
  if (sha !== undefined && existing.oid !== sha) {
    sendMessage(ctx.res, ctx.store, 409, 'sha does not match the current file');
    return;
  }
  files.delete(path);
  const newTree = writeFlatTree(repo, ctx.store, files);
  const commitOid = ctx.store.createCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(ctx.res, ctx.store, 200, { commit: { sha: commitOid } });
}

// --- issues / pulls -------------------------------------------------------------------------

function issueNumber(segment: string): number | null {
  const n = Number.parseInt(segment, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function listIssues(ctx: Ctx, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') {
    sendMessage(ctx.res, ctx.store, 422, `Invalid state ${state}`);
    return;
  }
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { pageItems, link } = paginate(ctx.req, issues, ctx.query);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx.res, ctx.store, 200, pageItems.map((issue) => ctx.store.issueRest(repo, issue)), headers);
}

async function createIssue(ctx: Ctx, repo: Repo): Promise<void> {
  const parsed = await jsonBody(ctx);
  if (!parsed.ok) return;
  const body = isRecord(parsed.value) ? parsed.value : {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendMessage(ctx.res, ctx.store, 422, 'title is required');
    return;
  }
  const bodyText = typeof body.body === 'string' ? body.body : '';
  const rawLabels = Array.isArray(body.labels) ? body.labels : [];
  const labels: string[] = [];
  for (const label of rawLabels) {
    if (typeof label === 'string') labels.push(label);
    else if (isRecord(label) && typeof label.name === 'string') labels.push(label.name);
  }
  const issue = ctx.store.createIssue(repo, title, bodyText, labels);
  if ('error' in issue) {
    sendMessage(ctx.res, ctx.store, 422, issue.error);
    return;
  }
  sendJson(ctx.res, ctx.store, 201, ctx.store.issueRest(repo, issue));
}

async function patchIssue(ctx: Ctx, repo: Repo, issue: Issue): Promise<void> {
  const parsed = await jsonBody(ctx);
  if (!parsed.ok) return;
  const body = isRecord(parsed.value) ? parsed.value : {};
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') {
      sendMessage(ctx.res, ctx.store, 422, `Invalid state ${String(body.state)}`);
      return;
    }
    issue.state = body.state;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.updatedSeq = ctx.store.nextSeq();
  sendJson(ctx.res, ctx.store, 200, ctx.store.issueRest(repo, issue));
}

function listPulls(ctx: Ctx, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') {
    sendMessage(ctx.res, ctx.store, 422, `Invalid state ${state}`);
    return;
  }
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { pageItems, link } = paginate(ctx.req, pulls, ctx.query);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx.res, ctx.store, 200, pageItems.map((pull) => ctx.store.pullRest(repo, pull)), headers);
}

async function createPull(ctx: Ctx, repo: Repo): Promise<void> {
  const parsed = await jsonBody(ctx);
  if (!parsed.ok) return;
  const body = isRecord(parsed.value) ? parsed.value : {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendMessage(ctx.res, ctx.store, 422, 'title is required');
    return;
  }
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (head === '' || base === '') {
    sendMessage(ctx.res, ctx.store, 422, 'head and base are required');
    return;
  }
  const stripOwner = (ref: string): string => {
    const colon = ref.indexOf(':');
    return colon >= 0 ? ref.slice(colon + 1) : ref;
  };
  const bodyText = typeof body.body === 'string' ? body.body : '';
  const pull = ctx.store.createPull(repo, title, bodyText, stripOwner(head), stripOwner(base));
  if ('error' in pull) {
    sendMessage(ctx.res, ctx.store, 422, pull.error);
    return;
  }
  sendJson(ctx.res, ctx.store, 201, ctx.store.pullRest(repo, pull));
}

async function mergePull(ctx: Ctx, repo: Repo, number: number): Promise<void> {
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendMessage(ctx.res, ctx.store, 404, 'Not Found');
    return;
  }
  // Consume the body if any (merge_method lives there); an empty body is fine.
  await readBody(ctx.req);
  const result = ctx.store.mergePull(repo, pull);
  if ('error' in result) {
    sendMessage(ctx.res, ctx.store, result.status, result.error);
    return;
  }
  sendJson(ctx.res, ctx.store, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
}

// --- router ---------------------------------------------------------------------------------

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  segments: string[],
  method: string,
): Promise<boolean> {
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const ctx: Ctx = { req, res, store, query: queryOf(req) };
  const rest = segments.slice(2);

  // API root and meta: public, like api.github.com.
  if ((method === 'GET' && rest.length === 0) || (method === 'GET' && rest.length === 1 && rest[0] === '')) {
    sendJson(res, store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, store, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (!requireAuth(ctx)) return true;

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, store, 200, store.viewerRest());
    return true;
  }

  // POST /user/repos, GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok) return true;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendMessage(res, store, 422, 'name is required');
        return true;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(store.viewer.login, name, description, isPrivate);
      if ('error' in repo) {
        sendMessage(res, store, 422, repo.error);
        return true;
      }
      sendJson(res, store, 201, store.repoRest(repo));
      return true;
    }
    if (method === 'GET') {
      const repos = store.listViewerRepos();
      const { pageItems, link } = paginate(req, repos, ctx.query);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, store, 200, pageItems.map((repo) => store.repoRest(repo)), headers);
      return true;
    }
    return true;
  }

  // /repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeSegment(rest[1] as string);
    const name = decodeSegment(rest[2] as string);
    const repo = repoOf(ctx, owner, name);
    if (!repo) {
      sendMessage(res, store, 404, 'Not Found');
      return true;
    }
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, store, 200, store.repoRest(repo));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = await jsonBody(ctx);
        if (!parsed.ok) return true;
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
          repo.defaultBranch = body.default_branch;
        }
        repo.updatedSeq = store.nextSeq();
        sendJson(res, store, 200, store.repoRest(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': store.nextRequestId() });
        res.end();
        return true;
      }
      return true;
    }

    const head = tail[0] as string;

    if (head === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
        sendJson(res, store, 200, branches);
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = decodeSegment(tail[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          sendMessage(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, { name: branch, commit: { sha }, protected: false });
        return true;
      }
      return true;
    }

    if (head === 'commits') {
      if (method === 'GET' && tail.length === 1) {
        const ref = ctx.query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === undefined) {
          sendJson(res, store, 200, []);
          return true;
        }
        const commits = store.listCommits(repo, tip).map((oid) => {
          const object = repo.objects.get(oid);
          const commit = object ? parseCommit(object.data) : null;
          const author = commit ? parseAuthor(commit.author) : { name: '', email: '', date: '' };
          const committer = commit ? parseAuthor(commit.committer) : { name: '', email: '', date: '' };
          return {
            sha: oid,
            commit: {
              message: commit?.message ?? '',
              author,
              committer,
              tree: { sha: commit?.tree ?? '' },
            },
            parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
            url: `/api/v3/repos/${owner}/${name}/commits/${oid}`,
          };
        });
        const { pageItems, link } = paginate(req, commits, ctx.query);
        const headers: Record<string, string> = {};
        if (link !== null) headers.link = link;
        sendJson(res, store, 200, pageItems, headers);
        return true;
      }
      return true;
    }

    if (head === 'contents') {
      const pathParts = tail.slice(1).map(decodeSegment);
      if (method === 'GET') {
        await getContents(ctx, repo, pathParts);
        return true;
      }
      if (method === 'PUT') {
        await putContents(ctx, repo, pathParts);
        return true;
      }
      if (method === 'DELETE') {
        await deleteContents(ctx, repo, pathParts);
        return true;
      }
      return true;
    }

    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = await jsonBody(ctx);
        if (!parsed.ok) return true;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/')) {
          sendMessage(res, store, 422, 'ref must start with refs/');
          return true;
        }
        if (!isObjectId(sha) || !repo.objects.has(sha)) {
          sendMessage(res, store, 422, 'sha does not name an object in this repository');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendMessage(res, store, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        const object = repo.objects.get(sha);
        sendJson(res, store, 201, { ref, object: { sha, type: object?.type ?? 'commit' } });
        return true;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const refs = [...repo.refs.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([ref, sha]) => ({ ref, object: { sha } }));
          sendJson(res, store, 200, refs);
          return true;
        }
        const refName = `refs/${tail.slice(2).map(decodeSegment).join('/')}`;
        const sha = repo.refs.get(refName);
        if (!sha) {
          sendMessage(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, { ref: refName, object: { sha } });
        return true;
      }
      return true;
    }

    if (head === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, store, 200, [...repo.labels.values()].map((label) => ({ ...label, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(label.name)}` })));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        const parsed = await jsonBody(ctx);
        if (!parsed.ok) return true;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') {
          sendMessage(res, store, 422, 'name is required');
          return true;
        }
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        const description = typeof body.description === 'string' ? body.description : '';
        const existing = repo.labels.get(labelName);
        if (existing) {
          sendJson(res, store, 201, { ...existing, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(labelName)}` });
          return true;
        }
        const label = { name: labelName, color, description };
        repo.labels.set(labelName, label);
        sendJson(res, store, 201, { ...label, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(labelName)}` });
        return true;
      }
      return true;
    }

    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          listIssues(ctx, repo);
          return true;
        }
        if (method === 'POST') {
          await createIssue(ctx, repo);
          return true;
        }
        return true;
      }
      const number = issueNumber(tail[1] as string);
      if (number === null) {
        sendMessage(res, store, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.get(number);
      if (tail.length === 2) {
        if (!issue) {
          sendMessage(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, store, 200, store.issueRest(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          await patchIssue(ctx, repo, issue);
          return true;
        }
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          sendMessage(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, store, 200, issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: comment.user, id: store.viewer.id, type: 'User' },
            created_at: new Date((SCENARIO_EPOCH_SEC + comment.createdSeq) * 1000).toISOString(),
            updated_at: new Date((SCENARIO_EPOCH_SEC + comment.createdSeq) * 1000).toISOString(),
            html_url: `https://github.example/${owner}/${name}/issues/${number}#issuecomment-${comment.id}`,
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          })));
          return true;
        }
        if (method === 'POST') {
          const parsed = await jsonBody(ctx);
          if (!parsed.ok) return true;
          const body = isRecord(parsed.value) ? parsed.value : {};
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') {
            sendMessage(res, store, 422, 'body is required');
            return true;
          }
          const comment = store.createComment(repo, issue, commentBody);
          sendJson(res, store, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: comment.user, id: store.viewer.id, type: 'User' },
            created_at: new Date((SCENARIO_EPOCH_SEC + comment.createdSeq) * 1000).toISOString(),
            updated_at: new Date((SCENARIO_EPOCH_SEC + comment.createdSeq) * 1000).toISOString(),
            html_url: `https://github.example/${owner}/${name}/issues/${number}#issuecomment-${comment.id}`,
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
          });
          return true;
        }
        return true;
      }
      return true;
    }

    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          listPulls(ctx, repo);
          return true;
        }
        if (method === 'POST') {
          await createPull(ctx, repo);
          return true;
        }
        return true;
      }
      const number = issueNumber(tail[1] as string);
      if (number === null) {
        sendMessage(res, store, 404, 'Not Found');
        return true;
      }
      const pull = repo.pulls.get(number);
      if (tail.length === 2) {
        if (!pull) {
          sendMessage(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, store, 200, store.pullRest(repo, pull));
          return true;
        }
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (!pull) {
          sendMessage(res, store, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, store, 200, store.currentFiles(repo, pull));
          return true;
        }
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method === 'PUT') {
          await mergePull(ctx, repo, number);
          return true;
        }
        return true;
      }
      return true;
    }

    // A known repo but an unknown sub-route: JSON 404.
    sendMessage(res, store, 404, 'Not Found');
    return true;
  }

  // Unknown /api/v3 route: JSON 404.
  sendMessage(res, store, 404, 'Not Found');
  return true;
}
