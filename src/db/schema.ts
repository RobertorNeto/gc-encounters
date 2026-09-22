export const STORES = {
  players: 'players',
  matches: 'matches',
  matchPlayers: 'matchPlayers',
  meta: 'meta',
} as const;

export const INDEXES = {
  players: { lastSeen: 'lastSeen', totalMatches: 'totalMatches' },
  matches: { playedAt: 'playedAt' },
  matchPlayers: { gcId: 'gcId', matchId: 'matchId' },
} as const;

export const META_KEY = 'meta' as const;
