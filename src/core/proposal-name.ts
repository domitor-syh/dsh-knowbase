import path from 'node:path'
import { extensionOf, TEXT_EXTENSIONS } from './model.ts'

/** Proposal filenames are deliberately one safe text segment in the first release. */
export function isSafeTextProposalName(fileName: string): boolean {
  return fileName.length > 0 && fileName.length <= 120 &&
    path.basename(fileName) === fileName &&
    !fileName.includes('..') && !/[<>:"/\\|?*\u0000-\u001f]/u.test(fileName) &&
    !/[. ]$/u.test(fileName) && TEXT_EXTENSIONS.has(extensionOf(fileName))
}
