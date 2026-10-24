import { measureQuality } from '../tests/fixtures/retrieval-quality.ts'

console.log(JSON.stringify(await measureQuality(), null, 2))
