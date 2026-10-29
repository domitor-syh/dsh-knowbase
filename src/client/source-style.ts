import type { Context } from '@deepseek-ai/cordis'

/** Styles remain scoped to owned controls, except the documented footer adapter. */
export const SOURCE_CSS = `
.kb-source-filter { position: relative; min-width: 0; }
.kb-source-filter-trigger { box-sizing: border-box; width: 100%; min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 16px 6px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; outline: none; box-shadow: none; }
.kb-source-filter-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-source-filter-chevron { flex: none; }
.kb-source-filter-trigger:focus, .kb-source-filter-trigger:focus-visible { outline: none; box-shadow: none; border-color: var(--dsw-alias-border-l1); }
.kb-source-filter-trigger:hover, .kb-source-filter-trigger:focus-visible { background: var(--dsw-alias-border-l1); }
.kb-source-filter-menu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 2; max-height: min(240px, 35vh); overflow-y: auto; overscroll-behavior: contain; box-sizing: border-box; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); outline: none; }
.kb-source-filter-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-radius: 8px; padding: 7px 8px; font-size: 12px; line-height: 18px; cursor: pointer; }
.kb-source-filter-option > span { min-width: 0; overflow-wrap: anywhere; }
.kb-source-filter-option > svg { flex: none; }
.kb-source-filter-option[aria-selected=true], .kb-source-filter-option[data-active=true] { background: var(--dsw-alias-border-l1); }
.kb-source-action { box-sizing: border-box; flex: none; height: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 2px 5px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font: inherit; line-height: 1; }
.kb-source-action:hover, .kb-source-action:focus-visible { background: var(--dsw-alias-border-l1); }
.kb-source-action:focus-visible { outline: 1px solid var(--dsw-alias-label-secondary); outline-offset: 2px; }
.kb-source-action [data-kb-source-icon] { display: inline-flex; align-items: center; width: calc(18px + var(--dsh-content-font-delta, 0px)); height: calc(18px + var(--dsh-content-font-delta, 0px)); }
.kb-source-action [data-kb-source-icon] svg { width: 100%; height: 100%; }
.kb-source-action [data-kb-source-count] { padding: 1px 5px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; font-size: calc(11px + var(--dsh-content-font-delta, 0px)); line-height: 16px; font-variant-numeric: tabular-nums; }
/* Host extraActions is before Branch, not a fully ordered toolbar. Move only
   this contribution's button after Branch, then keep endInfo last.
   Structural selectors avoid private hashed host classes and localized labels.
   Both direct entries and the current display:contents Slot anchor are covered. */
[data-clock=end] > [data-slot="conversation.chat.assistant-actions"] > .kb-source-action { order: 1; }
[data-clock=end] > .kb-source-action { order: 1; }
[data-clock=end]:has(> .kb-source-action) > span:last-child,
[data-clock=end]:has(> [data-slot="conversation.chat.assistant-actions"] > .kb-source-action) > span:last-child { order: 2; }
`

export function installSourceStyle(ctx: Context): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.knowbaseSources = ''
    tag.textContent = SOURCE_CSS
    document.head.appendChild(tag)
    return () => tag.remove()
  })
}
