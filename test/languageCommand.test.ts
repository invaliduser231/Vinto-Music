import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { registerCommands } from '../src/bot/commands/index.ts';
import { createTranslator } from '../src/i18n/index.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;

async function runLanguage(args: string[]): Promise<string[]> {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const execute = registry.resolve('language')?.execute as Execute | undefined;
  assert.ok(execute);

  const replies: string[] = [];
  const record = async (text: string) => {
    replies.push(text);
  };
  const guildConfig = { guildId: 'guild-1', prefix: '!', settings: { language: 'de' } };

  await execute({
    guildId: 'guild-1',
    channelId: 'text-1',
    authorId: 'user-1',
    args,
    prefix: '!',
    config: { prefix: '!' },
    message: { id: 'message-1' },
    locale: 'en',
    t: createTranslator('en'),
    guildConfig,
    guildConfigs: { get: async () => guildConfig, update: async () => guildConfig },
    library: { getUserLocale: async () => null, setUserLocale: async () => undefined },
    sessions: { applyGuildConfig() {} },
    reply: { info: record, success: record, warning: record, error: record },
  } as never);

  return replies;
}

test('language community shows the community language', async () => {
  assert.deepEqual(await runLanguage(['community']), ['The community language is 🇩🇪 Deutsch.']);
});

test('language guild still works as an alias for community', async () => {
  assert.deepEqual(await runLanguage(['guild']), await runLanguage(['community']));
});
