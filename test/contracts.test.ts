/**
 * Контракт: валидация `LaunchRequest` — то, через что проходит каждый ран.
 * Здесь важнее не «сколько всего полей», а что именно не должно пройти.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ENGINE_NAME,
  ValidationError,
  clampTimeout,
  isSafeRelativePath,
  isSafeWorkflowName,
  redact,
  validateLaunchRequest,
  type LaunchRequest,
} from '../src/contracts.js';

export function validLaunchRequest(overrides: Partial<LaunchRequest> = {}): Record<string, unknown> {
  return {
    runId: 'run_0fdd061d-14c3-42ea-b182-9393ff3564fa',
    jobId: 'job-1',
    userTaskId: 'task_1',
    profileId: 'profile-1',
    conversationId: 'conv-1',
    operationId: 'op-1',
    ownerGeneration: 1,
    engine: { name: ENGINE_NAME, adapterVersion: '1', modelSettings: { model: 'free', temperature: 0.2 } },
    input: { inlinePrompt: 'Сделай задачу' },
    cwd: '/home/runner/work/my-repo-abc/my-repo',
    envAllowlist: ['PATH', 'HOME'],
    env: { PATH: '/usr/bin', HOME: '/home/runner' },
    limits: { timeoutMs: 300_000, maxOutputBytes: 1_048_576, maxLogBytes: 1_048_576 },
    repository: { fullName: 'owner/name' },
    isolation: { mode: 'per_run_unix_identity' },
    outputs: [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }],
    ...overrides,
  };
}

test('принимает корректный LaunchRequest', () => {
  const spec = validateLaunchRequest(validLaunchRequest());
  assert.equal(spec.engine.name, ENGINE_NAME);
  assert.equal(spec.limits.timeoutMs, 300_000);
});

test('требует ровно тот движок, который зарегистрирован в нашем API', () => {
  assert.throws(
    () => validateLaunchRequest(validLaunchRequest({ engine: { name: 'opencode', adapterVersion: '1' } } as never)),
    (error: unknown) => error instanceof ValidationError && error.issues.some((i) => i.includes('engine.name')),
  );
});

test('не принимает неверную adapterVersion', () => {
  assert.throws(
    () => validateLaunchRequest(validLaunchRequest({ engine: { name: ENGINE_NAME, adapterVersion: '2' } } as never)),
    (error: unknown) => error instanceof ValidationError && error.issues.some((i) => i.includes('adapterVersion')),
  );
});

test('требует непустой промпт', () => {
  for (const prompt of [undefined, '', '   ']) {
    assert.throws(
      () => validateLaunchRequest(validLaunchRequest({ input: { inlinePrompt: prompt } } as never)),
      (error: unknown) => error instanceof ValidationError && error.issues.some((i) => i.includes('inlinePrompt')),
    );
  }
});

test('требует абсолютный cwd без выхода наверх', () => {
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ cwd: 'relative/path' } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ cwd: '/a/../../etc' } as never)));
});

test('отсекает небезопасные env-имена', () => {
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ envAllowlist: ['BAD NAME'] } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ envAllowlist: ['1BAD'] } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ env: { 'X=1': 'v' } } as never)));
});

test('требует положительные целые лимиты', () => {
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ limits: { timeoutMs: 0, maxOutputBytes: 1, maxLogBytes: 1 } } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ limits: { timeoutMs: 1.5, maxOutputBytes: 1, maxLogBytes: 1 } } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ limits: { timeoutMs: 1000, maxOutputBytes: -1, maxLogBytes: 1 } } as never)));
});

test('не принимает путь выхода `..` — иначе артефакты уедут наружу workspace', () => {
  for (const bad of ['../secrets', 'a/../../b', '/abs', 'a/./b', 'a//b', 'a/../']) {
    assert.equal(isSafeRelativePath(bad), false, `${bad} must be rejected`);
  }
  assert.equal(isSafeRelativePath('report.md'), true);
  assert.equal(isSafeRelativePath('docs/deep/report.md'), true);
});

test('валидирует форму repository.fullName', () => {
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ repository: { fullName: 'not-a-repo' } } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ repository: { fullName: 'a/b/c' } } as never)));
});

test('требует известный режим изоляции', () => {
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ isolation: { mode: 'docker' } } as never)));
  assert.doesNotThrow(() => validateLaunchRequest(validLaunchRequest({ isolation: { mode: 'none' } } as never)));
});

test('ключ LLM короче 8 символов — отказ: агент всё равно упадёт на первом запросе к модели', () => {
  assert.throws(
    () => validateLaunchRequest(validLaunchRequest({ credentials: { llmKey: 'short' } } as never)),
    (error: unknown) => error instanceof ValidationError && error.issues.some((i) => i.includes('llmKey')),
  );
});

test('имя workflow допускается только как имя файла', () => {
  assert.equal(isSafeWorkflowName('run-agent.yml'), true);
  assert.equal(isSafeWorkflowName('../../etc/passwd'), false);
  assert.equal(isSafeWorkflowName('run-agent.sh'), false);
});

test('clampTimeout держит рана в границах хоста', () => {
  assert.equal(clampTimeout(1), 5_000);
  assert.equal(clampTimeout(300_000), 300_000);
  assert.equal(clampTimeout(99 * 60 * 60 * 1000), 6 * 60 * 60 * 1000);
});

test('redact вычищает известные секреты и токены известных форматов', () => {
  const secret = 'super-secret-llm-key-value';
  const text = `ключ=${secret} и ghp_${'A'.repeat(36)} и sk-${'b'.repeat(30)}`;
  const out = redact(text, secret);
  assert.ok(!out.includes(secret), 'известный ключ обязан исчезнуть');
  assert.ok(!out.includes('ghp_'), 'github-токен обязан исчезнуть');
  assert.ok(!out.includes('sk-bb'), 'api-ключ обязан исчезнуть');
});

test('redact игнорирует слишком короткие значения, чтобы не съедать текст', () => {
  assert.equal(redact('the path is /a/b/c', '/a/b'), 'the path is /a/b/c');
});

test('принимает remote MCP и секреты к нему', () => {
  const spec = validateLaunchRequest(
    validLaunchRequest({
      mcp: {
        servers: {
          'trained-skills': {
            type: 'remote',
            url: 'https://recruiter-assistant.ru/mcp',
            headers: { Authorization: 'Bearer {env:AGENT_MCP_TOKEN}' },
          },
        },
      },
      mcpSecrets: { AGENT_MCP_TOKEN: 'rt_abc' },
    } as never),
  );
  assert.equal(spec.mcp?.servers['trained-skills']?.url, 'https://recruiter-assistant.ru/mcp');
});

test('не принимает локальный MCP: произвольная команда из запроса — это RCE в публичном CI', () => {
  assert.throws(
    () =>
      validateLaunchRequest(
        validLaunchRequest({
          mcp: { servers: { evil: { type: 'local', command: 'curl', args: ['attacker'] } } },
        } as never),
      ),
    (error: unknown) => error instanceof ValidationError && error.issues.some((i) => i.includes('only "remote"')),
  );
});

test('не принимает MCP с не-http URL', () => {
  assert.throws(
    () => validateLaunchRequest(validLaunchRequest({ mcp: { servers: { x: { type: 'remote', url: 'file:///etc/passwd' } } } } as never)),
    (error: unknown) => error instanceof ValidationError && error.issues.some((i) => i.includes('url')),
  );
});

test('проверяет mcpSecrets как env-имена', () => {
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ mcpSecrets: { 'BAD NAME': 'v' } } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ mcpSecrets: { OK: '' } } as never)));
  assert.throws(() => validateLaunchRequest(validLaunchRequest({ mcpSecrets: { OK: 42 } } as never)));
});
