import type { Context } from '@deepseek-ai/cordis'
import { installCitationLocale } from '../../src/client/citation-locale.ts'

/** Small Host locale implementation; subscriptions and registration disposal are real. */
export function installTestLocale(initial = 'zh') {
  let active = initial
  const dictionaries = new Map<string, Record<string, string>>()
  const listeners = new Set<() => void>()
  const effects: Array<() => void> = []
  const keyOf = (namespace: string, language: string) => `${namespace}:${language}`
  const locale = {
    register(namespace: string, language: string, dictionary: Record<string, string>) {
      const key = keyOf(namespace, language)
      dictionaries.set(key, dictionary)
      return () => { dictionaries.delete(key) }
    },
    bind(namespace: string) {
      return (key: string) => dictionaries.get(keyOf(namespace, active.toLowerCase().startsWith('zh') ? 'zh' : 'en'))?.[key] ?? key
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getLocale: () => ({ active }),
  }
  installCitationLocale({
    locale,
    effect(effect: () => (() => void)) { effects.push(effect()) },
  } as unknown as Context)
  return {
    setLocale(language: string) { active = language; listeners.forEach(listener => listener()) },
    dispose() { effects.splice(0).reverse().forEach(dispose => dispose()) },
    get registrations() { return dictionaries.size },
    get subscriptions() { return listeners.size },
  }
}
