/**
 * Persistence through the host's `storageDomain`.
 *
 * ## What is still persisted, and what is not
 *
 * Only knowledge bases. Their content is files in the vault folder, and the
 * folder is the record: a scan reads whatever is there, so the plugin storing a
 * second copy of a file's existence would create a way for the two to disagree
 * — and the one the user can see in their explorer is the one that must win.
 * What the base needs from storage is the part a folder cannot carry: its
 * description and when it was created and last changed.
 *
 * ## Why the schema was widened rather than versioned
 *
 * `storageDomain` has no migration on a version change — opening a domain whose
 * stored version differs is rejected outright — so bumping the version would
 * strand every existing install behind a manual migration. Instead version 1 is
 * kept and `folderName` is added as an optional field: records written before
 * the vault existed parse unchanged, and the service fills the field in when it
 * migrates them.
 *
 * The `materials` table is kept declared with its original schema for the same
 * reason on the other side: dropping a table whose records are still on the
 * medium is a change nothing verifies, and keeping it costs an empty read at
 * load. It is read exactly once, by `./core/migrate.ts`.
 *
 * @module @domitor-syh/dsh-knowbase/store
 */

import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { SessionScopeStore } from './core/session-scope.ts'
import type { ProposalStore, StoredProposal } from './core/proposals.ts'
import type { KnowbaseStore } from './core/service.ts'

/**
 * A knowledge base on the medium. Version 1, widened in place.
 *
 * Every field stays required rather than defaulted: a schema that invents
 * missing values would let a truncated or hand-edited record load as valid, and
 * the rule is that a corrupt record fails loudly instead of silently becoming
 * an empty knowledge base.
 */
const knowledgeBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // Added with the vault. Optional so pre-vault records load unchanged.
  folderName: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  indexRevision: z.number(),
  // Retired soft-delete marker. Kept so a record that carries it still parses;
  // the migration treats it as "do not resurrect this base".
  deletedAt: z.number().optional(),
})

/**
 * A text material on the medium, as the pre-vault build wrote it.
 *
 * Unchanged from that build's schema on purpose: this table exists so the
 * domain keeps loading, and the migration is the only reader.
 */
const legacyMaterialSchema = z.object({
  id: z.string(),
  kbId: z.string(),
  title: z.string(),
  source: z.literal('text'),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number(),
  text: z.string().optional(),
  deletedAt: z.number().optional(),
  contentHash: z.string().optional(),
  chunks: z.array(
    z.object({
      id: z.string(),
      ordinal: z.number(),
      text: z.string(),
      headingPath: z.string(),
      locator: z.string(),
    }),
  ),
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
    materials: domainTable(legacyMaterialSchema),
  },
})

const sessionScopeSchema = z.object({
  sessionId: z.string(),
  enabled: z.boolean(),
  all: z.boolean(),
  kbIds: z.array(z.string()),
  updatedAt: z.number(),
})

const proposalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kbId: z.string(),
  kbName: z.string(),
  fileName: z.string(),
  content: z.string(),
  contentBytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  reason: z.string(),
  baseRevision: z.number().int().nonnegative(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'failed']),
  appliedAt: z.number().optional(),
  materialId: z.string().optional(),
  failure: z.string().optional(),
})

/**
 * Pending write proposals have their own version axis: old installations can
 * keep reading the knowledge and session domains while this feature evolves.
 */
export const PROPOSAL_DOMAIN = defineDomain({
  name: 'dsh_knowbase_proposals',
  version: 1,
  tables: {
    proposals: domainTable(proposalSchema),
  },
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
  const legacyMaterials = domain.table('materials')

  const store: KnowbaseStore = {
    loadKnowledgeBases: () => [...knowledgeBases.entries()].map(([, record]) => record),
    saveKnowledgeBase: knowledgeBase =>
      knowledgeBases.put(knowledgeBase.id, {
        id: knowledgeBase.id,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        folderName: knowledgeBase.folderName,
        createdAt: knowledgeBase.createdAt,
        updatedAt: knowledgeBase.updatedAt,
        indexRevision: knowledgeBase.indexRevision,
      }),
    deleteKnowledgeBase: id => knowledgeBases.delete(id),

    loadLegacyMaterials: () => [...legacyMaterials.entries()].map(([, record]) => record),
    deleteLegacyMaterial: id => legacyMaterials.delete(id),
  }

  return { store, close: () => domain.close() }
}

export interface OpenedProposalStore {
  readonly store: ProposalStore
  /** Release the proposal domain. */
  close(): Promise<void>
}

/** Open the independent proposal domain. */
export async function openProposalStore(facility: DomainFacility): Promise<OpenedProposalStore> {
  const domain = await facility.open(PROPOSAL_DOMAIN)
  const proposals = domain.table('proposals')
  const store: ProposalStore = {
    loadAll: () => [...proposals.entries()].map(([, record]) => record),
    save: proposal => proposals.put(proposal.id, { ...proposal }),
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
