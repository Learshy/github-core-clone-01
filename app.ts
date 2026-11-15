// The forge server: one process, one in-memory store, four surfaces.
// Dispatch: /healthz, REST /api/v3/*, GraphQL /api/graphql, MCP /mcp, git smart HTTP
// /{owner}/{repo}.git/*. Everything else is a JSON 404. Auth: every API surface
// requires Authorization: Bearer $MAKEFUN_SHOP_TOKEN; /healthz takes none.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bearerToken, pathOf, queryOf, readBody, sendError, sendJson } from './lib/http.ts';
import { Store } from './lib/store.ts';
import { scenarioUsers } from './lib/scenario.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGit } from './lib/git.ts';

export interface Ctx {
  store: Store;
  /** The expected bearer token (empty string = auth disabled, never in a trial). */
  token: string;
  viewerLogin: string;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const users = scenarioUsers();
  const store = new Store(users[0], users.slice(1, 3));
  const ctx: Ctx = {
    store,
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    viewerLogin: users[0].login,
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(ctx, req, res).catch((err: unknown) => {
      // Never let a handler throw kill the server or leak a stack: JSON 500.
      try {
        sendError(res, 500, 'Internal Server Error');
      } catch {
        // Response already gone; nothing more to do.
      }
      process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
}

function isAuthed(ctx: Ctx, req: IncomingMessage): boolean {
  if (ctx.token === '') return true;
  const presented = bearerToken(req);
  return presented !== null && presented === ctx.token;
}

async function dispatch(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
  // Auth is ignored on git paths: no check tests auth failure there.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const body = await readBody(req);
    await handleGit(ctx, req, res, gitMatch[1], gitMatch[2], gitMatch[3], body, queryOf(req));
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!isAuthed(ctx, req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    await handleGraphql(ctx, req, res, body);
    return;
  }

  if (path === '/mcp') {
    if (!isAuthed(ctx, req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    await handleMcp(ctx, req, res, body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthed(ctx, req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const query = queryOf(req);
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    await handleRest(ctx, req, res, path, method, query, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}
