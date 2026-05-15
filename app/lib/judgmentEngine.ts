import { StockRow, JudgmentLogic, Condition } from './types'

export function evaluateCondition(row: StockRow, cond: Condition): boolean {
  const value = (row as unknown as Record<string, unknown>)[cond.metric]
  if (value == null || typeof value !== 'number') return false
  switch (cond.operator) {
    case '<':  return value < cond.threshold
    case '<=': return value <= cond.threshold
    case '>':  return value > cond.threshold
    case '>=': return value >= cond.threshold
    case '==': return value === cond.threshold
    case '!=': return value !== cond.threshold
  }
}

// 戻り値: 該当したグループ名の配列（空配列なら買い条件に該当しない）
export function evaluateLogic(row: StockRow, logic: JudgmentLogic): string[] {
  const matched: string[] = []
  for (const group of logic.groups) {
    if (group.conditions.length === 0) continue
    const allPass = group.conditions.every(c => evaluateCondition(row, c))
    if (allPass) matched.push(group.name)
  }
  return matched
}
