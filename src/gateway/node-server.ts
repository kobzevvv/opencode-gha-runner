/**
 * Локальный запуск шлюза на `node:http`.
 *
 * Тот же `createGateway`, что уедет в Cloudflare Worker, — отличается только транспорт.
 * Нужен, чтобы прогнать приёмку без деплоя: `npm run smoke`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGateway, type GatewayConfig, type GatewayDeps } from './app.js';
import { parseRing } from './ring.js';
import { MemoryRunStore, type RunStore } from './store.js';

export interface NodeServerOptions extends GatewayDeps {
  /** `0` — сервер сам выбирает свободный порт. */
  port?: number;
  host?: string;
}

export interface RunningServer {
  close: () => Promise<void>;
  port: number;
  url: string;
}

/** Конвертирует node-запрос в web-`Request`. */
export async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
  return new Request(url, {
    method,
    headers,
    body: body === undefined || body.length === 0 ? undefined : body,
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Поднимает сервер и резолвится, когда он уже слушает.
 *
 * Резолвиться по событию `listening` обязательно: `server.listen()` асинхронный, и
 * `server.address()` сразу после вызова возвращает `null` — при `port: 0` это дало бы
 * URL с портом `0` и неconnectable `fetch`.
 */
export function startNodeServer(options: NodeServerOptions): Promise<RunningServer> {
  const requestedPort = options.port ?? 8787;
  const host = options.host ?? '127.0.0.1';
  // Gateway собирается после listen: `publicBaseUrl` попадает в `statusUrl`/`resultUrl`
  // квитанции, и при `port: 0` его можно узнать только из связанного сокета. Иначе
  // квитанция указывала бы на несуществующий адрес — молча, до первого запроса.
  let gateway: ReturnType<typeof createGateway> | null = null;

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const origin = `http://${req.headers.host ?? `${host}:${requestedPort}`}`;
        const app = gateway;
        if (!app) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'gateway_not_ready' }));
          return;
        }
        await writeWebResponse(await app.fetch(await toWebRequest(req, origin)), res);
      } catch (cause) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'node_transport_error', message: String(cause) }));
      }
    })();
  });

  return new Promise<RunningServer>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const port = (server.address() as AddressInfo | null)?.port ?? requestedPort;
      const url = `http://${host}:${port}`;
      // Если адрес не задан явно (или в нём остался `:0`), берём фактический — иначе
      // квитанция вела бы в никуда.
      const declared = options.config.publicBaseUrl;
      const publicBaseUrl = declared && !declared.endsWith(':0') ? declared : url;
      gateway = createGateway({ ...options, config: { ...options.config, publicBaseUrl } });
      resolve({
        port,
        url,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });
}

/** Конфиг из окружения. Падает громко и рано, если чего-то не хватает. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value || value.trim().length === 0) throw new Error(`missing required env var: ${name}`);
    return value.trim();
  };

  const port = Number(env['PORT'] ?? '8787');
  return {
    workerToken: required('WORKER_TOKEN'),
    repo: required('GITHUB_REPO'),
    workflow: env['GITHUB_WORKFLOW'] ?? 'run-agent.yml',
    ref: env['GITHUB_REF'] || undefined,
    publicBaseUrl: (env['PUBLIC_BASE_URL'] ?? `http://127.0.0.1:${Number.isFinite(port) ? port : 8787}`).replace(/\/+$/, ''),
    agentBinary: env['AGENT_BINARY'] ?? 'opencode',
    githubToken: required('GITHUB_TOKEN'),
    // Кольцо необязательно: без него всё уходит в GITHUB_REPO, как раньше.
    ...(env['RING_TARGETS'] ? { ringTargets: parseRing(env['RING_TARGETS']) } : {}),
    ...(env['ZEN_RING_URL'] ? { zenRingUrl: env['ZEN_RING_URL'] } : {}),
    ...(env['ZEN_RING_ADMIN_TOKEN'] ? { zenRingAdminToken: env['ZEN_RING_ADMIN_TOKEN'] } : {}),
  };
}

export { MemoryRunStore };
export type { RunStore };
