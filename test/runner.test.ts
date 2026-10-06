/**
 * Раннер: env процесса агента, изоляция, таймаут, капы вывода, сбор артефактов.
 *
 * Здесь проверяются вещи, которые тихо ломают безопасность рана: посторонние
 * переменные в окружении агента, чужой UID, зависший процесс, симлинк наружу.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AGENT_CONFIG_TEMPLATE, installAgentConfig, renderAgentConfig } from '../src/runner/agent-config.js';
import { failure, isRetryableCode } from '../src/contracts.js';
import { validLaunchRequest } from './contracts.test.js';
import type { LaunchRequest } from '../src/contracts.js';
import { collectArtifacts, GitHubRepoApi } from '../src/runner/artifacts.js';
import { answerFromJsonEvents, buildLaunchResult, extractAnswer, failureForOutcome, publishArtifacts, SessionLog } from '../src/runner/main.js';
import { capOutput, resolveAgentEnv, runAgent } from '../src/runner/exec.js';
import { buildChildPath, buildLaunchCommand, ensureTraversable, identityName, parentDirs, type Identity } from '../src/runner/identity.js';

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

test('под изоляцией запуск идёт через sudo -u, а не setpriv', () => {
  // Регрессия: `setpriv --reuid` требует CAP_SETUID, которого у процесса раннера
  // нет — есть только passwordless sudo. Прямой вызов падал с
  // `setresuid failed: Operation not permitted`, и изоляция не ставилась вообще.
  const { command, argv } = buildLaunchCommand({
    identity: { ...baseIdentity, enforced: true },
    binary: '/usr/local/bin/opencode',
    argv: ['run', 'промпт'],
    env: { PATH: '/usr/bin' },
  });
  assert.equal(command, 'sudo');
  assert.deepEqual(argv.slice(0, 3), ['-u', 'ocrun-abc', '--']);
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


// ── конфиг агента ──────────────────────────────────────────────────────────────

test('в конфиг агента попадает ссылка на ключ, а не сам ключ', () => {
  const template = readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8');
  const rendered = renderAgentConfig(template, { llmKeyEnvName: 'MY_CUSTOM_KEY' });
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

test('ensureTraversable добавляет execute-бит только родителям, не самому workspace', async () => {
  // Регрессия: `runner.temp` — 700, и идентичность не могла дойти до своего
  // workspace, хотя сам workspace ей принадлежал. `git clone` падал с
  // «Permission denied» уже внутри принадлежащего каталога.
  const workspace = '/home/runner/work/_temp/opencode-gha-runner';
  const calls: string[] = [];
  await ensureTraversable(workspace, async (args) => {
    calls.push(args.join(' '));
  });

  const parents = parentDirs(workspace);
  assert.ok(parents.includes('/home/runner/work/_temp'));
  assert.ok(parents.includes('/home/runner/work'));
  assert.ok(parents.includes('/home/runner'));
  assert.ok(!parents.includes(workspace), 'сам workspace трогать не нужно — он уже принадлежит идентичности');
  assert.deepEqual(calls, parents.map((parent) => parent), 'chmod обязан идти по всем родителям ровно по одному разу');
});

test('parentDirs не включает сам каталог и не трогает корень', () => {
  // Корень не трогаем: `/` всегда 755, и `chmod` на нём — лишнее изменение хоста.
  assert.deepEqual(parentDirs('/a/b/c'), ['/a/b', '/a']);
  assert.deepEqual(parentDirs('/a'), []);
  assert.ok(!parentDirs('/a/b/c').includes('/a/b/c'));
});

test('при включённой изоляции HOME всегда указывает на home идентичности', () => {
  // Регрессия: наш API присылал HOME=/home/runner, процесс шёл под UID рана, и
  // opencode падал с `PermissionDenied: FileSystem.open
  // (/home/runner/.local/share/opencode/log/opencode.log)`.
  const env = resolveAgentEnv({
    envAllowlist: ['HOME'],
    env: { HOME: '/home/runner' },
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'K',
    llmKey: '',
    isolationEnforced: true,
  });
  assert.equal(env['HOME'], '/home/ocrun-abc', 'при изоляции HOME обязан быть home идентичности');
});

test('без изоляции переданный HOME уважается', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['HOME'],
    env: { HOME: '/home/runner' },
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'K',
    llmKey: '',
  });
  assert.equal(env['HOME'], '/home/runner');
});

// ── remote MCP ─────────────────────────────────────────────────────────────────

test('remote MCP попадает в конфиг, а токен остаётся ссылкой {env:...}', () => {
  const rendered = renderAgentConfig(readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8'), {
    llmKeyEnvName: 'LLM_LADDER_TOKEN',
    mcpServers: {
      'trained-skills': {
        type: 'remote',
        url: 'https://recruiter-assistant.ru/mcp',
        headers: { Authorization: 'Bearer {env:AGENT_MCP_TOKEN}' },
      },
    },
  });
  const config = JSON.parse(rendered) as {
    mcp: Record<string, { type: string; url: string; headers: Record<string, string>; enabled: boolean }>;
  };
  assert.equal(config.mcp['trained-skills']!.type, 'remote');
  assert.equal(config.mcp['trained-skills']!.url, 'https://recruiter-assistant.ru/mcp');
  assert.equal(config.mcp['trained-skills']!.headers['Authorization'], 'Bearer {env:AGENT_MCP_TOKEN}');
  assert.equal(config.mcp['trained-skills']!.enabled, true);
  assert.ok(!rendered.includes('rt_'), 'самого токена в конфиге быть не должно — только ссылка на env');
});

test('несколько MCP-серверов и выключенный сервер', () => {
  const rendered = renderAgentConfig(readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8'), {
    llmKeyEnvName: 'K',
    mcpServers: {
      'trained-skills': { type: 'remote', url: 'https://a.example/mcp' },
      hh: { type: 'remote', url: 'https://b.example/mcp', enabled: false },
    },
  });
  const config = JSON.parse(rendered) as { mcp: Record<string, { enabled: boolean; headers?: unknown }> };
  assert.deepEqual(Object.keys(config.mcp).sort(), ['hh', 'trained-skills']);
  assert.equal(config.mcp['hh']!.enabled, false);
  assert.equal(config.mcp['trained-skills']!.enabled, true);
  assert.equal(config.mcp['trained-skills']!.headers, undefined, 'без заголовков ключа быть не должно');
});

test('без mcp серверов ключ mcp в конфиг не добавляется', () => {
  const rendered = renderAgentConfig(readFileSync(AGENT_CONFIG_TEMPLATE, 'utf8'), { llmKeyEnvName: 'K' });
  const config = JSON.parse(rendered) as Record<string, unknown>;
  assert.ok(!('mcp' in config), 'пустая секция mcp в конфиге не нужна');
});

test('mcpSecrets доезжают в env агента под своими именами', () => {
  const env = resolveAgentEnv({
    envAllowlist: ['PATH'],
    env: { PATH: '/usr/bin' },
    identityHome: '/home/ocrun-abc',
    llmKeyEnvName: 'LLM_LADDER_TOKEN',
    llmKey: 'llm-key',
    injectedSecrets: { AGENT_MCP_TOKEN: 'rt_abc123' },
  });
  assert.equal(env['AGENT_MCP_TOKEN'], 'rt_abc123');
  assert.equal(env['LLM_LADDER_TOKEN'], 'llm-key');
});

// ── форма LaunchResult ─────────────────────────────────────────────────────────

test('LaunchResult содержит ровно те поля, что валидирует наш API', () => {
  // Кросс-репозиторная приёмка ловила здесь три расхождения (pid, status, commit),
  // потому что проверялся наш взгляд на контракт. Теперь форма закреплена явно.
  const result = buildLaunchResult({
    runId: 'run_1',
    outcome: {
      exitCode: 0,
      exitSignal: null,
      exitReason: 'completed',
      stdout: 'ок',
      stderr: '',
      durationMs: 100,
      timedOut: false,
      outputTruncated: false,
    },
    answer: { text: 'готово', source: 'engine_stdout' },
    artifacts: [],
    repo: { fullName: 'o/r', branch: 'agent-run/run_1', commit: '0'.repeat(40) },
    logUrl: 'local://run_1/session.log',
    outputTruncated: false,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'answer',
    'answerSource',
    'artifacts',
    'durationMs',
    'exitCode',
    'exitReason',
    'exitSignal',
    'logUrl',
    'outputTruncated',
    'pid',
    'repo',
    'runId',
    'status',
    'stderr',
    'stdout',
    'timedOut',
  ]);
});

test('status — «движок запустился», а не «чем кончился ран»', () => {
  const base = {
    runId: 'run_1',
    answer: { source: null as null },
    artifacts: [],
    repo: { fullName: 'o/r', branch: 'b', commit: '0'.repeat(40) },
    logUrl: '',
    outputTruncated: false,
  };
  // Ненулевой код и таймаут — это тоже `started`: процесс-то был.
  for (const exitReason of ['completed', 'nonzero_exit', 'timeout', 'crash'] as const) {
    const result = buildLaunchResult({
      ...base,
      outcome: { exitCode: exitReason === 'completed' ? 0 : 1, exitSignal: null, exitReason, stdout: '', stderr: '', durationMs: 1, timedOut: exitReason === 'timeout', outputTruncated: false },
    });
    assert.equal(result.status, 'started', exitReason);
  }
});

test('failure появляется только когда он есть', () => {
  const base = {
    runId: 'run_1',
    outcome: { exitCode: 1, exitSignal: null, exitReason: 'nonzero_exit' as const, stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false },
    answer: { source: null as null },
    artifacts: [],
    repo: { fullName: 'o/r', branch: 'b', commit: '0'.repeat(40) },
    logUrl: '',
    outputTruncated: false,
  };
  assert.ok(!('failure' in buildLaunchResult(base)));
  const withFailure = buildLaunchResult({ ...base, failure: failure('AGENT_NONZERO_EXIT', 'engine', 'упал') });
  assert.equal(withFailure.failure?.code, 'AGENT_NONZERO_EXIT');
});

// ── отказ финализации: выходы не извлекаемы ───────────────────────────────────

test('агент отработал, выходы не закоммитились — это отказ, а не успех без выходов', () => {
  // Живой дефект 05.10.2026: токен публикации не имел прав на репозиторий задачи, коммит
  // падал, и рапорт уходил как `completed artifacts=0`. Клиент получал успех без файлов.
  const result = failureForOutcome('completed', [], 'artifact push failed: could not create branch agent-run/run_x');
  assert.equal(result?.code, 'ARTIFACTS_PUSH_FAILED');
  assert.equal(result?.failureClass, 'finalization');
  assert.match(result!.safeSummary, /could not create branch/);
});

test('агент не создал объявленные выходы — это тоже отказ финализации', () => {
  const result = failureForOutcome('completed', ['report.md'], null);
  assert.equal(result?.code, 'ARTIFACTS_PUSH_FAILED');
  assert.match(result!.safeSummary, /report\.md/);
});

test('всё сложилось: отказа нет', () => {
  assert.equal(failureForOutcome('completed', [], null), undefined);
});

test('отказ движка важнее отказа финализации', () => {
  // Агент упал по своим причинам — клиенту нужен этот код, а не «выходы не легли» поверх.
  for (const [exitReason, code] of [
    ['timeout', 'AGENT_TIMEOUT'],
    ['crash', 'AGENT_CRASH'],
    ['nonzero_exit', 'AGENT_NONZERO_EXIT'],
  ] as const) {
    const result = failureForOutcome(exitReason, ['report.md'], 'artifact push failed: нет прав');
    assert.equal(result?.code, code, exitReason);
  }
});

test('ARTIFACTS_PUSH_FAILED не retryable: повтор с тем же токеном повторит тот же отказ', () => {
  assert.equal(isRetryableCode('ARTIFACTS_PUSH_FAILED'), false);
  assert.equal(isRetryableCode('ARTIFACTS_TOKEN_UNSET'), false);
  // А вот эти по-прежнему повторяются — правки не должны ломать прежнюю политику.
  assert.equal(isRetryableCode('AGENT_TIMEOUT'), true);
  assert.equal(isRetryableCode('AGENT_CRASH'), true);
  assert.equal(isRetryableCode('WORKER_INTERNAL'), true);
});

// ── baseRef: адрес мержа ─────────────────────────────────────────────────────

/** Мок GitHub API: отвечает на те вызовы, которые делает публикация. */
function githubApiMock(calls: string[]): typeof fetch {
  let seenRunBranch = false;
  return (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push(init?.method ?? 'GET');
    const body = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    // GitHub отдаёт JSON даже на 404 — тест повторяет это, а не пустое тело.
    const notFound = new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
    if (target.endsWith('/repos/owner/name')) return body({ default_branch: 'main' });
    if (target.includes('/git/ref/heads/main')) return body({ object: { sha: 'base-sha-0000000000000000000000000000000000' } });
    if (target.endsWith('/git/refs')) return new Response('', { status: 201 });
    if (target.includes('/git/ref/heads/agent-run/run_1')) {
      // Первый запрос — ветки рана ещё нет, второй (после createBranch) — уже есть.
      if (!seenRunBranch) {
        seenRunBranch = true;
        return notFound;
      }
      return body({ object: { sha: 'run-sha-1111111111111111111111111111111111' } });
    }
    if (target.includes('/contents/') && (init?.method ?? 'GET') === 'GET') return notFound;
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
}

test('baseRef доезжает в repo: без него клиент получает адрес ветки вместо адреса мержа', async () => {
  // На живой приёмке 05.10.2026 ветки с артефактами появились, но `baseRef` в ответе
  // отсутствовал: `mergeUrl` сводился к адресу ветки, и «куда мержить» было ручным поиском.
  const dir = await mkdtemp(path.join(tmpdir(), 'oga-publish-'));
  const log = new SessionLog();
  await log.open(path.join(dir, 'session.log'), '# run\n');

  const calls: string[] = [];
  const published = await publishArtifacts({
    spec: validLaunchRequest({ runId: 'run_1', repository: { fullName: 'owner/name', branch: 'agent-run/run_1' } }) as unknown as LaunchRequest,
    runId: 'run_1',
    workspace: dir,
    token: 'ghp_test_token_value',
    collected: { artifacts: [], missing: [], undeclared: [] },
    outcome: { exitCode: 0, exitSignal: null, exitReason: 'completed', stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false },
    startedAt: new Date(),
    sessionLog: log,
    fetchImpl: githubApiMock(calls),
  });

  assert.equal(published.repo.baseRef, 'main', 'baseRef обязан доехать: по нему наше API строит /compare/main...agent-run/<runId>');
  assert.equal(published.repo.commit, 'run-sha-1111111111111111111111111111111111');
  assert.equal(published.note, null);
  await rm(dir, { recursive: true, force: true });
});

test('profile update includes the current GitHub Contents sha', async () => {
  let written: Record<string, unknown> | null = null;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/repos/owner/name')) return body({ default_branch: 'main' });
    if (target.includes('/git/ref/heads/main')) return body({ object: { sha: 'a'.repeat(40) } });
    if (target.includes('/git/ref/heads/agent-run/run_1')) return body({ object: { sha: 'b'.repeat(40) } });
    if (target.includes('/contents/notes%2Fstate.txt') || target.includes('/contents/notes/state.txt')) {
      if (init?.method === 'PUT') {
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        return body({ content: { sha: 'c'.repeat(40) } });
      }
      return body({ sha: 'old-file-sha' });
    }
    throw new Error(`unexpected GitHub request: ${target}`);
  }) as typeof fetch;
  const api = new GitHubRepoApi({ token: 'ghp_test_token_value', repo: 'owner/name', fetchImpl });
  await api.pushFiles({ branch: 'agent-run/run_1', commitMessage: 'update profile', files: [{ path: 'notes/state.txt', content: Buffer.from('next') }] });
  assert.equal(written?.['sha'], 'old-file-sha');
});

test('heavy profile output goes to object storage while Git receives only its index and checksum', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oga-profile-output-'));
  const previousPath = process.env['PATH'];
  const previousRoot = process.env['FAKE_GCS_ROOT'];
  try {
    await mkdir(path.join(root, 'bin'));
    await mkdir(path.join(root, 'bucket'));
    const gcloud = path.join(root, 'bin', 'gcloud');
    await writeFile(gcloud, '#!/bin/sh\nset -eu\nfrom="$3"\nto="$4"\ncase "$to" in gs://profile-bucket/*) to="$FAKE_GCS_ROOT/${to#gs://profile-bucket/}";; esac\nmkdir -p "$(dirname "$to")"\ncp "$from" "$to"\n');
    await chmod(gcloud, 0o755);
    process.env['PATH'] = `${path.join(root, 'bin')}:${previousPath ?? ''}`;
    process.env['FAKE_GCS_ROOT'] = path.join(root, 'bucket');
    const bytes = Buffer.alloc(1024 * 1024 + 1, 42);
    await writeFile(path.join(root, 'large.bin'), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const requests: Array<{ path: string; body: string }> = [];
    const baseFetch = githubApiMock([]);
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET' && String(url).includes('/contents/large.bin')) return new Response('', { status: 404 });
      if (init?.method === 'PUT') requests.push({ path: String(url), body: String(init.body ?? '') });
      return baseFetch(url, init);
    }) as typeof fetch;
    const log = new SessionLog();
    await log.open(path.join(root, 'session.log'), '# profile run\n');
    const spec = validLaunchRequest({ runId: 'run_1', profileId: 'profile-a', repository: { fullName: 'owner/name', branch: 'agent-run/run_1', revision: 'a'.repeat(40) }, profileWorkspace: { bindingId: 'binding-a', objectBucket: 'profile-bucket', artifacts: [], excludedPatterns: [] } } as never) as unknown as LaunchRequest;
    const result = await publishArtifacts({
      spec, runId: 'run_1', workspace: root, token: 'ghp_test_token_value', profileBucket: 'profile-bucket',
      collected: { artifacts: [{ path: 'artifacts/large.bin', name: 'large.bin', mime: 'application/octet-stream', sha256, size: bytes.length }], missing: [], undeclared: [] },
      outcome: { exitCode: 0, exitSignal: null, exitReason: 'completed', stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false },
      startedAt: new Date(), sessionLog: log, fetchImpl,
    });
    assert.equal(result.note, null);
    assert.equal(result.artifactRefs[0]?.path, 'large.bin');
    assert.equal(result.artifactRefs[0]?.objectKey, `profiles/profile-a/workspace/run_1/${sha256}`);
    assert.equal(requests.some((entry) => entry.path.includes('/contents/large.bin')), false);
    assert.equal(requests.some((entry) => entry.path.includes('/contents/.trained-assist/artifacts.json')), true);
    assert.deepEqual(await readFile(path.join(root, 'bucket', result.artifactRefs[0]!.objectKey!)), bytes);
  } finally {
    process.env['PATH'] = previousPath;
    if (previousRoot === undefined) delete process.env['FAKE_GCS_ROOT']; else process.env['FAKE_GCS_ROOT'] = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('пустое тело на 404 — это «ветки нет», а не падение публикации', async () => {
  // Прокси и обрыв сети дают пустое тело, где GitHub обычно отдаёт JSON. Раньше `branchSha`
  // падал на `ref.data.object`, и публикация рана обрывалась вместо «создадим ветку».
  let seenRunBranch = false;
  const emptyBody404 = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    if (target.endsWith('/repos/owner/name')) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/git/ref/heads/main')) {
      return new Response(JSON.stringify({ object: { sha: 'base-sha-0000000000000000000000000000000000' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/git/refs')) return new Response('', { status: 201 });
    if (target.includes('/git/ref/heads/agent-run/run_1')) {
      if (!seenRunBranch) {
        seenRunBranch = true;
        return new Response('', { status: 404 });
      }
      return new Response(JSON.stringify({ object: { sha: 'run-sha-1111111111111111111111111111111111' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/contents/') && (init?.method ?? 'GET') === 'GET') return new Response('', { status: 404 });
    return new Response('', { status: 200 });
  };

  const dir = await mkdtemp(path.join(tmpdir(), 'oga-empty-body-'));
  const log = new SessionLog();
  await log.open(path.join(dir, 'session.log'), '# run\n');
  const published = await publishArtifacts({
    spec: validLaunchRequest({ runId: 'run_1', repository: { fullName: 'owner/name', branch: 'agent-run/run_1' } }) as unknown as LaunchRequest,
    runId: 'run_1',
    workspace: dir,
    token: 'ghp_test_token_value',
    collected: { artifacts: [], missing: [], undeclared: [] },
    outcome: { exitCode: 0, exitSignal: null, exitReason: 'completed', stdout: '', stderr: '', durationMs: 1, timedOut: false, outputTruncated: false },
    startedAt: new Date(),
    sessionLog: log,
    fetchImpl: emptyBody404 as unknown as typeof fetch,
  });

  assert.equal(published.note, null, 'пустое тело на 404 не должно ронять публикацию');
  assert.equal(published.repo.baseRef, 'main');
  await rm(dir, { recursive: true, force: true });
});

// ── ответ агента из потока JSON-событий ───────────────────────────────────────

/**
 * Фикстура по реальной схеме opencode (`packages/opencode/src/cli/cmd/run.ts`, `emit()`):
 * JSON-объект на строку, поля `type`/`timestamp`/`sessionID`, текст — в `part.text`.
 * `text` приходит только для завершённых частей (`part.time?.end`), поэтому
 * последнее событие `text` — финальный ответ.
 */
const jsonStream = [
  JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_1', part: { id: 'prt_1', type: 'step-start' } }),
  JSON.stringify({ type: 'reasoning', timestamp: 2, sessionID: 'ses_1', part: { id: 'prt_2', type: 'reasoning', text: 'размышляю' } }),
  JSON.stringify({ type: 'tool_use', timestamp: 3, sessionID: 'ses_1', part: { id: 'prt_3', type: 'tool', tool: 'bash', state: { status: 'completed' } } }),
  JSON.stringify({ type: 'text', timestamp: 4, sessionID: 'ses_1', part: { id: 'prt_4', type: 'text', text: 'Пишу файл.', time: { end: 5 } } }),
  JSON.stringify({ type: 'tool_use', timestamp: 5, sessionID: 'ses_1', part: { id: 'prt_5', type: 'tool', tool: 'write', state: { status: 'completed' } } }),
  JSON.stringify({ type: 'step_finish', timestamp: 6, sessionID: 'ses_1', part: { id: 'prt_6', type: 'step-finish' } }),
  JSON.stringify({ type: 'text', timestamp: 7, sessionID: 'ses_1', part: { id: 'prt_7', type: 'text', text: 'Готово: report.md с одной строкой.', time: { end: 8 } } }),
].join('\n');

test('JSON-поток: в ответ идёт последнее текстовое событие, а не весь поток', () => {
  assert.equal(answerFromJsonEvents(jsonStream), 'Готово: report.md с одной строкой.');
});

test('обычный stdout агента разбирается как раньше — он не JSON', () => {
  assert.equal(answerFromJsonEvents('Готово: `report.md` с одной строкой.'), undefined);
});

test('JSON без текстовых событий — это отсутствие ответа, а не пустой ответ', () => {
  const onlyTools = [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_1', part: { id: 'prt_1', type: 'step-start' } }),
    JSON.stringify({ type: 'tool_use', timestamp: 2, sessionID: 'ses_1', part: { id: 'prt_2', type: 'tool', tool: 'bash' } }),
  ].join('\n');
  assert.equal(answerFromJsonEvents(onlyTools), undefined);
});

test('пустое текстовое событие не становится ответом', () => {
  const blank = [
    JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'ses_1', part: { id: 'prt_1', type: 'text', text: '   ' } }),
  ].join('\n');
  assert.equal(answerFromJsonEvents(blank), undefined);
});

test('строка вывода агента вперемешку с JSON не роняет разбор', () => {
  // Поток событий идёт в stdout, а установка пакетов пишет рядом: строка, которая не
  // разбирается, пропускается, а не обрушивает весь ран.
  const mixed = `added 1 package\n${JSON.stringify({ type: 'text', timestamp: 1, sessionID: 'ses_1', part: { id: 'prt_1', type: 'text', text: 'Ответ.', time: { end: 2 } } })}`;
  assert.equal(answerFromJsonEvents(mixed), 'Ответ.');
});

test('extractAnswer: JSON-поток не уезжает в ответ целиком', async () => {
  // Сквозной тест: раньше ответом становился весь stdout, и при `--format json` клиент
  // получал поток событий вместо текста ассистента.
  const dir = await mkdtemp(path.join(tmpdir(), 'oga-answer-'));
  const answer = extractAnswer(dir, jsonStream);
  assert.equal(answer.source, 'engine_stdout');
  assert.equal(answer.text, 'Готово: report.md с одной строкой.');
  await rm(dir, { recursive: true, force: true });
});

test('extractAnswer: обычный текст агента отдаётся как раньше', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'oga-answer-plain-'));
  const answer = extractAnswer(dir, 'Готово: `report.md` с одной строкой.');
  assert.equal(answer.source, 'engine_stdout');
  assert.equal(answer.text, 'Готово: `report.md` с одной строкой.');
  await rm(dir, { recursive: true, force: true });
});
