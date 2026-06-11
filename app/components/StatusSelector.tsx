'use client'
// ─── StatusSelector ──────────────────────────────────────────────────
// 銘柄の「いまの状態」（気になる→ウォッチ中→買いたい→保有→売却済み）＋
// 目標価格＋買いたい理由。変更はタイムライン（stock_notes）に自動記録される。
import { useEffect, useState } from 'react'
import styles from '../page.module.css'
import { StockRow } from '../lib/types'
import { buildSnapshot } from '../lib/notes'
import {
  StockStatus, STATUS_LABEL, STATUS_OPTIONS,
  getState, setStatus, setStateFields, effectiveStatus,
} from '../lib/states'

const STATUS_EMOJI: Record<StockStatus, string> = {
  interested: '👀', watching: '🔍', want_to_buy: '🎯', holding: '💼', sold: '🏁', archived: '📦',
}

export default function StatusSelector({ code, row, isHeart, onChanged }: {
  code: string
  row: StockRow | null
  isHeart: boolean
  onChanged?: () => void   // ステータス変更後にタイムライン等を再読込させる
}) {
  const [current, setCurrent] = useState<StockStatus>('watching')
  const [explicit, setExplicit] = useState(false)   // 明示設定済みか（未設定は♥/★からの推定表示）
  const [targetDraft, setTargetDraft] = useState('')
  const [reasonDraft, setReasonDraft] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    const s = getState(code)
    setCurrent(effectiveStatus(s, isHeart))
    setExplicit(!!s)
    setTargetDraft(s?.targetPrice != null ? String(s.targetPrice) : '')
    setReasonDraft(s?.buyReason ?? '')
  }, [code, isHeart])

  function handleStatus(next: StockStatus) {
    if (next === current && explicit) return
    setStatus(code, next, { prevEffective: explicit ? current : undefined, snapshot: buildSnapshot(row) })
    setCurrent(next)
    setExplicit(true)
    onChanged?.()
  }

  function saveFields() {
    const t = targetDraft.trim()
    const price = t === '' ? null : Number(t.replace(/,/g, ''))
    setStateFields(code, {
      targetPrice: price != null && isFinite(price) && price > 0 ? price : null,
      buyReason: reasonDraft,
    }, { fallbackStatus: current, snapshot: buildSnapshot(row) })
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
    onChanged?.()
  }

  return (
    <div className={styles.statusSelector}>
      <div className={styles.statusChipRow}>
        {STATUS_OPTIONS.map(s => (
          <button
            key={s}
            className={`${styles.statusChip} ${current === s ? styles.statusChipActive : ''} ${current === s && !explicit ? styles.statusChipImplied : ''}`}
            onClick={() => handleStatus(s)}
            type="button"
          >{STATUS_EMOJI[s]} {STATUS_LABEL[s]}</button>
        ))}
      </div>
      {!explicit && (
        <div className={styles.statusHint}>
          {isHeart ? '♥から「買いたい」と仮表示中。' : '★から「ウォッチ中」と仮表示中。'}
          タップで確定すると、変化の履歴がノートに残ります。
        </div>
      )}
      <div className={styles.statusFieldRow}>
        <label className={styles.statusFieldLabel}>
          目標価格
          <input
            className={styles.statusFieldInput}
            type="text" inputMode="decimal" placeholder="例: 1500"
            value={targetDraft}
            onChange={e => setTargetDraft(e.target.value)}
          />
        </label>
        <label className={`${styles.statusFieldLabel} ${styles.statusFieldGrow}`}>
          この銘柄を選んだ理由
          <input
            className={styles.statusFieldInput}
            type="text" placeholder="例: 国内シェア1位で割安"
            value={reasonDraft}
            onChange={e => setReasonDraft(e.target.value)}
          />
        </label>
        <button
          className={styles.btnSecondary}
          style={{ alignSelf: 'flex-end', padding: '6px 14px', fontSize: 12, ...(savedFlash ? { borderColor: '#34d399', color: '#34d399' } : {}) }}
          onClick={saveFields}
          type="button"
        >{savedFlash ? '保存 ✓' : '保存'}</button>
      </div>
    </div>
  )
}
