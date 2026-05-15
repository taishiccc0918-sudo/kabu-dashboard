import { JudgmentSettings } from './types'

// 注: ROE/opMgn/nySalesGr/perFChg1m は小数単位（0.1 = 10%）
//     perF/pbr は倍数単位そのまま（15 = 15倍）
export const DEFAULT_LOGICS: JudgmentSettings = {
  activeLogicId: 'default',
  logics: [
    {
      id: 'default',
      name: 'マイロジック',
      groups: [
        {
          id: 'g1',
          name: '割安株',
          conditions: [
            { metric: 'perF', operator: '<',  threshold: 15 },
            { metric: 'pbr',  operator: '<',  threshold: 1.5 },
            { metric: 'roe',  operator: '>',  threshold: 0.08 },
          ],
        },
        {
          id: 'g2',
          name: 'グロース株',
          conditions: [
            { metric: 'nySalesGr', operator: '>', threshold: 0.15 },
            { metric: 'opMgn',     operator: '>', threshold: 0.15 },
          ],
        },
        {
          id: 'g3',
          name: '押し目',
          conditions: [
            { metric: 'perFChg1m', operator: '<=', threshold: -0.05 },
          ],
        },
      ],
    },
  ],
}
