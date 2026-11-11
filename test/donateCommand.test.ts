import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/bot/commandRegistry.ts';
import { registerCommands } from '../src/bot/commands/index.ts';
import { createTranslator } from '../src/i18n/index.ts';
import { buildHelpPages } from '../src/bot/commands/helpers/formatting.ts';

type Execute = NonNullable<NonNullable<ReturnType<CommandRegistry['resolve']>>['execute']>;
type Embed = { title?: string; description?: string; fields?: Array<{ name: string; value: string }>; footer?: { text?: string } };

async function runDonate(name: string, locale: 'en' | 'de' = 'en') {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const execute = registry.resolve(name)?.execute as Execute | undefined;
  assert.ok(execute);

  const sent: Embed[] = [];
  const noop = async () => undefined;
  await execute({
    guildId: 'guild-1',
    channelId: 'text-1',
    authorId: 'user-1',
    args: [],
    prefix: '!',
    config: { prefix: '!', enableEmbeds: true },
    message: { id: 'message-1' },
    t: createTranslator(locale),
    rest: {
      sendMessage: async (_channelId: string, payload: { embeds?: Embed[] }) => {
        sent.push(payload.embeds?.[0] ?? {});
        return { id: 'reply-1' };
      },
    },
    reply: { info: noop, success: noop, warning: noop, error: noop },
  } as never);

  assert.equal(sent.length, 1);
  return sent[0]!;
}

test('donate links ko-fi and the bank transfer page', async () => {
  const embed = await runDonate('donate');
  assert.equal(embed.title, 'Donate');
  assert.match(embed.description ?? '', /no perks/);
  const values = (embed.fields ?? []).map((field) => field.value);
  assert.deepEqual(values, ['https://ko-fi.com/invaliduser231', 'https://vinto.music/donate']);
});

test('kofi and tip are aliases for donate', async () => {
  assert.deepEqual(await runDonate('kofi'), await runDonate('donate'));
  assert.deepEqual(await runDonate('tip'), await runDonate('donate'));
});

test('donate is translated', async () => {
  const embed = await runDonate('donate', 'de');
  assert.equal(embed.title, 'Spenden');
  assert.equal(embed.fields?.[1]?.name, 'Überweisung (SEPA)');
});

test('help pages point to the donate page in the footer', () => {
  const registry = new CommandRegistry();
  registerCommands(registry);
  const pages = buildHelpPages({ prefix: '!', registry, t: createTranslator('en') });
  const footer = (pages[0]?.embeds?.[0] as Embed | undefined)?.footer?.text ?? '';
  assert.match(footer, /Donate: https:\/\/vinto\.music\/donate$/);
});
