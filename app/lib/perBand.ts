// PERバンド計算（純貋関数・テスト可能）— 直近1年版
//
// 「今の予想PERが、過去1年のPERレンジ（高値〜安値）のどこにあるか」を出す。
// 1年に絞るのは、数年スパンだと業績局面が変わって割安/割高判定が実態とズレるため
// （例: IMVのような銘柄で3年だと割高に見えてしまう）。
//
// 方式（期末日フィールドに依存しない）:
//   ・各FY決算の開示日(DiscDate)ごとのEPS実績で「EPSの階段関数」を作る
//   ・直近1年の各営業日について PER = 終値 / その時点の実績EPS を計算
//   ・その1年ぶんのPERの 高値(max)/安値(min) がレンジ
//   ・現在の予想PER(fwdPER) をそのレンジ内のどこかにプロット
// EPSは1年の途中で年次更新されうるので、階段関数で各日に正しい実績EPSを割り当てる。

export interface DailyClose {
  date: string   // 'YYYY-MM-DD'
  price: number  // 調整後終値
}

// FYのEPS実績ヒストリー（開示日昇順を想定するが内部でソートする）
export interface FyEps {
  d: string       // DiscDate 'YYYY-MM-DD'
  eps: number     // その期のEPS実績
}

// 算出不可の理由
export type PerBandReason =
  | 'no_history'   // FYのEPS履歴がまだ無い（取得待ち/不足）
  | 'loss'         // 直近EPSが赤字（PER算出不可）
  | 'no_price'     // 1年ぶんの株価が足りない
  | 'no_forecast'  // 予想EPS非開示（レンジは出せるが現在位置を置けない）
  | null

export interface PerBand {
  fwdPER: number | null      // 現在の予想PER（呼び出し側から渡す perF）
  highPER: number | null     // 直近1年のPER高値
  lowPER: number | null      // 直近1年のPER安値
  position: number | null    // 0(安値)〜1(高値) にクランプした現在の予想PER位置
  reason: PerBandReason      // null以外なら算出不可（理由つき）
}

// 'YYYY-MM-DD' を windowDays 日だけ遡った 'YYYY-MM-DD' を返す（Date.nowは使わない）
function minusDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) - days * 86400000
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * 直近1年のPERレンジ（高値/安値）と、その中での現在予想PERの位置を返す。
 * @param daily       1年ぶん程度の日次株価（順不同で可）
 * @param fyEps       FY決算ごとのEPS実績（順不同で可）
 * @param fwdPER      現在の予想PER（perF）。位置計算と表示に使う（nullなら現在位置なし）。
 * @param windowDays  集計する直近日数（既定365＝直近1年）
 */
export function buildPerBand(
  daily: DailyClose[] | null | undefined,
  fyEps: FyEps[] | null | undefined,
  fwdPER: number | null,
  windowDays = 365
): PerBand {
  const base = { fwdPER, highPER: null, lowPER: null, position: null }

  if (!fyEps || fyEps.length === 0) return { ...base, reason: 'no_history' }

  // EPS実績(>0)の階段関数を作る。開示日昇順。
  const byDate = new Map<string, number>()
  for (const f of fyEps) {
    if (f && f.d && typeof f.eps === 'number' && f.eps > 0) byDate.set(f.d, f.eps)
  }
  const steps = Array.from(byDate.entries())
    .map(([d, eps]) => ({ d, eps }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  if (steps.length === 0) return { ...base, reason: 'loss' }   // 直近の実績EPSが全て赤字

  if (!daily || daily.length === 0) return { ...base, reason: 'no_price' }
  const prices = daily
    .filter(p => p && p.price > 0 && p.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (prices.length === 0) return { ...base, reason: 'no_price' }

  // 集計対象期間：最新日から windowDays 遡った範囲
  const latest = prices[prices.length - 1].date
  const cutoff = minusDays(latest, windowDays)

  // 各日の実績EPS（その日以前で最新の開示EPS）。stepsは昇順。
  let hi = -Infinity, lo = Infinity, n = 0
  for (const p of prices) {
    if (p.date < cutoff) continue
    let eps = 0
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].d <= p.date) eps = steps[i].eps
      else break
    }
    if (eps <= 0) continue
    const per = p.price / eps
    if (per > hi) hi = per
    if (per < lo) lo = per
    n++
  }
  if (n === 0) return { ...base, reason: 'no_price' }

  let position: number | null = null
  let reason: PerBandReason = null
  if (fwdPER != null && isFinite(hi) && isFinite(lo) && hi > lo) {
    position = Math.max(0, Math.min(1, (fwdPER - lo) / (hi - lo)))
  } else if (fwdPER == null) {
    reason = 'no_forecast'
  }

  return {
    fwdPER,
    highPER: isFinite(hi) ? hi : null,
    lowPER: isFinite(lo) ? lo : null,
    position,
    reason,
  }
}
