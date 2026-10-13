/**
 * Client-side Remote contribution, written by hand.
 *
 * The generator would produce this file from the Host types; it is written
 * manually because the generator cannot run for a standalone plugin (see
 * `../remote.ts`). What it contains is exactly what the generated artifact
 * contains — zod schemas plus `InvocationDescriptor` records over the public
 * protocol types — so nothing here depends on undocumented behaviour.
 *
 * ## How drift is prevented
 *
 * Hand-writing descriptors risks three separate lists drifting apart: the Host
 * class, the marker list and these descriptors. So there is only one list.
 * `../remote-methods.ts` owns the method names; the Host installs its markers
 * from it and this file builds its descriptors from it. The spec table below is
 * typed as `Record<RemoteMethodName, …>`, which makes a missing method a
 * compile error rather than a button that fails when clicked.
 *
 * @module @domitor-syh/dsh-knowbase/client/contribution
 */

import type {
  InvocationDescriptor,
  TypertCodec,
  TypertRemoteContribution,
  TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { REMOTE_METHODS, type RemoteMethodName } from '../remote-methods.ts'

/** Package that owns these methods; also the descriptor id prefix. */
const PKG = '@domitor-syh/dsh-knowbase'
/** Cordis service key of `KnowbaseRemote`. */
const SERVICE = 'knowbase'

const knowledgeBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  materialCount: z.number(),
  chunkCount: z.number(),
  updatedAt: z.number(),
})

const materialSchema = z.object({
  id: z.string(),
  kbId: z.string(),
  title: z.string(),
  revision: z.number(),
  chunkCount: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const passageSchema = z.object({
  ordinal: z.number(),
  headingPath: z.string(),
  locator: z.string(),
  text: z.string(),
})

const searchHitSchema = z.object({
  kbName: z.string(),
  materialTitle: z.string(),
  locator: z.string(),
  text: z.string(),
})

const searchReportSchema = z.object({
  // `string`, not an enum: the Host owns the outcome vocabulary, and a client
  // that rejected an outcome it had not heard of would turn a new Host state
  // into a client-side crash.
  outcome: z.string(),
  passages: z.array(searchHitSchema),
  reason: z.string(),
  elapsedMs: z.number(),
})

const sessionScopeSchema = z.object({
  enabled: z.boolean(),
  all: z.boolean(),
  kbIds: z.array(z.string()),
})

const recycleBinSchema = z.object({
  bases: z.array(knowledgeBaseSchema),
  materials: z.array(materialSchema),
})

const duplicateSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  chunkCount: z.number(),
})

const backupPayloadSchema = z.object({
  fileName: z.string(),
  // The file's bytes travel as one string: the Host does not choose where a
  // backup lands, the page does, so there is nothing to gain from describing
  // the document twice.
  json: z.string(),
  bases: z.number(),
  materials: z.number(),
  bytes: z.number(),
})

const importResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('imported'),
    bases: z.number(),
    materials: z.number(),
    skippedMaterials: z.number(),
    reallocatedBases: z.number(),
    baseNames: z.array(z.string()),
  }),
  z.object({
    outcome: z.literal('rejected'),
    reason: z.string(),
  }),
])

const string = z.string()
const strings = z.array(z.string())
const boolean = z.boolean()

/** Wrap a schema as a strict boundary codec. */
function codec(typeSymbol: string, schema: z.ZodType): TypertCodec {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => schema as unknown as TypertSchema,
  }
}

/** One business parameter. */
interface ParameterSpec {
  readonly name: string
  readonly schema: z.ZodType
}

/** Parameters and result of one method. */
interface MethodSpec {
  readonly parameters: readonly ParameterSpec[]
  readonly result: z.ZodType
}

/**
 * Per-method schemas.
 *
 * Keyed by the shared method-name union, so an entry is required for every
 * method and cannot exist for a method that does not.
 */
const SPECS: Record<RemoteMethodName, MethodSpec> = {
  listKnowledgeBases: { parameters: [], result: z.array(knowledgeBaseSchema) },
  createKnowledgeBase: {
    parameters: [
      { name: 'name', schema: string },
      { name: 'description', schema: string },
    ],
    result: knowledgeBaseSchema,
  },
  renameKnowledgeBase: {
    parameters: [
      { name: 'id', schema: string },
      { name: 'name', schema: string },
    ],
    result: boolean,
  },
  deleteKnowledgeBase: { parameters: [{ name: 'id', schema: string }], result: boolean },
  listMaterials: {
    parameters: [{ name: 'kbId', schema: string }],
    result: z.array(materialSchema),
  },
  addTextMaterial: {
    parameters: [
      { name: 'kbId', schema: string },
      { name: 'title', schema: string },
      { name: 'text', schema: string },
      { name: 'allowDuplicate', schema: boolean },
    ],
    result: materialSchema,
  },
  findDuplicateMaterial: {
    parameters: [
      { name: 'kbId', schema: string },
      { name: 'text', schema: string },
    ],
    result: duplicateSchema.nullable(),
  },
  deleteMaterial: { parameters: [{ name: 'id', schema: string }], result: boolean },
  readMaterialChunks: {
    parameters: [{ name: 'id', schema: string }],
    result: z.array(passageSchema),
  },
  readMaterialText: {
    parameters: [{ name: 'id', schema: string }],
    result: string,
  },
  updateMaterialText: {
    parameters: [
      { name: 'id', schema: string },
      { name: 'text', schema: string },
    ],
    result: materialSchema,
  },
  updateDescription: {
    parameters: [
      { name: 'id', schema: string },
      { name: 'description', schema: string },
    ],
    result: boolean,
  },
  testSearch: {
    parameters: [
      { name: 'query', schema: string },
      { name: 'kbIds', schema: strings },
    ],
    result: searchReportSchema,
  },
  exportBackup: {
    // `''` means every live base; anything else exports that one.
    parameters: [{ name: 'kbId', schema: string }],
    result: backupPayloadSchema,
  },
  importBackup: {
    parameters: [{ name: 'json', schema: string }],
    result: importResultSchema,
  },
  getSessionScope: {
    parameters: [{ name: 'agentId', schema: string }],
    result: sessionScopeSchema,
  },
  setSessionScope: {
    parameters: [
      { name: 'agentId', schema: string },
      { name: 'enabled', schema: boolean },
      { name: 'all', schema: boolean },
      { name: 'kbIds', schema: strings },
    ],
    result: sessionScopeSchema,
  },
  listRecycleBin: { parameters: [], result: recycleBinSchema },
  restoreKnowledgeBase: { parameters: [{ name: 'id', schema: string }], result: boolean },
  restoreMaterial: { parameters: [{ name: 'id', schema: string }], result: boolean },
  purgeKnowledgeBase: { parameters: [{ name: 'id', schema: string }], result: boolean },
  purgeMaterial: { parameters: [{ name: 'id', schema: string }], result: boolean },
}

/** Build a unary (non-stream) invocation descriptor. */
function unary(method: string, spec: MethodSpec): InvocationDescriptor {
  const id = `${PKG}#${SERVICE}/${method}`
  return {
    id,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: spec.parameters.map(parameter => ({
      name: parameter.name,
      wire: parameter.name,
      source: 'json',
      codec: codec(`${id}:${parameter.name}`, parameter.schema),
    })),
    // The Host method's trailing `signal` parameter is transport cancellation,
    // not a business argument, so it never appears in the wire args.
    cancellation: { parameter: 'signal' },
    result: codec(`${id}:result`, spec.result),
  }
}

/** Every Remote method the browser may call. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: REMOTE_METHODS.map(method => unary(method, SPECS[method])),
}

/**
 * Typed client surface.
 *
 * The generated artifact declares the same thing; declaring it here is what
 * makes `ctx.remote.knowbase` type-check with real signatures instead of `any`.
 * `RemoteResult` unwrapping is the caller's job — see `./api.ts`.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6b6e6f7762617365 {
    listKnowledgeBases: () => Promise<unknown>
    createKnowledgeBase: (name: string, description: string) => Promise<unknown>
    renameKnowledgeBase: (id: string, name: string) => Promise<unknown>
    updateDescription: (id: string, description: string) => Promise<unknown>
    deleteKnowledgeBase: (id: string) => Promise<unknown>
    listMaterials: (kbId: string) => Promise<unknown>
    addTextMaterial: (
      kbId: string,
      title: string,
      text: string,
      allowDuplicate: boolean,
    ) => Promise<unknown>
    updateMaterialText: (id: string, text: string) => Promise<unknown>
    findDuplicateMaterial: (kbId: string, text: string) => Promise<unknown>
    deleteMaterial: (id: string) => Promise<unknown>
    readMaterialChunks: (id: string) => Promise<unknown>
    readMaterialText: (id: string) => Promise<unknown>
    testSearch: (query: string, kbIds: readonly string[]) => Promise<unknown>
    exportBackup: (kbId: string) => Promise<unknown>
    importBackup: (json: string) => Promise<unknown>
    getSessionScope: (agentId: string) => Promise<unknown>
    setSessionScope: (
      agentId: string,
      enabled: boolean,
      all: boolean,
      kbIds: readonly string[],
    ) => Promise<unknown>
    listRecycleBin: () => Promise<unknown>
    restoreKnowledgeBase: (id: string) => Promise<unknown>
    restoreMaterial: (id: string) => Promise<unknown>
    purgeKnowledgeBase: (id: string) => Promise<unknown>
    purgeMaterial: (id: string) => Promise<unknown>
  }

  interface TypertRemoteNamespaceMap {
    knowbase: TypertRemoteNamespace$6b6e6f7762617365
  }
}
