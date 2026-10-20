// usda/commodity_costs_and_returns tables. Ported from openbb_government_us/usda/utils/ers_commodity_costs_and_returns.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const COMMODITY_FILES: Record<string, { media_id: number; slug: string; label: string }> = {
  corn: {
    media_id: 4962,
    slug: 'corn',
    label: 'Corn',
  },
  cotton: {
    media_id: 4964,
    slug: 'cotton',
    label: 'Cotton',
  },
  barley: {
    media_id: 4966,
    slug: 'barley',
    label: 'Barley',
  },
  peanuts: {
    media_id: 4968,
    slug: 'peanuts',
    label: 'Peanuts',
  },
  rice: {
    media_id: 4970,
    slug: 'rice',
    label: 'Rice',
  },
  sorghum: {
    media_id: 4972,
    slug: 'sorghum',
    label: 'Sorghum',
  },
  oats: {
    media_id: 4974,
    slug: 'oats',
    label: 'Oats',
  },
  soybeans: {
    media_id: 4976,
    slug: 'soybeans',
    label: 'Soybeans',
  },
  wheat: {
    media_id: 4978,
    slug: 'wheat',
    label: 'Wheat',
  },
  milk: {
    media_id: 4980,
    slug: 'milk',
    label: 'Milk',
  },
  cow_calf: {
    media_id: 4982,
    slug: 'cow-calf',
    label: 'Cow-calf',
  },
  hogs_all: {
    media_id: 4984,
    slug: 'hogs-all',
    label: 'Hogs (all enterprises)',
  },
  hogs_farrow_finish: {
    media_id: 4986,
    slug: 'hogs-farrow-finish',
    label: 'Hogs, farrow-to-finish',
  },
  hogs_farrow_feeder: {
    media_id: 4988,
    slug: 'hogs-farrow-feeder',
    label: 'Hogs, farrow-to-feeder',
  },
  hogs_feeder_finish: {
    media_id: 4990,
    slug: 'hogs-feeder-finish',
    label: 'Hogs, feeder-to-finish',
  },
  hogs_farrow_weanling: {
    media_id: 4992,
    slug: 'hogs-farrow-weanling',
    label: 'Hogs, farrow-to-weanling',
  },
  hogs_weanling_feeder: {
    media_id: 4994,
    slug: 'hogs-weanling-feeder',
    label: 'Hogs, weanling-to-feeder',
  },
}

export const COMMODITY_REGIONS: Record<string, string[]> = {
  corn: ['U.S. total', 'Eastern Uplands', 'Heartland', 'Northern Crescent', 'Northern Great Plains', 'Prairie Gateway', 'Southern Seaboard'],
  cotton: ['U.S. total', 'Eastern Uplands', 'Fruitful Rim', 'Heartland', 'Mississippi Portal', 'Prairie Gateway', 'Southern Seaboard'],
  barley: ['U.S. total', 'Basin and Range', 'Fruitful Rim', 'Heartland', 'Northern Crescent', 'Northern Great Plains'],
  peanuts: ['U.S. total', 'Fruitful Rim', 'Prairie Gateway', 'Southern Seaboard (AL, GA)', 'Southern Seaboard (VA, NC, SC)'],
  rice: ['U.S. total', 'Arkansas Non-Delta', 'California', 'Gulf Coast', 'Mississippi River Delta'],
  sorghum: ['U.S. total', 'Eastern Uplands', 'Fruitful Rim', 'Heartland', 'Mississippi Portal', 'Northern Great Plains', 'Prairie Gateway'],
  oats: ['U.S. total', 'Eastern Uplands', 'Heartland', 'Northern Crescent', 'Northern Great Plains', 'Prairie Gateway'],
  soybeans: ['U.S. total', 'Eastern Uplands', 'Heartland', 'Mississippi Portal', 'Northern Crescent', 'Northern Great Plains', 'Prairie Gateway', 'Southern Seaboard'],
  wheat: ['U.S. total', 'Basin and Range', 'Fruitful Rim', 'Heartland', 'Mississippi Portal', 'Northern Crescent', 'Northern Great Plains', 'Prairie Gateway', 'Southern Seaboard'],
  milk: ['U.S. total', 'Basin and Range', 'Eastern Uplands', 'Fruitful Rim', 'Heartland', 'Northern Crescent', 'Prairie Gateway', 'Southern Seaboard'],
  cow_calf: ['U.S. total', 'Basin and Range', 'Eastern Uplands', 'Fruitful Rim', 'Heartland', 'Mississippi Portal', 'Northern Great Plains', 'Prairie Gateway', 'Southern Seaboard'],
  hogs_all: ['U.S. total', 'Eastern Uplands', 'Heartland', 'Mississippi Portal', 'Northern Crescent', 'Northern Great Plains', 'Prairie Gateway', 'Southern Seaboard'],
  hogs_farrow_finish: ['U.S. total', 'Eastern Uplands', 'Heartland', 'Northern Crescent', 'Prairie Gateway', 'Southern Seaboard'],
  hogs_farrow_feeder: ['U.S. total', 'Eastern Uplands', 'Southern Seaboard'],
  hogs_feeder_finish: ['U.S. total', 'Eastern Uplands', 'Heartland', 'Northern Crescent', 'Southern Seaboard'],
  hogs_farrow_weanling: ['U.S. total'],
  hogs_weanling_feeder: ['U.S. total', 'Heartland', 'Southern Seaboard'],
}

export const CATEGORY_CHOICES: Record<string, string> = {
  gross_value_of_production: 'Gross value of production',
  operating_costs: 'Operating costs',
  net_value: 'Net value',
  allocated_overhead: 'Allocated overhead',
  costs_listed: 'Costs listed',
  supporting_information: 'Supporting information',
  production_practices: 'Production practices',
  size_of_operation: 'Size of operation',
  production_arrangement: 'Production arrangement',
}

export const CATEGORY_ORDER: Record<string, number> = {
  'Gross value of production': 0,
  'Operating costs': 1,
  'Net value': 2,
  'Allocated overhead': 3,
  'Costs listed': 4,
  'Size of operation': 5,
  'Production arrangement': 6,
  'Supporting information': 7,
  'Production practices': 8,
}
