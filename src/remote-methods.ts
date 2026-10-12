/**
 * The Remote method list, and the marker that publishes it.
 *
 * ## Why not `@Remote`
 *
 * The decorator is the documented way to mark a Remote method, and it is what
 * the generator understands. It is not usable here for two reasons: neither
 * tsdown nor rolldown lowers stage-3 decorators (the generator shipped that
 * transform as part of its own plugin), so a decorated method reaches the bundle
 * as invalid JavaScript — `verify-bundles.mjs` catches exactly that; and
 * `@Remote` ultimately does nothing more than attach a descriptor to the class
 * prototype, which can be attached directly.
 *
 * ## What the marker is
 *
 * `remoteMethods(service)` in `@deepseek-ai/dsh-typert-protocol` reads a
 * property descriptor off the prototype under a fixed key. That key is a
 * module-private constant there, so it is spelled out here — and
 * `tests/remote-methods.test.ts` asserts that `remoteMethods()` really returns
 * this list, which turns a silent mismatch into a failing test.
 *
 * The list is the single source of truth for both sides: the Host installs the
 * markers from it, and the client builds its descriptors from it, so the two
 * cannot disagree about which methods exist.
 *
 * @module @domitor-syh/dsh-knowbase/remote-methods
 */

/**
 * Property key the protocol's marker reader looks up on the prototype.
 *
 * Mirrors `REMOTE_METHOD_DESCRIPTOR` in
 * `@deepseek-ai/dsh-typert-protocol/lib/index.js`.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Every Remote method, in Host declaration order.
 *
 * Adding a method here without implementing it fails to compile: the client
 * descriptor table is keyed by this union, so a missing entry is a type error
 * rather than a call that fails at runtime.
 */
export const REMOTE_METHODS = [
  'listKnowledgeBases',
  'createKnowledgeBase',
  'renameKnowledgeBase',
  'deleteKnowledgeBase',
  'listMaterials',
  'addTextMaterial',
  'deleteMaterial',
  'readMaterialChunks',
  'testSearch',
  'getSessionScope',
  'setSessionScope',
] as const

/** One Remote method name. */
export type RemoteMethodName = (typeof REMOTE_METHODS)[number]

/**
 * Publish {@link REMOTE_METHODS} as the prototype marker the Gateway reads.
 *
 * Every method is a plain unary direct invocation, so the marker carries no
 * per-method options beyond the invocation kind.
 *
 * @param target - the Remote service class.
 */
export function installRemoteMarkers(target: { prototype: object }): void {
  const methods = Object.freeze(
    REMOTE_METHODS.map(method => Object.freeze({ method, invocation: { kind: 'direct' as const } })),
  )
  // `version: 1` is not decoration: the protocol's reader rejects any other
  // value with a TypeError, so a marker without it is worse than no marker.
  Object.defineProperty(target.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods }),
  })
}
