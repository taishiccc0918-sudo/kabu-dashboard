import { JudgmentSettings } from './types'

// ROE は小数単位（0.08 = 8%）、perF/pbr は倍数そのまま
export const DEFAULT_LOGICS: JudgmentSettings = {
  activeLogicId: 'default',
  logics: [{
    id: 'default',
    name: '標準割安',
    ranges: [
      { metric: 'perF', min: null, max: 15 },
      { metric: 'pbr',  min: null, max: 1.5 },
      { metric: 'roe',  min: 0.08, max: null },
    ],
  }],
}
