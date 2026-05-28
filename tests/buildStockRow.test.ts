import { describe, it, expect } from 'vitest'
import { buildStockRow } from '../app/lib/format'
import type { FinRecord, PriceRecord, MasterRecord, StockMeta } from '../app/lib/types'

const master: Record<string, MasterRecord> = {
  '7203': { name: 'トヨタ', market: 'プライム市場' },
}
const meta: Record<string, StockMeta> = {}

function fin(overrides: Partial<FinRecord> = {}): Record<string, FinRecord> {
  return {
    '7203': {
      sales: 0, op: 0, odp: 0, np: 0,
      eps: 100, feps: 110, nyEPS: 120,
      bps: 1000, equity: 0, assets: 0,
      divAnn: 30, fdiv: 30, shOut: 0,
      discDate: '2026-05-01', perType: '',
      roe: 0.10, eqRat: 0, opMgn: 0.15,
      salesGr: 0, nySalesGr: 0.05,
      fsales: 0, fop: 0, nySales: 0, nyOP: 0,
      feps1m: 105,
      ...overrides,
    },
  }
}

function price(overrides: Partial<PriceRecord> = {}): Record<string, PriceRecord> {
  return {
    '7203': { close: 1100, prev1m: 1000, ...overrides },
  }
}

describe('buildStockRow — FEPS空欄ケース', () => {
  it('feps=nullのときperF/peg/epsCurGrはすべてnull', () => {
    const row = buildStockRow('7203', price(), fin({ feps: null }), master, meta)
    expect(row.perF).toBeNull()
    expect(row.peg).toBeNull()
    expect(row.epsCurGr).toBeNull()
    expect(row.perFChg1m).toBeNull()
  })

  it('feps=0でも安全（divide by zeroにならない、perF=null）', () => {
    const row = buildStockRow('7203', price(), fin({ feps: 0 }), master, meta)
    expect(row.perF).toBeNull()
  })
})

describe('buildStockRow — PEG異常値ケース', () => {
  it('epsCurGr=0（feps==eps）のときPEGはnull（ゼロ割回避）', () => {
    const row = buildStockRow('7203', price(), fin({ eps: 100, feps: 100 }), master, meta)
    expect(row.epsCurGr).toBe(0)
    expect(row.peg).toBeNull()
  })

  it('epsCurGr<0（減益予想）のときPEGは負値（異常だがnullではない）— 上位ロジックで弾く想定', () => {
    const row = buildStockRow('7203', price(), fin({ eps: 100, feps: 80 }), master, meta)
    expect(row.epsCurGr).toBeLessThan(0)
    expect(row.peg).toBeLessThan(0)
  })

  it('epsCurGrが極小（0.001）のときPEGは極大（異常検知用境界）', () => {
    const row = buildStockRow('7203', price(), fin({ eps: 100, feps: 100.1 }), master, meta)
    // epsCurGr = 0.001, perF = 11, peg = 11 / 0.1 = 110
    expect(row.peg).not.toBeNull()
    expect(Math.abs(row.peg!)).toBeGreaterThan(50)
  })
})

describe('buildStockRow — PER変化率の境界', () => {
  it('株価据置・FEPS据置 → perFChg1m=0', () => {
    const row = buildStockRow('7203', price({ close: 1100, prev1m: 1100 }), fin({ feps: 110, feps1m: 110 }), master, meta)
    expect(row.perFChg1m).toBe(0)
  })

  it('株価10%下落・FEPS据置 → perFChg1m≈-10%', () => {
    const row = buildStockRow('7203', price({ close: 990, prev1m: 1100 }), fin({ feps: 110, feps1m: 110 }), master, meta)
    expect(row.perFChg1m).toBeCloseTo(-0.1, 5)
  })

  it('feps1m=nullならperFChg1mはnull（IPO直後等）', () => {
    const row = buildStockRow('7203', price(), fin({ feps1m: null }), master, meta)
    expect(row.perFChg1m).toBeNull()
  })

  it('prev1m未設定（=0/undefined）ならperFChg1mはnull', () => {
    const row = buildStockRow('7203', { '7203': { close: 1100 } }, fin(), master, meta)
    expect(row.perFChg1m).toBeNull()
  })
})

describe('buildStockRow — 通常ケース', () => {
  it('全データ揃った銘柄でperF/pbr/roe/divYが計算される', () => {
    const row = buildStockRow('7203', price(), fin(), master, meta)
    expect(row.perF).toBeCloseTo(10, 5) // 1100 / 110
    expect(row.pbr).toBeCloseTo(1.1, 5) // 1100 / 1000
    expect(row.roe).toBe(0.10)
    expect(row.divY).toBeCloseTo(30 / 1100, 5)
    expect(row.judgment).toBe('') // page.tsx側で判定するので空
  })

  it('未登録銘柄でもクラッシュしない', () => {
    const row = buildStockRow('9999', {}, {}, {}, {})
    expect(row.code).toBe('9999')
    expect(row.perF).toBeNull()
  })
})
