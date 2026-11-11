import { DONATE_PAGE_URL, KOFI_URL, createCommand } from './commandHelpers.ts';
import { buildInfoPayload, withCommandReplyReference } from './responseUtils.ts';
import type { CommandRegistry } from '../commandRegistry.ts';
import type { CommandContextLike } from './helpers/types.ts';

export function registerDonateCommand(registry: CommandRegistry) {
  registry.register(createCommand({
    name: 'donate',
    aliases: ['kofi', 'tip'],
    description: 'Show how to donate to Vinto.',
    usage: 'donate',
    async execute(ctx: CommandContextLike) {
      const fields = [
        { name: ctx.t('donate.kofi'), value: KOFI_URL },
        { name: ctx.t('donate.bank'), value: DONATE_PAGE_URL },
      ];
      if (!ctx.rest?.sendMessage) {
        await ctx.reply.info(ctx.t('donate.description'), fields);
        return;
      }
      const payload = buildInfoPayload(ctx, ctx.t('donate.title'), ctx.t('donate.description'), fields);
      await ctx.rest.sendMessage(ctx.channelId, withCommandReplyReference(ctx, payload));
    },
  }));
}
