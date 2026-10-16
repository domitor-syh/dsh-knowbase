/**
 * The knowledge base page's stylesheet and its design tokens.
 *
 * ## Why a stylesheet and not inline styles
 *
 * Every other surface this plugin draws is inline-styled, because a control
 * dropped into the host's chrome has nowhere to put a rule. A whole page is the
 * other case: the hand-off is a stylesheet — hover, `:focus-visible`, disabled
 * opacities, `::placeholder`, two media queries and a `prefers-reduced-motion`
 * block — and translating that into React state and inline objects would be a
 * second, worse implementation of the same design.
 *
 * The sheet is injected once, and every selector is either `.kb-…` or scoped
 * under `#kb-settings-page`, so nothing reaches the host's own chrome. The
 * `body` rule the mockup carries is deliberately not ported: painting the app's
 * background is the app's job.
 *
 * ## The tokens
 *
 * `--brand-*` are the hand-off's own variable names, kept verbatim so the CSS
 * below reads the same as the file it came from. They are declared on the page
 * container rather than on `:root` — the same isolation rule as the selectors —
 * and the container carries either `.kb-theme-light` or `.kb-theme-dark`.
 *
 * Light is the hand-off's literal values, sampled from its token block (itself
 * drawn from a design library, so the numbers are the designer's, not mine).
 * The hand-off only states light; dark is the same semantic roles translated
 * through the palette the composer control already uses in dark (panel
 * `#24262c`, hairline `#34373e`, text `#f2f4f7`, muted `#9aa1ac`), so the page
 * and the control do not disagree about what dark means.
 *
 * @module @domitor-syh/dsh-knowbase/client/page-style
 */

import type { ColorScheme } from './theme.ts'

/** Id of the injected `<style>`; also what makes injection idempotent. */
const STYLE_ID = 'dsh-knowbase-page-style'

/** The page's own variable names, per scheme. */
const TOKENS: Record<ColorScheme, Record<string, string>> = {
  light: {
    '--brand-background': '#ffffff',
    '--brand-card': '#ffffff',
    '--brand-popover': '#f9f9fa',
    '--brand-muted': '#eff1f4',
    '--brand-foreground': '#0e1115',
    '--brand-card-foreground': '#0e1115',
    '--brand-popover-foreground': '#0e1115',
    '--brand-primary-foreground': '#ffffff',
    '--brand-secondary-foreground': '#333942',
    '--brand-muted-foreground': '#7f8d9f',
    '--brand-accent-foreground': '#003e8f',
    '--brand-destructive-foreground': '#ffffff',
    '--brand-primary': '#4285f4',
    '--brand-secondary': '#dbeafe',
    '--brand-accent': '#dbeafe',
    '--brand-input': '#e2e3e4',
    '--brand-ring': '#4285f4',
    '--brand-destructive': '#ef4444',
    '--brand-border': '#ebebeb',
    '--brand-sidebar': '#f0f6ff',
    '--brand-sidebar-foreground': '#0e1115',
    '--brand-sidebar-primary': '#4285f4',
    '--brand-sidebar-primary-foreground': '#ffffff',
    '--brand-sidebar-accent': '#dbeafe',
    '--brand-sidebar-accent-foreground': '#003e8f',
    '--brand-sidebar-border': '#e7eaef',
    '--brand-sidebar-ring': '#4285f4',
    '--state-info': '#4285f4',
    '--state-error': '#ef4444',
    '--state-warning': '#fbbc05',
    '--state-success': '#34a853',
    '--brand-radius-sm': '4px',
    '--brand-radius-md': '8px',
    '--brand-radius-lg': '12px',
    '--brand-radius-xl': '16px',
    '--brand-radius': '12px',
    '--brand-spacing': '3.84px',
    '--brand-font-sans':
      '"DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    '--brand-font-mono': '"JetBrains Mono", ui-monospace, monospace',
    '--brand-shadow': '0 1px 2px rgba(14, 17, 21, 0.05)',
    '--brand-shadow-popover': '0 8px 24px rgba(14, 17, 21, 0.12)',
    '--brand-shadow-card':
      '2px 2px 6px rgba(14, 17, 21, 0.10), 6px 8px 20px -8px rgba(14, 17, 21, 0.16)',
    '--brand-overlay': 'rgba(14, 17, 21, 0.45)',
  },
  dark: {
    '--brand-background': '#1b1d21',
    '--brand-card': '#24262c',
    '--brand-popover': '#2a2d33',
    '--brand-muted': '#2f333a',
    '--brand-foreground': '#f2f4f7',
    '--brand-card-foreground': '#f2f4f7',
    '--brand-popover-foreground': '#f2f4f7',
    '--brand-primary-foreground': '#ffffff',
    '--brand-secondary-foreground': '#c6ccd4',
    '--brand-muted-foreground': '#9aa1ac',
    '--brand-accent-foreground': '#a8c7fa',
    '--brand-destructive-foreground': '#ffffff',
    '--brand-primary': '#4285f4',
    '--brand-secondary': 'rgba(66, 133, 244, 0.16)',
    '--brand-accent': 'rgba(66, 133, 244, 0.16)',
    '--brand-input': '#3a3e45',
    '--brand-ring': '#4285f4',
    '--brand-destructive': '#ef4444',
    '--brand-border': '#34373e',
    '--brand-sidebar': '#1f242c',
    '--brand-sidebar-foreground': '#f2f4f7',
    '--brand-sidebar-primary': '#4285f4',
    '--brand-sidebar-primary-foreground': '#ffffff',
    '--brand-sidebar-accent': 'rgba(66, 133, 244, 0.16)',
    '--brand-sidebar-accent-foreground': '#a8c7fa',
    '--brand-sidebar-border': '#34373e',
    '--brand-sidebar-ring': '#4285f4',
    '--state-info': '#4285f4',
    '--state-error': '#ef4444',
    '--state-warning': '#fbbc05',
    '--state-success': '#34a853',
    '--brand-radius-sm': '4px',
    '--brand-radius-md': '8px',
    '--brand-radius-lg': '12px',
    '--brand-radius-xl': '16px',
    '--brand-radius': '12px',
    '--brand-spacing': '3.84px',
    '--brand-font-sans':
      '"DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    '--brand-font-mono': '"JetBrains Mono", ui-monospace, monospace',
    '--brand-shadow': '0 1px 2px rgba(0, 0, 0, 0.35)',
    '--brand-shadow-popover': '0 10px 28px rgba(0, 0, 0, 0.55)',
    '--brand-shadow-card': '0 2px 6px rgba(0, 0, 0, 0.40), 0 8px 20px -8px rgba(0, 0, 0, 0.55)',
    '--brand-overlay': 'rgba(0, 0, 0, 0.55)',
  },
}

/**
 * The hand-off's stylesheet.
 *
 * Copied from the mockup's `critical-layout` block with two changes: the `body`
 * rule is gone (the host owns the app's background), and the root's fixed
 * `height: 860px` becomes `height: 100%` — the mockup is a fixed-size canvas,
 * while the real page lives in the host's centre column and must fill whatever
 * height that column has.
 */
const CSS = `
/* The row menu is drawn into \`document.body\` rather than into the page (see
   \`RowMenu\`), so it is outside this subtree and has to be named separately. */
#kb-settings-page, #kb-settings-page *,
.kb-menu, .kb-menu * { box-sizing: border-box; }
#kb-settings-page [hidden] { display: none !important; }

#kb-settings-page {
  max-width: 1320px;
  height: 100%;
  margin: 0 auto;
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
  font-size: 14px;
  line-height: 1.5;
  color: var(--brand-foreground);
  font-family: var(--brand-font-sans);
}

/* 页头 */
.kb-head-title { margin: 0; font-size: 20px; line-height: 1.25; font-weight: 700; }

/* 卡片：无边框，侧阴影（独立卡片观感） */
.kb-card {
  background: var(--brand-card);
  border: 0;
  border-radius: var(--brand-radius);
  padding: 16px;
  box-shadow: var(--brand-shadow-card);
}
/* 顶部两卡：OCR 窄 / 检索宽（检索测试需要更多空间） */
.kb-top-grid { display: grid; grid-template-columns: minmax(0, 4fr) minmax(0, 5fr); gap: 16px; }
.kb-top-grid .kb-card { min-width: 0; display: flex; flex-direction: column; }
.kb-top-grid .kb-report { flex: 1; min-height: 0; max-height: 200px; overflow-y: auto; margin-top: 12px; padding-top: 12px; }

/* 统一居中模态（添加/重命名/删除知识库、删除文件） */
.kb-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--brand-overlay);
}
.kb-modal {
  width: min(400px, calc(100vw - 48px));
  padding: 20px;
  background: var(--brand-card);
  border-radius: var(--brand-radius-xl);
  box-shadow: var(--brand-shadow-popover);
}
.kb-modal-title { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3; color: var(--brand-foreground); }
.kb-modal-body { margin-top: 12px; font-size: 13px; line-height: 1.6; color: var(--brand-secondary-foreground); overflow-wrap: anywhere; }
.kb-modal-body .kb-input { margin-top: 4px; }
.kb-modal-body .kb-field-label { display: block; margin-top: 12px; }
.kb-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.kb-modal-actions .kb-btn--danger { color: var(--state-error); border-color: var(--state-error); }
.kb-block-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
/* 文件块：标题分割线延长到窗口两边；滚动裁切线严格贴合——顶部 = 分割线，底部 = 卡片底边 */
#kb-files-block { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; padding-bottom: 0; }
#kb-files-block .kb-block-head { margin: 0 -16px; padding: 0 16px 12px; border-bottom: 1px solid var(--brand-border); flex: none; }
.kb-card-title { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.4; }
.kb-btn-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

/* 按钮 */
.kb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--brand-border);
  border-radius: var(--brand-radius);
  background: var(--brand-card);
  color: var(--brand-foreground);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, opacity 140ms ease;
}
.kb-btn svg { flex: none; }
.kb-btn:hover:not(:disabled) { background: var(--brand-muted); }
.kb-btn:active:not(:disabled) { background: var(--brand-sidebar-accent); }
.kb-btn:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: 2px; }
.kb-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.kb-icon-only { width: 32px; padding: 0; gap: 0; }
.kb-btn--primary { background: var(--brand-primary); border-color: var(--brand-primary); color: var(--brand-primary-foreground); }
.kb-btn--primary:hover:not(:disabled) { background: var(--brand-primary); opacity: 0.88; }
.kb-btn--primary:active:not(:disabled) { background: var(--brand-primary); opacity: 0.78; }
.kb-btn--danger { color: var(--state-error); border-color: var(--state-error); }
.kb-btn--danger:hover:not(:disabled) { background: var(--brand-muted); }
.kb-full { width: 100%; }

/* 表单控件 */
.kb-input, .kb-textarea {
  width: 100%;
  border: 1px solid var(--brand-input);
  border-radius: var(--brand-radius);
  background: var(--brand-card);
  color: var(--brand-foreground);
  font-family: inherit;
  font-size: 13px;
  padding: 0 10px;
  transition: border-color 140ms ease;
}
.kb-input { height: 32px; }
.kb-textarea { min-height: 72px; padding: 8px 10px; line-height: 1.5; resize: vertical; }
/* Focus is the field's own border turning blue — not a second ring around it.
   The 2px outline the hand-off draws reads as a box the input sits inside, and
   two concentric blue lines is one too many for a 32px control. */
.kb-input:focus, .kb-textarea:focus { outline: none; border-color: var(--brand-ring); }
.kb-input::placeholder, .kb-textarea::placeholder { color: var(--brand-muted-foreground); }

/* OCR 卡 */
.kb-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--brand-secondary-foreground);
}
.kb-status svg { flex: none; }
.kb-status--reading svg { color: var(--brand-muted-foreground); animation: kb-spin 1.1s linear infinite; }
.kb-status--ready svg { color: var(--state-success); }
.kb-status--missing svg { color: var(--state-warning); }
.kb-ocr-actions { margin-top: 10px; }
.kb-progress { margin-top: 10px; }
.kb-progress-track { height: 6px; background: var(--brand-muted); border-radius: var(--brand-radius-sm); overflow: hidden; }
.kb-progress-fill { height: 100%; width: 0; background: var(--brand-primary); border-radius: var(--brand-radius-sm); transition: width 180ms linear; }
.kb-progress-text { margin: 8px 0 0; font-family: var(--brand-font-mono); font-size: 12px; color: var(--brand-muted-foreground); overflow-wrap: anywhere; }
.kb-msg { display: flex; align-items: center; gap: 8px; margin: 10px 0 0; font-size: 13px; color: var(--brand-secondary-foreground); }
.kb-msg svg { flex: none; }
.kb-msg--ok { color: var(--state-success); }
.kb-msg--warn { color: var(--state-warning); }
.kb-ocr-dir { margin: 10px 0 0; font-family: var(--brand-font-mono); font-size: 12px; color: var(--brand-muted-foreground); overflow-wrap: anywhere; }
.kb-ocr-privacy {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--brand-secondary-foreground);
}
.kb-ocr-privacy svg { flex: none; margin-top: 1px; color: var(--brand-muted-foreground); }

/* 提示条（互斥单条，滑入） */
.kb-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--brand-border);
  border-radius: var(--brand-radius);
  background: var(--brand-card);
  font-size: 13px;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 180ms ease, transform 180ms ease;
}
.kb-alert svg { flex: none; }
.kb-alert.is-in { opacity: 1; transform: translateY(0); }
.kb-alert--error { border-color: var(--state-error); color: var(--state-error); }
.kb-alert--notice { border-color: var(--brand-primary); color: var(--brand-primary); }

/* 主区两栏：左列表 / 右文件（页面整体固定，仅列表内部滚动） */
.kb-columns { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; align-items: stretch; flex: 1; min-height: 0; }
.kb-columns > aside.kb-card { display: flex; flex-direction: column; min-height: 0; overflow: hidden; padding-bottom: 0; }
#kb-lib-empty { margin-bottom: 8px; }
.kb-right { min-width: 0; min-height: 0; }
.kb-detail { display: flex; flex-direction: column; gap: 16px; min-width: 0; height: 100%; }
.kb-placeholder {
  margin: 0;
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--brand-muted-foreground);
  background: var(--brand-card);
  border: 1px dashed var(--brand-border);
  border-radius: var(--brand-radius);
}

/* 左栏合一卡。底部留白与顶部一致（列表 \`margin-top: 8px\`）：最后一行贴着卡片
   下边缘，等于把「列表还没完」画成了一个视觉终点。 */
.kb-left-sec { position: relative; display: flex; flex-direction: column; min-height: 0; flex: 1; padding-bottom: 8px; }
.kb-sec-label { display: block; margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--brand-muted-foreground); }
.kb-left-head { display: flex; align-items: center; gap: 4px; margin: 0 -16px 0; padding: 0 16px 6px; border-bottom: 1px solid var(--brand-border); }
.kb-left-head .kb-sec-label { flex: 1; margin: 0; font-size: 13px; color: var(--brand-foreground); }
.kb-left-head .kb-sec-label .kb-sec-count { font-weight: 400; color: var(--brand-muted-foreground); }
.kb-icon-btn {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--brand-radius-sm);
  color: var(--brand-muted-foreground);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.kb-icon-btn svg { width: 15px; height: 15px; }
.kb-icon-btn--add { width: 32px; height: 32px; }
.kb-icon-btn--add svg { width: 18px; height: 18px; }
.kb-icon-btn:hover:not(:disabled) { background: var(--brand-muted); color: var(--brand-foreground); }
.kb-icon-btn:active:not(:disabled) { background: var(--brand-sidebar-accent); }
.kb-icon-btn:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: 1px; }
.kb-icon-btn[aria-expanded="true"] { background: var(--brand-sidebar-accent); color: var(--brand-accent-foreground); }
.kb-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.kb-lib-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 0; flex: 1; min-height: 0; overflow-y: auto; }
.kb-lib-list > li { position: relative; }
.kb-lib-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 8px;
  border: 0;
  border-radius: var(--brand-radius);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  transition: background-color 160ms ease;
}
.kb-lib-row:hover { background: var(--brand-muted); }
.kb-lib-row.is-selected { background: var(--brand-sidebar-accent); }
.kb-lib-select {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.kb-lib-select:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: 1px; border-radius: var(--brand-radius-sm); }
.kb-lib-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.5;
  color: var(--brand-foreground);
  overflow-wrap: anywhere;
  transition: color 160ms ease;
}
.kb-lib-row.is-selected .kb-lib-name { font-weight: 700; color: var(--brand-accent-foreground); }
.kb-lib-more {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  padding: 0;
  border: 0;
  border-radius: var(--brand-radius-sm);
  background: transparent;
  color: var(--brand-muted-foreground);
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}
.kb-lib-more:hover { background: var(--brand-muted); color: var(--brand-foreground); }
.kb-lib-more:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: 1px; }
.kb-lib-more[aria-expanded="true"] { background: var(--brand-muted); color: var(--brand-foreground); }

/* 库行三点菜单：浮层。画进 document.body（见 RowMenu），top/right 由组件按锚点算，
   所以这里不写定位偏移；列表是滚动容器，菜单留在里面会被裁成半条。 */
.kb-menu {
  position: fixed;
  z-index: 90;
  min-width: 148px;
  padding: 6px;
  background: var(--brand-popover);
  border: 1px solid var(--brand-border);
  border-radius: var(--brand-radius-xl);
  box-shadow: var(--brand-shadow-popover);
}
.kb-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--brand-radius);
  background: transparent;
  color: var(--brand-foreground);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms ease;
}
.kb-menu-item:hover:not(:disabled) { background: var(--brand-muted); }
.kb-menu-item:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: -2px; }
.kb-menu-item:disabled { opacity: 0.45; cursor: not-allowed; }
.kb-menu-item--danger { color: var(--state-error); }
.kb-empty { margin: 16px 0 0; font-size: 13px; color: var(--brand-muted-foreground); }

/* 字段标签 */
.kb-field-label { font-size: 12px; font-weight: 600; color: var(--brand-muted-foreground); }

/* 文件块 */
.kb-title-group { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.kb-files-size { font-size: 12px; color: var(--brand-muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; }
.kb-file-list { list-style: none; margin: 0; padding: 0; flex: 1; min-height: 0; overflow-y: auto; }
/* 非滚动状态时补充卡片底部留白（滚动时由卡片底边直接裁切） */
#kb-files-block > .kb-empty, #kb-files-block > .kb-inline-hint { margin-bottom: 16px; }
.kb-file-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 0; }
.kb-file-name { font-size: 13px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.kb-file-reason { display: block; font-weight: 400; font-size: 11.5px; line-height: 1.4; color: var(--brand-muted-foreground); }
.kb-file-main { flex: 1 1 auto; min-width: 0; }
.kb-file-size {
  flex: none;
  width: 64px;
  text-align: right;
  font-size: 12px;
  line-height: 1.4;
  color: var(--brand-muted-foreground);
  font-variant-numeric: tabular-nums;
}
.kb-file-actions { display: flex; flex: none; gap: 6px; }
.kb-upload { position: relative; cursor: pointer; }
/* Keyboard focus only. \`:focus-within\` would also match the mouse: clicking the
   label focuses the hidden input, so the ring stayed drawn until something else
   took focus — a blue box around a button the user had already used. */
.kb-upload:has(.kb-file-input:focus-visible) { background: var(--brand-muted); }
.kb-upload:not(.is-disabled):hover { background: var(--brand-muted); }
.kb-upload.is-disabled { opacity: 0.45; cursor: not-allowed; }
.kb-file-input { position: absolute; left: 0; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; }
.kb-inline-hint {
  margin-top: 16px;
  padding: 12px;
  background: var(--brand-popover);
  border: 1px solid var(--brand-border);
  border-radius: var(--brand-radius);
}
.kb-inline-hint p { margin: 0 0 12px; font-size: 13px; color: var(--brand-secondary-foreground); }

/* 检索测试 */
.kb-scope-group { display: inline-flex; border: 1px solid var(--brand-border); border-radius: var(--brand-radius); overflow: hidden; }
.kb-scope {
  height: 32px;
  padding: 0 12px;
  border: 0;
  background: var(--brand-card);
  color: var(--brand-secondary-foreground);
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease;
}
.kb-scope + .kb-scope { border-left: 1px solid var(--brand-border); }
.kb-scope:hover:not([aria-pressed="true"]):not(:disabled) { background: var(--brand-muted); }
.kb-scope[aria-pressed="true"] { background: var(--brand-sidebar-accent); color: var(--brand-accent-foreground); font-weight: 700; }
.kb-scope:focus-visible { outline: 2px solid var(--brand-ring); outline-offset: -2px; }
.kb-scope:disabled { opacity: 0.45; cursor: not-allowed; }
.kb-search-row { display: flex; gap: 8px; margin-top: 16px; }
.kb-search-row .kb-input { flex: 1 1 auto; min-width: 0; }
.kb-search-row .kb-btn { flex: none; }
.kb-report { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--brand-border); font-size: 13px; }
.kb-report:empty { display: none; }
.kb-report-scope { margin: 0 0 8px; font-weight: 600; }
.kb-report-summary { margin: 0 0 16px; color: var(--brand-secondary-foreground); }
.kb-hit { padding: 12px 0; }
.kb-hit + .kb-hit { border-top: 1px solid var(--brand-border); }
.kb-hit-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.kb-hit-src { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.kb-hit-score { font-size: 12px; color: var(--brand-muted-foreground); white-space: nowrap; }
.kb-hit-body {
  margin: 8px 0 0;
  padding-left: 12px;
  border-left: 2px solid var(--brand-border);
  font-size: 13px;
  line-height: 1.7;
  color: var(--brand-secondary-foreground);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.kb-report-foot { margin: 16px 0 0; padding-top: 16px; border-top: 1px solid var(--brand-border); font-size: 12px; color: var(--brand-muted-foreground); }

@keyframes kb-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* 双箭头按钮（检测 / 重扫 / 重扫全部）在工作时的自转。周期与 useSpin 的最短可见
   时长一致，所以「瞬间完成」的动作正好转满一圈，停下的位置就是起点。 */
.kb-icon-spin { transform-origin: center; animation: kb-spin 600ms linear infinite; }
/* 自转中的按钮是在工作，不是「不可用」：别在它转的时候同时把它压暗。 */
.kb-btn:has(.kb-icon-spin):disabled,
.kb-icon-btn:has(.kb-icon-spin):disabled { opacity: 1; }

@media (max-width: 1120px) {
  #kb-settings-page { height: auto; overflow: visible; }
  .kb-top-grid { grid-template-columns: minmax(0, 1fr); }
  .kb-file-list { max-height: 360px; }
  .kb-lib-list { max-height: 320px; }
}
@media (max-width: 860px) {
  .kb-columns { grid-template-columns: minmax(0, 1fr); }
  .kb-columns > aside.kb-card { overflow: visible; }
  .kb-lib-list { max-height: 320px; overflow-y: auto; }
}

@media (prefers-reduced-motion: reduce) {
  #kb-settings-page *, #kb-settings-page *::before, #kb-settings-page *::after,
  .kb-menu, .kb-menu * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`

/**
 * Inject the sheet, once.
 *
 * Called during `apply` rather than from the page component so the rules are in
 * place before the first paint: a page that renders unstyled for one frame and
 * then jumps is the kind of thing that reads as a bug in the host.
 */
export function installPageStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * The container's inline style: the token values for one scheme, and nothing
 * else. Inline rather than a rule because the scheme is React state — and
 * because an inline custom property beats any rule the sheet could carry.
 */
export function pageTokens(scheme: ColorScheme): Record<string, string> {
  return TOKENS[scheme]
}
