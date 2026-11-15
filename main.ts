// Entry point: the handshake between this forge and the trial env.
//
// The env (named by MAKEFUN_ENV_URL) runs the trial; this process only runs the handshake around
// the forge. The forge itself is app.ts. What happens here, in order:
//
//   - The env origin must be set. With nobody to register with, the process exits 1 at once.
//   - The server listens on port 0, so the kernel picks a free port. Port 8080 belongs to the env
//     and is never bound.
//   - POST {env}/register with {"port": <bound>}. 200 accepts the registration. 409 means another
//     entry registered first; that is not an error, this process simply waits like any other.
//     400/405 mean the request itself is wrong, which no retry can fix, so the process exits 1.
//     Any other outcome (env still booting, dropped connection, unexpected status) is retried
//     forever on an exponential backoff.
//   - GET {env}/done until the body reads {"done": true}. Every other answer, timeout, or transport
//     failure just means "not yet": wait and ask again. The process never quits on its own.
//   - Once done, close the server and exit 0.
//
// The only ways out are the env saying done, a fatal register error, or a failure to bind.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CEILING_MS = 2_000;
const BACKOFF_MAX_STEP = 8;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff after `failed` consecutive failures: doubles from the first wait, capped at the ceiling. */
function backoffMs(failed: number): number {
  const step = Math.min(failed, BACKOFF_MAX_STEP);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** step);
}

/** The env origin, trailing slashes stripped. Exits 1 when it is not set at all. */
function envOrigin(): string {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (raw === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
    process.exit(1);
  }
  return raw;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** A register answer the process cannot recover from: 400/405. */
class FatalRegisterError extends Error {}

/**
 * Register the bound port, retrying until the env takes it. 200 accepts; 409 means the first
 * registration already won and this process just waits. 400/405 are fatal; anything else is
 * retried, because the env may still be starting.
 */
async function register(env: string, port: number): Promise<void> {
  let failed = 0;
  for (;;) {
    let res: Response;
    try {
      res = await postJson(`${env}/register`, { port });
    } catch {
      await wait(backoffMs(failed));
      failed += 1;
      continue;
    }
    if (res.status === 200 || res.status === 409) return;
    if (res.status === 400 || res.status === 405) {
      throw new FatalRegisterError(`register answered HTTP ${res.status}: ${await res.text()}`);
    }
    await wait(backoffMs(failed));
    failed += 1;
  }
}

/** Ask GET /done until it answers {"done": true}; every other outcome just means "not yet". */
async function waitUntilDone(env: string): Promise<void> {
  let failed = 0;
  for (;;) {
    try {
      const res = await fetch(`${env}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env unreachable or slow: not done yet, ask again.
    }
    await wait(backoffMs(failed));
    failed += 1;
  }
}

/** Bind, register, wait for done, close: the whole life of the process. */
async function run(): Promise<void> {
  const env = envOrigin();
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await register(env, port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone(env);
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
