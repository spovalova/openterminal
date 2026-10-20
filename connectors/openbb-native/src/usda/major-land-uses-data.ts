// usda/major_land_uses tables. Ported from openbb_government_us/usda/utils/ers_major_land_uses.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const MAJOR_LAND_USES_FILES: Record<string, { media_path: string; format: string }> = {
  land_use: {
    media_path: '/media/5639/all-data-in-csv-comma-separated-values-format.csv',
    format: 'csv',
  },
  cropland_used_for_crops: {
    media_path: '/media/5647/summary-table-3-total-cropland-used-for-crops-cropland-harvested-including-double-cropped-crop-failure-and-cultivated-summer-fallow-for-the-united-states-annual-1910-2025.xlsx',
    format: 'xlsx',
  },
}

export const LAND_USE_CATEGORIES: Record<string, string> = {
  cropland_idled: 'Cropland idled',
  cropland_used_for_crops: 'Cropland used for crops',
  cropland_used_for_pasture: 'Cropland used for pasture',
  defense_and_industrial: 'Land in defense and industrial areas',
  farmsteads_roads_and_miscellaneous_farmland: 'Farmsteads, roads, and miscellaneous farmland',
  forest_use_land: 'Forest-use land (all)',
  grassland_pasture_and_range: 'Grassland pasture and range',
  grazed_forest_use_land: 'Grazed forest-use land grazed',
  miscellaneous_other_land: 'Miscellaneous other land',
  rural_parks_and_wildlife: 'Land in rural parks and wildlife areas',
  rural_transportation: 'Land in rural transportation facilities',
  special_uses: 'All special uses of land',
  total_cropland: 'Total cropland',
  total_land: 'Total land',
  ungrazed_forest_use_land: 'Ungrazed forest-use land',
  urban_areas: 'Land in urban areas',
}

export const GEOGRAPHIES: string[] = ['48 States', 'Alabama', 'Alaska', 'Appalachian', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Corn Belt', 'Delaware', 'Delta States', 'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Lake States', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Mountain', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Northeast', 'Northern Plains', 'Ohio', 'Oklahoma', 'Oregon', 'Pacific', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Southeast', 'Southern Plains', 'Tennessee', 'Texas', 'U.S. total', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming']

export const CROPLAND_VARIABLES: string[] = ['total_crops_harvested', 'double_cropped', 'cropland_harvested', 'crop_failure', 'cultivated_summer_fallow', 'total_cropland_used_for_crops']
