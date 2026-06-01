import { describe, it, expect } from 'vitest'
import { selectFEPS, selectNyEPS, newerStmt } from '../app/lib/api'

// テスト用の bestValOrNull（api.ts内のものと同等）
const bvn = (stmts: Record<string,string>[], ...keys: string[]): number | null => {
  for (const k of keys) for (let i = stmts.length - 1; i >= 0; i--) {
    const v = Number(stmts[i][k]); if (stmts[i][k] !== '' && !isNaN(v) && v !== 0) return v
  }
  return null
}

describe('selectFEPS — 最新開示の予想EPSを優先（Food & Life型の不具合修正）', () => {
  // 本決算(2025-11-07)で出した今期予想132を、その後の四半期(2026-05-13)で265に上方修正したケース
  const fy  = { CurPerType: 'FY', DiscDate: '2025-11-07', EPS: '203', FEPS: '132', NxFEPS: '140' }
  const nfy = { CurPerType: '2Q', DiscDate: '2026-05-13', EPS: '120', FEPS: '265', NxFEPS: '300' }
  const all = [fy, nfy]

  it('四半期(新しい)の予想EPSを採用する（古い本決算の132ではなく265）', () => {
    expect(selectFEPS(fy, nfy, all, bvn)).toBe(265)
  })
  it('newerStmt は開示日が新しい方を返す', () => {
    expect(newerStmt(fy, nfy)).toBe(nfy)
    expect(newerStmt(nfy, fy)).toBe(nfy)
  })
  it('来期EPSは通常どおり（shiftedしない）', () => {
    expect(selectNyEPS(fy, nfy, all, bvn).fepsShifted).toBe(false)
  })
})

describe('selectFEPS — 本決算が最新でFEPS空欄なら次期予想を今期に充当（従来挙動を維持）', () => {
  const nfy = { CurPerType: '3Q', DiscDate: '2025-08-01', FEPS: '50', NxFEPS: '' }
  const fy  = { CurPerType: 'FY', DiscDate: '2025-11-07', FEPS: '', NxFEPS: '70' } // 通期確定・今期予想空欄
  const all = [nfy, fy]

  it('最新の本決算でFEPS空欄 → NxFEPS(70)を今期に充当', () => {
    expect(selectFEPS(fy, nfy, all, bvn)).toBe(70)
  })
  it('その場合 fepsShifted=true・来期nyEPS=null', () => {
    const r = selectNyEPS(fy, nfy, all, bvn)
    expect(r.fepsShifted).toBe(true)
    expect(r.nyEPS).toBeNull()
  })
})

describe('selectFEPS — 四半期が最新だがFEPS空欄なら本決算側にフォールバック', () => {
  const fy  = { CurPerType: 'FY', DiscDate: '2025-11-07', FEPS: '180', NxFEPS: '190' }
  const nfy = { CurPerType: '1Q', DiscDate: '2026-02-10', FEPS: '', NxFEPS: '' }
  const all = [fy, nfy]
  it('最新四半期がFEPS空欄 → 本決算の180を使う', () => {
    expect(selectFEPS(fy, nfy, all, bvn)).toBe(180)
  })
})
