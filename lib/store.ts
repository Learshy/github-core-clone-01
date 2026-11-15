// In-memory store: one store behind REST, GraphQL, MCP and git smart HTTP.
// Deterministic by construction: ids come from counters, timestamps from a fixed epoch
// plus a per-entity sequence offset — no Date.now(), no Math.random() anywhere in state.
import { createHash } from 'node:crypto';

export const FIXED_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the env's fixed time
export const FIXED_EPOCH_ISO = '2025-01-01T00:00:00Z';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  /** Raw content bytes, without the "<type> <len>\0" header. */
  data: Buffer;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
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
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full refname -> tip oid. Heads and tags live here; HEAD points at defaultBranch. */
  refs: Map<string, string>;
  /** oid (hex) -> object. */
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  issueSeq: number;
  prSeq: number;
  commentSeq: number;
  /** Commits created by the server on this repo (contents PUT/DELETE, squash merges). */
  commitSeq: number;
}

export const DEFAULT_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

/** SHA-1 oid of a git object: sha1("<type> <len>\0" + data). */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The loose object bytes: header + data, for zlib storage / packfile emission. */
export function looseBytes(type: GitObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

/** A creation counter: timestamps are epoch + seq seconds, monotonic with creation order. */
export class Store {
  readonly viewer: User;
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private userSeq = 1003;
  private globalSeq = 1;
  private commentIdSeq = 1;

  constructor(viewer: User, teammates: readonly User[] = []) {
    this.viewer = viewer;
    this.users.set(viewer.login, viewer);
    for (const user of teammates) this.users.set(user.login, user);
  }

  /** Deterministic timestamp for the next created entity (ISO, monotonic). */
  stamp(): string {
    const sec = FIXED_EPOCH_SEC + this.globalSeq;
    this.globalSeq += 1;
    return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  userFor(login: string): User {
    const existing = this.users.get(login);
    if (existing) return existing;
    const user: User = {
      id: this.userSeq,
      login,
      name: login,
      email: `${login}@example.invalid`,
    };
    this.userSeq += 1;
    this.users.set(login, user);
    return user;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch,
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: [],
      pulls: [],
      labels: DEFAULT_LABELS.map((label, i) => ({ id: i + 1, ...label })),
      issueSeq: 0,
      prSeq: 0,
      commentSeq: 0,
      commitSeq: 0,
    };
    this.repoSeq += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[], user: string): Issue {
    repo.issueSeq += 1;
    const now = this.stamp();
    const issue: Issue = {
      id: repo.id * 100000 + repo.issueSeq,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      user,
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string, user: string): IssueComment {
    repo.commentSeq += 1;
    const now = this.stamp();
    const comment: IssueComment = {
      id: this.commentIdSeq,
      body,
      user,
      createdAt: now,
      updatedAt: now,
    };
    this.commentIdSeq += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
    user: string,
  ): Pull {
    repo.prSeq += 1;
    const now = this.stamp();
    const pull: Pull = {
      id: repo.id * 100000 + repo.prSeq,
      number: repo.prSeq,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }
}
