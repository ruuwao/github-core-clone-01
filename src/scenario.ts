// The seeded scenario, re-implemented exactly as the env's wire.ts defines it: the same
// SCENARIO_SEED, the same PRNG (fnv1a64 / mix64 / xorshift64* Rng), the same name lists and the
// same generators. The entry cannot learn the viewer login from its token (the token does not
// encode it), so it derives the viewer the only way the suite allows: from the seed.
//
// Everything in this file is deterministic: no clock, no Math.random.

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';
export const U64_MASK = 0xffffffffffffffffn;
export const SCENARIO_EPOCH_SEC = 1_735_689_600;
export const SCENARIO_USERS = 12;
export const SCENARIO_VIEWER_REPOS = 30;
export const SCENARIO_ORG_REPOS = 6;
export const SCENARIO_STRANGER_REPOS = 3;
export const SCENARIO_FILE_PATHS = 60;
export const SCENARIO_BLOBS = 24;
export const SCENARIO_COMMITS = 60;
export const SCENARIO_ISSUES = 60;
export const SCENARIO_PULLS = 30;
export const DEFAULT_BRANCH = 'main';

export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

const HEX_DIGITS = '0123456789abcdef';

export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  clone(): Rng {
    return new Rng(this.#state);
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new WireError(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new WireError('pick from an empty list');
    return items[this.nextInt(items.length)];
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  bytes(length: number): Uint8Array {
    const size = Number.isSafeInteger(length) ? Math.max(0, length) : 0;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 4) {
      const word = this.nextU32();
      out[i] = word & 0xff;
      if (i + 1 < size) out[i + 1] = (word >>> 8) & 0xff;
      if (i + 2 < size) out[i + 2] = (word >>> 16) & 0xff;
      if (i + 3 < size) out[i + 3] = (word >>> 24) & 0xff;
    }
    return out;
  }

  hex(length: number): string {
    let out = '';
    while (out.length < length) out += HEX_DIGITS[this.nextInt(16)];
    return out;
  }

  words(count: number, list: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(this.pick(list));
    return out;
  }
}

export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const FIRST_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);
const REPO_ADJECTIVES: readonly string[] = Object.freeze([
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
]);
const REPO_NOUNS: readonly string[] = Object.freeze([
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
]);
const REPO_DESCRIPTIONS: readonly string[] = Object.freeze([
  'a small service with a sharp edge',
  'notes and experiments, kept until they are not',
  'the tooling behind the thing',
  'a reference implementation, for reading',
  'what the prototype became',
  'fixtures, generators and the odd benchmark',
  'the parts that must not break',
  'a sandbox for the next idea',
]);
const PATH_SEGMENTS: readonly string[] = Object.freeze([
  'src', 'lib', 'docs', 'test', 'scripts', 'api', 'core', 'util', 'config', 'data', 'web', 'cli', 'pkg',
  'internal', 'examples', 'assets', 'build', 'tools', 'server', 'client',
]);
const FILE_STEMS: readonly string[] = Object.freeze([
  'index', 'request', 'response', 'server', 'client', 'schema', 'parser', 'router', 'config', 'store',
  'clock', 'queue', 'render', 'format', 'validate', 'session', 'token', 'event', 'stream', 'cache',
]);
const FILE_EXTENSIONS: readonly string[] = Object.freeze(['ts', 'js', 'json', 'md', 'txt', 'yml', 'toml', 'css', 'html', 'sql']);
const BLOB_WORDS: readonly string[] = Object.freeze([
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor',
  'whiskey', 'xray', 'yankee', 'zulu', 'amber', 'basalt', 'cobalt', 'drift', 'ember', 'frost', 'granite',
  'hollow', 'ivory', 'jasper', 'kelp', 'lichen', 'moss', 'nickel',
]);
const COMMIT_VERBS: readonly string[] = Object.freeze([
  'Add', 'Fix', 'Refactor', 'Document', 'Test', 'Tidy', 'Speed up', 'Simplify', 'Handle', 'Extract',
  'Inline', 'Rename', 'Guard', 'Wire', 'Drop',
]);
const COMMIT_OBJECTS: readonly string[] = Object.freeze([
  'the request parser', 'repo lookup', 'issue pagination', 'the merge path', 'token checks',
  'the clone endpoint', 'packfile handling', 'error bodies', 'branch listing', 'the GraphQL node query',
  'MCP tool dispatch', 'rate limit headers', 'the upload pack', 'the ref advertisement', 'commit ancestry',
]);
const ISSUE_ADJECTIVES: readonly string[] = Object.freeze([
  'Broken', 'Slow', 'Missing', 'Confusing', 'Unexpected', 'Flaky', 'Incorrect', 'Unclear', 'Stale', 'Noisy',
]);
const ISSUE_SUBJECTS: readonly string[] = Object.freeze([
  'clone over HTTP', 'push report-status', 'issue pagination', 'merge button', 'GraphQL node ids',
  'MCP tool list', 'shallow fetch', 'tag listing', 'repo creation', 'content update', 'branch deletion',
  'commit listing',
]);
const PULL_VERBS: readonly string[] = Object.freeze(['Add', 'Fix', 'Improve', 'Simplify', 'Document', 'Refactor', 'Speed up', 'Harden']);
const PULL_SUBJECTS: readonly string[] = Object.freeze([
  'shallow fetch support', 'push report status checks', 'issue label validation', 'merge conflict detection',
  'GraphQL cursor pagination', 'MCP tool schemas', 'packfile delta reuse', 'conditional requests',
  'repo pagination', 'branch protection stubs',
]);
const SENTENCE_STARTS: readonly string[] = Object.freeze([
  'Steps to reproduce are below', 'This showed up after the last change', 'The expected behaviour is clear',
  'A minimal case is attached', 'It works on a fresh repository', 'The same flow works over the API',
]);
const SENTENCE_ENDS: readonly string[] = Object.freeze([
  'and the server answers with a JSON error', 'but the second request fails', 'and nothing is written to the log',
  'while the reply body stays empty', 'and the status is wrong for the method', 'so the client gives up',
]);
export const ISSUE_LABELS: readonly string[] = Object.freeze(['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']);
const DEFAULT_BRANCHES: readonly string[] = Object.freeze(['main', 'develop', 'release/1.0']);

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface ScenarioRepo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
}

export interface ScenarioBlob {
  readonly path: string;
  readonly content: string;
  readonly base64: string;
}

export interface ScenarioCommit {
  readonly message: string;
  readonly author: ScenarioUser;
  readonly epochSec: number;
  readonly iso: string;
}

export interface ScenarioIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface ScenarioPull {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

export interface Scenario {
  readonly seed: string;
  readonly viewer: ScenarioUser;
  readonly teammate: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly users: readonly ScenarioUser[];
  readonly org: string;
  readonly repos: readonly ScenarioRepo[];
  readonly orgRepos: readonly ScenarioRepo[];
  readonly strangerRepos: readonly ScenarioRepo[];
  readonly labels: readonly string[];
  readonly branches: readonly string[];
  readonly filePaths: readonly string[];
  readonly blobs: readonly ScenarioBlob[];
  readonly commits: readonly ScenarioCommit[];
  readonly issues: readonly ScenarioIssue[];
  readonly pulls: readonly ScenarioPull[];
}

export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}

export function generateRepos(rng: Rng, owner: string, count: number, firstId = 5000): ScenarioRepo[] {
  const used = new Set<string>();
  const repos: ScenarioRepo[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const base = `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(name);
    repos.push(
      Object.freeze({
        id: firstId + i,
        owner,
        name,
        fullName: `${owner}/${name}`,
        description: rng.pick(REPO_DESCRIPTIONS),
        private: i % 7 === 3,
        defaultBranch: DEFAULT_BRANCH,
      }),
    );
  }
  return repos;
}

export function generateFilePaths(rng: Rng, count: number): string[] {
  const used = new Set<string>();
  const paths: string[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const depth = rng.nextInt(3) === 0 ? 0 : 1 + rng.nextInt(2);
    const dirs = depth === 0 ? [] : rng.shuffle(PATH_SEGMENTS).slice(0, depth);
    const base = [...dirs, `${rng.pick(FILE_STEMS)}.${rng.pick(FILE_EXTENSIONS)}`].join('/');
    let path = base;
    let suffix = 2;
    while (used.has(path)) {
      path = [...dirs, `${suffix}-${base.split('/').pop() ?? base}`].join('/');
      suffix += 1;
    }
    used.add(path);
    paths.push(path);
  }
  return paths;
}

export function generateBlobText(rng: Rng, sizeBytes: number): string {
  const size = Number.isFinite(sizeBytes) ? Math.max(0, Math.trunc(sizeBytes)) : 0;
  let out = '';
  while (out.length < size) {
    out += rng.pick(BLOB_WORDS);
    if (out.length < size) out += rng.chance(0.14) ? '\n' : ' ';
  }
  return out.slice(0, size);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >> 18) & 63] ?? '';
    out += BASE64_ALPHABET[(triplet >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triplet >> 6) & 63] ?? '' : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triplet & 63] ?? '' : '=';
  }
  return out;
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function generateBlob(rng: Rng, path: string, sizeBytes: number): ScenarioBlob {
  const content = generateBlobText(rng, sizeBytes);
  return Object.freeze({ path, content, base64: textToBase64(content) });
}

export function scenarioDate(rng: Rng): { readonly epochSec: number; readonly iso: string } {
  const epochSec = SCENARIO_EPOCH_SEC + rng.nextInt(90 * 24 * 60 * 60);
  return Object.freeze({ epochSec, iso: new Date(epochSec * 1000).toISOString() });
}

export function generateCommitMessage(rng: Rng): string {
  const head = `${rng.pick(COMMIT_VERBS)} ${rng.pick(COMMIT_OBJECTS)}`;
  return rng.chance(0.35) ? `${head}\n\n${generateSentence(rng)}` : head;
}

export function generateCommit(rng: Rng, author: ScenarioUser): ScenarioCommit {
  const when = scenarioDate(rng);
  return Object.freeze({ message: generateCommitMessage(rng), author, epochSec: when.epochSec, iso: when.iso });
}

export function generateSentence(rng: Rng): string {
  return `${rng.pick(SENTENCE_STARTS)} ${rng.pick(SENTENCE_ENDS)}.`;
}

export function generateBody(rng: Rng): string {
  const sentences: string[] = [];
  const count = 1 + rng.nextInt(3);
  for (let i = 0; i < count; i += 1) sentences.push(generateSentence(rng));
  return sentences.join(' ');
}

export function generateIssue(rng: Rng): ScenarioIssue {
  return Object.freeze({
    title: `${rng.pick(ISSUE_ADJECTIVES)} ${rng.pick(ISSUE_SUBJECTS)}`,
    body: generateBody(rng),
    labels: rng.chance(0.5) ? [rng.pick(ISSUE_LABELS)] : [],
  });
}

export function generateBranchName(rng: Rng): string {
  const kind = rng.pick(['feature', 'fix', 'perf', 'docs', 'chore']);
  const subject = rng
    .pick(PULL_SUBJECTS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${kind}/${subject}`;
}

export function generatePull(rng: Rng, base: string = DEFAULT_BRANCH): ScenarioPull {
  return Object.freeze({
    title: `${rng.pick(PULL_VERBS)} ${rng.pick(PULL_SUBJECTS)}`,
    body: generateBody(rng),
    head: generateBranchName(rng),
    base,
  });
}

function uniqueBranch(rng: Rng, used: Set<string>): string {
  let branch = generateBranchName(rng);
  let suffix = 2;
  while (used.has(branch)) {
    branch = `${generateBranchName(rng)}-${suffix}`;
    suffix += 1;
  }
  used.add(branch);
  return branch;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

let cachedScenario: Scenario | null = null;

export function buildScenario(): Scenario {
  if (cachedScenario !== null) return cachedScenario;
  const users = generateUsers(scenarioRng('users'), SCENARIO_USERS);
  const viewer = users[0] as ScenarioUser;
  const teammate = users[1] as ScenarioUser;
  const stranger = users[2] as ScenarioUser;
  const orgRng = scenarioRng('org');
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  const branchRng = scenarioRng('branches');
  const branchSet = new Set<string>(DEFAULT_BRANCHES);
  for (let i = 0; i < 8; i += 1) uniqueBranch(branchRng, branchSet);
  const filePaths = generateFilePaths(scenarioRng('paths'), SCENARIO_FILE_PATHS);
  const blobRng = scenarioRng('blobs');
  const blobs = filePaths.slice(0, SCENARIO_BLOBS).map((path) => generateBlob(blobRng, path, 64 + blobRng.nextInt(4_033)));
  const commitRng = scenarioRng('commits');
  const commits = Array.from({ length: SCENARIO_COMMITS }, () => generateCommit(commitRng, commitRng.pick(users)));
  const issueRng = scenarioRng('issues');
  const issues = Array.from({ length: SCENARIO_ISSUES }, () => generateIssue(issueRng));
  const pullRng = scenarioRng('pulls');
  const pulls = Array.from({ length: SCENARIO_PULLS }, () => generatePull(pullRng));
  const repos = generateRepos(scenarioRng('repos.viewer'), viewer.login, SCENARIO_VIEWER_REPOS, 5000);
  const orgRepos = generateRepos(scenarioRng('repos.org'), org, SCENARIO_ORG_REPOS, 6000);
  const strangerRepos = generateRepos(scenarioRng('repos.stranger'), stranger.login, SCENARIO_STRANGER_REPOS, 7000);
  cachedScenario = deepFreeze({
    seed: SCENARIO_SEED_HEX,
    viewer,
    teammate,
    stranger,
    users,
    org,
    repos,
    orgRepos,
    strangerRepos,
    labels: ISSUE_LABELS,
    branches: [...branchSet],
    filePaths,
    blobs,
    commits,
    issues,
    pulls,
  });
  return cachedScenario;
}
