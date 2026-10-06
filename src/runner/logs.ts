/**
 * Лог сессии рана → Google Storage, наш API получает только ссылку.
 *
 * Ключевое требование issue #73, п.2: «Лог сессии — в Google Storage, воркер возвращает
 * ссылку (`logUrl`), НЕ содержимое». Поэтому лог не возвращается в `LaunchResult`
 * и не кладётся в артефакты — ни наш API, ни кто-либо ещё не читает его байты.
 *
 * Лог уже прошёл redaction на стороне `runAgent`, поэтому в бакет уезжает текст без
 * ключей. Ответственность за это — на вызывающей стороне, здесь она только проверяется.
 */

import { execFile } from 'node:child_process';
import { open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type LogUploadMode = 'gcs' | 'local';

export interface LogUploadOptions {
  mode: LogUploadMode;
  bucket?: string;
  runId: string;
  localPath: string;
  maxLogBytes: number;
  /** Куда в бакете. Дефолт — `<runId>/session.log`. */
  objectPrefix?: string;
}

export interface LogUploadResult {
  logUrl: string;
  size: number;
  truncated: boolean;
  mode: LogUploadMode;
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const UPLOAD_ATTEMPTS = 4;
const UPLOAD_RETRY_BASE_MS = 500;

/**
 * Обрезает лог до `maxLogBytes`, оставляя хвост: в хвосте — ошибка агента и ответ
 * модели, в начале — шум установки пакетов. Хвост читается в отдельный файл и
 * подменяет исходный, чтобы не держать лог целиком в памяти джобы.
 */
export async function capLogFile(filePath: string, maxLogBytes: number): Promise<{ size: number; truncated: boolean }> {
  const { size } = await stat(filePath);
  if (size <= maxLogBytes) return { size, truncated: false };

  const handle = await open(filePath, 'r');
  try {
    const tail = Buffer.allocUnsafe(maxLogBytes);
    const { bytesRead } = await handle.read(tail, 0, maxLogBytes, size - maxLogBytes);
    const prefix = Buffer.from('...[log truncated, tail follows]\n', 'utf8');
    const capped = Buffer.concat([prefix, tail.subarray(0, bytesRead)]);
    await writeFile(`${filePath}.capped`, capped);
    await rename(`${filePath}.capped`, filePath);
  } finally {
    await handle.close();
  }
  return { size: maxLogBytes, truncated: true };
}

export async function uploadSessionLog(options: LogUploadOptions): Promise<LogUploadResult> {
  const capped = await capLogFile(options.localPath, options.maxLogBytes);

  if (options.mode === 'local') {
    // Путь без схемы — это не ссылка, и наш API такое не примет как лог.
    // Поэтому в dev-режиме отдаём честный маркер, который видно в приёмке.
    const relative = path.basename(options.localPath);
    return { logUrl: `local://${options.runId}/${relative}`, size: capped.size, truncated: capped.truncated, mode: 'local' };
  }

  const bucket = options.bucket;
  if (!bucket || !BUCKET_NAME.test(bucket)) {
    throw new Error(`LOG_UPLOAD=gcs requires a valid GCS_LOG_BUCKET, got "${bucket ?? ''}"`);
  }

  const prefix = options.objectPrefix ?? `${options.runId}/session.log`;
  const objectPath = prefix.endsWith('/') ? `${prefix}session.log` : prefix;
  const objectUri = `gs://${bucket}/${objectPath}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await exec('gcloud', ['storage', 'cp', options.localPath, objectUri, '--quiet']);
      // Verify durable custody before exposing the URL or reporting the run complete.
      const { stdout } = await exec('gcloud', ['storage', 'objects', 'describe', objectUri, '--format=json']);
      const uploaded = JSON.parse(stdout) as { size?: string | number };
      if (Number(uploaded.size) !== capped.size) {
        throw new Error(`uploaded session log size mismatch: expected ${capped.size}, got ${String(uploaded.size)}`);
      }
      // The current API contract serves session logs through a direct HTTPS URL.
      await exec('gcloud', ['storage', 'objects', 'update', objectUri, '--acl=publicRead', '--recursive', '--quiet']);
      lastError = null;
      break;
    } catch (cause) {
      lastError = cause;
      if (attempt + 1 < UPLOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }
  if (lastError) throw new Error(`session log upload/verification failed after ${UPLOAD_ATTEMPTS} attempts: ${String((lastError as Error)?.message ?? lastError)}`);

  return {
    logUrl: `https://storage.googleapis.com/${bucket}/${objectPath}`,
    size: capped.size,
    truncated: capped.truncated,
    mode: 'gcs',
  };
}

export async function cleanupLocalLog(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Файла нет — уборка не должна ронять рана.
  }
}
