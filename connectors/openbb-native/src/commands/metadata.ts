// The metadata commands (EIA datasets and facets, IMF and OECD dataflows and tables) and news/rss.
import { datasets as eiaDatasets, facetOptions as eiaFacetOptions } from '../eia/metadata.js'
import { getDataflowDimensions as imfGetDataflowDimensions, listDataflows as imfListDataflows, listTables as imfListTables } from '../imf/dataflows.js'
import { getDataflowParameters as oecdGetDataflowParameters, getTableDetail as oecdGetTableDetail, listDataflows as oecdListDataflows, listTables as oecdListTables, listTopics as oecdListTopics } from '../oecd/dataflows.js'
import type { ProviderPart } from '../types.js'
import { rss as newsRss } from './news/rss.js'

export const metadataCommands: ProviderPart = {
  routes: {
    'eia/datasets': eiaDatasets,
    'eia/facet_options': eiaFacetOptions,
    'imf/get_dataflow_dimensions': imfGetDataflowDimensions,
    'imf/list_dataflows': imfListDataflows,
    'imf/list_tables': imfListTables,
    'oecd/get_dataflow_parameters': oecdGetDataflowParameters,
    'oecd/get_table_detail': oecdGetTableDetail,
    'oecd/list_dataflows': oecdListDataflows,
    'oecd/list_tables': oecdListTables,
    'oecd/list_topics': oecdListTopics,
    'news/rss': newsRss,
  },
}
