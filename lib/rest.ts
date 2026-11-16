// REST v3: repos, branches, commits, contents, labels, issues, pulls.
// One store shared with git, GraphQL and MCP. Wire rules from spec/rest.md:
// JSON everywhere, X-GitHub-Request-Id on every reply, errors {"message": string},
// unknown route 404, malformed JSON 400, duplicate repo 422, stale contents sha 409,
// unknown issue label 422, conflicted merge 405.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  linkHeader,
  nextRequestId,
  pageParams,
  paginate,
  sendError,
  sendJson,
  sendJsonText,
  tryParseJsonBody,
} from './http.ts';
import {
  commitTree,
  diffTrees,
  flattenTree,
  makeCommit,
  mergeBase,
  nextCommitEpoch,
  parseCommit,
  treeFromFiles,
} from './gitobj.ts';
import { bumpRefs, objectId, type Issue, type Pull, type Repo } from './store.ts';
import type { Ctx } from '../app.ts';

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    html_url: `https://example.invalid/${repo.fullName}`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    ssh_url: `git@example.invalid:${repo.fullName}.git`,
    homepage: null,
    language: null,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    subscribers_count: 0,
    license: null,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** Serialized single-issue JSON (no trailing newline), cached per issue number. */
function issueJsonText(repo: Repo, issue: Issue): string {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueJson(repo, issue));
  repo.issueJsonCache.set(issue.number, text);
  return text;
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((item) => item.name === name);
      return label === undefined
        ? { id: 0, name, color: 'ededed', description: '' }
        : { id: label.id, name: label.name, color: label.color, description: label.description };
    }),
    user: { login: issue.user, id: 1000 },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user, id: 1000 },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

/** 204 with the request-id header and no body. */
function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Working tree of a branch tip as path -> content bytes. */
function branchFiles(repo: Repo, branch: string): Map<string, Buffer> | null {
  const tip = branchTip(repo, branch);
  if (tip === undefined) return null;
  const treeOid = commitTree(repo, tip);
  if (treeOid === '') return null;
  const flat = flattenTree(repo, treeOid);
  const out = new Map<string, Buffer>();
  for (const [path, entry] of flat) {
    const blob = repo.objects.get(entry.oid);
    if (blob !== undefined) out.set(path, blob.data);
  }
  return out;
}

/**
 * Commit a full working tree onto a branch (creating the branch if needed) and
 * return the new commit oid. Used by contents PUT/DELETE.
 */
function commitTreeOnBranch(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  files: ReadonlyMap<string, Buffer>,
  message: string,
): string {
  const blobOids = new Map<string, string>();
  for (const [path, content] of files) {
    blobOids.set(path, repo.objects.has(objectId('blob', content)) ? objectId('blob', content) : (() => {
      const oid = objectId('blob', content);
      repo.objects.set(oid, { type: 'blob', data: content });
      return oid;
    })());
  }
  const treeOid = treeFromFiles(repo, blobOids);
  const parent = branchTip(repo, branch);
  const parents = parent === undefined ? [] : [parent];
  const epoch = nextCommitEpoch(repo);
  const oid = makeCommit(repo, treeOid, parents, message, ctx.viewerLogin, `${ctx.viewerLogin}@example.invalid`, epoch);
  repo.refs.set(`refs/heads/${branch}`, oid);
  bumpRefs(repo);
  return oid;
}

/** List commits reachable from a tip, newest-first (DFS pre-order over parents).
 * The REST message is the commit message without its trailing newline (GitHub's
 * REST API strips it; the raw git object keeps the conventional trailing LF). */
function listCommits(repo: Repo, tipOid: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    const info = parseCommit(obj.data);
    out.push({ sha: oid, message: info.message.replace(/\n$/, '') });
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
  }
  return out;
}

type RouteHandler = (
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
  /** The pattern string, kept so dispatch can bucket routes without regexes. */
  source: string;
}

function route(method: string, pattern: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const source = pattern.replace(/\{(\w+)\}/g, (_m, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler, source: pattern };
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve {owner}/{repo} from params; 404 when missing or foreign-owned. */
function mustRepo(ctx: Ctx, res: ServerResponse, params: Record<string, string>): Repo | null {
  const repo = ctx.store.getRepo(decodeSegment(params.owner), decodeSegment(params.repo));
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function absoluteUrl(req: IncomingMessage, path: string, query: URLSearchParams): string {
  const host = req.headers.host ?? 'localhost';
  const qs = query.toString();
  return `http://${host}${path}${qs === '' ? '' : `?${qs}`}`;
}

const routes: Route[] = [
  route('GET', '/api/v3/user', (ctx, _req, res) => {
    sendJson(res, 200, {
      login: ctx.viewerLogin,
      id: 1000,
      name: ctx.viewerLogin,
      email: `${ctx.viewerLogin}@example.invalid`,
      type: 'User',
    });
  }),

  route('GET', '/api/v3/meta', (_ctx, _req, res) => {
    sendJson(res, 200, { installed_version: '1.0.0' });
  }),

  route('POST', '/api/v3/user/repos', (ctx, _req, res, _params, _query, body) => {
    const input = (body ?? {}) as Record<string, unknown>;
    const name = typeof input.name === 'string' ? input.name : '';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return;
    }
    if (ctx.store.getRepo(ctx.viewerLogin, name) !== undefined) {
      sendError(res, 422, 'Validation Failed: repository already exists');
      return;
    }
    const repo = ctx.store.createRepo(
      ctx.viewerLogin,
      name,
      typeof input.description === 'string' ? input.description : '',
      input.private === true,
      typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
    );
    sendJson(res, 201, repoJson(repo));
  }),

  route('GET', '/api/v3/user/repos', (ctx, req, res, _params, query) => {
    const { page, perPage } = pageParams(query);
    const all = ctx.store.listReposByOwner(ctx.viewerLogin);
    const { items, hasNext } = paginate(all, page, perPage);
    const headers: Record<string, string> = {};
    if (hasNext || page > 1) {
      const total = all.length;
      const urlFor = (p: number): string => {
        const q = new URLSearchParams(query);
        q.set('page', String(p));
        q.set('per_page', String(perPage));
        return absoluteUrl(req, '/api/v3/user/repos', q);
      };
      const link = linkHeader(urlFor, page, perPage, total);
      if (link !== null) headers.link = link;
    }
    sendJson(res, 200, items.map((repo) => repoJson(repo)), headers);
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    sendJson(res, 200, repoJson(repo));
  }),

  route('PATCH', '/api/v3/repos/{owner}/{repo}', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const input = (body ?? {}) as Record<string, unknown>;
    if (typeof input.description === 'string') repo.description = input.description;
    if (typeof input.default_branch === 'string' && input.default_branch !== '') {
      repo.defaultBranch = input.default_branch;
    }
    sendJson(res, 200, repoJson(repo));
  }),

  route('DELETE', '/api/v3/repos/{owner}/{repo}', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    ctx.store.deleteRepo(repo.owner, repo.name);
    sendNoContent(res);
  }),

  route('POST', '/api/v3/repos/{owner}/{repo}/git/refs', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const input = (body ?? {}) as Record<string, unknown>;
    const ref = typeof input.ref === 'string' ? input.ref : '';
    const sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
    if (!/^refs\/.+/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
      sendError(res, 422, 'Validation Failed: ref and sha are required');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Validation Failed: reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    bumpRefs(repo);
    sendJson(res, 201, { ref, object: { sha, type: 'commit', url: '' } });
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const sha = branchTip(repo, decodeSegment(params.branch));
    if (sha === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { ref: `refs/heads/${decodeSegment(params.branch)}`, object: { sha, type: 'commit', url: '' } });
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/branches', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const out: { name: string; commit: { sha: string } }[] = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
    sendJson(res, 200, out);
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/branches/{branch}', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const sha = branchTip(repo, decodeSegment(params.branch));
    if (sha === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { name: decodeSegment(params.branch), commit: { sha } });
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/commits', (ctx, _req, res, params, query) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const ref = query.get('sha') ?? repo.defaultBranch;
    let tip = branchTip(repo, ref);
    if (tip === undefined && /^[0-9a-f]{40}$/i.test(ref)) tip = ref.toLowerCase();
    if (tip === undefined || repo.objects.get(tip) === undefined) {
      sendJson(res, 200, []);
      return;
    }
    sendJson(
      res,
      200,
      listCommits(repo, tip).map((entry) => ({ sha: entry.sha, commit: { message: entry.message } })),
    );
  }),
];

/** Subtree tree oid for a directory (built from the files beneath it). */
function dirTreeOid(repo: Repo, files: ReadonlyMap<string, Buffer>, dir: string): string {
  const prefix = dir === '' ? '' : `${dir}/`;
  const nested = new Map<string, string>();
  for (const [path, content] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest !== '') nested.set(rest, objectId('blob', content));
  }
  return treeFromFiles(repo, nested);
}

function contentsPut(
  ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  path: string,
  body: unknown,
): void {
  const input = (body ?? {}) as Record<string, unknown>;
  const message = typeof input.message === 'string' ? input.message : 'Update file';
  const contentB64 = typeof input.content === 'string' ? input.content : '';
  if (contentB64 === '') {
    sendError(res, 422, 'Validation Failed: content is required');
    return;
  }
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const files = branchFiles(repo, branch) ?? new Map<string, Buffer>();
  const existed = files.has(path);
  if (existed) {
    const currentSha = objectId('blob', files.get(path) as Buffer);
    if (typeof input.sha === 'string' && input.sha.toLowerCase() !== currentSha) {
      sendError(res, 409, 'Conflict: sha does not match the current blob');
      return;
    }
  }
  const bytes = Buffer.from(contentB64, 'base64');
  files.set(path, bytes);
  const commitSha = commitTreeOnBranch(ctx, repo, branch, files, message);
  const blobSha = objectId('blob', bytes);
  sendJson(res, existed ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
}

function contentsGet(
  _ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
): void {
  const branch = query.get('ref') ?? repo.defaultBranch;
  const files = branchFiles(repo, branch);
  if (files === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (files.has(path)) {
    const content = files.get(path) as Buffer;
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      sha: objectId('blob', content),
      size: content.length,
      name: path.split('/').pop() ?? path,
      path,
    });
    return;
  }
  // Directory listing: immediate children of `path` ('' = repo root).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
  for (const [filePath, content] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', name: rest, path: filePath, sha: objectId('blob', content) });
    } else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        children.set(dirName, {
          type: 'dir',
          name: dirName,
          path: `${prefix}${dirName}`,
          sha: dirTreeOid(repo, files, `${prefix}${dirName}`),
        });
      }
    }
  }
  if (children.size === 0) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
}

function contentsDelete(
  ctx: Ctx,
  res: ServerResponse,
  repo: Repo,
  path: string,
  body: unknown,
): void {
  const input = (body ?? {}) as Record<string, unknown>;
  const message = typeof input.message === 'string' ? input.message : 'Delete file';
  const files = branchFiles(repo, repo.defaultBranch);
  if (files === null || !files.has(path)) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const currentSha = objectId('blob', files.get(path) as Buffer);
  if (typeof input.sha === 'string' && input.sha.toLowerCase() !== currentSha) {
    sendError(res, 409, 'Conflict: sha does not match the current blob');
    return;
  }
  files.delete(path);
  const commitSha = commitTreeOnBranch(ctx, repo, repo.defaultBranch, files, message);
  sendJson(res, 200, { commit: { sha: commitSha, message } });
}

const issueRoutes: Route[] = [
  route('POST', '/api/v3/repos/{owner}/{repo}/labels', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const input = (body ?? {}) as Record<string, unknown>;
    const name = typeof input.name === 'string' ? input.name : '';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return;
    }
    const existing = repo.labels.find((label) => label.name === name);
    if (existing !== undefined) {
      sendJson(res, 201, { id: existing.id, name: existing.name, color: existing.color, description: existing.description });
      return;
    }
    const id = repo.labels.length + 1;
    const label = {
      id,
      name,
      color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
      description: typeof input.description === 'string' ? input.description : '',
    };
    repo.labels.push(label);
    sendJson(res, 201, label);
  }),

  route('POST', '/api/v3/repos/{owner}/{repo}/issues', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const input = (body ?? {}) as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') {
      sendError(res, 422, 'Validation Failed: title is required');
      return;
    }
    const labelNames = Array.isArray(input.labels) ? (input.labels.filter((v) => typeof v === 'string') as string[]) : [];
    for (const labelName of labelNames) {
      if (repo.labels.find((label) => label.name === labelName) === undefined) {
        sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
        return;
      }
    }
    const issue = ctx.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labelNames, ctx.viewerLogin);
    sendJsonText(res, 201, `${issueJsonText(repo, issue)}\n`);
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/issues', (ctx, req, res, params, query) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const state = query.get('state') ?? 'open';
    const { page, perPage } = pageParams(query);
    let list = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
    const direction = query.get('direction') === 'asc' ? 1 : -1;
    list = [...list].sort((a, b) => (a.number - b.number) * direction);
    const { items, hasNext } = paginate(list, page, perPage);
    const headers: Record<string, string> = {};
    if (hasNext || page > 1) {
      const urlFor = (p: number): string => {
        const q = new URLSearchParams(query);
        q.set('page', String(p));
        q.set('per_page', String(perPage));
        return absoluteUrl(req, `/api/v3/repos/${params.owner}/${params.repo}/issues`, q);
      };
      const link = linkHeader(urlFor, page, perPage, list.length);
      if (link !== null) headers.link = link;
    }
    sendJsonText(res, 200, `[${items.map((issue) => issueJsonText(repo, issue)).join(',')}]\n`, headers);
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/issues/{number}', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const issue = repo.issues.find((item) => item.number === Number(params.number));
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJsonText(res, 200, `${issueJsonText(repo, issue)}\n`);
  }),

  route('PATCH', '/api/v3/repos/{owner}/{repo}/issues/{number}', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const issue = repo.issues.find((item) => item.number === Number(params.number));
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const input = (body ?? {}) as Record<string, unknown>;
    if (typeof input.title === 'string') issue.title = input.title;
    if (typeof input.body === 'string') issue.body = input.body;
    if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
    issue.updatedAt = ctx.store.stamp();
    repo.issueJsonCache.delete(issue.number);
    sendJsonText(res, 200, `${issueJsonText(repo, issue)}\n`);
  }),

  route('POST', '/api/v3/repos/{owner}/{repo}/issues/{number}/comments', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const issue = repo.issues.find((item) => item.number === Number(params.number));
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const input = (body ?? {}) as Record<string, unknown>;
    const commentBody = typeof input.body === 'string' ? input.body : '';
    repo.commentSeq += 1;
    const comment = {
      id: repo.commentSeq,
      body: commentBody,
      user: ctx.viewerLogin,
      createdAt: ctx.store.stamp(),
      updatedAt: ctx.store.stamp(),
    };
    issue.comments.push(comment);
    repo.issueJsonCache.delete(issue.number);
    sendJson(res, 201, {
      id: comment.id,
      body: comment.body,
      user: { login: comment.user, id: 1000 },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    });
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/issues/{number}/comments', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const issue = repo.issues.find((item) => item.number === Number(params.number));
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(
      res,
      200,
      issue.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.user, id: 1000 },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })),
    );
  }),
];

const pullRoutes: Route[] = [
  route('POST', '/api/v3/repos/{owner}/{repo}/pulls', (ctx, _req, res, params, _query, body) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const input = (body ?? {}) as Record<string, unknown>;
    const head = typeof input.head === 'string' ? input.head : '';
    const base = typeof input.base === 'string' ? input.base : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const headSha = branchTip(repo, head);
    const baseSha = branchTip(repo, base);
    if (headSha === undefined || baseSha === undefined || title === '') {
      sendError(res, 422, 'Validation Failed: head and base branches must exist and title is required');
      return;
    }
    const pull = ctx.store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha, ctx.viewerLogin);
    sendJson(res, 201, pullJson(repo, pull));
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/pulls', (ctx, req, res, params, query) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const state = query.get('state') ?? 'open';
    const { page, perPage } = pageParams(query);
    let list = state === 'all' ? [...repo.pulls] : repo.pulls.filter((pull) => pull.state === state);
    list = [...list].sort((a, b) => b.number - a.number);
    const { items, hasNext } = paginate(list, page, perPage);
    const headers: Record<string, string> = {};
    if (hasNext || page > 1) {
      const urlFor = (p: number): string => {
        const q = new URLSearchParams(query);
        q.set('page', String(p));
        q.set('per_page', String(perPage));
        return absoluteUrl(req, `/api/v3/repos/${params.owner}/${params.repo}/pulls`, q);
      };
      const link = linkHeader(urlFor, page, perPage, list.length);
      if (link !== null) headers.link = link;
    }
    sendJson(res, 200, items.map((pull) => pullJson(repo, pull)), headers);
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/pulls/{number}', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const pull = repo.pulls.find((item) => item.number === Number(params.number));
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, pullJson(repo, pull));
  }),

  route('GET', '/api/v3/repos/{owner}/{repo}/pulls/{number}/files', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const pull = repo.pulls.find((item) => item.number === Number(params.number));
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const base = mergeBase(repo, pull.headSha, pull.baseSha);
    const baseFiles = base === null ? new Map() : flattenTree(repo, commitTree(repo, base));
    const headFiles = flattenTree(repo, commitTree(repo, pull.headSha));
    sendJson(res, 200, diffTrees(repo, baseFiles, headFiles));
  }),

  route('PUT', '/api/v3/repos/{owner}/{repo}/pulls/{number}/merge', (ctx, _req, res, params) => {
    const repo = mustRepo(ctx, res, params);
    if (repo === null) return;
    const pull = repo.pulls.find((item) => item.number === Number(params.number));
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (pull.merged) {
      sendJson(res, 200, { merged: true, sha: pull.mergeCommitSha, message: 'Pull request successfully merged' });
      return;
    }
    const result = squashMergePull(ctx, repo, pull);
    if (result.status === 'no-base') {
      sendError(res, 422, 'Validation Failed: base branch is missing');
      return;
    }
    if (result.status === 'conflict') {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    sendJson(res, 200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
  }),
];

/**
 * Squash-merge a pull request into its base branch: three-way conflict check
 * (a path changed on both sides of the merge base to different contents blocks
 * the merge), then one commit on the base branch whose tree is the head tree.
 * Shared by the REST merge route and the GraphQL mergePullRequest mutation.
 */
export function squashMergePull(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
): { status: 'ok' | 'conflict' | 'no-base'; sha: string | null } {
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined) return { status: 'no-base', sha: null };
  const base = mergeBase(repo, pull.headSha, baseTip);
  const baseOf = base === null ? new Map<string, { oid: string }>() : flattenTree(repo, commitTree(repo, base));
  const baseTree = flattenTree(repo, commitTree(repo, baseTip));
  const headTree = flattenTree(repo, commitTree(repo, pull.headSha));
  const paths = new Set<string>([...baseOf.keys(), ...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const fromBase = baseOf.get(path)?.oid ?? null;
    const onBase = baseTree.get(path)?.oid ?? null;
    const onHead = headTree.get(path)?.oid ?? null;
    if (fromBase !== onBase && fromBase !== onHead && onBase !== onHead) {
      return { status: 'conflict', sha: null };
    }
  }
  const headTreeOid = commitTree(repo, pull.headSha);
  const epoch = nextCommitEpoch(repo);
  const mergeSha = makeCommit(
    repo,
    headTreeOid,
    [baseTip],
    `Merge pull request #${pull.number} from ${pull.headRef}`,
    ctx.viewerLogin,
    `${ctx.viewerLogin}@example.invalid`,
    epoch,
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  bumpRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ctx.store.stamp();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = ctx.store.stamp();
  return { status: 'ok', sha: mergeSha };
}

/** True when a pull request's head can merge cleanly onto its current base tip. */
export function pullIsMergeable(repo: Repo, pull: Pull): boolean {
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === undefined) return false;
  const base = mergeBase(repo, pull.headSha, baseTip);
  const baseOf = base === null ? new Map<string, { oid: string }>() : flattenTree(repo, commitTree(repo, base));
  const baseTree = flattenTree(repo, commitTree(repo, baseTip));
  const headTree = flattenTree(repo, commitTree(repo, pull.headSha));
  const paths = new Set<string>([...baseOf.keys(), ...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const fromBase = baseOf.get(path)?.oid ?? null;
    const onBase = baseTree.get(path)?.oid ?? null;
    const onHead = headTree.get(path)?.oid ?? null;
    if (fromBase !== onBase && fromBase !== onHead && onBase !== onHead) return false;
  }
  return true;
}

const allRoutes: Route[] = [...routes, ...issueRoutes, ...pullRoutes];

/**
 * Dispatch buckets: routes are grouped by method + the resource segment
 * after /api/v3/repos/{owner}/{repo}/ ('' for shorter or other paths), so a
 * request only regex-tests the handful of routes it could match instead of
 * all ~25. A route whose pattern has a parameter at that position lands in
 * `routeAny` and is always tested (none exist today; the fallback keeps the
 * index correct if one is added).
 */
function bucketOfPattern(method: string, pattern: string): string | null {
  const segments = pattern.split('/');
  if (segments.length <= 6 || segments[3] !== 'repos') return `${method}:`;
  const seg = segments[6];
  if (seg.startsWith('{')) return null;
  return `${method}:${seg}`;
}

const routeBuckets = new Map<string, Route[]>();
const routeAny: Route[] = [];
for (const r of allRoutes) {
  const bucket = bucketOfPattern(r.method, r.source);
  if (bucket === null) {
    routeAny.push(r);
    continue;
  }
  const list = routeBuckets.get(bucket) ?? [];
  list.push(r);
  routeBuckets.set(bucket, list);
}

function bucketOfPath(method: string, path: string): string {
  const segments = path.split('/');
  if (segments.length <= 6 || segments[3] !== 'repos') return `${method}:`;
  return `${method}:${segments[6]}`;
}

export async function handleRest(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  query: URLSearchParams,
  body: Buffer,
): Promise<void> {
  // Contents paths carry slashes in {path}: handle before the table.
  if (path.indexOf('/contents') !== -1) {
    const contentsMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*)$/.exec(path);
    if (contentsMatch !== null) {
      const repo = ctx.store.getRepo(decodeSegment(contentsMatch[1]), decodeSegment(contentsMatch[2]));
      if (repo === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const contentPath = contentsMatch[3]
        .split('/')
        .map((segment) => decodeSegment(segment))
        .join('/');
      const parsed = tryParseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      if (method === 'PUT') contentsPut(ctx, res, repo, contentPath, parsed.value);
      else if (method === 'GET') contentsGet(ctx, res, repo, contentPath, query);
      else if (method === 'DELETE') contentsDelete(ctx, res, repo, contentPath, parsed.value);
      else sendError(res, 404, 'Not Found');
      return;
    }
  }

  const candidates = [...(routeBuckets.get(bucketOfPath(method, path)) ?? []), ...routeAny];
  for (const r of candidates) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(path);
    if (match === null) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => {
      params[key] = match[i + 1];
    });
    const parsed = tryParseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    await r.handler(ctx, req, res, params, query, parsed.value);
    return;
  }
  sendError(res, 404, 'Not Found');
}
