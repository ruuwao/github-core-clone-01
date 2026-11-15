// GitHub GraphQL v4, hand-rolled: a small parser for the documents the suite sends
// (queries, mutations, aliases, variables, inline objects/enums, inline fragments,
// __type introspection, batched arrays) and resolvers over the same store the REST API
// reads, so the two surfaces always agree. Unknown fields are GraphQL errors (HTTP 200
// with an `errors` array naming the field), never HTTP 400s.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorized, parseJsonBody, readBody, sendJson, sendMessage } from './http-util.ts';
import {
  decodeGlobalId,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { SCENARIO_EPOCH_SEC } from './scenario.ts';

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$=@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += src[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
  fragmentName?: string;
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentSelection>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentSelection>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        fragments.set(name, { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next && next.kind === 'name') name = this.next().value;
        const variables = this.parseVariableDefinitions();
        operations.push({ type, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Record<string, unknown> {
    const variables: Record<string, unknown> = {};
    if (!this.acceptPunct('(')) return variables;
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.acceptPunct('=')) variables[name] = this.parseValue();
      else variables[name] = undefined;
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (next && next.kind === 'name') {
          const name = this.next().value;
          selections.push({ kind: 'fragment', typeCondition: null, selections: [], fragmentName: name });
        } else {
          throw new Error('malformed fragment spread');
        }
        continue;
      }
      selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldSelection {
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.acceptPunct(':')) {
      name = this.expectName();
    }
    const args = this.parseArguments();
    let selections: Selection[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (!this.acceptPunct('(')) return args;
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return token.value.includes('.') || token.value.includes('e') ? Number(token.value) : Number.parseInt(token.value, 10);
    if (token.kind === 'punct' && token.value === '$') return { $var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum literal
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
  fragments: Map<string, FragmentSelection>;
}

type Source = Record<string, unknown>;

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'createdAt', 'author'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  Label: ['name', 'color'],
  IssueComment: ['id', 'body'],
  IssueEdge: ['node'],
  CommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeNameOf(source: Source): string {
  return (source.__typename as string) ?? 'Unknown';
}

function resolveValue(value: unknown, ctx: GqlContext): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, ctx));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('$var' in record && typeof record.$var === 'string') {
      return ctx.variables[record.$var] ?? null;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveValue(entry, ctx);
    return out;
  }
  return value;
}

function cursorForNumber(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorForIssue(issue: Issue): string {
  return cursorForNumber(issue.number);
}

function cursorForIndex(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function pageInfoFor(nodes: unknown[], hasNextPage: boolean, endCursor: string | null): Source {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: nodes.length > 0 ? (endCursor as string) : null };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function decodeNodeId(store: Store, id: unknown): Source | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const { kind, parts } = decoded;
  if (kind === 'Repository') {
    const repo = findRepoById(store, Number(parts[0]));
    return repo ? { __typename: 'Repository', repo } : null;
  }
  if (kind === 'User') {
    const viewer = store.viewer;
    return { __typename: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email };
  }
  if (kind === 'Issue') {
    const repo = findRepoById(store, Number(parts[0]));
    const issue = repo?.issues.get(Number(parts[1]));
    return repo && issue ? issueSource(repo, issue) : null;
  }
  if (kind === 'PullRequest') {
    const repo = findRepoById(store, Number(parts[0]));
    const pull = repo?.pulls.get(Number(parts[1]));
    return repo && pull ? pullSource(repo, pull) : null;
  }
  return null;
}

function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const order = (orderBy !== null && typeof orderBy === 'object' ? (orderBy as Record<string, unknown>) : {}) as Record<string, unknown>;
  const direction = order.direction === 'ASC' ? 1 : -1;
  const field = order.field ?? 'CREATED_AT';
  const sorted = [...issues];
  if (field === 'COMMENTS') sorted.sort((a, b) => direction * (a.comments.length - b.comments.length));
  else if (field === 'UPDATED_AT') sorted.sort((a, b) => direction * (a.updatedSeq - b.updatedSeq));
  else sorted.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
  return sorted;
}

function orderPulls(pulls: Pull[], orderBy: unknown): Pull[] {
  const order = (orderBy !== null && typeof orderBy === 'object' ? (orderBy as Record<string, unknown>) : {}) as Record<string, unknown>;
  const direction = order.direction === 'ASC' ? 1 : -1;
  const field = order.field ?? 'CREATED_AT';
  const sorted = [...pulls];
  if (field === 'UPDATED_AT') sorted.sort((a, b) => direction * (a.updatedSeq - b.updatedSeq));
  else sorted.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
  return sorted;
}

function issueConnection(repo: Repo, issues: Issue[], args: Record<string, unknown>): Source {
  let list = [...issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list = orderIssues(list, args.orderBy ?? null);
  const after = decodeCursor(typeof args.after === 'string' ? args.after : undefined);
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    list = index >= 0 ? list.slice(index + 1) : list;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorForIssue(page[page.length - 1] as Issue) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueSource(repo, issue)),
    pageInfo: pageInfoFor(page, hasNextPage, endCursor),
    totalCount: list.length,
  };
}

function pullConnection(repo: Repo, pulls: Pull[], args: Record<string, unknown>): Source {
  let list = [...pulls];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    list = list.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  list = orderPulls(list, args.orderBy ?? null);
  const after = decodeCursor(typeof args.after === 'string' ? args.after : undefined);
  if (after !== null) {
    const index = list.findIndex((pull) => pull.number === after);
    list = index >= 0 ? list.slice(index + 1) : list;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorForNumber((page[page.length - 1] as Pull).number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullSource(repo, pull)),
    pageInfo: pageInfoFor(page, hasNextPage, endCursor),
    totalCount: list.length,
  };
}

function resolveField(typeName: string, field: FieldSelection, source: Source, ctx: GqlContext): unknown {
  const store = ctx.store;
  if (field.name === '__typename') return typeName;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, ctx);

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      const viewer = store.viewer;
      return { __typename: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email };
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== store.viewer.login) return null;
      const repo = store.getRepo(owner, name);
      return repo ? { __typename: 'Repository', repo } : null;
    }
    if (field.name === 'node') return decodeNodeId(store, args.id);
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      const enumValues = TYPE_ENUM_VALUES[name];
      if (!fields && !enumValues) return null;
      return {
        __typename: '__Type',
        name,
        kind: enumValues ? 'ENUM' : 'OBJECT',
        fields: fields ? fields.map((entry) => ({ __typename: '__Field', name: entry })) : null,
        enumValues: enumValues ? enumValues.map((entry) => ({ __typename: '__EnumValue', name: entry })) : null,
      };
    }
    return undefined;
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = decodeNodeId(store, input.repositoryId);
      if (!repo || (repo as Source).__typename !== 'Repository') {
        ctx.errors.push({ message: 'createIssue: repositoryId does not name a repository' });
        return null;
      }
      const repoObj = (repo as Source).repo as Repo;
      const issue = store.createIssue(repoObj, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in issue) {
        ctx.errors.push({ message: `createIssue: ${issue.error}` });
        return null;
      }
      return { __typename: 'CreateIssuePayload', issue: issueSource(repoObj, issue) };
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = decodeNodeId(store, input.issueId);
      if (!node || (node as Source).__typename !== 'Issue') {
        ctx.errors.push({ message: 'closeIssue: issueId does not name an issue' });
        return null;
      }
      const issue = (node as Source).issue as Issue;
      issue.state = 'closed';
      issue.updatedSeq = store.nextSeq();
      return { __typename: 'CloseIssuePayload', issue: node };
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoNode = decodeNodeId(store, input.repositoryId);
      if (!repoNode || (repoNode as Source).__typename !== 'Repository') {
        ctx.errors.push({ message: 'createPullRequest: repositoryId does not name a repository' });
        return null;
      }
      const repoObj = (repoNode as Source).repo as Repo;
      const pull = store.createPull(repoObj, String(input.title ?? ''), '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in pull) {
        ctx.errors.push({ message: `createPullRequest: ${pull.error}` });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repoObj, pull) };
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = decodeNodeId(store, input.pullRequestId);
      if (!node || (node as Source).__typename !== 'PullRequest') {
        ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request' });
        return null;
      }
      const repoObj = (node as Source).repo as Repo;
      const pull = (node as Source).pull as Pull;
      const result = store.mergePull(repoObj, pull);
      if ('error' in result) {
        ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: node };
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = decodeNodeId(store, input.subjectId);
      if (!node || (node as Source).__typename !== 'Issue') {
        ctx.errors.push({ message: 'addComment: subjectId does not name an issue' });
        return null;
      }
      const repoObj = (node as Source).repo as Repo;
      const issue = (node as Source).issue as Issue;
      const comment = store.createComment(repoObj, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', repoObj.id, issue.number, comment.id), body: comment.body },
        },
      };
    }
    return undefined;
  }

  if (typeName === 'User') {
    if (field.name === 'login') return source.login;
    if (field.name === 'id') return globalId('User', Number(source.id ?? 0));
    if (field.name === 'name') return source.name ?? null;
    if (field.name === 'email') return source.email ?? null;
    return undefined;
  }

  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    switch (field.name) {
      case 'id': return globalId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return { __typename: 'User', login: repo.owner, id: repo.owner === store.viewer.login ? store.viewer.id : 0, name: repo.owner, email: '' };
      case 'defaultBranchRef': {
        const tip = store.headTip(repo);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'private': return repo.private;
      case 'url': return `/api/v3/repos/${repo.owner}/${repo.name}`;
      case 'createdAt': return new Date(SCENARIO_EPOCH_SEC * 1000).toISOString();
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueSource(repo, issue) : null;
      }
      case 'issues': return issueConnection(repo, [...repo.issues.values()], args);
      case 'pullRequests': return pullConnection(repo, [...repo.pulls.values()], args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullSource(repo, pull) : null;
      }
      default: return undefined;
    }
  }

  if (typeName === 'Issue') {
    const issue = source.issue as Issue;
    switch (field.name) {
      case 'id': return issue.globalId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body;
      case 'labels': return issue.labels.map((name) => ({ __typename: 'Label', name, color: '' }));
      case 'createdAt': return new Date((SCENARIO_EPOCH_SEC + issue.createdSeq) * 1000).toISOString();
      case 'author': return { __typename: 'User', login: issue.user, id: store.viewer.id, name: issue.user, email: '' };
      default: return undefined;
    }
  }

  if (typeName === 'PullRequest') {
    const repo = source.repo as Repo;
    const pull = source.pull as Pull;
    switch (field.name) {
      case 'id': return pull.globalId;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pull.merged;
      case 'headRefName': return pull.head.ref;
      case 'baseRefName': return pull.base.ref;
      case 'mergeable': return store.mergeableState(repo, pull);
      case 'body': return pull.body;
      case 'headRef': return { __typename: 'Ref', name: pull.head.ref };
      case 'baseRef': return { __typename: 'Ref', name: pull.base.ref };
      case 'files': {
        const files = store.currentFiles(repo, pull);
        const after = decodeCursor(typeof args.after === 'string' ? args.after : undefined);
        const start = after === null ? 0 : after + 1;
        const first = typeof args.first === 'number' ? args.first : files.length;
        const page = files.slice(start, start + Math.max(0, first));
        const hasNextPage = start + page.length < files.length;
        const endCursor = page.length > 0 ? cursorForIndex(start + page.length - 1) : null;
        return {
          __typename: 'PullRequestConnection',
          nodes: page.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, filename: file.filename })),
          pageInfo: pageInfoFor(page, hasNextPage, endCursor),
          totalCount: files.length,
        };
      }
      default: return undefined;
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection') {
    if (field.name === 'nodes') return source.nodes;
    if (field.name === 'pageInfo') return source.pageInfo;
    if (field.name === 'totalCount') return source.totalCount;
    return undefined;
  }

  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return source.hasNextPage;
    if (field.name === 'endCursor') return source.endCursor;
    if (field.name === 'hasPreviousPage') return source.hasPreviousPage;
    if (field.name === 'startCursor') return source.startCursor;
    return undefined;
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return source.name;
    return undefined;
  }

  if (typeName === 'Label') {
    if (field.name === 'name') return source.name;
    if (field.name === 'color') return source.color;
    return undefined;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return source.path;
    if (field.name === 'filename') return source.filename;
    return undefined;
  }

  if (typeName === '__Type') {
    if (field.name === 'name') return source.name;
    if (field.name === 'kind') return source.kind;
    if (field.name === 'fields') return source.fields;
    if (field.name === 'enumValues') return source.enumValues;
    return undefined;
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return source.name;
    return undefined;
  }

  if (typeName === 'IssueComment') {
    if (field.name === 'id') return source.id;
    if (field.name === 'body') return source.body;
    return undefined;
  }

  if (typeName === 'IssueEdge' || typeName === 'CommentEdge') {
    if (field.name === 'node') return source.node;
    return undefined;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') return source.issue;
    return undefined;
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return source.pullRequest;
    return undefined;
  }

  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return source.commentEdge;
    return undefined;
  }

  return undefined;
}

function executeSelectionSet(typeName: string, source: Source, selections: Selection[], ctx: GqlContext): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragment = selection.fragmentName ? ctx.fragments.get(selection.fragmentName) : selection;
      if (!fragment) continue;
      const condition = fragment.typeCondition;
      if (condition !== null && condition !== typeName) continue;
      const nested = executeSelectionSet(typeName, source, fragment.selections, ctx);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection as FieldSelection;
    const known = (TYPE_FIELDS[typeName] ?? []).includes(field.name) || field.name.startsWith('__');
    if (!known) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[field.alias] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(typeName, field, source, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[field.alias] = null;
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[field.alias] = null;
      continue;
    }
    if (field.selections.length === 0) {
      out[field.alias] = value;
      continue;
    }
    if (value === null) {
      out[field.alias] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[field.alias] = value.map((entry) => {
        if (entry !== null && typeof entry === 'object') {
          return executeSelectionSet(typeNameOf(entry as Source), entry as Source, field.selections, ctx);
        }
        return entry;
      });
      continue;
    }
    if (typeof value === 'object') {
      out[field.alias] = executeSelectionSet(typeNameOf(value as Source), value as Source, field.selections, ctx);
      continue;
    }
    ctx.errors.push({ message: `Field "${field.name}" of type "${typeName}" must not have a sub-selection.` });
    out[field.alias] = null;
  }
  return out;
}

function executeOperation(document: Document, operation: Operation, variables: Record<string, unknown>, store: Store): Record<string, unknown> {
  const ctx: GqlContext = { store, variables, errors: [], fragments: document.fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __typename: rootType }, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeRequest(body: unknown, store: Store): Record<string, unknown> | Array<Record<string, unknown>> {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'GraphQL request body must be an object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    if (query === '') return { errors: [{ message: 'GraphQL request body must include a query string' }] };
    let document: Document;
    try {
      document = new Parser(query).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
    }
    let operation = document.operations[0];
    if (operationName !== null) {
      operation = document.operations.find((candidate) => candidate.name === operationName) ?? operation;
    }
    if (!operation) return { errors: [{ message: 'GraphQL document has no operation' }] };
    // Operation-level variable defaults.
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const [key, defaultValue] of Object.entries(operation.variables)) {
      if (mergedVariables[key] === undefined && defaultValue !== undefined) mergedVariables[key] = defaultValue;
    }
    return executeOperation(document, operation, mergedVariables, store);
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!authorized(req)) {
    sendMessage(res, store, 401, 'Bad credentials');
    return true;
  }
  const body = await readBody(req);
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendMessage(res, store, 400, 'Malformed JSON body');
    return true;
  }
  const result = executeRequest(parsed.value, store);
  sendJson(res, store, 200, result);
  return true;
}
