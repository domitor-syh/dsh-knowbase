/**
 * Typed client API over the Remote channel.
 *
 * The UI talks to this and never to the transport. That boundary is deliberate:
 * the transport started as the only option available and may change again, and
 * keeping every call site behind these signatures means a change is one file
 * rather than every component.
 *
 * `RemoteResult` is unwrapped here too. A failed call is a rejected promise at
 * this boundary, so components handle one failure shape instead of two.
 *
 * @module @domitor-syh/dsh-knowbase/client/api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  KnowledgeBaseView,
  MaterialDetailView,
  MaterialView,
  SearchReportView,
  SessionScopeView,
  UploadResultView,
} from '../remote.ts'

/** A Remote call that failed on the Host. */
export class KnowbaseRemoteError extends Error {
  readonly failure: RemoteFailure

  constructor(failure: RemoteFailure) {
    super(typeof failure === 'object' && failure !== null && 'message' in failure
      ? String((failure as { message: unknown }).message)
      : '知识库操作失败')
    this.name = 'KnowbaseRemoteError'
    this.failure = failure
  }
}

/** A file the page is pushing into a base. */
export interface UploadFile {
  readonly name: string
  /** Raw bytes; the API encodes them to base64 for the wire. */
  readonly bytes: Uint8Array
}

/** Everything the settings page, the reader and the composer toggle need. */
export interface KnowbaseApi {
  listKnowledgeBases(): Promise<readonly KnowledgeBaseView[]>
  createKnowledgeBase(name: string, description: string): Promise<KnowledgeBaseView>
  renameKnowledgeBase(id: string, name: string): Promise<boolean>
  updateDescription(id: string, description: string): Promise<boolean>
  deleteKnowledgeBase(id: string): Promise<boolean>

  listMaterials(kbId: string): Promise<readonly MaterialView[]>
  addFiles(kbId: string, files: readonly UploadFile[]): Promise<UploadResultView>
  readMaterial(kbId: string, id: string): Promise<MaterialDetailView | null>
  /** A file's bytes, decoded from the wire's base64; `undefined` when unavailable. */
  readMaterialBytes(kbId: string, id: string): Promise<Uint8Array | undefined>
  deleteMaterial(kbId: string, id: string): Promise<boolean>

  /** `kbId` of `''` rescans every base. */
  rescan(kbId: string): Promise<boolean>
  getVaultRoot(): Promise<string>

  testSearch(query: string, kbIds: readonly string[]): Promise<SearchReportView>

  getSessionScope(agentId: string): Promise<SessionScopeView>
  setSessionScope(
    agentId: string,
    enabled: boolean,
    all: boolean,
    kbIds: readonly string[],
  ): Promise<SessionScopeView>
}

/** Unwrap a Remote result, turning a Host-side failure into a rejection. */
async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new KnowbaseRemoteError(result.error)
  return result.value
}

/**
 * The wire namespace as declared in `./contribution.ts`.
 *
 * Narrowed from `unknown` to the real result types in one place, so the casts
 * below are the only unchecked step in the client half.
 */
interface KnowbaseWire {
  listKnowledgeBases: () => Promise<RemoteResult<readonly KnowledgeBaseView[]>>
  createKnowledgeBase: (
    name: string,
    description: string,
  ) => Promise<RemoteResult<KnowledgeBaseView>>
  renameKnowledgeBase: (id: string, name: string) => Promise<RemoteResult<boolean>>
  updateDescription: (id: string, description: string) => Promise<RemoteResult<boolean>>
  deleteKnowledgeBase: (id: string) => Promise<RemoteResult<boolean>>
  listMaterials: (kbId: string) => Promise<RemoteResult<readonly MaterialView[]>>
  addFiles: (
    kbId: string,
    files: readonly { readonly name: string; readonly base64: string }[],
  ) => Promise<RemoteResult<UploadResultView>>
  readMaterial: (kbId: string, id: string) => Promise<RemoteResult<MaterialDetailView | null>>
  readMaterialBytes: (kbId: string, id: string) => Promise<RemoteResult<string>>
  deleteMaterial: (kbId: string, id: string) => Promise<RemoteResult<boolean>>
  rescan: (kbId: string) => Promise<RemoteResult<boolean>>
  getVaultRoot: () => Promise<RemoteResult<string>>
  testSearch: (query: string, kbIds: readonly string[]) => Promise<RemoteResult<SearchReportView>>
  getSessionScope: (agentId: string) => Promise<RemoteResult<SessionScopeView>>
  setSessionScope: (
    agentId: string,
    enabled: boolean,
    all: boolean,
    kbIds: readonly string[],
  ) => Promise<RemoteResult<SessionScopeView>>
}

/**
 * The API once the Remote channel is mounted.
 *
 * Held here rather than in the plugin entry so the page and the entry can both
 * import it without a cycle. The slot registration hands React a component
 * rather than props, so there is nowhere to thread this through; it is set
 * before the section is registered, so the page never observes it unset.
 */
let mounted: KnowbaseApi | undefined

/** Publish the API once the channel is mounted. */
export function setKnowbaseApi(next: KnowbaseApi | undefined): void {
  mounted = next
}

/** The mounted API, or `undefined` before the channel is ready. */
export function knowbaseApi(): KnowbaseApi | undefined {
  return mounted
}

/**
 * Why the channel is not ready, when that is a failure rather than a wait.
 *
 * Surfaced in the page rather than only the console: a settings page whose
 * buttons silently do nothing is the hardest kind of bug to report, and the
 * person looking at it should not have to open developer tools to find out why.
 */
let channelError: string | undefined

/** Record why mounting failed. */
export function setChannelError(message: string | undefined): void {
  channelError = message
}

/** The mounting failure, or `undefined` when the channel is fine or pending. */
export function knowbaseChannelError(): string | undefined {
  return channelError
}

/** Encode bytes as base64 for the wire, in chunks small enough to not blow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/** Decode the wire's base64 back to bytes; `undefined` for the empty string. */
function fromBase64(value: string): Uint8Array | undefined {
  if (value === '') return undefined
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return undefined
  }
}

/** Build the typed API over a mounted client context. */
export function createKnowbaseApi(ctx: Context): KnowbaseApi {
  const wire = (ctx.remote as unknown as { knowbase: KnowbaseWire }).knowbase

  return {
    listKnowledgeBases: () => unwrap(wire.listKnowledgeBases()),
    createKnowledgeBase: (name, description) => unwrap(wire.createKnowledgeBase(name, description)),
    renameKnowledgeBase: (id, name) => unwrap(wire.renameKnowledgeBase(id, name)),
    updateDescription: (id, description) => unwrap(wire.updateDescription(id, description)),
    deleteKnowledgeBase: id => unwrap(wire.deleteKnowledgeBase(id)),
    listMaterials: kbId => unwrap(wire.listMaterials(kbId)),
    addFiles: (kbId, files) =>
      unwrap(wire.addFiles(kbId, files.map(file => ({ name: file.name, base64: toBase64(file.bytes) })))),
    readMaterial: (kbId, id) => unwrap(wire.readMaterial(kbId, id)),
    readMaterialBytes: async (kbId, id) => fromBase64(await unwrap(wire.readMaterialBytes(kbId, id))),
    deleteMaterial: (kbId, id) => unwrap(wire.deleteMaterial(kbId, id)),
    rescan: kbId => unwrap(wire.rescan(kbId)),
    getVaultRoot: () => unwrap(wire.getVaultRoot()),
    testSearch: (query, kbIds) => unwrap(wire.testSearch(query, kbIds)),
    getSessionScope: agentId => unwrap(wire.getSessionScope(agentId)),
    setSessionScope: (agentId, enabled, all, kbIds) =>
      unwrap(wire.setSessionScope(agentId, enabled, all, kbIds)),
  }
}
