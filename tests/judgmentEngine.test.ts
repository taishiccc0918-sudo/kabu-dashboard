import { describe, it, expect } from 'vitest'
import { evaluateRange, evaluateLogic, formatLogicDescription } from '../app/lib/judgmentEngine'
import { DEFAULT_LOGICS } from '../app/lib/defaultLogics'
import type { StockRow, JudgmentLogic, MetricRange } from '../app/lib/types'

function makeRow(overrides: Partial<StockRow> = {}): StockRow {
  return {
    code: '0000',
    name: 'TEST',
    market: 'プライム市場',
    genres: [],
    close: 1000,
    chg1d: 0, chg1w: 0, chg1m: 0, chg3m: 0, chg1y: 0,
    mcap: 1000,
    perA: 12, perF: 10,
    perFChg1m: 0, perFChg1mPrev: 0,
    pbr: 1.0,
    roe: 0.10,
    divY: 0.03,
    epsCurGr: 0.10,
    peg: 1.0,
    opMgn: 0.15,
    nySalesGr: 0.05,
    judgment: '',
    ...overrides,
  }
}

describe('evaluateRange', () => {
  it('値がmin/max範囲内ならtrue', () => {
    expect(evaluateRange(makeRow({ perF: 10 }), { metric: 'perF', min: 5, max: 15 })).toBe(true)
  })

  it('上限境界（max=15, value=15）はtrue', () => {
    expect(evaluateRange(makeRow({ perF: 15 }), { metric: 'perF', min: null, max: 15 })).toBe(true)
  })

  it('上限超え（max=15, value=15.01）はfalse', () => {
    expect(evaluateRange(makeRow({ perF: 15.01 }), { metric: 'perF', min: null, max: 15 })).toBe(false)
  })

  it('下限境界（min=0.08, value=0.08）はtrue', () => {
    expect(evaluateRange(makeRow({ roe: 0.08 }), { metric: 'roe', min: 0.08, max: null })).toBe(true)
  })

  it('下限未満（min=0.08, value=0.0799）はfalse', () => {
    expect(evaluateRange(makeRow({ roe: 0.0799 }), { metric: 'roe', min: 0.08, max: null })).toBe(false)
  })

  it('値がnullならfalse（FEPS空欄→perF=null相当）', () => {
    expect(evaluateRange(makeRow({ perF: null }), { metric: 'perF', min: null, max: 15 })).toBe(false)
  })

  it('値が数値以外ならfalse', () => {
    const row = makeRow()
    ;(row as any).perF = 'NaN'
    expect(evaluateRange(row, { metric: 'perF', min: null, max: 15 })).toBe(false)
  })

  it('存在しないmetricキーはfalse（安全側）', () => {
    expect(evaluateRange(makeRow(), { metric: 'nonexistent', min: null, max: 100 })).toBe(false)
  })
})

describe('evaluateLogic（買い／様子見／見送り相当）', () => {
  const standard: JudgmentLogic = DEFAULT_LOGICS.logics[0] // perF≤15, pbr≤1.5, roe≥0.08

  it('全条件一致 → 買い判定（ロジック名を返す）', () => {
    const row = makeRow({ perF: 12, pbr: 1.2, roe: 0.10 })
    expect(evaluateLogic(row, standard)).toBe('標準割安')
  })

  it('1条件外れる（roe不足）→ 様子見/見送り（null）', () => {
    const row = makeRow({ perF: 12, pbr: 1.2, roe: 0.05 })
    expect(evaluateLogic(row, standard)).toBeNull()
  })

  it('PEG異常値（負・極大）でも該当ロジックに含まれない限り判定は影響なし', () => {
    const row = makeRow({ perF: 12, pbr: 1.2, roe: 0.10, peg: -50 })
    expect(evaluateLogic(row, standard)).toBe('標準割安')
  })

  it('PEG異常値を判定に含めるロジック（PEG 0〜2）でPEG=-1は外れる', () => {
    const pegLogic: JudgmentLogic = {
      id: 'peg', name: 'PEG妥当',
      ranges: [{ metric: 'peg', min: 0, max: 2 }],
    }
    expect(evaluateLogic(makeRow({ peg: -1 }), pegLogic)).toBeNull()
    expect(evaluateLogic(makeRow({ peg: 100 }), pegLogic)).toBeNull()
    expect(evaluateLogic(makeRow({ peg: 1.0 }), pegLogic)).toBe('PEG妥当')
  })

  it('FEPS空欄相当（perF=null）の場合、perF条件があるロジックは必ずnull', () => {
    const row = makeRow({ perF: null, pbr: 1.0, roe: 0.10 })
    expect(evaluateLogic(row, standard)).toBeNull()
  })

  it('PER変化率の境界（perFChg1m ≤ -0.05 = 買いシグナル相当）', () => {
    const dropLogic: JudgmentLogic = {
      id: 'drop', name: '急落',
      ranges: [{ metric: 'perFChg1m', min: null, max: -0.05 }],
    }
    expect(evaluateLogic(makeRow({ perFChg1m: -0.05 }), dropLogic)).toBe('急落') // 境界含む
    expect(evaluateLogic(makeRow({ perFChg1m: -0.0499 }), dropLogic)).toBeNull()
    expect(evaluateLogic(makeRow({ perFChg1m: null }), dropLogic)).toBeNull()
  })

  it('ranges空配列はnull（条件なし→誤って全件buy防止）', () => {
    expect(evaluateLogic(makeRow(), { id: 'x', name: 'empty', ranges: [] })).toBeNull()
  })
})

describe('formatLogicDescription', () => {
  it('標準割安の説明文を生成', () => {
    const desc = formatLogicDescription(DEFAULT_LOGICS.logics[0])
    expect(desc).toContain('標準割安')
    expect(desc).toContain('PER今期')
    expect(desc).toContain('PBR')
    expect(desc).toContain('ROE')
    // ROEはisPercent=trueなので 0.08 → 8%
    expect(desc).toContain('8%')
  })

  it('未知metricは無視される', () => {
    const logic: JudgmentLogic = {
      id: 'x', name: 'x',
      ranges: [{ metric: 'nonexistent', min: 0, max: 1 }],
    }
    const desc = formatLogicDescription(logic)
    expect(desc).toBe('x: ')
  })
})
