export const SUPPORTED_LOCALES = ['en', 'de', 'pt-BR'] as const;

export type Locale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
};

export const LOCALE_FLAGS: Record<Locale, string> = {
  en: '🇬🇧',
  de: '🇩🇪',
  'pt-BR': '🇧🇷',
};

export interface PluralForms {
  one: string;
  other: string;
}

export type TranslationValue = string | PluralForms;

export type TranslationParams = Record<string, string | number>;
