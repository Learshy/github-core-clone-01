// GraphQL v4: a small parser + executor for the 18 operation documents the suite
// sends, over the same store as REST/git/MCP. Rules from spec/graphql.md:
// always HTTP 200 (except auth, handled in app.ts), data key always present,
// unknown field -> errors naming the field, unknown repo -> data.repository null
// with no errors, global ids are opaque base64 and stable, mutations are
// REST-visible, batching returns one envelope per operation in order.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, sendError, sendJson } from './http.ts';
import { commitTree, diffTrees, flattenTree, mergeBase } from './gitobj.ts';
import { pullIsMergeable, squashMergePull } from './rest.ts';
import type { Issue, Pull, Repo } from './store.ts';
import type { Ctx } from '../app.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

type Selection =
  | { kind: 'field'; alias: string; name: string; args: { name: string; value: Value }[]; selections: Selection[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: { name: string; defaultValue: Value | null }[];
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}", got ${token.value}`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variables = this.matchPunct('(') ? this.parseVariableDefinitions() : [];
        operations.push({ type, name, variables, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue: Value | null }[] {
    const variables: { name: string; defaultValue: Value | null }[] = [];
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: Value | null = null;
      if (this.matchPunct('=')) defaultValue = this.parseValue();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  /** Skip a type reference (String!, [Int], CreateIssueInput!, ...). */
  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next !== undefined && next.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.matchPunct(':')) {
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives (@...) are not used by the suite; skip them if present.
    while (this.matchPunct('@')) {
      this.expectName();
      if (this.matchPunct('(')) {
        while (!this.matchPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
    const next = this.peek();
    const selections = next !== undefined && next.kind === 'punct' && next.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value} in GraphQL document`);
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecState {
  ctx: Ctx;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
  errors: { message: string }[];
  failed: boolean;
}

type Resolver = (parent: Record<string, unknown>, args: Record<string, unknown>, ctx: Ctx) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {};

function registerResolvers(typeName: string, fields: Record<string, Resolver>): void {
  resolvers[typeName] = fields;
}

function executeSelectionSet(
  obj: Record<string, unknown>,
  typeName: string,
  selections: Selection[],
  state: ExecState,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (state.failed) return null;
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        const merged = executeSelectionSet(obj, typeName, selection.selections, state);
        if (merged === null) return null;
        Object.assign(out, merged);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment === undefined) {
        state.errors.push({ message: `Unknown fragment "${selection.name}".` });
        state.failed = true;
        return null;
      }
      if (fragment.typeCondition === typeName) {
        const merged = executeSelectionSet(obj, typeName, fragment.selections, state);
        if (merged === null) return null;
        Object.assign(out, merged);
      }
      continue;
    }
    const fields = resolvers[typeName];
    const resolver = fields === undefined ? undefined : fields[selection.name];
    if (resolver === undefined) {
      state.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      state.failed = true;
      return null;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = evalValue(arg.value, state.variables);
    let value: unknown;
    try {
      value = resolver(obj, args, state.ctx);
    } catch (err: unknown) {
      state.errors.push({ message: err instanceof Error ? err.message : 'Internal error' });
      out[selection.alias] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[selection.alias] = null;
      continue;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const typed = item as Record<string, unknown>;
          items.push(executeSelectionSet(typed, typed.__typename as string, selection.selections, state));
        } else {
          items.push(item);
        }
        if (state.failed) return null;
      }
      out[selection.alias] = items;
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const typed = value as Record<string, unknown>;
      out[selection.alias] = executeSelectionSet(typed, typed.__typename as string, selection.selections, state);
      if (state.failed) return null;
      continue;
    }
    out[selection.alias] = value;
  }
  return out;
}

function executeOperation(
  doc: Document,
  operation: Operation,
  variables: Record<string, unknown>,
  ctx: Ctx,
): { data: unknown; errors: { message: string }[] } {
  const provided: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (!(variable.name in provided) || provided[variable.name] === undefined) {
      provided[variable.name] = variable.defaultValue === null ? null : evalValue(variable.defaultValue, provided);
    }
  }
  const state: ExecState = { ctx, variables: provided, fragments: doc.fragments, errors: [], failed: false };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet({ __typename: rootType }, rootType, operation.selections, state);
  return { data: state.failed ? null : data, errors: state.errors };
}

// ---------------------------------------------------------------------------
// Global ids (opaque base64, stable, decodable by the server)
// ---------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.fullName}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.fullName}:${issue.number}`);
}

function prGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.fullName}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64(`Comment:${repo.fullName}:${issue.number}:${commentId}`);
}

interface DecodedId {
  type: string;
  owner: string;
  repo: string;
  number: number | undefined;
  seq: number | undefined;
}

function decodeGlobalId(id: string): DecodedId | null {
  const text = unb64(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const [owner, repo] = parts[1].split('/');
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return null;
  const number = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : undefined;
  const seq = parts.length >= 4 && parts[3] !== '' ? Number(parts[3]) : undefined;
  return { type: parts[0], owner, repo, number, seq };
}

function findRepo(ctx: Ctx, decoded: DecodedId): Repo | undefined {
  return ctx.store.getRepo(decoded.owner, decoded.repo);
}

// ---------------------------------------------------------------------------
// Introspection data
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'createdAt', 'updatedAt', 'author', 'head', 'base',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt',
    'updatedAt', 'url', 'defaultBranch', 'fork', 'private',
  ],
  User: ['login', 'id', 'name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MARKETPLACE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function introspectionType(name: string): Record<string, unknown> | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'OBJECT', fields: TYPE_FIELDS[name], enumValues: null };
  }
  if (ENUM_VALUES[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: ENUM_VALUES[name] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  // No orderBy: creation order (number ASC) so cursors partition the set.
  const direction = orderBy === undefined ? 1 : orderBy.direction === 'ASC' ? 1 : -1;
  const field = orderBy?.field ?? 'CREATED_AT';
  list.sort((a, b) => {
    if (field === 'COMMENTS') {
      const diff = (a.comments.length - b.comments.length) * direction;
      if (diff !== 0) return diff;
    } else if (field === 'UPDATED_AT') {
      const diff = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
      if (diff !== 0) return diff * direction;
    } else {
      const diff = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      if (diff !== 0) return diff * direction;
    }
    return (a.number - b.number) * direction;
  });
  let start = 0;
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after !== '') {
    const decoded = unb64(after);
    const number = decoded === null ? Number.NaN : Number(decoded);
    if (!Number.isNaN(number)) {
      const index = list.findIndex((issue) => issue.number === number);
      if (index !== -1) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? b64(String(page[page.length - 1].number)) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function prFiles(repo: Repo, pull: Pull): { filename: string }[] {
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseFiles = base === null ? new Map() : flattenTree(repo, commitTree(repo, base));
  const headFiles = flattenTree(repo, commitTree(repo, pull.headSha));
  return diffTrees(repo, baseFiles, headFiles).map((diff) => ({ filename: diff.filename }));
}

function nodeObject(ctx: Ctx, id: string): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const repo = findRepo(ctx, decoded);
  if (repo === undefined) return null;
  if (decoded.type === 'Repository') return { __typename: 'Repository', repo };
  if (decoded.type === 'Issue' && decoded.number !== undefined) {
    const issue = repo.issues.find((item) => item.number === decoded.number);
    return issue === undefined ? null : { __typename: 'Issue', repo, issue };
  }
  if (decoded.type === 'PullRequest' && decoded.number !== undefined) {
    const pull = repo.pulls.find((item) => item.number === decoded.number);
    return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

registerResolvers('Query', {
  viewer: (_parent, _args, ctx) => ({ __typename: 'User', login: ctx.viewerLogin }),
  repository: (_parent, args, ctx) => {
    const repo = ctx.store.getRepo(String(args.owner), String(args.name));
    return repo === undefined ? null : { __typename: 'Repository', repo };
  },
  node: (_parent, args, ctx) => nodeObject(ctx, String(args.id)),
  __type: (_parent, args) => introspectionType(String(args.name)),
});

registerResolvers('User', {
  login: (parent) => parent.login as string,
  id: (parent, _args, ctx) => b64(`User:${String(parent.login)}`),
  name: (parent) => parent.login as string,
});

registerResolvers('Repository', {
  id: (parent) => repoGlobalId(parent.repo as Repo),
  databaseId: (parent) => (parent.repo as Repo).id,
  name: (parent) => (parent.repo as Repo).name,
  nameWithOwner: (parent) => (parent.repo as Repo).fullName,
  owner: (parent) => ({ __typename: 'User', login: (parent.repo as Repo).owner }),
  defaultBranchRef: (parent) => {
    const repo = parent.repo as Repo;
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (parent, args) => {
    const repo = parent.repo as Repo;
    const issue = repo.issues.find((item) => item.number === args.number);
    return issue === undefined ? null : { __typename: 'Issue', repo, issue };
  },
  issues: (parent, args) => issuesConnection(parent.repo as Repo, args),
  pullRequests: (parent, args) => {
    const repo = parent.repo as Repo;
    const first = typeof args.first === 'number' ? args.first : 100;
    const nodes = [...repo.pulls]
      .sort((a, b) => b.number - a.number)
      .slice(0, first)
      .map((pull) => ({ __typename: 'PullRequest', repo, pull }));
    return { __typename: 'PullRequestConnection', nodes };
  },
  pullRequest: (parent, args) => {
    const repo = parent.repo as Repo;
    const pull = repo.pulls.find((item) => item.number === args.number);
    return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
  },
});

registerResolvers('Ref', {
  name: (parent) => parent.name as string,
});

registerResolvers('Issue', {
  id: (parent) => issueGlobalId(parent.repo as Repo, parent.issue as Issue),
  number: (parent) => (parent.issue as Issue).number,
  title: (parent) => (parent.issue as Issue).title,
  body: (parent) => (parent.issue as Issue).body,
  state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
});

registerResolvers('PullRequest', {
  id: (parent) => prGlobalId(parent.repo as Repo, parent.pull as Pull),
  number: (parent) => (parent.pull as Pull).number,
  title: (parent) => (parent.pull as Pull).title,
  body: (parent) => (parent.pull as Pull).body,
  state: (parent) => {
    const pull = parent.pull as Pull;
    if (pull.merged) return 'MERGED';
    return pull.state === 'open' ? 'OPEN' : 'CLOSED';
  },
  merged: (parent) => (parent.pull as Pull).merged,
  headRefName: (parent) => (parent.pull as Pull).headRef,
  baseRefName: (parent) => (parent.pull as Pull).baseRef,
  mergeable: (parent) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    if (pull.merged) return 'UNKNOWN';
    return pullIsMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
  },
  files: (parent, args) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    const first = typeof args.first === 'number' ? args.first : 100;
    const nodes = prFiles(repo, pull)
      .slice(0, first)
      .map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
    return { __typename: 'PullRequestChangedFileConnection', nodes };
  },
});

registerResolvers('PullRequestChangedFile', {
  path: (parent) => parent.path as string,
});

registerResolvers('IssueConnection', {
  nodes: (parent) => parent.nodes as unknown[],
  pageInfo: (parent) => parent.pageInfo as Record<string, unknown>,
});

registerResolvers('PullRequestConnection', {
  nodes: (parent) => parent.nodes as unknown[],
});

registerResolvers('PullRequestChangedFileConnection', {
  nodes: (parent) => parent.nodes as unknown[],
});

registerResolvers('PageInfo', {
  hasNextPage: (parent) => parent.hasNextPage as boolean,
  endCursor: (parent) => (parent.endCursor ?? null) as string | null,
});

registerResolvers('__Type', {
  name: (parent) => parent.name as string,
  kind: (parent) => parent.kind as string,
  fields: (parent) => {
    const fields = parent.fields as string[] | null;
    return fields === null ? null : fields.map((name) => ({ __typename: '__Field', name }));
  },
  enumValues: (parent) => {
    const values = parent.enumValues as string[] | null;
    return values === null ? null : values.map((name) => ({ __typename: '__EnumValue', name }));
  },
});

registerResolvers('__Field', {
  name: (parent) => parent.name as string,
});

registerResolvers('__EnumValue', {
  name: (parent) => parent.name as string,
});

registerResolvers('CreateIssuePayload', {
  issue: (parent) => parent.issue as Record<string, unknown>,
});

registerResolvers('CloseIssuePayload', {
  issue: (parent) => parent.issue as Record<string, unknown>,
});

registerResolvers('CreatePullRequestPayload', {
  pullRequest: (parent) => parent.pullRequest as Record<string, unknown>,
});

registerResolvers('MergePullRequestPayload', {
  pullRequest: (parent) => parent.pullRequest as Record<string, unknown>,
});

registerResolvers('AddCommentPayload', {
  commentEdge: (parent) => parent.commentEdge as Record<string, unknown>,
});

registerResolvers('IssueCommentEdge', {
  node: (parent) => parent.node as Record<string, unknown>,
});

registerResolvers('IssueComment', {
  id: (parent) => parent.id as string,
  body: (parent) => parent.body as string,
});

registerResolvers('Mutation', {
  createIssue: (_parent, args, ctx) => {
    const input = args.input as { repositoryId: string; title: string; body?: string };
    const decoded = decodeGlobalId(input.repositoryId);
    if (decoded === null || decoded.type !== 'Repository') throw new Error('Invalid repositoryId');
    const repo = findRepo(ctx, decoded);
    if (repo === undefined) throw new Error('Repository not found');
    const issue = ctx.store.createIssue(repo, input.title, input.body ?? '', [], ctx.viewerLogin);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
  },
  closeIssue: (_parent, args, ctx) => {
    const input = args.input as { issueId: string };
    const decoded = decodeGlobalId(input.issueId);
    if (decoded === null || decoded.type !== 'Issue' || decoded.number === undefined) {
      throw new Error('Invalid issueId');
    }
    const repo = findRepo(ctx, decoded);
    const issue = repo?.issues.find((item) => item.number === decoded.number);
    if (repo === undefined || issue === undefined) throw new Error('Issue not found');
    issue.state = 'closed';
    issue.updatedAt = ctx.store.stamp();
    return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } };
  },
  createPullRequest: (_parent, args, ctx) => {
    const input = args.input as { repositoryId: string; baseRefName: string; headRefName: string; title: string };
    const decoded = decodeGlobalId(input.repositoryId);
    if (decoded === null || decoded.type !== 'Repository') throw new Error('Invalid repositoryId');
    const repo = findRepo(ctx, decoded);
    if (repo === undefined) throw new Error('Repository not found');
    const headSha = repo.refs.get(`refs/heads/${input.headRefName}`);
    const baseSha = repo.refs.get(`refs/heads/${input.baseRefName}`);
    if (headSha === undefined || baseSha === undefined) throw new Error('Head or base branch not found');
    const pull = ctx.store.createPull(repo, input.title, '', input.headRefName, input.baseRefName, headSha, baseSha, ctx.viewerLogin);
    return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
  },
  mergePullRequest: (_parent, args, ctx) => {
    const input = args.input as { pullRequestId: string; mergeMethod?: string };
    const decoded = decodeGlobalId(input.pullRequestId);
    if (decoded === null || decoded.type !== 'PullRequest' || decoded.number === undefined) {
      throw new Error('Invalid pullRequestId');
    }
    const repo = findRepo(ctx, decoded);
    const pull = repo?.pulls.find((item) => item.number === decoded.number);
    if (repo === undefined || pull === undefined) throw new Error('Pull request not found');
    if (!pull.merged) {
      const result = squashMergePull(ctx, repo, pull);
      if (result.status === 'conflict') throw new Error('Merge conflict');
      if (result.status === 'no-base') throw new Error('Base branch not found');
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
  },
  addComment: (_parent, args, ctx) => {
    const input = args.input as { subjectId: string; body: string };
    const decoded = decodeGlobalId(input.subjectId);
    if (decoded === null || decoded.type !== 'Issue' || decoded.number === undefined) {
      throw new Error('Invalid subjectId');
    }
    const repo = findRepo(ctx, decoded);
    const issue = repo?.issues.find((item) => item.number === decoded.number);
    if (repo === undefined || issue === undefined) throw new Error('Issue not found');
    const comment = ctx.store.createComment(repo, issue, input.body, ctx.viewerLogin);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: {
          __typename: 'IssueComment',
          id: commentGlobalId(repo, issue, comment.id),
          body: comment.body,
        },
      },
    };
  },
});

// ---------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------

export async function handleGraphql(
  ctx: Ctx,
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  const parsed = parseJsonBody(body);
  if (parsed === null) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const runOne = (operation: unknown): { data: unknown; errors: { message: string }[] } => {
    const input = (operation ?? {}) as Record<string, unknown>;
    const query = input.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err: unknown) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
    }
    if (doc.operations.length === 0) {
      return { data: null, errors: [{ message: 'Must provide an operation.' }] };
    }
    const operationName = typeof input.operationName === 'string' ? input.operationName : null;
    const selected = operationName === null
      ? doc.operations[0]
      : doc.operations.find((item) => item.name === operationName);
    if (selected === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
    const variables = (input.variables ?? {}) as Record<string, unknown>;
    return executeOperation(doc, selected, variables, ctx);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((operation) => runOne(operation)));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
