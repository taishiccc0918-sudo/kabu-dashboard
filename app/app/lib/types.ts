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
  close: number
  chg1d: number | null
  chg1w: number | null
  chg3m: number | null
  chg1y: number | null
  mcap: number
  perA: number | null
  perF: number | null
  perN: number | null
  // PER今期の変化率
  perFChg1w: number | null
  perFChg1m: number | null
  perFChg3m: number | null
  perFChg1y: number | null
  pbr: number | null
  roe: number | null
  divY: number | null
  epsGr: number | null
  peg: number | null
  nySalesGr: number | null
  judgment: string
}
export type SortKey = keyof StockRow
export type FilterKey = 'all' | 'buy' | 'watch' | 'up' | 'down'
export type TabKey = 'dashboard' | 'card' | 'watchlist'
export type StatusType = 'idle' | 'loading' | 'ok' | 'error'
