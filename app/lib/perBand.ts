// 四季報式PERバンド計算（純粋関数・テスト可能）
//
// 「今の予想PERが、過去3年の高値平均PER／安値平均PERのどこにあるか」を出す。
// データ依存を最小化するため、期末日フィールドには頼らず
//   ・各FY決算の開示日(DiscDate)とそのEPS実績
//   ・3年ぶんの日次株価（調整後終値）
// だけで計算する。
//
// 考え方:
//   FY開示日を境にした「EPSレジーム」を作る。
//   レジーム i = [discDate_i, discDate_{i+1}) の期間で、市場はその年に確定した
//   EPS_i を見て株価を付けている。その期間の株価高値/安値 ÷ EPS_i = その年に
//   市場が付けた実績PERのレンジ。直近3レジームを平均して高値平均/安値平均とする。
//   （四季報の「高値平均PER/安値平均PER」と同じ趣旨。開示ラグを織り込むぶん
//     「実際にその年いくらのPERで売買されていたか」に忠実。）

export interface DailyClose {
  date: string   // 'YYYY-MM-DD'
  price: number  // 調整後終値
}

// FYのEPS実績ヒストリー（開示日昇順を想定するが内部でソートする）
export interface FyEps {
  d: string       // DiscDate 'YYYY-MM-DD'
  eps: number     // その期のEPS実績（>0 を想定。0/負は呼び出し側で除外推奨）
}

export interface PerBand {
  fwdPER: number | null      // 現在の予想PER（呼び出し側から渡す perF）
  highAvgPER: number | null  // 直近レジームの高値PER平均
  lowAvgPER: number | null   // 直近レジームの安値PER平均
  years: number              // 平均に使えたレジーム数（最大3）
  position: number | null    // 0(安値平均)〜1(高値平均) にクランプした現在の予想PER位置
}

const EMPTY: PerBand = { fwdPER: null, highAvgPER: null, lowAvgPER: null, years: 0, position: null }

/**
 * 直近最大3レジームの高値平均PER／安値平均PERを計算し、現在の予想PERの位置を返す。
 * @param daily       3年ぶん程度の日次株価（順不同で可）
 * @param fyEps       FY決算ごとのEPS実績（順不同で可、eps>0 のもの）
 * @param fwdPER      現在の予想PER（perF）。位置計算と表示に使う。
 * @param maxRegimes  平均に使うレジーム数（既定3＝四季報の直近3年相当）
 */
export function buildPerBand(
  daily: DailyClose[] | null | undefined,
  fyEps: FyEps[] | null | undefined,
  fwdPER: number | null,
  maxRegimes = 3
): PerBand {
  if (!daily || daily.length === 0 || !fyEps || fyEps.length === 0) {
    return { ...EMPTY, fwdPER }
  }

  // EPS実績が有効(>0)なFY開示を昇順ソート・同一開示日は新しいEPSで上書き
  const byDate = new Map<string, number>()
  for (const f of fyEps) {
    if (f && f.d && typeof f.eps === 'number' && f.eps > 0) byDate.set(f.d, f.eps)
  }
  const regimesAsc = Array.from(byDate.entries())
    .map(([d, eps]) => ({ d, eps }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  if (regimesAsc.length === 0) return { ...EMPTY, fwdPER }

  // 価格を日付昇順に
  const prices = daily
    .filter(p => p && p.price > 0 && p.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (prices.length === 0) return { ...EMPTY, fwdPER }

  // 各レジーム [d_i, d_{i+1}) の期間内 高値/安値 を集計
  type Agg = { eps: number; hi: number; lo: number; n: number }
  const aggs: Agg[] = []
  for (let i = 0; i < regimesAsc.length; i++) {
    const start = regimesAsc[i].d
    const end = i + 1 < regimesAsc.length ? regimesAsc[i + 1].d : null // 最新レジームは未来端なし
    let hi = -Infinity, lo = Infinity, n = 0
    for (const p of prices) {
      if (p.date < start) continue
      if (end !== null && p.date >= end) continue
      if (p.price > hi) hi = p.price
      if (p.price < lo) lo = p.price
      n++
    }
    if (n > 0) aggs.push({ eps: regimesAsc[i].eps, hi, lo, n })
  }
  if (aggs.length === 0) return { ...EMPTY, fwdPER }

  // 直近 maxRegimes レジームを採用（新しい順に最大3）
  const recent = aggs.slice(-maxRegimes)
  let sumHi = 0, sumLo = 0
  for (const a of recent) {
    sumHi += a.hi / a.eps
    sumLo += a.lo / a.eps
  }
  const highAvgPER = sumHi / recent.length
  const lowAvgPER = sumLo / recent.length

  let position: number | null = null
  if (fwdPER != null && isFinite(highAvgPER) && isFinite(lowAvgPER) && highAvgPER > lowAvgPER) {
    position = (fwdPER - lowAvgPER) / (highAvgPER - lowAvgPER)
    position = Math.max(0, Math.min(1, position))
  }

  return {
    fwdPER,
    highAvgPER: isFinite(highAvgPER) ? highAvgPER : null,
    lowAvgPER: isFinite(lowAvgPER) ? lowAvgPER : null,
    years: recent.length,
    position,
  }
}
