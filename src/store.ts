/**
 * Persistence through the host's `storageDomain`.
 *
 * The plan's rule is that metadata lives in the host's storage facility while
 * bulk text lives in plugin-controlled files. This file is the first half; it
 * deliberately does not hand-roll `node:fs` into `~/.dsh/storages` the way the
 * reference plugin does, because `storageDomain` gives version checking,
 * schema validation at the durable boundary and change events for free — and
 * because a hand-rolled directory would have no format version at all.
 *
 * Layout is left at the default (`single`): one document per domain, loaded
 * into memory on open. `per-record` is the upgrade path the moment materials
 * grow large enough that rewriting the whole unit per write shows up in
 * measurements — not before, since the default is the better-tested path.
 *
 * @module @domitor-syh/dsh-knowbase/store
 */

import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { SessionScopeStore } from './core/session-scope.ts'
import type { KnowbaseStore } from './core/service.ts'

/**
 * On-disk shape. Version 1.
 *
 * Every field is required rather than defaulted: a schema that invents missing
 * values would let a truncated or hand-edited record load as valid, and the
 * plan's rule is that a corrupt record fails loudly instead of silently
 * becoming an empty knowledge base.
 */
const chunkSchema = z.object({
  id: z.string(),
  ordinal: z.number(),
  text: z.string(),
  headingPath: z.string(),
  locator: z.string(),
})

const knowledgeBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  indexRevision: z.number(),
})

const materialSchema = z.object({
  id: z.string(),
  kbId: z.string(),
  title: z.string(),
  source: z.literal('text'),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number(),
  // Absent in records written before the editor existed; those fall back to
  // reassembling the text from their chunks.
  text: z.string().optional(),
  chunks: z.array(chunkSchema),
})

/**
 * The plugin's storage declaration. Validated at module load by `defineDomain`.
 *
 * The name must match `/^[a-z][a-z0-9_]*$/` — no dashes, unlike the package
 * name. A violation throws during module evaluation, so it would surface as the
 * plugin failing to import rather than as a storage error.
 */
export const KNOWBASE_DOMAIN = defineDomain({
  name: 'dsh_knowbase',
  version: 1,
  tables: {
    knowledge_bases: domainTable(knowledgeBaseSchema),
    materials: domainTable(materialSchema),
  },
})

const sessionScopeSchema = z.object({
  sessionId: z.string(),
  enabled: z.boolean(),
  all: z.boolean(),
  kbIds: z.array(z.string()),
  updatedAt: z.number(),
})

/**
 * Session selections live in their own domain, not a third table above.
 *
 * `storageDomain` has no migration on a version change — opening a domain whose
 * stored version differs is rejected outright — so widening the knowledge
 * domain would strand every existing install's data behind a manual migration.
 * A separate domain keeps the knowledge data at version 1 forever and gives the
 * session state its own version axis to evolve on.
 */
export const SESSION_DOMAIN = defineDomain({
  name: 'dsh_knowbase_sessions',
  version: 1,
  tables: {
    session_scopes: domainTable(sessionScopeSchema),
  },
})

/** An opened store plus the handle that releases it. */
export interface OpenedStore {
  readonly store: KnowbaseStore
  /** Release the backend unit. Idempotent. */
  close(): Promise<void>
}

/**
 * Open the plugin's domain.
 *
 * The caller owns the returned handle and must close it — typically from a
 * `ctx.effect` disposer, so disabling the plugin releases the unit instead of
 * leaving it open until the facility unmounts.
 *
 * @param facility - `ctx.storageDomain`.
 * @returns the store and its release handle.
 */
export async function openStorageDomainStore(facility: DomainFacility): Promise<OpenedStore> {
  const domain = await facility.open(KNOWBASE_DOMAIN)
  const knowledgeBases = domain.table('knowledge_bases')
  const materials = domain.table('materials')

  const store: KnowbaseStore = {
    loadKnowledgeBases: () => [...knowledgeBases.entries()].map(([, record]) => record),
    loadMaterials: () => [...materials.entries()].map(([, record]) => record),

    saveKnowledgeBase: knowledgeBase => knowledgeBases.put(knowledgeBase.id, knowledgeBase),
    deleteKnowledgeBase: id => knowledgeBases.delete(id),

    // Spread the chunks into fresh objects: the domain's records are the
    // schema's mutable shape, and handing it a readonly array would only type
    // check by accident.
    saveMaterial: material =>
      materials.put(material.id, {
        ...material,
        chunks: material.chunks.map(chunk => ({ ...chunk })),
      }),
    deleteMaterial: id => materials.delete(id),
  }

  return { store, close: () => domain.close() }
}

/** An opened session-scope store plus its release handle. */
export interface OpenedSessionStore {
  readonly store: SessionScopeStore
  /** Release the backend unit. Idempotent. */
  close(): Promise<void>
}

/**
 * Open the session-selection domain.
 *
 * Separate from {@link openStorageDomainStore} for the versioning reason on
 * {@link SESSION_DOMAIN}; the caller owns the handle in the same way.
 *
 * @param facility - `ctx.storageDomain`.
 * @returns the store and its release handle.
 */
export async function openSessionScopeStore(
  facility: DomainFacility,
): Promise<OpenedSessionStore> {
  const domain = await facility.open(SESSION_DOMAIN)
  const scopes = domain.table('session_scopes')

  const store: SessionScopeStore = {
    loadAll: () => [...scopes.entries()].map(([, record]) => record),
    // Spread as the other writer does: the domain's records are the schema's
    // mutable shape, and a readonly array would only type check by accident.
    save: record => scopes.put(record.sessionId, { ...record, kbIds: [...record.kbIds] }),
  }

  return { store, close: () => domain.close() }
}
