import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTranslator,
  isSupportedLocale,
  localeFlag,
  localeLabel,
  normalizeLocale,
  resolveLocale,
  translate,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
} from '../src/i18n/index.ts';
import { en } from '../src/i18n/locales/en.ts';
import { de } from '../src/i18n/locales/de.ts';
import { ptBR } from '../src/i18n/locales/pt-BR.ts';

const CATALOGS: Record<Locale, Record<string, unknown>> = {
  en,
  de,
  'pt-BR': ptBR,
};

function placeholdersOf(value: unknown): Set<string> {
  const found = new Set<string>();
  const texts = typeof value === 'string'
    ? [value]
    : [(value as { one: string }).one, (value as { other: string }).other];

  for (const text of texts) {
    for (const match of String(text).matchAll(/\{(\w+)\}/g)) {
      found.add(match[1] as string);
    }
  }
  return found;
}

test('every locale defines the same keys as the english catalog', () => {
  const baseKeys = Object.keys(en).sort();

  for (const locale of SUPPORTED_LOCALES) {
    const keys = Object.keys(CATALOGS[locale]).sort();
    assert.deepEqual(keys, baseKeys, `catalog ${locale} does not match the english key set`);
  }
});

test('translations keep the same placeholders across locales', () => {
  for (const key of Object.keys(en)) {
    const expected = [...placeholdersOf(en[key as keyof typeof en])].sort();

    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const actual = [...placeholdersOf(CATALOGS[locale][key])].sort();
      assert.deepEqual(actual, expected, `placeholders differ for "${key}" in ${locale}`);
    }
  }
});

test('no translation is left as an untranslated copy of english', () => {
  const shared = new Set([
    'language.usage',
    'perm.ADMINISTRATOR',
    'lastfm.overviewAccountValue',
    'lastfm.overviewStatsValue',
    'lastfm.overviewSocialValue',
    'lastfm.topTitle',
    'autoplay.set',
  ]);
  let identical = 0;

  for (const key of Object.keys(en)) {
    if (shared.has(key)) continue;
    const base = en[key as keyof typeof en];
    if (typeof base !== 'string' || base.length < 12) continue;

    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      if (CATALOGS[locale][key] === base) identical += 1;
    }
  }

  assert.equal(identical, 0, `${identical} translated strings are identical to english`);
});

test('normalizeLocale accepts common aliases and rejects unknown values', () => {
  assert.equal(normalizeLocale('de'), 'de');
  assert.equal(normalizeLocale('DE-de'), 'de');
  assert.equal(normalizeLocale('deutsch'), 'de');
  assert.equal(normalizeLocale('pt'), 'pt-BR');
  assert.equal(normalizeLocale('pt-br'), 'pt-BR');
  assert.equal(normalizeLocale('BR'), 'pt-BR');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('klingon'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(null), null);
});

test('resolveLocale prefers user over guild over fallback', () => {
  assert.equal(resolveLocale({ userLocale: 'de', guildLocale: 'pt-BR', fallbackLocale: 'en' }), 'de');
  assert.equal(resolveLocale({ userLocale: null, guildLocale: 'pt-BR', fallbackLocale: 'en' }), 'pt-BR');
  assert.equal(resolveLocale({ userLocale: null, guildLocale: null, fallbackLocale: 'de' }), 'de');
  assert.equal(resolveLocale({}), DEFAULT_LOCALE);
});

test('resolveLocale ignores unsupported values instead of failing', () => {
  assert.equal(resolveLocale({ userLocale: 'klingon', guildLocale: 'de' }), 'de');
  assert.equal(resolveLocale({ userLocale: 'klingon', guildLocale: 'elvish' }), DEFAULT_LOCALE);
});

test('translate interpolates parameters and leaves unknown placeholders intact', () => {
  assert.equal(
    translate('language.updated', 'de', { flag: '🇩🇪', label: 'Deutsch' }),
    'Deine Sprache ist jetzt 🇩🇪 Deutsch.'
  );
  assert.equal(translate('common.page', 'en', { current: 2, total: 5 }), 'Page 2/5');
  assert.equal(translate('common.page', 'en', { current: 2 }), 'Page 2/{total}');
});

test('translate falls back to english when a locale lacks the key', () => {
  const sparse = { ...de } as Record<string, unknown>;
  delete sparse['common.page'];

  assert.equal(translate('common.page', 'en', { current: 1, total: 1 }), 'Page 1/1');
  assert.equal(typeof translate('common.enabled', 'pt-BR'), 'string');
});

test('createTranslator binds a locale and exposes it', () => {
  const t = createTranslator('pt-BR');
  assert.equal(t.locale, 'pt-BR');
  assert.equal(t('common.enabled'), 'Ativado');
  assert.equal(createTranslator('de')('common.enabled'), 'Aktiviert');
});

test('every registered command has a translated description key', async () => {
  const { CommandRegistry } = await import('../src/bot/commandRegistry.ts');
  const { registerCommands } = await import('../src/bot/commands/index.ts');

  const registry = new CommandRegistry();
  registerCommands(registry);

  const missing = registry.list()
    .map((cmd) => String(cmd.name))
    .filter((name) => !Object.prototype.hasOwnProperty.call(en, `cmd.${name}.description`));

  assert.deepEqual(missing, [], `commands without a description key: ${missing.join(', ')}`);
});

test('translation keys attached to thrown errors exist in the catalog', async () => {
  const { ValidationError } = await import('../src/core/errors.ts');

  const error = new ValidationError('Prefix cannot be empty.', { translationKey: 'store.prefixEmpty' });
  assert.equal(error.translationKey, 'store.prefixEmpty');
  assert.ok(Object.prototype.hasOwnProperty.call(en, error.translationKey));

  const plain = new ValidationError('no key');
  assert.equal(plain.translationKey, null);
});

test('locale metadata is defined for every supported locale', () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(localeLabel(locale).length > 0, `missing label for ${locale}`);
    assert.ok(localeFlag(locale).length > 0, `missing flag for ${locale}`);
    assert.ok(isSupportedLocale(locale));
  }
  assert.equal(isSupportedLocale('klingon'), false);
});
