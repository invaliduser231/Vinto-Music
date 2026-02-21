import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArguments, parseCommand } from '../src/utils/commandParser.js';

test('parseArguments handles plain args', () => {
  assert.deepEqual(parseArguments('play hello world'), ['play', 'hello', 'world']);
});

test('parseArguments handles quoted args', () => {
  assert.deepEqual(parseArguments('play "never gonna give you up"'), ['play', 'never gonna give you up']);
  assert.deepEqual(parseArguments("play 'highway to hell'"), ['play', 'highway to hell']);
});

test('parseCommand parses prefix commands', () => {
  const parsed = parseCommand('!play "bohemian rhapsody"', '!');
  assert.equal(parsed.name, 'play');
  assert.deepEqual(parsed.args, ['bohemian rhapsody']);
});

test('parseCommand returns null for non-commands', () => {
  assert.equal(parseCommand('hello', '!'), null);
  assert.equal(parseCommand('!    ', '!'), null);
});
