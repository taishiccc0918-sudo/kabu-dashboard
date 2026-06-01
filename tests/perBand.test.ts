import { describe, it, expect } from 'vitest'
import { buildPerBand } from '../app/lib/perBand'
import type { DailyClose, FyEps } from '../app/lib/perBand'

// 単一EPS=100。直近1年のPERレンジ＝株価/100 の高値/安値。
const fy1: FyEps[] = [{ d: '2025-01-15', eps: 100 }]
const daily1: DailyClose[] = [
  { date: '2025-01-05', price: 9999 }, // EPS開示前 → eps未定で除外されるべき
  { date: '2025-02-01', price: 1500 }, // PER 15
  { date: '2025-06-01', price: 2500 }, // PER 25 ← 高値
  { date: '2025-09-01', price: 1200 }, // PER 12 ← 安値
  { date: '2025-12-01', price: 2000 }, // PER 20（最新）
]

describe('buildPerBand — 直近1年のPERレンジ', () => {
  it('高値25・安値12（EPS開示前の点は除外）', () => {
    const band = buildPerBand(daily1, fy1, 20)
    expect(band.highPER).toBeCloseTo(25, 6)
    expect(band.lowPER).toBeCloseTo(12, 6)
    expect(band.position).toBeCloseTo((20 - 12) / (25 - 12), 6)
    expect(band.reason).toBeNull()
  })

  it('予想PERが安値なら0、高値なら1、レンジ外はクランプ', () => {
    expect(buildPerBand(daily1, fy1, 12).position).toBeCloseTo(0, 6)
    expect(buildPerBand(daily1, fy1, 25).position).toBeCloseTo(1, 6)
    expect(buildPerBand(daily1, fy1, 5).position).toBe(0)
    expect(buildPerBand(daily1, fy1, 40).position).toBe(1)
  })
})

describe('buildPerBand — 期中でEPSが更新される階段関数', () => {
  it('開示日以降は新EPSでPERを計算する', () => {
    const fy2: FyEps[] = [
      { d: '2025-01-15', eps: 100 },
      { d: '2025-07-01', eps: 200 },
    ]
    const daily2: DailyClose[] = [
      { date: '2025-02-01', price: 1500 }, // /100 = 15
      { date: '2025-06-01', price: 2500 }, // /100 = 25 ← 高値
      { date: '2025-08-01', price: 3000 }, // /200 = 15
      { date: '2025-12-01', price: 2000 }, // /200 = 10 ← 安値
    ]
    const band = buildPerBand(daily2, fy2, 15)
    expect(band.highPER).toBeCloseTo(25, 6)
    expect(band.lowPER).toBeCloseTo(10, 6)
    expect(band.position).toBeCloseTo((15 - 10) / (25 - 10), 6)
  })
})

describe('buildPerBand — windowDaysで古い点を除外', () => {
  it('直近180日だけを使う', () => {
    const band = buildPerBand(daily1, fy1, 20, 180) // 最新2025-12-01から180日 → cutoff≈2025-06-04
    // 2025-06-01(25) は範囲外、2025-09-01(12)/2025-12-01(20) が残る
    expect(band.highPER).toBeCloseTo(20, 6)
    expect(band.lowPER).toBeCloseTo(12, 6)
  })
})

describe('buildPerBand — 算出不可の理由', () => {
  it('FY履歴なし → no_history', () => {
    expect(buildPerBand(daily1, [], 20).reason).toBe('no_history')
  })
  it('EPSが全て赤字(<=0) → loss', () => {
    expect(buildPerBand(daily1, [{ d: '2025-01-15', eps: -50 }], 20).reason).toBe('loss')
  })
  it('株価なし → no_price', () => {
    expect(buildPerBand([], fy1, 20).reason).toBe('no_price')
  })
  it('予想EPS非開示(fwdPER=null) → レンジは出るが現在位置なし・no_forecast', () => {
    const band = buildPerBand(daily1, fy1, null)
    expect(band.highPER).toBeCloseTo(25, 6)
    expect(band.position).toBeNull()
    expect(band.reason).toBe('no_forecast')
  })
})
