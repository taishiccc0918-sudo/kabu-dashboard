import { describe, it, expect } from 'vitest'
import { buildPerBand } from '../app/lib/perBand'
import type { DailyClose, FyEps } from '../app/lib/perBand'

// 各FYのEPS実績は100で固定 → PER = 株価/100
const fyEps: FyEps[] = [
  { d: '2022-01-01', eps: 100 }, // R0（直近3年に入らない・除外されるべき）
  { d: '2023-01-01', eps: 100 }, // R1
  { d: '2024-01-01', eps: 100 }, // R2
  { d: '2025-01-01', eps: 100 }, // R3（最新・終端なし）
]

// 各レジームに2点ずつ（高値/安値が明確になるように）
const daily: DailyClose[] = [
  { date: '2022-06-01', price: 500 },  // R0: low  → PER 5
  { date: '2022-09-01', price: 600 },  // R0: high → PER 6
  { date: '2023-06-01', price: 1000 }, // R1: low  → PER 10
  { date: '2023-09-01', price: 2000 }, // R1: high → PER 20
  { date: '2024-06-01', price: 1500 }, // R2: low  → PER 15
  { date: '2024-09-01', price: 2500 }, // R2: high → PER 25
  { date: '2025-06-01', price: 2000 }, // R3: low  → PER 20
  { date: '2025-09-01', price: 3000 }, // R3: high → PER 30
]

describe('buildPerBand — 直近3レジームの高値/安値平均', () => {
  it('R1/R2/R3 の高値平均=25・安値平均=15（R0は除外）', () => {
    const band = buildPerBand(daily, fyEps, 20) // fwdPER=20
    expect(band.years).toBe(3)
    expect(band.highAvgPER).toBeCloseTo(25, 6)  // (20+25+30)/3
    expect(band.lowAvgPER).toBeCloseTo(15, 6)   // (10+15+20)/3
    expect(band.position).toBeCloseTo(0.5, 6)   // (20-15)/(25-15)
  })

  it('fwdPERが安値平均なら position=0、高値平均なら position=1', () => {
    expect(buildPerBand(daily, fyEps, 15).position).toBeCloseTo(0, 6)
    expect(buildPerBand(daily, fyEps, 25).position).toBeCloseTo(1, 6)
  })

  it('レンジ外の予想PERは 0〜1 にクランプ', () => {
    expect(buildPerBand(daily, fyEps, 5).position).toBe(0)
    expect(buildPerBand(daily, fyEps, 40).position).toBe(1)
  })
})

describe('buildPerBand — データ不足時', () => {
  it('日次株価なし → 高値/安値平均は null・position は null', () => {
    const band = buildPerBand([], fyEps, 20)
    expect(band.highAvgPER).toBeNull()
    expect(band.lowAvgPER).toBeNull()
    expect(band.position).toBeNull()
    expect(band.fwdPER).toBe(20)
  })

  it('EPS実績なし → null', () => {
    const band = buildPerBand(daily, [], 20)
    expect(band.highAvgPER).toBeNull()
    expect(band.years).toBe(0)
  })

  it('eps<=0 のFYは無視される', () => {
    const band = buildPerBand(daily, [{ d: '2025-01-01', eps: 0 }], 20)
    expect(band.years).toBe(0)
    expect(band.highAvgPER).toBeNull()
  })
})

describe('buildPerBand — 3年に満たない場合は取れた分で出す', () => {
  it('2レジームのみなら years=2 で平均', () => {
    const fy2: FyEps[] = [
      { d: '2024-01-01', eps: 100 },
      { d: '2025-01-01', eps: 100 },
    ]
    const band = buildPerBand(daily, fy2, 20)
    expect(band.years).toBe(2)
    // R2(high25/low15) と R3(high30/low20)
    expect(band.highAvgPER).toBeCloseTo(27.5, 6)
    expect(band.lowAvgPER).toBeCloseTo(17.5, 6)
  })
})
