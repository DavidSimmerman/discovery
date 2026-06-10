// Stock sampler knobs. Lives outside $lib/server because the settings UI needs
// it too (the Weighting tab's "Reset"); the server config module re-exports it.

import type { SamplerConfig } from '$lib/server/shuffle/sampler';

export const DEFAULT_SAMPLER_CONFIG: SamplerConfig = {
  mix: { ratedPct: 100, unratedPct: 0 },
  tierWeights: { '1': 0, '2': 10, '3': 30, '4': 70, '5': 100, unrated: 20 },
  filters: {},
  gates: {
    cooldownCount: { enabled: true, n: 50 },
    cooldownTime: { enabled: true, hours: 6 },
    dailyCap: { enabled: false, max: 2 },
  },
  recency: {
    '5': { curve: 'log', halfLifePicks: 80 },
    '4': { curve: 'exp', halfLifePicks: 40 },
    '3': { curve: 'linear', halfLifePicks: 20 },
    '2': { curve: 'linear', halfLifePicks: 10 },
    '1': { curve: 'linear', halfLifePicks: 5 },
    unrated: { curve: 'linear', halfLifePicks: 20 },
  },
};
