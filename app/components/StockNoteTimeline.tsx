'use client'
// ─── StockNoteTimeline ───────────────────────────────────────────────
// 銘柄ノート（タイムライン型・追記式）。日付つきの記録を積み重ね、
// 保存時の株価・PERを自動添付して「当時の自分の判断」を残す。
import { useEffect, useState } from 'react'
import styles from '../page.module.css'
import { StockRow } from '../lib/types'
import {
  StockNote, getNotes, addNote, deleteNote, ensureLegacySeed, buildSnapshot,
} from '../lib/notes'
import VoiceMemoInput from './VoiceMemoInput'

function fmtNoteDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function fmtPrice(code: string, price: number): string {
  const isUs = /^[A-Za-z]/.test(code)
  const v = price.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return isUs ? `$${v}` : `¥${v}`
}

const KIND_LABEL: Record<string, string> = {
  status_change: 'ステータス変更',
  target: '目標',
  trade: '売買',
  review: 'ふりかえり',
}

export default function StockNoteTimeline({ code, row, refreshToken = 0 }: { code: string; row: StockRow | null; refreshToken?: number }) {
  const [notes, setNotes] = useState<StockNote[]>([])
  const [draft, setDraft] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => { setDraft('') }, [code])   // 銘柄切替時のみ下書きをリセット
  useEffect(() => {
    ensureLegacySeed(code)           // 旧メモがあれば最初の記録として取り込む（冪等）
    setNotes(getNotes(code))
  }, [code, refreshToken])

  function handleAdd() {
    const body = draft.trim()
    if (!body) return
    addNote({ code, body, snapshot: buildSnapshot(row) })
    setNotes(getNotes(code))
    setDraft('')
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  function handleDelete(n: StockNote) {
    if (!window.confirm('この記録を削除しますか？（元に戻せません）')) return
    deleteNote(code, n.id)
    setNotes(getNotes(code))
  }

  // 「その後 +14%」チップ：当時の価格 vs 現在価格（自分の記録の再提示・事実のみ）
  function sinceChip(n: StockNote) {
    const then = n.snapshot?.price
    const now = row?.close
    if (!then || !now || then <= 0) return null
    const pct = (now - then) / then
    const cls = pct > 0 ? styles.noteDiffUp : pct < 0 ? styles.noteDiffDown : styles.noteDiffFlat
    return <span className={`${styles.noteChip} ${cls}`}>その後 {pct > 0 ? '+' : ''}{(pct * 100).toFixed(1)}%</span>
  }

  return (
    <div className={styles.noteTimeline}>
      <textarea
        className={styles.detailMemo}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder="いま考えていることを記録...（例: 決算良かった。PERはまだ低い。来期ガイダンス待ち）"
      />
      <VoiceMemoInput appendLabel="入力欄に追加 ↓" onAppend={t => setDraft(prev => (prev ? prev + '\n' + t : t))} />
      <div className={styles.noteAddRow}>
        <button
          className={styles.btnPrimary}
          style={{ flex: 1, ...(savedFlash ? { background: '#34d399' } : {}) }}
          onClick={handleAdd}
          disabled={!draft.trim()}
        >{savedFlash ? '記録しました ✓' : '＋ 記録する（上書きされません）'}</button>
        {notes.length > 0 && <span className={styles.noteCount}>記録 {notes.length}件</span>}
      </div>

      {notes.length === 0 && (
        <div className={styles.noteEmpty}>
          まだ記録がありません。気になった理由をひとこと残すと、<b>そのときの株価つき</b>で積み重なっていきます。
        </div>
      )}

      {notes.map(n => (
        <div key={n.id} className={styles.noteItem}>
          <div className={styles.noteHead}>
            <span className={styles.noteDate}>{fmtNoteDate(n.createdAt)}</span>
            {KIND_LABEL[n.kind] && <span className={styles.noteChip}>{KIND_LABEL[n.kind]}</span>}
            {n.snapshot?.price ? <span className={styles.noteChip}>当時 {fmtPrice(code, n.snapshot.price)}</span> : null}
            {n.snapshot?.per != null ? <span className={styles.noteChip}>PER {n.snapshot.per.toFixed(1)}倍</span> : null}
            {sinceChip(n)}
            <button className={styles.noteDelBtn} onClick={() => handleDelete(n)} title="この記録を削除" aria-label="削除">✕</button>
          </div>
          <div className={styles.noteBody}>{n.body}</div>
        </div>
      ))}
    </div>
  )
}
