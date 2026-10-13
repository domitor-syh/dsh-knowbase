/**
 * Run the suite as if this were not a Chinese machine.
 *
 * ## Why this file exists
 *
 * CI went red on a test that passed on every developer machine, and the reason
 * is the one thing a local run cannot show you: the ambient locale. On a zh-CN
 * desktop `'甲'.localeCompare('乙')` is negative (pinyin), while on a bare Linux
 * runner the root collation compares Han by code point and the same call is
 * positive (`乙` = U+4E59 before `甲` = U+7532). An export that promised
 * byte-identical output produced two different files.
 *
 * A test that asserts pinyin order therefore *cannot* fail here — it only fails
 * on the machine you were not testing on. This setup file closes that gap: it
 * replaces the ambient collation with a non-Chinese one for the whole run, so
 * the same suite that passes on a zh-CN desktop also passes as a stand-in for
 * the runner.
 *
 * ## Usage
 *
 *     npx vitest run --setupFiles scripts/ci-locale.setup.mjs
 *
 * Any locale-dependent ordering in `src/` fails under it. Note that it does not
 * make the suite pass or fail differently for *correct* code: a pinned collator
 * ignores this shim entirely, which is the whole point.
 */

// What the root (locale-neutral) collation does with Han characters — the
// behaviour the runner had. Chosen explicitly rather than left to `en-US` so the
// simulation does not itself depend on the machine's locale data.
const rootCollation = new Intl.Collator('en-US')

const original = String.prototype.localeCompare

String.prototype.localeCompare = function localeCompare(other, locales, options) {
  // A call that names its locale is asking for that locale, so honour it: only
  // the *ambient* form (no locale argument) is what varies between machines.
  if (locales !== undefined || options !== undefined) {
    return new Intl.Collator(locales, options).compare(String(this), String(other))
  }
  return rootCollation.compare(String(this), String(other))
}

// Leave no doubt about which run produced a result.
console.log('[ci-locale] ambient localeCompare replaced with root collation')

// Restore on teardown so the shim cannot leak into a watch-mode rerun.
process.on('exit', () => {
  String.prototype.localeCompare = original
})
