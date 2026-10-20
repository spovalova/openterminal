import { defineProvider } from '../types.js'
import a from './part-a.js'
import b from './part-b.js'
import c from './part-c.js'
import g from './part-g.js'

// usda is ported in four parts (part-<x>.ts with cases.<x>.json): a yearbook and commodity tables, b food, nutrition and
// household tables, c farm economy, trade, international and FAS, g rural geography and legacy .xls workbooks.
const parts = [a, b, c, g]

export default defineProvider({
  name: 'usda',
  credentials: [],
  status: 'ported',
  routes: Object.assign({}, ...parts.map((p) => p.routes)),
  skipped: Object.assign({}, ...parts.map((p) => p.skipped ?? {})),
})
