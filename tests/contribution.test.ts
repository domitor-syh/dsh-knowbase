/**
 * Drift tests for the Remote surface.
 *
 * Writing the descriptors by hand is the price of not vendoring the dsh
 * monorepo's package tree (see the stage-0 report, §12). The price is only
 * acceptable if drift is impossible to ship: a Host method with no descriptor is
 * silently unreachable from the browser, and a descriptor naming a method that
 * no longer exists fails only when a user clicks something. Both are caught
 * here, in the same gate as everything else.
 *
 * The marker test is the important one. `@Remote` is replaced by a hand-written
 * prototype descriptor under a key that is private to the protocol package, so
 * if that key or the descriptor's shape ever changes, this is where it shows up
 * — rather than as a settings page whose buttons do nothing.
 */

import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/client/contribution.ts'
import { REMOTE_METHODS } from '../src/remote-methods.ts'
import { KnowbaseRemote } from '../src/remote.ts'

/** Public instance methods the Host class actually exposes. */
function hostMethods(): string[] {
  const prototype = KnowbaseRemote.prototype as unknown as Record<string, unknown>
  return Object.getOwnPropertyNames(prototype)
    .filter(name => name !== 'constructor')
    .filter(name => typeof prototype[name] === 'function')
    .sort()
}

/** An object whose prototype is the service's, so markers can be read without
 * constructing a service (which needs a live cordis context). */
function markerProbe(): object {
  return Object.create(KnowbaseRemote.prototype) as object
}

describe('Remote markers', () => {
  it('are readable by the protocol reader', () => {
    // Reads through the same code path the Gateway uses.
    expect(() => remoteMethods(markerProbe())).not.toThrow()
  })

  it('expose exactly the methods the Host class defines', () => {
    const marked = remoteMethods(markerProbe())
      .map(marker => marker.method)
      .sort()
    expect(marked).toEqual(hostMethods())
  })

  it('declare every method as a direct invocation', () => {
    for (const marker of remoteMethods(markerProbe())) {
      expect(marker.invocation).toEqual({ kind: 'direct' })
    }
  })
})

describe('Remote contribution — coverage', () => {
  it('lists the same methods as the shared method list', () => {
    expect([...REMOTE_METHODS].sort()).toEqual(TYPERT_REMOTE.descriptors.map(d => d.method).sort())
  })

  it('describes exactly the Host service methods', () => {
    expect(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method).sort()).toEqual(
      hostMethods(),
    )
  })

  it('declares no descriptor twice', () => {
    const ids = TYPERT_REMOTE.descriptors.map(descriptor => descriptor.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches each descriptor arity to the method it names', () => {
    // `Function.length` counts the declared parameters, so this catches a
    // parameter added on one side only — the failure the generator exists to
    // prevent.
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      const prototype = KnowbaseRemote.prototype as unknown as Record<
        string,
        (...args: never[]) => unknown
      >
      const method = prototype[descriptor.method]!
      expect(descriptor.parameters.length, `${descriptor.method} descriptor/arity mismatch`).toBe(
        method.length,
      )
    }
  })
})

describe('Remote contribution — shape', () => {
  it('names the owning package', () => {
    expect(TYPERT_REMOTE.package).toBe('@domitor-syh/dsh-knowbase')
  })

  it('routes every descriptor through the knowbase service and namespace', () => {
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      expect(descriptor.service).toBe('knowbase')
      expect(descriptor.namespace).toBe('knowbase')
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
    }
  })

  it('declares the transport cancellation parameter instead of a wire argument', () => {
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      expect(descriptor.cancellation).toEqual({ parameter: 'signal' })
    }
  })

  it('gives every parameter a json source and a strict codec', () => {
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      for (const parameter of descriptor.parameters) {
        expect(parameter.source).toBe('json')
        expect(parameter.wire).toBe(parameter.name)
        // `strict` is the mode that carries a schema factory; the other arm of
        // the codec union is source-mode and has no `create`.
        expect(parameter.codec.mode).toBe('strict')
      }
      expect(descriptor.result?.mode).toBe('strict')
    }
  })

  it('materializes a usable zod schema for every codec', () => {
    // A codec whose `create` throws would fail at the first call boundary, which
    // is the worst place to discover a typo.
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      const codec = descriptor.result
      if (codec?.mode !== 'strict') throw new Error(`${descriptor.method} has no strict result codec`)
      const schema = codec.create() as { safeParse?: unknown }
      expect(typeof schema.safeParse).toBe('function')
    }
  })
})
