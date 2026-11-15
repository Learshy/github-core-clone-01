// Git smart HTTP: info/refs (v0 + v2 advertisement), git-upload-pack (v0 + v2
// ls-refs / fetch), git-receive-pack (v0, unpack-first, per-ref FF checks).
// Plain objects only in packs we write; packs we read may carry OFS deltas.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PKT_DELIM, PKT_FLUSH, parsePktLines, pktLine, pktLineBuf, readPack, writePack } from './pack.ts';
import { sendError, sendRaw } from './http.ts';
import { objectId, type Repo } from './store.ts';
import { commitTree, isAncestor, parseCommit, parseTree, peelToNonTag } from './gitobj.ts';
import type { Ctx } from '../app.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const UPLOAD_CAPS = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function repoOr404(ctx: Ctx, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Ref lines for the v0 advertisement: HEAD first, then branches, then tags (+ peels). */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  const headOid = headTip ?? ZERO_OID;
  lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const [ref, oid] of refs) {
    lines.push(pktLine(`${oid} ${ref}\n`));
    if (ref.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToNonTag(repo, oid);
        if (peeled !== oid) lines.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  return lines;
}

function handleInfoRefs(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): void {
  const service = query.get('service') ?? '';
  const isV2 = req.headers['git-protocol'] === 'version=2';
  if (isV2) {
    // v2 capability advertisement: exactly version 2, fetch=shallow, ls-refs=unborn,
    // object-format=sha1, then flush.
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('fetch=shallow\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS;
  const body = Buffer.concat([
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    ...v0RefLines(repo, caps),
    PKT_FLUSH,
  ]);
  const contentType =
    service === 'git-receive-pack'
      ? 'application/x-git-receive-pack-advertisement'
      : 'application/x-git-upload-pack-advertisement';
  sendRaw(res, 200, body, contentType);
}

/** One ls-refs response line (oid, refname, attributes). */
interface LsRef {
  oid: string;
  name: string;
  attrs: string[];
}

function listLsRefs(repo: Repo, args: { peel: boolean; unborn: boolean; symrefs: boolean; prefixes: string[] | null }): LsRef[] {
  const out: LsRef[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  // On an empty repo there is no HEAD to list: the response is just the unborn
  // line (the suite's clone-empty check accepts zero refs or just the unborn
  // line). A HEAD line carrying the zero oid would read as an extra ref.
  if (headTip !== undefined) {
    const headAttrs: string[] = [];
    if (args.symrefs) headAttrs.push(`symref-target:refs/heads/${repo.defaultBranch}`);
    out.push({ oid: headTip, name: 'HEAD', attrs: headAttrs });
  }
  for (const [ref, oid] of refs) {
    const attrs: string[] = [];
    if (args.peel && ref.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToNonTag(repo, oid);
        if (peeled !== oid) attrs.push(`peeled:${peeled}`);
      }
    }
    out.push({ oid, name: ref, attrs });
  }
  if (refs.length === 0 && args.unborn) {
    // gitprotocol-v2: an unborn HEAD is sent as "unborn HEAD
    // symref-target:<target>" — the first token is literally "unborn", not a
    // zero oid, and the refname is HEAD. A zero-oid refs/heads/main line would
    // be read as a real branch and break fixture pushes (parent = zero oid).
    const attrs: string[] = [];
    if (args.symrefs) attrs.push(`symref-target:refs/heads/${repo.defaultBranch}`);
    out.push({ oid: 'unborn', name: 'HEAD', attrs });
  }
  if (args.prefixes !== null) {
    // Multiple ref-prefix lines are a union: a ref is listed when it matches ANY prefix.
    return out.filter((entry) => args.prefixes?.some((prefix) => entry.name.startsWith(prefix)) ?? false);
  }
  return out;
}

function handleLsRefs(repo: Repo, lines: { type: string; data?: Buffer }[], res: ServerResponse): void {
  const args = { peel: false, unborn: false, symrefs: false, prefixes: null as string[] | null };
  for (const line of lines) {
    if (line.type !== 'data' || line.data === undefined) continue;
    const text = line.data.toString('utf8').trim();
    if (text === 'peel') args.peel = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text.startsWith('ref-prefix ')) {
      if (args.prefixes === null) args.prefixes = [];
      args.prefixes.push(text.slice('ref-prefix '.length));
    }
  }
  const entries = listLsRefs(repo, args);
  const parts: Buffer[] = entries.map((entry) => {
    const attrs = entry.attrs.length === 0 ? '' : ` ${entry.attrs.join(' ')}`;
    return pktLine(`${entry.oid} ${entry.name}${attrs}\n`);
  });
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Wrap a packfile in sideband band-1 pkt-lines, ending with a flush.
 * A pkt-line is at most 65520 bytes total (4 length + payload), and the payload
 * carries a 1-byte band, so a pack chunk is at most 65515 bytes. */
function sidebandPackLines(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), pack.subarray(i, Math.min(i + CHUNK, pack.length))])));
  }
  parts.push(PKT_FLUSH);
  return parts;
}

interface FetchPlan {
  objects: { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Plan a fetch: which commits to include (BFS from wants, depth-limited, minus
 * anything the client already has), the shallow boundary, unshallow lines, and
 * the full object set (commits, then their trees and blobs).
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: string[],
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Commits the client already holds. The closure stops at the client's shallow
  // boundary: a shallow commit's parents are NOT held (that is what "shallow"
  // means), so a deepen must still send them.
  const haveCommits = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      const peeled = peelToNonTag(repo, have);
      if (repo.objects.get(peeled)?.type === 'commit') queue.push(peeled);
    }
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (haveCommits.has(oid)) continue;
      haveCommits.add(oid);
      if (shallowSet.has(oid)) continue; // boundary: parents not held
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!haveCommits.has(parent)) queue.push(parent);
      }
    }
  }
  // Every object reachable from the client's commits (their trees + blobs):
  // re-sending one of these fails fetch-incremental.
  const haveObjects = new Set<string>(haveCommits);
  {
    const walkTree = (treeOid: string): void => {
      const obj = repo.objects.get(treeOid);
      if (obj === undefined || obj.type !== 'tree' || haveObjects.has(treeOid)) return;
      haveObjects.add(treeOid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') walkTree(entry.oid);
        else if (entry.mode === '160000') continue;
        else haveObjects.add(entry.oid);
      }
    };
    for (const oid of haveCommits) {
      const tree = commitTree(repo, oid);
      if (tree !== null) walkTree(tree);
    }
  }
  const included = new Map<string, number>(); // commit oid -> distance from a want
  const order: string[] = [];
  const queue: { oid: string; dist: number }[] = [];
  const tagObjects: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.push(want);
      const peeled = peelToNonTag(repo, want);
      if (repo.objects.get(peeled)?.type === 'commit') queue.push({ oid: peeled, dist: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    // Include only commits the client does not hold, within depth. But always
    // traverse through a held commit's parents: a deepen asks for the parent
    // of a tip the client already has, so skipping the traversal would lose it.
    if (!haveCommits.has(oid) && (depth === null || dist < depth)) {
      included.set(oid, dist);
      order.push(oid);
    }
    if (depth === null || dist + 1 < depth) {
      for (const parent of parseCommit(obj.data).parents) {
        if (!included.has(parent)) queue.push({ oid: parent, dist: dist + 1 });
      }
    }
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, dist] of included) {
      if (dist !== depth - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
        shallow.push(oid);
      }
    }
  }
  // A client-shallow commit is unshallowed when we just sent one of its parents.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!haveCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (parseCommit(obj.data).parents.some((parent) => included.has(parent))) unshallow.push(oid);
  }
  const objects = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  const addObject = (oid: string): void => {
    if (objects.has(oid) || haveObjects.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    objects.set(oid, { type: obj.type, data: obj.data });
  };
  for (const oid of tagObjects) addObject(oid);
  for (const oid of order) addObject(oid);
  const walkTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    addObject(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else if (entry.mode === '160000') continue;
      else addObject(entry.oid);
    }
  };
  for (const oid of order) walkTree(commitTree(repo, oid));
  return { objects: [...objects.values()], shallow, unshallow };
}

function handleFetchV2(repo: Repo, lines: { type: string; data?: Buffer }[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of lines) {
    if (line.type !== 'data' || line.data === undefined) continue;
    const text = line.data.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).trim().split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7).trim(), 10) || null;
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8).trim());
    else if (text === 'done') done = true;
  }
  const plan = planFetch(repo, wants, haves, depth, clientShallow);
  // Negotiation round (no "done"): acknowledgments section only, ending with a flush.
  if (!done) {
    const out: Buffer[] = [pktLine('acknowledgments\n')];
    const matchingHaves = haves.filter((have) => repo.objects.has(have));
    if (matchingHaves.length === 0) out.push(pktLine('NAK\n'));
    else for (const have of matchingHaves) out.push(pktLine(`ACK ${have}\n`));
    out.push(pktLine('ready\n'));
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
    return;
  }
  // "done" was sent: the acknowledgments section MUST be omitted. Response is
  // [shallow-info section] + packfile section, each with its header line.
  const out: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(PKT_DELIM);
  }
  out.push(pktLine('packfile\n'));
  out.push(...sidebandPackLines(writePack(plan.objects)));
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let caps = '';
  let inHaves = false;
  for (const line of lines) {
    if (line.type === 'flush') {
      inHaves = true;
      continue;
    }
    if (line.type !== 'data' || line.data === undefined) continue;
    const text = line.data.toString('utf8').trim();
    if (!inHaves) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5);
        const nul = rest.indexOf('\0');
        if (nul !== -1) {
          wants.push(rest.slice(0, nul).trim());
          caps = rest.slice(nul + 1);
        } else {
          wants.push(rest.trim());
        }
      } else if (text.startsWith('deepen ')) {
        depth = Number.parseInt(text.slice(7).trim(), 10) || null;
      }
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    } else if (text.startsWith('shallow ')) {
      clientShallow.push(text.slice(8).trim());
    }
  }
  const plan = planFetch(repo, wants, haves, depth, clientShallow);
  const out: Buffer[] = [];
  const matchingHaves = haves.filter((have) => repo.objects.has(have));
  if (matchingHaves.length === 0) {
    out.push(pktLine('NAK\n'));
  } else if (caps.includes('multi_ack')) {
    for (const have of matchingHaves) out.push(pktLine(`ACK ${have}\n`));
  } else {
    out.push(pktLine(`ACK ${matchingHaves[0]}\n`));
  }
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  const sideband = caps.includes('side-band-64k') || caps.includes('side-band');
  if (sideband) out.push(...sidebandPackLines(pack));
  else out.push(pack);
  sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
}

function sendReceiveReport(res: ServerResponse, lines: string[], reportStatus: boolean, sideband: boolean): void {
  if (!reportStatus) {
    sendRaw(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  if (sideband) {
    // The band-1 payload is itself a pkt-line stream: each report line framed
    // with its own length prefix, ending with an inner flush. A raw "unpack ok"
    // payload makes git fail with "bad line length character: unpa".
    const inner = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let i = 0; i < inner.length; i += CHUNK) {
      parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), inner.subarray(i, Math.min(i + CHUNK, inner.length))])));
    }
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
    return;
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { lines, rest } = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let caps = '';
  for (const line of lines) {
    if (line.type === 'flush') break;
    if (line.type !== 'data' || line.data === undefined) continue;
    const text = line.data.toString('utf8').trim();
    const nul = text.indexOf('\0');
    let cmd = text;
    if (nul !== -1) {
      cmd = text.slice(0, nul);
      caps = text.slice(nul + 1);
    }
    const parts = cmd.split(' ');
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  const reportStatus = caps.includes('report-status');
  const sideband = caps.includes('side-band-64k') || caps.includes('side-band');
  const reportLines: string[] = [];
  // Unpack first: every object lands in the store before any ref is checked.
  // A delete-only push carries no pack at all (rest is empty) — that is valid.
  try {
    const packObjects = rest.length === 0 ? [] : readPack(rest);
    for (const obj of packObjects) {
      const oid = objectId(obj.type, obj.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
    }
    reportLines.push('unpack ok');
  } catch (err: unknown) {
    reportLines.push(`unpack ${err instanceof Error ? err.message : 'failed'}`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed`);
    sendReceiveReport(res, reportLines, reportStatus, sideband);
    return;
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let error: string | null = null;
    if (cmd.newOid !== ZERO_OID) {
      const obj = repo.objects.get(cmd.newOid);
      if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) error = 'object not found';
    }
    if (error === null) {
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) error = 'reference already exists';
      } else if (cmd.newOid === ZERO_OID) {
        if (current !== cmd.oldOid) error = 'old value mismatch';
      } else {
        if (current !== cmd.oldOid) error = 'old value mismatch';
        else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) error = 'non-fast-forward';
      }
    }
    if (error === null) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
    } else {
      reportLines.push(`ng ${cmd.ref} ${error}`);
    }
  }
  sendReceiveReport(res, reportLines, reportStatus, sideband);
}

export async function handleGit(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  action: string,
  body: Buffer,
  query: URLSearchParams,
): Promise<void> {
  const repo = repoOr404(ctx, res, owner, repoName);
  if (repo === null) return;
  if (action === 'info/refs') {
    handleInfoRefs(ctx, req, res, repo, query);
    return;
  }
  if (action === 'git-upload-pack') {
    const { lines } = parsePktLines(body);
    if (body.length > 0 && lines.length === 0) {
      sendError(res, 400, 'Bad Request');
      return;
    }
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (isV2) {
      const first = lines.find((line) => line.type === 'data');
      const firstText = first !== undefined && first.data !== undefined ? first.data.toString('utf8').trim() : '';
      if (firstText.startsWith('command=ls-refs')) {
        handleLsRefs(repo, lines, res);
        return;
      }
      if (firstText.startsWith('command=fetch')) {
        handleFetchV2(repo, lines, res);
        return;
      }
      sendError(res, 400, 'Bad Request');
      return;
    }
    const first = lines.find((line) => line.type === 'data');
    const firstText = first !== undefined && first.data !== undefined ? first.data.toString('utf8').trim() : '';
    if (!firstText.startsWith('want ')) {
      sendError(res, 400, 'Bad Request');
      return;
    }
    handleUploadPackV0(repo, body, res);
    return;
  }
  if (action === 'git-receive-pack') {
    const { lines } = parsePktLines(body);
    if (body.length > 0 && lines.length === 0) {
      sendError(res, 400, 'Bad Request');
      return;
    }
    handleReceivePack(repo, body, res);
    return;
  }
  sendError(res, 404, 'Not Found');
}
