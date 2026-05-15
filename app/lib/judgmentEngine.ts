import { StockRow, JudgmentLogic, MetricRange } from './types'
import { METRIC_LABELS } from './metricLabels'

export function evaluateRange(row: StockRow, range: MetricRange): boolean {
  const value = (row as unknown as Record<string, unknown>)[range.metric]
  if (value == null || typeof value !== 'number') return false
  if (range.min != null && value < range.min) return false
  if (range.max != null && value > range.max) return false
  return true
}

// 戻り値: ロジック名（全条件AND一致）または null（非該当）
export function evaluateLogic(row: StockRow, logic: JudgmentLogic): string | null {
  if (logic.ranges.length === 0) return null
  const allPass = logic.ranges.every(r => evaluateRange(row, r))
  return allPass ? logic.name : null
}

// ホバー説明文: 「ロジック名: 条件1, 条件2, ...」
export function formatLogicDescription(logic: JudgmentLogic): string {
  const parts = logic.ranges.map(r => {
    const meta = METRIC_LABELS[r.metric]
    if (!meta) return ''
    const label = meta.label
    const fmt = (v: number) => meta.isPercent ? `${Math.round(v * 100)}%` : `${v}`
    if (r.min != null && r.max != null) return `${label} ${fmt(r.min)}～${fmt(r.max)}`
    if (r.min != null) return `${label}≥${fmt(r.min)}`
    if (r.max != null) return `${label}≤${fmt(r.max)}`
    return ''
  }).filter(Boolean)
  return `${logic.name}: ${parts.join(', ')}`
}
