import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/bot/commands/queueEffectsMiscCommands.ts', import.meta.url), 'utf8');

const body = /function stripCodeFence\(raw: unknown\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
assert.ok(body, 'stripCodeFence must exist');
const stripCodeFence = new Function('raw', body.replace(/: unknown/g, '')) as (raw: unknown) => string;

test('a fenced block keeps the code and drops the fence', () => {
  assert.equal(stripCodeFence('```js\n1 + 1\n```'), '1 + 1');
  assert.equal(stripCodeFence('```\n1 + 1\n```'), '1 + 1');
  assert.equal(stripCodeFence('```ts\nconst a = 1;\nconst b = 2;\n```'), 'const a = 1;\nconst b = 2;');
});

test('an inline block is unwrapped too', () => {
  assert.equal(stripCodeFence('`process.uptime()`'), 'process.uptime()');
});

test('plain code is passed through untouched', () => {
  assert.equal(stripCodeFence('process.uptime()'), 'process.uptime()');
  assert.equal(stripCodeFence('  1 + 1  '), '1 + 1');
});

test('operators that markdown would eat survive inside a fence', () => {
  const code = 'a || b; c * d; `tpl ${x}`';
  assert.equal(stripCodeFence('```js\n' + code + '\n```'), code);
});

test('a lone backtick inside the code is not mistaken for a fence', () => {
  assert.equal(stripCodeFence('"`"'), '"`"');
});

test('empty input stays empty', () => {
  assert.equal(stripCodeFence(''), '');
  assert.equal(stripCodeFence(undefined), '');
});
