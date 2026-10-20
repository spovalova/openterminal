import type { ProviderPart } from '../../types.js'
import atlanta from './atlanta/index.js'
import cleveland from './cleveland/index.js'
import dallas from './dallas/index.js'
import kc from './kc/index.js'
import minneapolis from './minneapolis/index.js'
import philadelphia from './philadelphia/index.js'
import richmond from './richmond/index.js'
import sf from './sf/index.js'

// federal_reserve, regional part: see ../index.ts for which routes belong here. One module per Reserve Bank.
const banks: ProviderPart[] = [atlanta, cleveland, dallas, kc, minneapolis, philadelphia, richmond, sf]

export default {
  routes: Object.assign({}, ...banks.map((b) => b.routes)),
  skipped: Object.assign({}, ...banks.map((b) => b.skipped ?? {})),
} satisfies ProviderPart
