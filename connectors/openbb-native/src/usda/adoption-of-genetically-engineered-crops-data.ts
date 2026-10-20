// usda/adoption_of_genetically_engineered_crops tables. Ported from openbb_government_us/usda/utils/ers_adoption_of_genetically_engineered_crops_in_the_united_states.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const CROPS: Record<string, { label: string; sheet: string; traits: string[] }> = {
  corn: {
    label: 'Corn',
    sheet: 'Corn',
    traits: ['Bt only', 'HT only', 'Stacked', 'All GE'],
  },
  cotton: {
    label: 'Upland cotton',
    sheet: 'Cotton',
    traits: ['Bt only', 'HT only', 'Stacked', 'All GE'],
  },
  soybeans: {
    label: 'Soybeans',
    sheet: 'Soybeans',
    traits: ['HT only', 'All GE'],
  },
}

export const TRAIT_PREFIXES: [string, string][] = [
  ['insect-resistant (bt) only', 'Bt only'],
  ['herbicide-tolerant (ht) only', 'HT only'],
  ['stacked gene varieties', 'Stacked'],
  ['all ge varieties', 'All GE'],
]

export const CROP_STATES: Record<string, string[]> = {
  corn: ['Illinois', 'Indiana', 'Iowa', 'Kansas', 'Michigan', 'Minnesota', 'Missouri', 'Nebraska', 'North Dakota', 'Ohio', 'South Dakota', 'Texas', 'Wisconsin', 'Other States', 'United States'],
  cotton: ['Alabama', 'Arkansas', 'California', 'Georgia', 'Louisiana', 'Mississippi', 'Missouri', 'North Carolina', 'Tennessee', 'Texas', 'Other States', 'United States'],
  soybeans: ['Arkansas', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Nebraska', 'North Dakota', 'Ohio', 'South Dakota', 'Wisconsin', 'Other States', 'United States'],
}

export const STATES_ALL: string[] = ['Alabama', 'Arkansas', 'California', 'Georgia', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Louisiana', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Nebraska', 'North Carolina', 'North Dakota', 'Ohio', 'Other States', 'South Dakota', 'Tennessee', 'Texas', 'United States', 'Wisconsin']
