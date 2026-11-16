// Git object primitives over the store: trees, commits, ancestry, merge-base, diffs.
// The server is a dumb object store: pushed objects are kept byte-for-byte; trees and
// commits the server itself builds (contents PUT/DELETE, squash merges) use the same
// formats so they round-trip identically through a clone.
import { FIXED_EPOCH_SEC, objectId, type GitObject, type Repo } from './store.ts';

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries: "<mode> SP <name> NUL <20-byte oid>" each. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(i, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort: byte order of the name, a directory compared as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(treeSortKey(a)), Buffer.from(treeSortKey(b))),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) to path -> { oid, mode }. Gitlinks (160000) are skipped. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode === '160000') continue;
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build nested trees for a flat path -> blob-oid map; returns the root tree oid. */
export function treeFromFiles(repo: Repo, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = objectId('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Deterministic commit epoch for server-created commits: fixed epoch + repo sequence. */
export function nextCommitEpoch(repo: Repo): number {
  repo.commitSeq += 1;
  return FIXED_EPOCH_SEC + repo.commitSeq;
}

/** Create a commit object in the store and return its oid. Message keeps its trailing \n. */
export function makeCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  epochSec: number,
): string {
  const ident = `${authorName} <${authorEmail}> ${epochSec} +0000`;
  const lines: string[] = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const text = `${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  const data = Buffer.from(text, 'utf8');
  const oid = objectId('commit', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** Peel tag objects to the first non-tag object oid (or the input if it is not a tag). */
export function peelToNonTag(repo: Repo, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return current;
    current = match[1];
  }
  return current;
}

/** All commit oids reachable from a tip (parents only, tags peeled first). */
export function commitAncestors(repo: Repo, tipOid: string): Set<string> {
  const seen = new Set<string>();
  const start = peelToNonTag(repo, tipOid);
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Walk the ancestor set from the descendant and stop at the first hit.
  // The old code built the whole set first (O(history) per push even when the
  // answer is the immediate parent, as in every sequential push).
  const start = peelToNonTag(repo, descendant);
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (oid === ancestor) return true;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** First common ancestor of two tips (BFS from both sides, nearest to `a` wins ties). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsB = commitAncestors(repo, b);
  const queue: string[] = [peelToNonTag(repo, a)];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsB.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/** A commit's tree oid (tags peeled, missing -> ''). */
export function commitTree(repo: Repo, commitOid: string): string {
  const peeled = peelToNonTag(repo, commitOid);
  const obj = repo.objects.get(peeled);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) lines += 1;
  if (buf[buf.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** Simple LCS line diff counts for two buffers (blobs are small here). */
function lineDiffCounts(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } {
  const oldLines = oldBuf.toString('utf8').split('\n');
  const newLines = newBuf.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths, two rows (files are small; worst case is a few thousand lines).
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const common = prev[m];
  return { additions: m - common, deletions: n - common };
}

/** Diff two flat trees (path -> blob oid): added/removed/modified with line counts. */
export function diffTrees(
  repo: Repo,
  baseFiles: ReadonlyMap<string, { oid: string }>,
  headFiles: ReadonlyMap<string, { oid: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base === undefined && head !== undefined) {
      const blob = repo.objects.get(head.oid);
      const additions = blob === undefined ? 0 : countLines(blob.data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head === undefined) {
      const blob = repo.objects.get(base.oid);
      const deletions = blob === undefined ? 0 : countLines(blob.data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldBlob = repo.objects.get(base.oid);
      const newBlob = repo.objects.get(head.oid);
      const { additions, deletions } = lineDiffCounts(
        oldBlob === undefined ? Buffer.alloc(0) : oldBlob.data,
        newBlob === undefined ? Buffer.alloc(0) : newBlob.data,
      );
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Get an object or undefined (typed accessor for handlers). */
export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}
