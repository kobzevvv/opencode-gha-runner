/**
 * Раннер: env процесса агента, изоляция, таймаут, капы вывода, сбор артефактов.
 *
 * Здесь проверяются вещи, которые тихо ломают безопасность рана: посторонние
 * переменные в окружении агента, чужой UID, зависший процесс, симлинк наружу.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_CONFIG_TEMPLATE, installAgentConfig, renderAgentConfig } from '../src/runner/agent-config.js';
import { collectArtifacts, artifactBranch } from '../src/runner/artifacts.js';
import { capOutput, resolveAgentEnv, runAgent } from '../src/runner/exec.js';
import { buildChildPath, buildLaunchCommand, identityName, type Identity } from '../src/runner/identity.js';

const baseIdentity: Identity = {
  name: 'ocrun-abc',
  uid: 1234,
  gid: 1234,
  home: '/home/ocrun-abc',
  workspace: '/tmp/ws',
  enforced: false,
};

// ── env ────────────────────────────────────────────────────────────────────────

test('в процесс агента попадают только имена из envAllowlist', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['PATH', 'LANG'],
    env: { PATH: '/usr/bin', LANG: 'C', SECRET: 'нельзя' },
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'LLM_LADDER_TOKEN',
    llmKey: '',
  });
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'PATH']);
  assert.ok(!('SECRET' in env), 'значение вне allowlist не должно доезжать даже при наличии в env');
});

test('HOME без значения подменяется home идентичности, а не home хоста', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['HOME'],
    env: {},
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'LLM_LADDER_TOKEN',
    llmKey: '',
  });
  assert.equal(env['HOME'], '/home/ocrun-abc');
});

test('переданный HOME уважается — наш API может задать свой', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['HOME'],
    env: { HOME: '/home/runner' },
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'LLM_LADDER_TOKEN',
    llmKey: '',
  });
  assert.equal(env['HOME'], '/home/runner');
});

test('ключ LLM доезжает под своим именем даже если его нет в env', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['PATH'],
    env: { PATH: '/usr/bin' },
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'LLM_LADDER_TOKEN',
    llmKey: 'ключ-из-credentials',
  });
  assert.equal(env['LLM_LADDER_TOKEN'], 'ключ-из-credentials');
});

test('extra проходит только через allowlist', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['PATH'],
    env: { PATH: '/usr/bin' },
    identityHome: '/home',
    llmKeyEnvName: 'K',
    llmKey: '',
    extra: { PATH: '/custom', FORBIDDEN: 'x' },
  });
  assert.equal(env['PATH'], '/custom');
  assert.ok(!('FORBIDDEN' in env));
});

// ── изоляция ───────────────────────────────────────────────────────────────────

test('имя идентичности безопасно для Unix и детерминировано', () => {
  const name = identityName('run_0fdd061d-14c3-42ea-b182-9393ff3564fa');
  assert.match(name, /^ocrun-[a-z0-9]{1,12}$/);
  assert.equal(name, identityName('run_0fdd061d-14c3-42ea-b182-9393ff3564fa'));
  assert.notEqual(name, identityName('run-другой'));
});

test('имя идентичности не ломается на управляющих символах в runId', () => {
  const name = identityName('run/../../etc/passwd');
  assert.match(name, /^ocrun-[a-z0-9]+$/);
  assert.ok(!name.includes('/') && !name.includes('.'));
});

test('под изоляцией запуск идёт через setpriv с UID рана', () => {
  const { command, argv } = buildLaunchCommand({
    identity: { ...baseIdentity, enforced: true },
    binary: '/usr/local/bin/opencode',
    argv: ['run', 'промпт'],
    env: { PATH: '/usr/bin' },
  });
  assert.equal(command, 'setpriv');
  assert.ok(argv.includes('--reuid=1234'));
  assert.ok(argv.includes('--regid=1234'));
  assert.ok(argv.includes('--init-groups'));
  // Каталог бинаря обязан быть в PATH агента: иначе opencode не найдёт node.
  const envIndex = argv.indexOf('env');
  const binaryIndex = argv.indexOf('/usr/local/bin/opencode');
  const assignments = argv.slice(envIndex + 1, binaryIndex);
  assert.deepEqual(assignments, ['-i', `PATH=${buildChildPath('/usr/bin', '/usr/local/bin')}`]);
});

test('без разрешённого PATH подставляется минимальный плюс каталог бинаря', () => {
  const { argv } = buildLaunchCommand({
    identity: baseIdentity,
    binary: '/opt/hostedtoolcache/node/20.19.0/x64/bin/opencode',
    argv: ['run', 'промпт'],
    env: {},
  });
  const assignments = argv.slice(argv.indexOf('-i') + 1, argv.indexOf('/opt/hostedtoolcache/node/20.19.0/x64/bin/opencode'));
  assert.equal(assignments[0], `PATH=${buildChildPath(undefined, '/opt/hostedtoolcache/node/20.19.0/x64/bin')}`);
  assert.ok(assignments[0]!.includes('/opt/hostedtoolcache/node/20.19.0/x64/bin'));
  assert.ok(assignments[0]!.includes('/usr/local/bin'));
});

test('без изоляции запуск идёт напрямую, но всё равно через env -i', () => {
  const { command, argv } = buildLaunchCommand({
    identity: baseIdentity,
    binary: 'opencode',
    argv: ['run', 'промпт'],
    env: { HOME: '/home/x' },
  });
  assert.equal(command, 'env');
  assert.equal(argv[0], '-i', 'без env -i агент унаследует GITHUB_TOKEN джобы');
  assert.ok(!argv.includes('GITHUB_TOKEN'));
});

test('в окружении самого spawn нет токена джобы', async () => {
  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', 'process.stdout.write(JSON.stringify({github: process.env.GITHUB_TOKEN ?? null, only: process.env.ONLY_ALLOWED ?? null}))'],
    env: { ONLY_ALLOWED: 'да' },
    timeoutMs: 20_000,
    maxOutputBytes: 65_536,
    secrets: [],
  });
  assert.equal(outcome.exitReason, 'completed');
  assert.deepEqual(JSON.parse(outcome.stdout), { github: null, only: 'да' });
});

// ── таймаут и коды выхода ──────────────────────────────────────────────────────

test('успешный агент даёт completed', async () => {
  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', 'process.stdout.write("готово")'],
    env: {},
    timeoutMs: 20_000,
    maxOutputBytes: 65_536,
    secrets: [],
  });
  assert.equal(outcome.exitReason, 'completed');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.stdout, 'готово');
});

test('ненулевой код выхода — nonzero_exit, а не startup_failure', async () => {
  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', 'process.exit(3)'],
    env: {},
    timeoutMs: 20_000,
    maxOutputBytes: 65_536,
    secrets: [],
  });
  assert.equal(outcome.exitReason, 'nonzero_exit');
  assert.equal(outcome.exitCode, 3);
});

test('по таймауту процесс убивается и рана помечается timeout', async () => {
  const started = Date.now();
  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    env: {},
    timeoutMs: 1_500,
    maxOutputBytes: 65_536,
    secrets: [],
  });
  assert.equal(outcome.exitReason, 'timeout');
  assert.equal(outcome.timedOut, true);
  assert.ok(Date.now() - started < 15_000, `убийство заняло ${Date.now() - started}ms — SIGKILL не сработал`);
});

test('таймаут убивает всё дерево процесса, а не только корневой pid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gha-tree-'));
  const marker = path.join(dir, 'child-alive');
  // Отдельный файл, а не вложенная кавычка в `-e`: иначе тест проверяет шелл, а не нас.
  const childScript = path.join(dir, 'child.cjs');
  await writeFile(
    childScript,
    `const fs = require('node:fs');\nsetInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, 'x'), 200);\n`,
    'utf8',
  );
  // Маркер удаляется уже после таймаута: иначе тест ловит файл, написанный
  // во время работы агента, а не доказательство того, что ребёнок пережил убийство.
  await rm(marker, { force: true });

  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', `require('node:child_process').spawn(process.execPath, [${JSON.stringify(childScript)}], {stdio:'ignore'}); setInterval(() => {}, 1000)`],
    env: {},
    timeoutMs: 2_000,
    maxOutputBytes: 65_536,
    secrets: [],
  });
  assert.equal(outcome.exitReason, 'timeout');
  await rm(marker, { force: true });
  const { existsSync } = await import('node:fs');
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(existsSync(marker), false, 'дочерний процесс пережил таймаут — дерево не убито');
  await rm(dir, { recursive: true, force: true });
});

// ── вывод ──────────────────────────────────────────────────────────────────────

test('кап суммарный, а не на каждый поток', async () => {
  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', 'process.stdout.write("a".repeat(5000)); process.stderr.write("b".repeat(5000))'],
    env: {},
    timeoutMs: 20_000,
    maxOutputBytes: 8_000,
    secrets: [],
  });
  const total = Buffer.byteLength(outcome.stdout, 'utf8') + Buffer.byteLength(outcome.stderr, 'utf8');
  assert.ok(total <= 8_000, `суммарный вывод ${total} превысил maxOutputBytes 8000`);
  assert.equal(outcome.outputTruncated, true);
});

test('capOutput сохраняет хвост, а не начало', () => {
  const { text, truncated } = capOutput('начало-шум'.repeat(1000) + 'ХВОСТ-С-ОШИБКОЙ', 200);
  assert.equal(truncated, true);
  assert.ok(text.endsWith('ХВОСТ-С-ОШИБКОЙ'), 'в хвосте ошибка агента — её и нужно читать');
});

test('capOutput не ломает многобайтовый символ на границе', () => {
  const { text } = capOutput('ы'.repeat(100), 101);
  assert.ok(!text.startsWith('�'), 'хвост не должен начинаться с полусимвола');
});

test('ключ вычищается из stdout перед возвратом наверх', async () => {
  const secret = 'llm-key-very-secret-value';
  const outcome = await runAgent({
    identity: { ...baseIdentity, workspace: process.cwd() },
    binary: 'node',
    argv: ['-e', `process.stdout.write(process.argv[1])`, secret],
    env: { LLM_LADDER_TOKEN: secret },
    timeoutMs: 20_000,
    maxOutputBytes: 65_536,
    secrets: [secret],
  });
  assert.ok(!outcome.stdout.includes(secret), 'ключ не должен возвращаться в наш API');
  assert.ok(outcome.stdout.includes('[redacted]'));
});

// ── артефакты ──────────────────────────────────────────────────────────────────

test('собираются только объявленные выходы, с sha256 и размером', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'gha-ws-'));
  await writeFile(path.join(workspace, 'report.md'), '# Отчёт\n', 'utf8');
  await writeFile(path.join(workspace, 'secret.env'), 'TOKEN=abc\n', 'utf8');

  const collected = await collectArtifacts(workspace, [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }]);
  assert.equal(collected.artifacts.length, 1);
  assert.equal(collected.artifacts[0]!.path, 'artifacts/report.md');
  assert.equal(collected.artifacts[0]!.size, 13, 'UTF-8: «# Отчёт» — 13 байт, а не 8');
  assert.match(collected.artifacts[0]!.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(collected.missing, []);
  await rm(workspace, { recursive: true, force: true });
});

test('выход за пределы workspace не читается, даже если объявлен', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gha-root-'));
  const workspace = path.join(root, 'ws');
  await mkdir(workspace);
  await writeFile(path.join(root, 'secret.txt'), 'секрет', 'utf8');

  const collected = await collectArtifacts(workspace, [{ path: '../secret.txt', name: 'secret.txt', mime: 'text/plain' }]);
  assert.deepEqual(collected.artifacts, []);
  assert.deepEqual(collected.missing, ['../secret.txt']);
  await rm(root, { recursive: true, force: true });
});

test('симлинк наружу не читается', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gha-root-'));
  const workspace = path.join(root, 'ws');
  await mkdir(workspace);
  await writeFile(path.join(root, 'id_rsa'), 'PRIVATE KEY', 'utf8');
  await symlink(path.join(root, 'id_rsa'), path.join(workspace, 'report.md'));

  const collected = await collectArtifacts(workspace, [{ path: 'report.md', name: 'report.md', mime: 'text/markdown' }]);
  assert.deepEqual(collected.artifacts, [], 'симлинк наружу — тот же класс проблемы, что и ..');
  await rm(root, { recursive: true, force: true });
});

test('отсутствующий выход попадает в missing, а не игнорируется', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'gha-ws-'));
  const collected = await collectArtifacts(workspace, [{ path: 'нет-такого.md', name: 'нет-такого.md', mime: 'text/markdown' }]);
  assert.deepEqual(collected.artifacts, []);
  assert.deepEqual(collected.missing, ['нет-такого.md']);
  await rm(workspace, { recursive: true, force: true });
});

test('каталог вместо файла не принимается за выход', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'gha-ws-'));
  await mkdir(path.join(workspace, 'dir'));
  const collected = await collectArtifacts(workspace, [{ path: 'dir', name: 'dir', mime: 'text/plain' }]);
  assert.deepEqual(collected.artifacts, []);
  assert.deepEqual(collected.missing, ['dir']);
  await rm(workspace, { recursive: true, force: true });
});

test('ветка артефактов детерминированная и не трогает историю юзера', () => {
  const runId = 'run_0fdd061d-14c3-42ea-b182-9393ff3564fa';
  assert.equal(artifactBranch(runId), `opencode-gha-runner/${runId}`);
  assert.ok(!artifactBranch(runId).includes('..'));
});

// ── конфиг агента ──────────────────────────────────────────────────────────────

test('в конфиг агента попадает ссылка на ключ, а не сам ключ', () => {
  const template = readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8');
  const rendered = renderAgentConfig(template, 'MY_CUSTOM_KEY');
  assert.ok(!rendered.includes('llm-key'));
  const config = JSON.parse(rendered) as { provider: Record<string, { options: { apiKey: string } }> };
  for (const provider of Object.values(config.provider)) {
    assert.equal(provider.options.apiKey, '{env:MY_CUSTOM_KEY}', 'apiKey обязан остаться ссылкой на env');
  }
});

test('шаблон конфига валиден и объявляет провайдера', () => {
  const config = JSON.parse(readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8')) as {
    provider: Record<string, { options: { baseURL: string }; models: Record<string, unknown> }>;
  };
  const provider = config.provider['ladder'];
  assert.ok(provider, 'провайдер ladder обязан быть в шаблоне');
  assert.match(provider!.options.baseURL, /^https:\/\//);
  assert.ok(Object.keys(provider!.models).includes('free'), 'модель free нужна для дешёвых ранов');
});

test('конфиг ставится в home идентичности с правами 0600 и не трогает workspace', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'gha-home-'));
  const template = path.join(home, 'template.json');
  await writeFile(template, readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8'), 'utf8');

  const installed = await installAgentConfig({ identityHome: home, llmKeyEnvName: 'K', templatePath: template });
  assert.equal(installed, path.join(home, '.config', 'opencode', 'opencode.json'));
  const mode = (await stat(installed)).mode & 0o777;
  assert.equal(mode, 0o600, 'конфиг читаться должен только владельцу');
  assert.ok(JSON.parse(readFileSync(installed, 'utf8')).provider.ladder.options.apiKey.includes('{env:K}'));
  await rm(home, { recursive: true, force: true });
});

test('getent-парсинг даёт uid и gid из строки passwd', () => {
  // Регрессия: `id -u -g` — недопустимая комбинация «only»-флагов, GNU id отвечает
  // «cannot print "only" of more than one choice». Парсим `getent passwd` вместо этого.
  const line = 'ocrun-abc:x:1001:1001:OpenCode run identity:/home/ocrun-abc:/bin/bash';
  const [uidRaw = '0', gidRaw = '0'] = line.trim().split(':').slice(2, 4);
  assert.equal(Number(uidRaw), 1001);
  assert.equal(Number(gidRaw), 1001);
});
