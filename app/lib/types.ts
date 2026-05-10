export const DEFAULT_WATCHLIST = [
  '290A','8729','4902','7003','7014','3635','6590','3010','7729','7832',
  '6137','4980','6758','6637','9722','7721','4204','5644','6016','8111',
  '4107','3433','7760','6565','6643','6331','3088','6273','7552','6023',
  '6890','6762','4043','9616','8306','5253','6113','7453','6814','3542',
  '7906','6954','6861','6368','6469','3697','6503','8136','7245','4062',
  '4046','9684','3563','5032','6332','7011','9766','5857','7550','5016',
  '6269','6701','4186','6383','6501','7974','3993','7018','4011','1663',
  '4180','7936','285A','6946','9468','5803','268A','5136','6524',
]

// デフォルトジャンルマップ（複数タグ対応: カンマ区切り文字列）
export const DEFAULT_GENRES: Record<string, string> = {
  '290A': '宇宙',
  '6946': '宇宙',
  '7003': '防衛,造船',
  '7014': '防衛,造船',
  '7011': '防衛,機械',
  '7018': '防衛,造船',
  '6332': '防衛',
  '6758': '半導体,機械',
  '6590': '半導体',
  '6137': '半導体,機械',
  '7729': '半導体,機械',
  '7760': '半導体,機械',
  '6861': '半導体',
  '6273': '半導体,機械',
  '6524': '半導体,機械',
  '5136': '半導体',
  '7832': 'IP',
  '7974': 'IP',
  '9684': 'IT,IP',
  '3635': 'IT,IP',
  '285A': 'IT,IP',
  '9766': 'スポーツ',
  '7936': 'スポーツ',
  '8729': '保険',
  '8306': '銀行',
  '5253': '保険',
  '4204': '素材',
  '5644': '素材',
  '3433': '素材',
  '5803': '素材',
  '4107': '化学',
  '4043': '化学',
  '4980': '化学',
  '4186': '化学',
  '4046': '化学',
  '4062': '化学',
  '6016': '機械',
  '6023': '機械',
  '6331': '機械',
  '6368': '機械',
  '6469': '機械',
  '6503': '機械',
  '6501': '機械,半導体',
  '6701': '機械,IT',
  '4902': '機械',
  '6113': '機械',
  '6637': '機械',
  '6643': '機械',
  '6762': '機械,半導体',
  '7721': '機械',
  '7245': '機械',
  '6890': '機械',
  '6814': '機械',
  '6565': '機械',
  '7906': '機械',
  '6954': '機械,半導体',
  '6383': '機械',
  '6269': '機械',
  '268A': '機械',
  '3697': 'IT',
  '4011': 'IT',
  '4180': 'IT',
  '3993': 'IT',
  '5032': 'IT',
  '3542': 'サービス',
  '3088': 'サービス',
  '9722': 'サービス',
  '9616': 'サービス',
  '8136': 'サービス',
  '7453': '小売',
  '3563': '小売',
  '5016': 'エネルギー',
  '1663': 'エネルギー',
  '5857': 'エネルギー',
  '7550': '自動車',
  '9468': 'サービス',
  '9416': '宇宙',
}

export const ALL_GENRE_OPTIONS = [
  '宇宙','防衛','造船','半導体','機械','IT','IP','スポーツ',
  '保険','銀行','素材','化学','サービス','小売','エネルギー','自動車','その他'
]

export interface PriceRecord {
  close: number
  open?: number
  high?: number
  low?: number
  vol?: number
  mcap?: number
  prev1d?: number
  prev1w?: number
  prev1m?: number
  prev3m?: number
  prev1y?: number
  chg1d?: number
  chg1w?: number
  chg3m?: number
  chg1y?: number
}
export interface FinRecord {
  sales: number
  op: number
  odp: number
  np: number
  eps: number
  feps: number
  nyEPS: number
  bps: number
  equity: number
  assets: number
  divAnn: number
  fdiv: number
  shOut: number
  nextAnnouncementDate?: string  // 次回決算予定日 (YYYY-MM-DD)
  discDate: string
  perType: string
  roe: number
  eqRat: number
  opMgn: number
  salesGr: number
  nySalesGr: number
  fsales: number
  fop: number
  nySales: number
  nyOP: number
}
export interface MasterRecord {
  name: string
  market: string
}
export interface StockRow {
  code: string
  name: string
  market: string
  genres: string[]       // 複数タグ
  close: number
  chg1d: number | null
  chg1w: number | null
  chg3m: number | null
  chg1y: number | null
  mcap: number
  perA: number | null
  perF: number | null
  perN: number | null
  perFChg1w: number | null
  perFChg1m: number | null
  perFChg1mPrev: number | null
  perFChg3m: number | null
  perFChg1y: number | null
  pbr: number | null
  roe: number | null
  divY: number | null
  epsGr: number | null
  peg: number | null
  opMgn: number | null
  nySalesGr: number | null
  judgment: string
}
export type SortKey = keyof StockRow
export type FilterKey = 'all' | 'buy'
export type TabKey = 'dashboard' | 'card' | 'watchlist'
export type StatusType = 'idle' | 'loading' | 'ok' | 'error'

export interface KSFRecord {
  code: string
  ksf1_product: string        // KSF①Q1: 商品（何を売ってる）
  ksf1_customer: string       // KSF①Q1: 顧客（誰に売れてる）
  ksf1_profitNote: string     // KSF①Q1: 利益率（どのくらい儲かる）
  ksf2b_industryPer: number | null   // KSF②買い時: 業界平均PER
  ksf2b_per5yMin: number | null      // KSF②買い時: 過去5年PER最低
  ksf2b_per5yMax: number | null      // KSF②買い時: 過去5年PER最高
  ksf2b_finalCheck: boolean          // KSF②買い時: 1時間考えた
  ksf2s_industryAvgRich: 'high' | 'normal' | null  // KSF②売り時: 業界平均より高い側に振れた?
  holding: boolean            // 保有中フラグ
  buyPrice: number | null     // 買値
  buyDate: string | null      // 購入日 (YYYY-MM-DD)
  updatedAt: string           // ISO8601文字列
}

export function emptyKSF(code: string): KSFRecord {
  return {
    code,
    ksf1_product: '',
    ksf1_customer: '',
    ksf1_profitNote: '',
    ksf2b_industryPer: null,
    ksf2b_per5yMin: null,
    ksf2b_per5yMax: null,
    ksf2b_finalCheck: false,
    ksf2s_industryAvgRich: null,
    holding: false,
    buyPrice: null,
    buyDate: null,
    updatedAt: new Date().toISOString(),
  }
}
