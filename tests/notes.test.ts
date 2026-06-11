import { describe, it, expect } from 'vitest'
import { mergeNotes, legacyMemoToNote, buildSnapshot, sortNotesDesc, StockNote } from '../app/lib/notes'
import type { StockRow } from '../app/lib/types'

function note(overrides: Partial<StockNote> = {}): StockNote {
  return {
    id: 'id1', code: '7203', market: 'jp', kind: 'note', body: 'テスト',
    snapshot: {}, meta: {}, createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function row(overrides: Partial<StockRow> = {}): StockRow {
  return {
    code: '7203', name: 'トヨタ', market: 'プライム市場', genres: [],
    close: 1840, chg1d: 0, chg1w: 0, chg1m: 0, chg3m: 0, chg1y: 0,
    mcap: 30000, perA: 13, perF: 12.3, perFChg1m: 0, perFChg1mPrev: 0,
    pbr: 1.1, roe: 0.1, divY: 0.032, epsCurGr: 0.05, peg: 1.0,
    opMgn: 0.1, nySalesGr: 0.05, judgment: '',
    ...overrides,
  }
}

describe('sortNotesDesc', () => {
  it('createdAt の新しい順に並べる', () => {
    const a = note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' })
    const b = note({ id: 'b', createdAt: '2026-06-01T00:00:00.000Z' })
    expect(sortNotesDesc([a, b]).map(n => n.id)).toEqual(['b', 'a'])
  })
})

describe('mergeNotes', () => {
  it('id で重複排除し、ローカルを優先する', () => {
    const local = [note({ id: 'x', body: 'ローカル版' })]
    const cloud = [note({ id: 'x', body: 'クラウド版' }), note({ id: 'y', createdAt: '2026-06-10T00:00:00.000Z' })]
    const merged = mergeNotes(local, cloud)
    expect(merged).toHaveLength(2)
    expect(merged.find(n => n.id === 'x')?.body).toBe('ローカル版')
  })
  it('クラウドのみのノートを取り込み、新しい順に並ぶ', () => {
    const merged = mergeNotes([], [
      note({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      note({ id: 'new', createdAt: '2026-06-01T00:00:00.000Z' }),
    ])
    expect(merged.map(n => n.id)).toEqual(['new', 'old'])
  })
})

describe('legacyMemoToNote', () => {
  it('id が legacy-<code> に固定される（端末をまたぐ二重シード防止）', () => {
    const n = legacyMemoToNote('7203', '昔のメモ', '2026-05-01T00:00:00.000Z')
    expect(n.id).toBe('legacy-7203')
    expect(n.body).toBe('昔のメモ')
    expect(n.createdAt).toBe('2026-05-01T00:00:00.000Z')
    expect(n.market).toBe('jp')
    expect(n.kind).toBe('note')
  })
  it('米国ティッカーは market=us になる', () => {
    expect(legacyMemoToNote('AAPL', 'memo').market).toBe('us')
  })
  it('updatedAt が無ければ現在時刻が入る', () => {
    expect(legacyMemoToNote('7203', 'memo').createdAt).toBeTruthy()
  })
})

describe('buildSnapshot', () => {
  it('株価・PER・PBR・配当利回り・時価総額を写し取る', () => {
    expect(buildSnapshot(row())).toEqual({ price: 1840, per: 12.3, pbr: 1.1, divY: 0.032, mcap: 30000 })
  })
  it('null/0 の値は省く', () => {
    const s = buildSnapshot(row({ close: 0, perF: null, pbr: null, divY: null, mcap: 0 }))
    expect(s).toEqual({})
  })
  it('row が無ければ空', () => {
    expect(buildSnapshot(null)).toEqual({})
  })
})
