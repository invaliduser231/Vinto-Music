import { en } from './locales/en.ts';
import { de } from './locales/de.ts';
import { ptBR } from './locales/pt-BR.ts';
import {
  DEFAULT_LOCALE,
  LOCALE_FLAGS,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
  type PluralForms,
  type TranslationParams,
  type TranslationValue,
} from './types.ts';

export type TranslationKey = keyof typeof en;

export type Catalog = Record<TranslationKey, TranslationValue>;

const CATALOGS: Record<Locale, Catalog> = {
  en,
  de,
  'pt-BR': ptBR,
};

const LOCALE_ALIASES: Record<string, Locale> = {
  en: 'en',
  eng: 'en',
  english: 'en',
  'en-us': 'en',
  'en-gb': 'en',
  de: 'de',
  ger: 'de',
  deu: 'de',
  german: 'de',
  deutsch: 'de',
  'de-de': 'de',
  'de-at': 'de',
  'de-ch': 'de',
  pt: 'pt-BR',
  ptbr: 'pt-BR',
  'pt-br': 'pt-BR',
  br: 'pt-BR',
  bra: 'pt-BR',
  brasil: 'pt-BR',
  brazil: 'pt-BR',
  portugues: 'pt-BR',
  português: 'pt-BR',
  portuguese: 'pt-BR',
};

const pluralRules = new Map<Locale, Intl.PluralRules>();

function getPluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules;
}

export function normalizeLocale(value: unknown): Locale | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;

  const direct = LOCALE_ALIASES[raw];
  if (direct) return direct;

  const base = raw.split(/[-_]/)[0];
  return LOCALE_ALIASES[base ?? ''] ?? null;
}

export function isSupportedLocale(value: unknown): value is Locale {
  return SUPPORTED_LOCALES.includes(String(value) as Locale);
}

export interface LocaleSources {
  userLocale?: unknown;
  guildLocale?: unknown;
  fallbackLocale?: unknown;
}

export function resolveLocale({ userLocale, guildLocale, fallbackLocale }: LocaleSources = {}): Locale {
  return normalizeLocale(userLocale)
    ?? normalizeLocale(guildLocale)
    ?? normalizeLocale(fallbackLocale)
    ?? DEFAULT_LOCALE;
}

function selectPluralForm(forms: PluralForms, locale: Locale, count: number): string {
  const category = getPluralRules(locale).select(count);
  if (category === 'one') return forms.one;
  return forms.other;
}

function interpolate(template: string, params: TranslationParams | undefined): string {
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function lookup(locale: Locale, key: TranslationKey): TranslationValue | undefined {
  const catalog = CATALOGS[locale];
  const value = catalog?.[key];
  if (value !== undefined) return value;
  if (locale !== DEFAULT_LOCALE) return CATALOGS[DEFAULT_LOCALE]?.[key];
  return undefined;
}

export function translate(key: TranslationKey, locale: Locale = DEFAULT_LOCALE, params?: TranslationParams): string {
  const value = lookup(locale, key);
  if (value === undefined) return String(key);

  if (typeof value === 'string') {
    return interpolate(value, params);
  }

  const count = Number(params?.count ?? 0);
  const form = selectPluralForm(value, locale, Number.isFinite(count) ? count : 0);
  return interpolate(form, params);
}

export type Translator = {
  (key: TranslationKey, params?: TranslationParams): string;
  locale: Locale;
};

export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  const translator = ((key: TranslationKey, params?: TranslationParams) => translate(key, locale, params)) as Translator;
  translator.locale = locale;
  return translator;
}

export function localeLabel(locale: Locale): string {
  return LOCALE_LABELS[locale] ?? locale;
}

export function localeFlag(locale: Locale): string {
  return LOCALE_FLAGS[locale] ?? '';
}

export {
  DEFAULT_LOCALE,
  LOCALE_FLAGS,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  type Locale,
  type PluralForms,
  type TranslationParams,
  type TranslationValue,
};
