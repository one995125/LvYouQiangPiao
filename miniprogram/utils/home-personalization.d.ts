import { FavoriteItem, FootprintItem, Scenic } from '../types/index'

export const HOME_RECENT_LIMIT: number
export const HOME_RECOMMENDATION_LIMIT: number

export function selectRecentFootprints(footprints: FootprintItem[], limit?: number): FootprintItem[]
export function recommendLoadedScenics(
  loadedScenics: Scenic[],
  favorites: FavoriteItem[],
  footprints: FootprintItem[],
  limit?: number,
): Scenic[]
