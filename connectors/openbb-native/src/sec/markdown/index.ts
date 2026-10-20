import type { ProviderPart } from '../../types.js'
import { managementDiscussionAnalysis } from './management-discussion-analysis.js'
import { secRssLitigation } from './rss-litigation.js'

// sec, markdown part: see ../index.ts for which routes belong here.
export default {
  routes: {
    'sec/rss_litigation': secRssLitigation,
    'equity/fundamental/management_discussion_analysis': managementDiscussionAnalysis,
  },
  skipped: {},
} satisfies ProviderPart
