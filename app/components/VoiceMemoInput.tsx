'use client'
// ─── VoiceMemoInput ──────────────────────────────────────────────────
// 音声でテキストを入力（Web Speech API）。page.tsx から切り出し（ノート/メモで共用）。
import { useRef, useState } from 'react'
import styles from '../page.module.css'

type VoicePhase = 'idle' | 'recording' | 'review'

export default function VoiceMemoInput({ onAppend, appendLabel = 'メモに追加 ↓' }: { onAppend: (text: string) => void; appendLabel?: string }) {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [finalText, setFinalText] = useState('')
  const [interimText, setInterimText] = useState('')
  const [reviewText, setReviewText] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null)
  const accRef = useRef('')   // accumulated final transcript
  const abortedRef = useRef(false)  // true when user cancels mid-recording

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isSupported = typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  function startRecording() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new SR()
    rec.lang = 'ja-JP'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    accRef.current = ''
    abortedRef.current = false

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) accRef.current += t
        else interim += t
      }
      setFinalText(accRef.current)
      setInterimText(interim)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      if (abortedRef.current || e.error === 'aborted') return
      setInterimText('')
      if (accRef.current) { setReviewText(accRef.current); setPhase('review') }
      else setPhase('idle')
    }

    rec.onend = () => {
      if (abortedRef.current) return   // cancelled — state already set by cancelAll()
      setInterimText('')
      if (accRef.current) { setReviewText(accRef.current); setPhase('review') }
      else setPhase('idle')
    }

    recRef.current = rec
    setFinalText('')
    setInterimText('')
    setPhase('recording')
    try { rec.start() } catch { setPhase('idle') }
  }

  function stopRecording() {
    recRef.current?.stop()
    recRef.current = null
    // onend will handle transition to review / idle
  }

  function cancelAll() {
    abortedRef.current = true
    recRef.current?.abort()
    recRef.current = null
    accRef.current = ''
    setFinalText(''); setInterimText(''); setReviewText('')
    setPhase('idle')
  }

  function appendToMemo() {
    const t = reviewText.trim()
    if (t) onAppend(t)
    setReviewText(''); setFinalText('')
    setPhase('idle')
  }

  function retry() {
    setReviewText(''); setFinalText('')
    startRecording()
  }

  if (!isSupported) return null

  if (phase === 'idle') {
    return (
      <button className={styles.voiceBtn} onClick={startRecording} title="音声でメモを入力" type="button">
        🎤 音声入力
      </button>
    )
  }

  if (phase === 'recording') {
    return (
      <div className={styles.voicePanel}>
        <div className={styles.voiceRecBar}>
          <span className={styles.voiceRecDot} />
          <span className={styles.voiceRecLabel}>録音中... 日本語で話してください</span>
          <button className={styles.voiceStopBtn} onClick={stopRecording} type="button">■ 停止</button>
          <button className={styles.voiceXBtn} onClick={cancelAll} type="button">✕</button>
        </div>
        <div className={styles.voiceTranscript}>
          {finalText && <span className={styles.voiceFinal}>{finalText}</span>}
          {interimText && <span className={styles.voiceInterim}>{interimText}</span>}
          {!finalText && !interimText && <span className={styles.voicePlaceholder}>認識待機中...</span>}
        </div>
      </div>
    )
  }

  // review phase
  return (
    <div className={styles.voicePanel}>
      <div className={styles.voiceReviewBar}>
        <span className={styles.voiceReviewLabel}>🎤 認識結果を確認・編集してください</span>
      </div>
      <textarea
        className={styles.voiceReviewArea}
        value={reviewText}
        onChange={e => setReviewText(e.target.value)}
      />
      <div className={styles.voiceActions}>
        <button
          className={`${styles.btnPrimary} ${styles.voiceAppendBtn}`}
          onClick={appendToMemo}
          type="button"
        >
          {appendLabel}
        </button>
        <button className={styles.voiceRetryBtn} onClick={retry} type="button">
          🎤 録り直す
        </button>
        <button className={styles.voiceXBtn2} onClick={cancelAll} type="button">
          キャンセル
        </button>
      </div>
    </div>
  )
}
