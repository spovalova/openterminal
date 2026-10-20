import type { ProviderPart } from '../../types.js'
import { secSchemaFiles } from './schema-files.js'

// sec, taxonomy part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'sec/schema_files': secSchemaFiles,
  },
  skipped: {},
} satisfies ProviderPart
