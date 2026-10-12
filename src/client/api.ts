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
  MaterialView,
  PassageView,
  SearchReportView,
  SessionScopeView,
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

/** Everything the settings page and the composer toggle need. */
export interface KnowbaseApi {
  listKnowledgeBases(): Promise<readonly KnowledgeBaseView[]>
  createKnowledgeBase(name: string, description: string): Promise<KnowledgeBaseView>
  renameKnowledgeBase(id: string, name: string): Promise<boolean>
  deleteKnowledgeBase(id: string): Promise<boolean>

  listMaterials(kbId: string): Promise<readonly MaterialView[]>
  addTextMaterial(kbId: string, title: string, text: string): Promise<MaterialView>
  deleteMaterial(id: string): Promise<boolean>
  readMaterialChunks(id: string): Promise<readonly PassageView[]>

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
  deleteKnowledgeBase: (id: string) => Promise<RemoteResult<boolean>>
  listMaterials: (kbId: string) => Promise<RemoteResult<readonly MaterialView[]>>
  addTextMaterial: (
    kbId: string,
    title: string,
    text: string,
  ) => Promise<RemoteResult<MaterialView>>
  deleteMaterial: (id: string) => Promise<RemoteResult<boolean>>
  readMaterialChunks: (id: string) => Promise<RemoteResult<readonly PassageView[]>>
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

/** Build the typed API over a mounted client context. */
export function createKnowbaseApi(ctx: Context): KnowbaseApi {
  const wire = (ctx.remote as unknown as { knowbase: KnowbaseWire }).knowbase

  return {
    listKnowledgeBases: () => unwrap(wire.listKnowledgeBases()),
    createKnowledgeBase: (name, description) => unwrap(wire.createKnowledgeBase(name, description)),
    renameKnowledgeBase: (id, name) => unwrap(wire.renameKnowledgeBase(id, name)),
    deleteKnowledgeBase: id => unwrap(wire.deleteKnowledgeBase(id)),
    listMaterials: kbId => unwrap(wire.listMaterials(kbId)),
    addTextMaterial: (kbId, title, text) => unwrap(wire.addTextMaterial(kbId, title, text)),
    deleteMaterial: id => unwrap(wire.deleteMaterial(id)),
    readMaterialChunks: id => unwrap(wire.readMaterialChunks(id)),
    testSearch: (query, kbIds) => unwrap(wire.testSearch(query, kbIds)),
    getSessionScope: agentId => unwrap(wire.getSessionScope(agentId)),
    setSessionScope: (agentId, enabled, all, kbIds) =>
      unwrap(wire.setSessionScope(agentId, enabled, all, kbIds)),
  }
}
