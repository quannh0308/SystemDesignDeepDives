/** Config matrix (lld.md §7): every knob defined once, reaches code via env. */
export const CONFIG = {
  CITY_BBOX: '52.35,13.20,52.60,13.55', // Berlin: latMin,lngMin,latMax,lngMax
  STALE_DRIVER_S: '30',
  FARE_TTL_S: '300',
  SEARCH_RADIUS_KM: '5',
  CANDIDATE_LIMIT: '10',
  LOCK_TTL_MS: '10000',
  MATCH_BUDGET_S: '60',
} as const;
