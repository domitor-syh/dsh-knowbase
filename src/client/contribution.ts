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
  folderName: z.string(),
  materialCount: z.number(),
  indexedCount: z.number(),
  bytes: z.number(),
  updatedAt: z.number(),
})

const materialSchema = z.object({
  id: z.string(),
  kbId: z.string(),
  fileName: z.string(),
  title: z.string(),
  bytes: z.number(),
  extension: z.string(),
  indexed: z.boolean(),
  mtimeMs: z.number(),
  // Always present, `''` when there is nothing to explain — see `Material.note`.
  note: z.string(),
})

const passageSchema = z.object({
  ordinal: z.number(),
  headingPath: z.string(),
  locator: z.string(),
  text: z.string(),
})

const materialDetailSchema = materialSchema.extend({
  text: z.string(),
  chunks: z.array(passageSchema),
})

const searchHitSchema = z.object({
  kbName: z.string(),
  materialTitle: z.string(),
  locator: z.string(),
  text: z.string(),
  score: z.number(),
  coverage: z.number(),
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

// A file pushed from the browser. Bytes travel base64-encoded because the
// channel carries lossless JSON only (see `../remote.ts` and `HANDOFF.md` §15).
const uploadedFileSchema = z.object({
  name: z.string(),
  base64: z.string(),
})

const uploadResultSchema = z.object({
  added: z.number(),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
})

// The OCR language packs. `state` is a `string`, not an enum, for the same
// reason as the search outcome: a client that rejected a state it had not heard
// of would turn a future Host state into a client-side crash.
const ocrPackSchema = z.object({
  lang: z.string(),
  fileName: z.string(),
  url: z.string(),
  gzipBytes: z.number(),
  present: z.boolean(),
  bytes: z.number(),
})

const ocrStatusSchema = z.object({
  ready: z.boolean(),
  dir: z.string(),
  packs: z.array(ocrPackSchema),
  downloadedBytes: z.number(),
  fetchBytes: z.number(),
  missing: z.array(z.string()),
})

const ocrDownloadSchema = z.object({
  state: z.string(),
  downloadedBytes: z.number(),
  totalBytes: z.number(),
  lang: z.string(),
  message: z.string(),
})

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
  updateDescription: {
    parameters: [
      { name: 'id', schema: string },
      { name: 'description', schema: string },
    ],
    result: boolean,
  },
  deleteKnowledgeBase: { parameters: [{ name: 'id', schema: string }], result: boolean },
  listMaterials: {
    parameters: [{ name: 'kbId', schema: string }],
    result: z.array(materialSchema),
  },
  addFiles: {
    parameters: [
      { name: 'kbId', schema: string },
      { name: 'files', schema: z.array(uploadedFileSchema) },
    ],
    result: uploadResultSchema,
  },
  readMaterial: {
    parameters: [
      { name: 'kbId', schema: string },
      { name: 'id', schema: string },
    ],
    result: materialDetailSchema.nullable(),
  },
  readMaterialBytes: {
    // The result is the file's bytes as one base64 string, or `''` when the
    // file is gone or too large to pull into the page.
    parameters: [
      { name: 'kbId', schema: string },
      { name: 'id', schema: string },
    ],
    result: string,
  },
  deleteMaterial: {
    parameters: [
      { name: 'kbId', schema: string },
      { name: 'id', schema: string },
    ],
    result: boolean,
  },
  rescan: {
    // `''` rescans every base; anything else rescans that one.
    parameters: [{ name: 'kbId', schema: string }],
    result: boolean,
  },
  getVaultRoot: { parameters: [], result: string },
  getOcrStatus: { parameters: [], result: ocrStatusSchema },
  startOcrDownload: { parameters: [], result: ocrDownloadSchema },
  cancelOcrDownload: { parameters: [], result: ocrDownloadSchema },
  getOcrDownload: { parameters: [], result: ocrDownloadSchema },
  testSearch: {
    parameters: [
      { name: 'query', schema: string },
      { name: 'kbIds', schema: strings },
    ],
    result: searchReportSchema,
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
    addFiles: (
      kbId: string,
      files: readonly { readonly name: string; readonly base64: string }[],
    ) => Promise<unknown>
    readMaterial: (kbId: string, id: string) => Promise<unknown>
    readMaterialBytes: (kbId: string, id: string) => Promise<unknown>
    deleteMaterial: (kbId: string, id: string) => Promise<unknown>
    rescan: (kbId: string) => Promise<unknown>
    getVaultRoot: () => Promise<unknown>
    getOcrStatus: () => Promise<unknown>
    startOcrDownload: () => Promise<unknown>
    cancelOcrDownload: () => Promise<unknown>
    getOcrDownload: () => Promise<unknown>
    testSearch: (query: string, kbIds: readonly string[]) => Promise<unknown>
    getSessionScope: (agentId: string) => Promise<unknown>
    setSessionScope: (
      agentId: string,
      enabled: boolean,
      all: boolean,
      kbIds: readonly string[],
    ) => Promise<unknown>
  }

  interface TypertRemoteNamespaceMap {
    knowbase: TypertRemoteNamespace$6b6e6f7762617365
  }
}
