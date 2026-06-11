import { describe, it, expect } from 'vitest'
import { mergeStates, defaultStatus, effectiveStatus, StockState, STATUS_LABEL, STATUS_OPTIONS } from '../app/lib/states'

function state(overrides: Partial<StockState> = {}): StockState {
  return {
    code: '7203', status: 'watching', targetPrice: null, buyReason: '',
    statusChangedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('defaultStatus / effectiveStatus', () => {
  it('未設定は ★=ウォッチ中 / ♥=買いたい', () => {
    expect(defaultStatus(false)).toBe('watching')
    expect(defaultStatus(true)).toBe('want_to_buy')
    expect(effectiveStatus(null, false)).toBe('watching')
    expect(effectiveStatus(null, true)).toBe('want_to_buy')
  })
  it('明示設定があればそちらを優先', () => {
    expect(effectiveStatus(state({ status: 'holding' }), true)).toBe('holding')
  })
})

describe('mergeStates', () => {
  it('updated_at が新しい方を採用する', () => {
    const local = { '7203': state({ status: 'holding', updatedAt: '2026-06-11T00:00:00.000Z' }) }
    const cloud = { '7203': state({ status: 'watching', updatedAt: '2026-06-01T00:00:00.000Z' }) }
    expect(mergeStates(local, cloud)['7203'].status).toBe('holding')
    expect(mergeStates(cloud, local)['7203'].status).toBe('holding')
  })
  it('片方にしかない銘柄は両方残る', () => {
    const local = { '7203': state() }
    const cloud = { '8306': state({ code: '8306', status: 'sold' }) }
    const merged = mergeStates(local, cloud)
    expect(Object.keys(merged).sort()).toEqual(['7203', '8306'])
  })
  it('同時刻はローカル優先', () => {
    const t = '2026-06-11T00:00:00.000Z'
    const local = { '7203': state({ status: 'sold', updatedAt: t }) }
    const cloud = { '7203': state({ status: 'watching', updatedAt: t }) }
    expect(mergeStates(local, cloud)['7203'].status).toBe('sold')
  })
})

describe('STATUS_OPTIONS / STATUS_LABEL', () => {
  it('UIに出す5ステータスにラベルがある', () => {
    expect(STATUS_OPTIONS).toHaveLength(5)
    for (const s of STATUS_OPTIONS) expect(STATUS_LABEL[s]).toBeTruthy()
  })
})
