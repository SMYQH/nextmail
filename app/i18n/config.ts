export const locales = ['en', 'zh-CN'] as const
export type Locale = typeof locales[number]

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
}

export const defaultLocale: Locale = 'en'

export const i18n = {
  locales,
  defaultLocale,
  localePrefix: 'as-needed',
}
