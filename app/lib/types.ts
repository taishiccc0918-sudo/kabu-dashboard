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

// ジャンル分類
export const STOCK_GENRES: Record<string, string> = {
  // 宇宙
  '290A': '宇宙', '9416': '宇宙', '6946': '宇宙',
  // 防衛
  '7003': '防衛', '7014': '防衛', '7011': '防衛', '7018': '防衛', '6332': '防衛', '7832': '防衛',
  // 半導体
  '6758': '半導体', '6590': '半導体', '6137': '半導体', '7729': '半導体', '7760': '半導体',
  '6861': '半導体', '6273': '半導体', '6383': '半導体', '6524': '半導体', '5136': '半導体',
  // 造船
  '7003': '造船', // 三井E&S (防衛と重複→防衛優先)
  // IP・ゲーム
  '7832': 'IP', '7974': 'IP', '9684': 'IP', '3635': 'IP', '9766': 'スポーツ',
  // スポーツ
  '7936': 'スポーツ',
  // 金融
  '8729': '保険', '8306': '銀行', '5253': '保険',
  // 素材・化学
  '4204': '素材', '5644': '素材', '4107': '化学', '3433': '素材', '4043': '化学',
  '4980': '化学', '4186': '化学', '4046': '化学', '4062': '化学', '5803': '素材',
  // 機械・製造
  '6016': '機械', '6023': '機械', '6331': '機械', '6368': '機械', '6469': '機械',
  '6503': '機械', '6501': '機械', '6701': '機械', '4902': '機械', '6113': '機械',
  '6637': '機械', '6643': '機械', '6762': '機械', '7721': '機械', '7245': '機械',
  '6890': '機械', '6814': '機械', '6565': '機械', '7906': '機械', '6954': '機械',
  // サービス・IT
  '3697': 'IT', '4011': 'IT', '4180': 'IT', '3993': 'IT', '3542': 'サービス',
  '3088': 'サービス', '7453': '小売', '3563': '小売', '9722': 'サービス', '9616': 'サービス',
  '8136': 'サービス', '5032': 'IT', '6269': '機械',
  // エネルギー
  '5016': 'エネルギー', '1663': 'エネルギー', '5857': 'エネルギー',
  // その他
  '7550': '自動車', '268A': '機械', '285A': 'IP', '6383': '機械',
}

export function getGenre(code: string): string {
  return STOCK_GENRES[code] ?? 'その他'
}

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
  genre: string
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
  perFChg1mPrev: number | null   // 1ヶ月前のPER今期値
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
