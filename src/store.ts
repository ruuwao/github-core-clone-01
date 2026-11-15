// The forge's store: one in-memory map of repositories, each holding its git objects, refs,
// issues, pull requests, labels and comments. Everything is in memory (the perf workloads
// need ~1ms reads), and every timestamp derives from a deterministic sequence counter — no
// wall clock anywhere, so replaying the same trial produces the same state export.

import {
  buildCommit,
  buildTree,
  collectReachable,
  countLineDiff,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';
import { buildScenario, DEFAULT_BRANCH, ISSUE_LABELS, SCENARIO_EPOCH_SEC, type Scenario, type ScenarioUser } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  user: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  mergeBaseSha: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  files: PullFile[];
  createdSeq: number;
  updatedSeq: number;
  user: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  updatedSeq: number;
  objects: Map<string, GitObject>;
  objectSeq: Map<string, number>;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
}

const LABEL_COLORS: Record<string, string> = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
};

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** Flatten a tree (recursively) to path -> entry. */
export function flattenTree(repo: Repo, treeOid: string | null, out: Map<string, { mode: string; oid: string }> = new Map()): Map<string, { mode: string; oid: string }> {
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode === '160000') continue;
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

interface DirNode {
  files: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, DirNode>;
}

function buildDirTree(files: Map<string, { mode: string; oid: string }>): DirNode {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts[i] as string;
      let child = node.dirs.get(dir);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(dir, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  return root;
}

function writeDirTree(repo: Repo, store: Store, node: DirNode): string {
  const entries: TreeEntry[] = [];
  for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
  for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: writeDirTree(repo, store, sub) });
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  store.putObject(repo, { type: 'tree', data });
  return oid;
}

/** Build a new tree from a flat path map, storing every tree object in the repo. */
export function writeFlatTree(repo: Repo, store: Store, files: Map<string, { mode: string; oid: string }>): string {
  return writeDirTree(repo, store, buildDirTree(files));
}

export function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object) return '';
  return object.data.toString('utf8');
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): PullFile[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const files: PullFile[] = [];
  const all = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...all].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const deletions = countLines(blobText(repo, b.oid));
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = countLines(blobText(repo, h.oid));
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const { additions, deletions } = countLineDiff(blobText(repo, b.oid), blobText(repo, h.oid));
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

export function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

export class Store {
  readonly scenario: Scenario;
  readonly viewer: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private seq = 0;
  private requestCounter = 0;

  constructor() {
    this.scenario = buildScenario();
    this.viewer = this.scenario.viewer;
  }

  /** The next deterministic timestamp: the scenario epoch plus the operation sequence. */
  nextTimestamp(): { epochSec: number; iso: string } {
    this.seq += 1;
    const epochSec = SCENARIO_EPOCH_SEC + this.seq;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  viewerIdentity(): string {
    return `${this.viewer.name} <${this.viewer.email}>`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === this.viewer.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | { error: string } {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) return { error: 'Invalid repository name' };
    if (this.repos.has(this.repoKey(owner, name))) return { error: 'Repository already exists' };
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: seq,
      updatedSeq: seq,
      objects: new Map(),
      objectSeq: new Map(),
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
    };
    this.nextRepoId += 1;
    for (const label of ISSUE_LABELS) {
      repo.labels.set(label, { name: label, color: LABEL_COLORS[label] ?? 'ededed', description: '' });
    }
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  putObject(repo: Repo, object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, object);
      repo.objectSeq.set(oid, this.nextSeq());
    }
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Resolve a ref name, a full ref, or an object id to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return tag;
    return undefined;
  }

  refTip(repo: Repo, refName: string): string | undefined {
    return repo.refs.get(refName);
  }

  /** Create a commit object in the repo with the viewer identity and a deterministic time. */
  createCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const { epochSec } = this.nextTimestamp();
    const identity = this.viewerIdentity();
    const data = buildCommit({ tree: treeOid, parents, message, author: identity, committer: identity, timestamp: epochSec, timezone: '+0000' });
    return this.putObject(repo, { type: 'commit', data });
  }

  /** All commits reachable from `tip`, newest (by insertion order) first. */
  listCommits(repo: Repo, tip: string): string[] {
    const reachable = collectReachable([tip], this.lookup(repo), { allowMissing: true });
    const commits: string[] = [];
    for (const oid of reachable) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') commits.push(oid);
    }
    commits.sort((a, b) => (repo.objectSeq.get(b) ?? 0) - (repo.objectSeq.get(a) ?? 0));
    return commits;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    const seq = this.nextSeq();
    const issue: Issue = {
      id,
      globalId: globalId('Issue', repo.id, number),
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
      user: this.viewer.login,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId, body, user: this.viewer.login, createdSeq: this.nextSeq() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedSeq = this.nextSeq();
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = this.resolveRef(repo, headRef);
    if (!headSha) return { error: `Head branch '${headRef}' does not exist` };
    const baseSha = this.resolveRef(repo, baseRef);
    if (!baseSha) return { error: `Base branch '${baseRef}' does not exist` };
    if (headSha === baseSha) return { error: 'No commits between head and base' };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head.ref === headRef && existing.base.ref === baseRef) {
        return { error: 'A pull request already exists for these branches' };
      }
    }
    const mb = mergeBase(headSha, baseSha, this.lookup(repo));
    const headTree = commitTreeOid(repo, headSha);
    const mbTree = mb === null ? null : commitTreeOid(repo, mb);
    const files = diffTrees(repo, mbTree, headTree);
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    const seq = this.nextSeq();
    const pull: Pull = {
      id,
      globalId: globalId('PullRequest', repo.id, number),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      mergeBaseSha: mb,
      mergeCommitSha: null,
      mergedAt: null,
      files,
      createdSeq: seq,
      updatedSeq: seq,
      user: this.viewer.login,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The PR's files, recomputed from the live branch tips while it is open. */
  currentFiles(repo: Repo, pull: Pull): PullFile[] {
    if (pull.state !== 'open') return pull.files;
    const headSha = this.resolveRef(repo, pull.head.ref);
    const baseSha = this.resolveRef(repo, pull.base.ref);
    if (!headSha || !baseSha) return pull.files;
    const mb = mergeBase(headSha, baseSha, this.lookup(repo));
    return diffTrees(repo, mb === null ? null : commitTreeOid(repo, mb), commitTreeOid(repo, headSha));
  }

  /** Is the PR mergeable right now (no file-level conflict between head and base)? */
  mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return pull.merged ? 'MERGEABLE' : 'UNKNOWN';
    const headSha = this.resolveRef(repo, pull.head.ref);
    const baseSha = this.resolveRef(repo, pull.base.ref);
    if (!headSha || !baseSha) return 'UNKNOWN';
    return this.findConflict(repo, headSha, baseSha) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * The first conflicting path between head and base (three-way, file level), or null.
   * A path conflicts when it differs between merge-base and head AND between merge-base
   * and the base tip, with different results.
   */
  findConflict(repo: Repo, headSha: string, baseSha: string): string | null {
    const mb = mergeBase(headSha, baseSha, this.lookup(repo));
    const mbFiles = flattenTree(repo, mb === null ? null : commitTreeOid(repo, mb));
    const headFiles = flattenTree(repo, commitTreeOid(repo, headSha));
    const baseFiles = flattenTree(repo, commitTreeOid(repo, baseSha));
    const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const mbOid = mbFiles.get(path)?.oid ?? null;
      const headOid = headFiles.get(path)?.oid ?? null;
      const baseOid = baseFiles.get(path)?.oid ?? null;
      const headChanged = headOid !== mbOid;
      const baseChanged = baseOid !== mbOid;
      if (headChanged && baseChanged && headOid !== baseOid) return path;
    }
    return null;
  }

  /**
   * Squash-merge an open PR onto its base branch: one commit whose tree is the base tree plus
   * the head's changes, parented on the base tip. Returns the merge commit sha, or an error
   * with an HTTP status (405 on conflict).
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const headSha = this.resolveRef(repo, pull.head.ref);
    const baseSha = this.resolveRef(repo, pull.base.ref);
    if (!headSha || !baseSha) return { error: 'Head or base branch no longer exists', status: 422 };
    const conflict = this.findConflict(repo, headSha, baseSha);
    if (conflict !== null) return { error: `Merge conflict on ${conflict}`, status: 405 };
    const mb = mergeBase(headSha, baseSha, this.lookup(repo));
    const headFiles = flattenTree(repo, commitTreeOid(repo, headSha));
    const mbFiles = flattenTree(repo, mb === null ? null : commitTreeOid(repo, mb));
    const baseFiles = flattenTree(repo, commitTreeOid(repo, baseSha));
    const merged = new Map(baseFiles);
    for (const [path, entry] of headFiles) merged.set(path, entry);
    for (const path of mbFiles.keys()) {
      if (!headFiles.has(path)) merged.delete(path);
    }
    const treeOid = writeFlatTree(repo, this, merged);
    const message = `${pull.title} (#${pull.number})`;
    const commitOid = this.createCommit(repo, treeOid, [baseSha], message);
    repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
    const { iso } = this.nextTimestamp();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commitOid;
    pull.mergedAt = iso;
    pull.updatedSeq = this.nextSeq();
    pull.head.sha = headSha;
    pull.base.sha = baseSha;
    return { sha: commitOid };
  }

  /** The viewer as a REST user object. */
  viewerRest(): Record<string, unknown> {
    return {
      login: this.viewer.login,
      id: this.viewer.id,
      node_id: globalId('User', this.viewer.id),
      avatar_url: '',
      type: 'User',
      site_admin: false,
      name: this.viewer.name,
      email: this.viewer.email,
      html_url: `https://github.example/${this.viewer.login}`,
      url: `/api/v3/users/${this.viewer.login}`,
    };
  }

  repoRest(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: globalId('Repository', repo.id),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === this.viewer.login ? this.viewer.id : 0, type: 'User' },
      private: repo.private,
      description: repo.description,
      fork: false,
      created_at: new Date(SCENARIO_EPOCH_SEC * 1000).toISOString(),
      updated_at: new Date(SCENARIO_EPOCH_SEC * 1000).toISOString(),
      pushed_at: new Date(SCENARIO_EPOCH_SEC * 1000).toISOString(),
      homepage: null,
      size: 0,
      stargazers_count: 0,
      watchers_count: 0,
      language: null,
      has_issues: true,
      has_projects: true,
      has_downloads: true,
      has_wiki: true,
      has_pages: false,
      forks_count: 0,
      open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
      license: null,
      default_branch: repo.defaultBranch,
      html_url: `https://github.example/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://github.example/${repo.owner}/${repo.name}.git`,
      git_url: `git://github.example/${repo.owner}/${repo.name}.git`,
      ssh_url: `git@github.example:${repo.owner}/${repo.name}.git`,
    };
  }

  issueRest(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: issue.globalId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      locked: false,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
      }),
      user: { login: issue.user, id: this.viewer.id, type: 'User' },
      assignees: [],
      comments: issue.comments.length,
      created_at: new Date((SCENARIO_EPOCH_SEC + issue.createdSeq) * 1000).toISOString(),
      updated_at: new Date((SCENARIO_EPOCH_SEC + issue.updatedSeq) * 1000).toISOString(),
      closed_at: issue.state === 'closed' ? new Date((SCENARIO_EPOCH_SEC + issue.updatedSeq) * 1000).toISOString() : null,
    };
  }

  pullRest(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: pull.globalId,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
      html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      user: { login: pull.user, id: this.viewer.id, type: 'User' },
      head: { label: `${repo.owner}:${pull.head.ref}`, ref: pull.head.ref, sha: pull.head.sha },
      base: { label: `${repo.owner}:${pull.base.ref}`, ref: pull.base.ref, sha: pull.base.sha },
      merged: pull.merged,
      mergeable: pull.state === 'open' ? this.mergeableState(repo, pull) === 'MERGEABLE' : null,
      merge_commit_sha: pull.mergeCommitSha,
      merged_at: pull.mergedAt,
      created_at: new Date((SCENARIO_EPOCH_SEC + pull.createdSeq) * 1000).toISOString(),
      updated_at: new Date((SCENARIO_EPOCH_SEC + pull.updatedSeq) * 1000).toISOString(),
      closed_at: pull.state === 'closed' ? new Date((SCENARIO_EPOCH_SEC + pull.updatedSeq) * 1000).toISOString() : null,
    };
  }
}

export { ZERO_OID };
export type { GitObjectType };
