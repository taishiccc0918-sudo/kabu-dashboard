import { StockRow, JudgmentLogic, MetricRange } from './types'

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
