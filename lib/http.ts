// HTTP plumbing for the forge: JSON replies, request ids, auth, body reading, pagination.
// Every REST reply is application/json with a non-empty X-GitHub-Request-Id; errors are
// JSON {"message": string}; unknown routes are 404 JSON; malformed JSON bodies are 400.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** Deterministic per-process request id: non-empty, unique within a run, no clock/random. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** JSON error body, GitHub style. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Bearer token from the Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('Bearer ')) return null;
  const token = raw.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** Read the whole request body (buffered). Throws on overflow or stream error. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a body as JSON. Returns null when the body is empty or malformed. */
export function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Parse a body as JSON, distinguishing empty from malformed: empty -> { ok: true, value: null },
 * malformed -> { ok: false } (the caller sends 400).
 */
export function tryParseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** GitHub pagination params: page >= 1, per_page 1..100, defaults 1/30. */
export function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const raw = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, raw));
  return { page, perPage };
}

/** Slice a list for one page; returns the page items and whether more pages follow. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

/**
 * GitHub Link header for a paginated collection. `urlFor(page)` builds the page URL
 * (path + query with the page replaced). Only rels that exist are emitted.
 */
export function linkHeader(
  urlFor: (page: number) => string,
  page: number,
  perPage: number,
  total: number,
): string | null {
  const last = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < last) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (last > 1) {
    parts.push(`<${urlFor(1)}>; rel="first"`);
    parts.push(`<${urlFor(last)}>; rel="last"`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}
