import { useSyncExternalStore } from 'react'
import { localizeDiagnostic, localizePosition } from '../diagnostic-locale.ts'
import { currentUiLanguage, subscribeUiLocale, uiLocaleSnapshot } from './citation-locale.ts'

export type UiText = (zh: string, en: string) => string
export const uiLanguage = currentUiLanguage
export const uiText: UiText = (zh, en) => uiLanguage() === 'en' ? en : zh
export function useUiText(): UiText {
  useSyncExternalStore(subscribeUiLocale, uiLocaleSnapshot, uiLocaleSnapshot)
  return uiText
}

export function localizeLocator(value: string): string {
  return localizePosition(value, uiLanguage())
}

export function localizeError(message: string): string {
  return localizeDiagnostic(message, uiLanguage())
}
