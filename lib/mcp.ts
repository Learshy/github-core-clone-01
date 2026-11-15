// MCP: JSON-RPC 2.0 over Streamable HTTP (single POST, one JSON body back).
// Modern era revision 2026-07-28 via server/discover, with the legacy
// initialize handshake as fallback. Six tools over the same store as REST.
// Rules from spec/mcp-bench-export.md: ids echo exactly, tools/list is
// byte-identical across calls, unknown tool -> -32602/-32601 (never HTTP 500),
// non-JSON body -> HTTP 400 + -32700, missing args -> isError:true, auth 401
// is decided in app.ts before routing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http.ts';
import { issueJson, pullJson, repoJson, squashMergePull } from './rest.ts';
import type { Ctx } from '../app.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Built once, reused verbatim: tools/list must serialise byte-identically.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: RpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(object: unknown): Record<string, unknown> {
  const text = JSON.stringify(object);
  return { content: [{ type: 'text', text }], structuredContent: object, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Missing required argument -> isError:true tool result (check 11 accepts this). */
function missingArg(name: string): Record<string, unknown> {
  return toolError(`Missing required argument: ${name}`);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === null) return missingArg('name');
      if (ctx.store.getRepo(ctx.viewerLogin, repoName) !== undefined) {
        return toolError(`Repository ${ctx.viewerLogin}/${repoName} already exists`);
      }
      const repo = ctx.store.createRepo(
        ctx.viewerLogin,
        repoName,
        asString(args.description) ?? '',
        args.private === true,
        'main',
      );
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (title === null) return missingArg('title');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const issue = ctx.store.createIssue(repo, title, asString(args.body) ?? '', [], ctx.viewerLogin);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = asString(args.state) ?? 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      const objects = list.map((issue) => issueJson(repo, issue));
      return { content: [{ type: 'text', text: JSON.stringify(objects) }], structuredContent: { issues: objects }, isError: false };
    }
    case 'create_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (title === null) return missingArg('title');
      if (head === null) return missingArg('head');
      if (base === null) return missingArg('base');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return toolError(`Head or base branch not found: ${head} / ${base}`);
      }
      const pull = ctx.store.createPull(repo, title, asString(args.body) ?? '', head, base, headSha, baseSha, ctx.viewerLogin);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const pullNumber = asNumber(args.pull_number);
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (pullNumber === null) return missingArg('pull_number');
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((item) => item.number === pullNumber);
      if (pull === undefined) return toolError(`Pull request #${pullNumber} not found`);
      if (!pull.merged) {
        const result = squashMergePull(ctx, repo, pull);
        if (result.status === 'conflict') return toolError('Merge conflict');
        if (result.status === 'no-base') return toolError('Base branch not found');
      }
      return toolResult(pullJson(repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function handleRequest(ctx: Ctx, request: unknown): Record<string, unknown> | null {
  const input = (request ?? {}) as Record<string, unknown>;
  const id = (input.id ?? null) as RpcId;
  const method = typeof input.method === 'string' ? input.method : '';
  const params = (input.params ?? {}) as Record<string, unknown>;
  // Notifications (no id) get no response.
  if (input.id === undefined) return null;
  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      if (!LEGACY_VERSIONS.includes(offered)) {
        return rpcError(id, -32602, `Unsupported protocol version: ${offered || '(none)'}`, { supported: LEGACY_VERSIONS });
      }
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === '') return rpcError(id, -32602, 'Missing tool name');
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      return rpcResult(id, callTool(ctx, name, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): Promise<void> {
  if (req.method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((item) => handleRequest(ctx, item)).filter((item) => item !== null);
    sendJson(res, 200, responses);
    return;
  }
  const response = handleRequest(ctx, parsed);
  if (response === null) {
    // Notification: no response body.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}
