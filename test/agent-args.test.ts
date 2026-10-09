import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentArguments } from '../src/runner/agent-args.js';
import { validateLaunchRequest } from '../src/contracts.js';
import { validLaunchRequest } from './contracts.test.js';

test('the accepted free model overrides every repository model flag', () => {
  assert.deepEqual(agentArguments(['--pure', '-m', 'ladder/doctor', '--model=other/paid', '-mlegacy', '--format', 'json'], 'free', 'synthetic prompt'),
    ['--pure', '--format', 'json', '-m', 'ladder/free', 'run', 'synthetic prompt']);
  assert.deepEqual(agentArguments(['--model', 'other/paid'], 'free:plan', 'fixture'), ['-m', 'ladder/free:plan', 'run', 'fixture']);
});
test('qualified model IDs remain qualified and absent settings preserve defaults', () => {
  assert.deepEqual(agentArguments([], 'ladder/free', 'fixture'), ['-m', 'ladder/free', 'run', 'fixture']);
  assert.deepEqual(agentArguments(['-m', 'configured/model'], undefined, 'fixture'), ['-m', 'configured/model', 'run', 'fixture']);
});
test('malformed model settings cannot become agent flags', () => {
  for (const value of ['', '--model', 'free --other', 'free\nsecret', 'x'.repeat(201)]) {
    assert.throws(() => agentArguments([], value, 'fixture'), /^Error: invalid engine model$/);
  }
});
test('invalid model identifiers are rejected during launch validation', () => {
  for (const model of ['', '--model', 'free --other', 'free\nsecret', 'x'.repeat(201)]) {
    const request = validLaunchRequest();
    request.engine.modelSettings = { model };
    assert.throws(() => validateLaunchRequest(request), /engine.modelSettings.model/);
  }
  const valid = validLaunchRequest();
  valid.engine.modelSettings = { model: 'free:plan' };
  assert.doesNotThrow(() => validateLaunchRequest(valid));
});
