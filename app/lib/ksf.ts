import { KSFRecord, StockRow, FinRecord, emptyKSF } from './types'

const LS_PREFIX = 'ksf:'
const LS_ALL_KEY = 'ksfCodes'

function getAllKSFCodes(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const v = localStorage.getItem(LS_ALL_KEY)
    return v ? JSON.parse(v) : []
  } catch { return [] }
}

export function getKSF(code: string): KSFRecord {
  if (typeof window === 'undefined') return emptyKSF(code)
  try {
    const v = localStorage.getItem(LS_PREFIX + code)
    return v ? JSON.parse(v) : emptyKSF(code)
  } catch { return emptyKSF(code) }
}

export function saveKSF(record: KSFRecord): void {
  if (typeof window === 'undefined') return
  try {
    const updated = { ...record, updatedAt: new Date().toISOString() }
    localStorage.setItem(LS_PREFIX + record.code, JSON.stringify(updated))
    const codes = getAllKSFCodes()
    if (!codes.includes(record.code)) {
      localStorage.setItem(LS_ALL_KEY, JSON.stringify([...codes, record.code]))
    }
  } catch { /* quota */ }
}

export function getAllKSF(): KSFRecord[] {
  return getAllKSFCodes().map(code => getKSF(code))
}

export function exportKSFAsJSON(): string {
  return JSON.stringify(getAllKSF(), null, 2)
}

export function importKSFFromJSON(json: string): { imported: number; errors: number } {
  let imported = 0
  let errors = 0
  try {
    const records = JSON.parse(json)
    if (!Array.isArray(records)) throw new Error('not an array')
    for (const r of records) {
      if (r && typeof r.code === 'string') {
        saveKSF(r as KSFRecord)
        imported++
      } else {
        errors++
      }
    }
  } catch { errors++ }
  return { imported, errors }
}

export interface JudgeDetail {
  key: string
  label: string
  passed: boolean
}

export interface JudgeResult {
  passed: number
  total: number
  details: JudgeDetail[]
}

export function judgeKSF1(row: StockRow): JudgeResult {
  const details: JudgeDetail[] = [
    {
      key: 'salesGrowth',
      label: '売上成長YoY ≥ 15%',
      passed: (row.nySalesGr ?? 0) >= 0.15,
    },
    {
      key: 'roe',
      label: 'ROE ≥ 15%',
      passed: (row.roe ?? 0) >= 0.15,
    },
  ]
  return { passed: details.filter(d => d.passed).length, total: details.length, details }
}

export function judgeKSF2Buy(row: StockRow, ksf: KSFRecord, fin: FinRecord): JudgeResult {
  const perF = row.perF ?? null

  const inCheapZone: boolean = (() => {
    if (perF === null || ksf.ksf2b_per5yMin === null || ksf.ksf2b_per5yMax === null) return false
    const range = ksf.ksf2b_per5yMax - ksf.ksf2b_per5yMin
    if (range <= 0) return false
    return perF <= ksf.ksf2b_per5yMin + range / 3
  })()

  const belowIndustryPer: boolean =
    perF !== null && ksf.ksf2b_industryPer !== null && perF <= ksf.ksf2b_industryPer

  const twoWeeksBeforeAnnouncement: boolean = (() => {
    if (!fin.nextAnnouncementDate) return false
    const diffDays = (new Date(fin.nextAnnouncementDate).getTime() - Date.now()) / 86400000
    return diffDays >= 14
  })()

  const details: JudgeDetail[] = [
    {
      key: 'per5yRange',
      label: `現在PER(${perF?.toFixed(1) ?? '-'}) が過去5年レンジの安い1/3以内`,
      passed: inCheapZone,
    },
    {
      key: 'industryPer',
      label: `現在PER(${perF?.toFixed(1) ?? '-'}) が業界平均PER(${ksf.ksf2b_industryPer ?? '-'})以下`,
      passed: belowIndustryPer,
    },
    {
      key: 'nextAnnouncement',
      label: `次決算まで2週間以上 (${fin.nextAnnouncementDate ?? '不明'})`,
      passed: twoWeeksBeforeAnnouncement,
    },
  ]
  return { passed: details.filter(d => d.passed).length, total: details.length, details }
}

export interface SellSignal {
  key: string
  label: string
  triggered: boolean
  detail: string
}

export interface SellJudgeResult {
  sellSignals: SellSignal[]
}

export function judgeKSF2Sell(row: StockRow, ksf: KSFRecord): SellJudgeResult {
  const industryOvervalued: SellSignal = {
    key: 'industryAvgRich',
    label: 'A判定: 業界平均PERより割高側に振れた',
    triggered: ksf.ksf2s_industryAvgRich === 'high',
    detail: ksf.ksf2s_industryAvgRich === 'high' ? '業界平均より高い側に振れたと判断済み' : '未判定',
  }

  const buyPriceDrop: SellSignal = (() => {
    if (!ksf.buyPrice || ksf.buyPrice <= 0 || row.close <= 0) {
      return { key: 'buyPriceDrop', label: 'B-1判定: 買値から-10%落ち', triggered: false, detail: '買値未設定' }
    }
    const dropPct = (row.close - ksf.buyPrice) / ksf.buyPrice
    return {
      key: 'buyPriceDrop',
      label: 'B-1判定: 買値から-10%落ち',
      triggered: dropPct <= -0.10,
      detail: `買値 ${ksf.buyPrice.toFixed(0)}円 → 現在 ${row.close.toFixed(0)}円 (${(dropPct * 100).toFixed(1)}%)`,
    }
  })()

  // 3ヶ月変化率がマイナス10%以下 = 3ヶ月高値から10%以上下落と見なす
  const highFromPeak: SellSignal = (() => {
    const chg3m = row.chg3m
    if (chg3m === null || row.close <= 0) {
      return { key: 'highFromPeak', label: 'B-2判定: 直近高値から-10%落ち', triggered: false, detail: '3ヶ月データなし' }
    }
    const price3mAgo = row.close / (1 + chg3m)
    const estimatedPeak = Math.max(row.close, price3mAgo)
    const dropFromPeak = (row.close - estimatedPeak) / estimatedPeak
    return {
      key: 'highFromPeak',
      label: 'B-2判定: 直近高値から-10%落ち',
      triggered: dropFromPeak <= -0.10,
      detail: `推定高値 ${estimatedPeak.toFixed(0)}円 → 現在 ${row.close.toFixed(0)}円 (${(dropFromPeak * 100).toFixed(1)}%)`,
    }
  })()

  return { sellSignals: [industryOvervalued, buyPriceDrop, highFromPeak] }
}
