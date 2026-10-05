import type { LaunchResult } from '../contracts.js';

export function installHostCancellation(source: Pick<NodeJS.Process, 'on' | 'removeListener'> = process): {
  signal: AbortSignal; dispose: () => void;
} {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort('SIGINT');
  const terminate = (): void => controller.abort('SIGTERM');
  source.on('SIGINT', interrupt);
  source.on('SIGTERM', terminate);
  return { signal: controller.signal, dispose: () => {
    source.removeListener('SIGINT', interrupt);
    source.removeListener('SIGTERM', terminate);
  } };
}

export function singleReport(send: (result: LaunchResult) => Promise<void>): (result: LaunchResult) => Promise<void> {
  let attempt: Promise<void> | undefined;
  return result => {
    if (!attempt) attempt = Promise.resolve().then(() => send(result));
    return attempt;
  };
}
