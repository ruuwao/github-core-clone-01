// Shared HTTP plumbing: body reading, JSON replies (every reply carries a non-empty
// X-GitHub-Request-Id and an application/json content type), auth against the trial token,
// and GitHub-style pagination with absolute same-origin Link URLs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  store: Store,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  };
  res.writeHead(status, all);
  res.end(text);
}

export function sendBuffer(
  res: ServerResponse,
  store: Store,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  const all: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  };
  res.writeHead(status, all);
  res.end(body);
}

export function sendMessage(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, store, status, { message });
}

/** The trial token, or '' when the env did not set one (then every request is accepted). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries the trial token (or when no token is configured). */
export function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
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

export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

export interface PageParams {
  page: number;
  perPage: number;
}

/** Parse ?page=&per_page= the way GitHub does: defaults 1 and 30, per_page clamped to 100. */
export function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, rawPerPage));
  return { page, perPage };
}

/**
 * Slice `items` to the requested page and build the Link header. Other query parameters are
 * preserved in the next/prev/first/last URLs, which are absolute and same-origin.
 */
export function paginate<T>(req: IncomingMessage, items: readonly T[], query: URLSearchParams): { pageItems: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const origin = originOf(req);
  const path = pathOf(req);
  const buildUrl = (pageNumber: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(pageNumber));
    params.set('per_page', String(perPage));
    return `${origin}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${buildUrl(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${buildUrl(page - 1)}>; rel="prev"`);
  links.push(`<${buildUrl(1)}>; rel="first"`);
  links.push(`<${buildUrl(totalPages)}>; rel="last"`);
  return { pageItems, link: links.length > 0 ? links.join(', ') : null };
}

/** Parse a JSON body: empty body is {}, malformed JSON is an error. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'malformed JSON' };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
