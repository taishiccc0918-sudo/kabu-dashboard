'use client'
import React, { useEffect, useRef, useState } from 'react'
import type { MasterRecord } from '../lib/types'
import { matchNameToCode, type NameMatch } from '../lib/searchText'
import styles from '../page.module.css'

// ── AIアシスト（✨）─────────────────────────────────────────────────
// 2モード:
//   ことばで追加: 「トヨタとソニー追加して」と書く/喋る → 社名抽出(API) → masterDB照合 → 一括追加
//   テーマでさがす: 「レアアース」→ 候補銘柄＋一次情報の根拠(API) → 選んで一括追加
// コンプラ: 推奨ではなく事実共有。免責文は常設（下部固定）。
// 幻覚対策: 表示されるのは JPX マスタ照合を通った実在銘柄のみ。

type AddGroup = { input: string; matches: NameMatch[] }
type ThemeItem = {
  code: string; name: string; market: string; relation: string
  factsheet: { bizDesc: string; docUrl: string | null; docDate: string | null } | null
  news: { title: string; link: string; source: string; pubDate: string }[]
}

// Web Speech API（あれば使う・無ければマイクボタン非表示＝キーボードの音声入力で代替可）
type SpeechRecognitionLike = {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null
  onend: (() => void) | null; onerror: (() => void) | null
  start: () => void; stop: () => void
}
function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export default function AiAssist({
  masterDB, favorites, loggedIn, onSignIn, onBulkAdd, onClose,
}: {
  masterDB: Record<string, MasterRecord>
  favorites: Set<string>
  loggedIn: boolean
  onSignIn: () => void
  onBulkAdd: (codes: string[], themeLabel?: string) => number // 戻り値=実際に追加した件数
  onClose: () => void
}) {
  const [mode, setMode] = useState<'add' | 'theme'>('add')
  const [input, setInput] = useState('')
  const [themeInput, setThemeInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [groups, setGroups] = useState<AddGroup[] | null>(null)       // ことばで追加の照合結果
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [themeItems, setThemeItems] = useState<ThemeItem[] | null>(null)
  const [themeLabel, setThemeLabel] = useState('')                    // 検索したテーマ（メモ記録用）
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [doneMsg, setDoneMsg] = useState('')
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const speechAvailable = !!getSpeechRecognition()

  // 閉じるときに音声認識を止める
  useEffect(() => () => { try { recRef.current?.stop() } catch { /* noop */ } }, [])

  // target: 認識結果の書き込み先（'add'=ことばで追加の本文 / 'theme'=テーマ入力欄）
  function toggleMic(target: 'add' | 'theme') {
    const SR = getSpeechRecognition()
    if (!SR) return
    if (listening) { try { recRef.current?.stop() } catch { /* noop */ }; setListening(false); return }
    const rec = new SR()
    rec.lang = 'ja-JP'
    rec.interimResults = false
    rec.continuous = true
    rec.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript
      }
      if (!text) return
      if (target === 'add') setInput(prev => (prev ? prev + ' ' : '') + text)
      else setThemeInput(prev => (prev ? prev + ' ' : '') + text)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    try { rec.start(); setListening(true) } catch { setListening(false) }
  }

  function resetResults() {
    setGroups(null); setUnmatched([]); setThemeItems(null); setChecked(new Set()); setError(''); setDoneMsg('')
  }

  // ── ことばで追加 ──
  async function runAdd() {
    const text = input.trim()
    if (!text || loading) return
    resetResults(); setLoading(true)
    try {
      const res = await fetch('/api/ai-add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      })
      const d = (await res.json()) as { names?: string[]; error?: string }
      if (!res.ok) { setError(d.error ?? `エラー（${res.status}）`); return }
      const names = d.names ?? []
      // クライアントで JPX マスタ照合（LLMにコードを答えさせない＝幻覚が登録に直結しない）
      const gs: AddGroup[] = []
      const miss: string[] = []
      const seenCodes = new Set<string>()
      for (const n of names) {
        const all = matchNameToCode(n, masterDB)
        if (all.length === 0) { miss.push(n); continue } // 本当に照合できなかったものだけ「見つかりません」
        const hits = all.filter(h => !seenCodes.has(h.code))
        if (hits.length === 0) continue // 全候補が他の社名で表示済み（例: ソフトバンクとソフトバンクグループの両抽出）→ 黙ってスキップ
        hits.forEach(h => seenCodes.add(h.code))
        gs.push({ input: n, matches: hits })
      }
      setGroups(gs); setUnmatched(miss)
      // 既定ON: 完全一致のみ（複数あれば全部=ソフトバンク両方）。
      // あいまい一致は自動チェックしない＝誤変換由来の別会社が勝手に選ばれる事故を防ぐ（本人フィードバック）。
      const init = new Set<string>()
      for (const g of gs) {
        g.matches.filter(m => m.exact).forEach(m => { if (!favorites.has(m.code)) init.add(m.code) })
      }
      setChecked(init)
      if (gs.length === 0 && miss.length === 0) setError('文章から上場企業名を見つけられませんでした')
    } catch {
      setError('通信に失敗しました。もう一度お試しください')
    } finally { setLoading(false) }
  }

  // ── テーマでさがす ──
  async function runTheme() {
    const theme = themeInput.trim()
    if (!theme || loading) return
    resetResults(); setLoading(true)
    try {
      const res = await fetch('/api/ai-theme', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }),
      })
      const d = (await res.json()) as { items?: ThemeItem[]; unmatched?: string[]; error?: string }
      if (!res.ok) { setError(d.error ?? `エラー（${res.status}）`); return }
      setThemeItems(d.items ?? []); setUnmatched(d.unmatched ?? []); setThemeLabel(theme)
      if ((d.items ?? []).length === 0) setError('該当する上場銘柄が見つかりませんでした')
    } catch {
      setError('通信に失敗しました。もう一度お試しください')
    } finally { setLoading(false) }
  }

  function toggleCheck(code: string) {
    setChecked(prev => { const next = new Set(prev); if (next.has(code)) next.delete(code); else next.add(code); return next })
  }

  function commitAdd(theme?: string) {
    const codes = Array.from(checked)
    if (codes.length === 0) return
    const added = onBulkAdd(codes, theme)
    setDoneMsg(added > 0 ? `${added}件をウォッチリストに追加しました` : '選択した銘柄はすべて登録済みでした')
    setChecked(new Set())
  }

  const checkRow = (m: { code: string; name: string; market: string }) => {
    const isFav = favorites.has(m.code)
    return (
      <label key={m.code} className={`${styles.aiCandRow} ${isFav ? styles.aiCandRowDone : ''}`}>
        <input type="checkbox" disabled={isFav} checked={checked.has(m.code)} onChange={() => toggleCheck(m.code)} />
        <span className={styles.aiCandName}>{m.name}</span>
        <span className={styles.aiCandCode}>{m.code}</span>
        <span className={styles.aiCandMkt}>{m.market.replace('市場', '')}</span>
        {isFav && <span className={styles.aiCandDoneBadge}>登録済み</span>}
      </label>
    )
  }

  return (
    <div className={styles.aiOverlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.aiPanel}>
        <div className={styles.aiHeader}>
          <span className={styles.aiTitle}>✨ AIアシスト</span>
          <button className={styles.aiClose} onClick={onClose} aria-label="閉じる">× 閉じる</button>
        </div>

        <div className={styles.aiTabs}>
          <button className={`${styles.aiTabBtn} ${mode === 'add' ? styles.aiTabBtnActive : ''}`}
            onClick={() => { setMode('add'); resetResults() }}>ことばで追加</button>
          <button className={`${styles.aiTabBtn} ${mode === 'theme' ? styles.aiTabBtnActive : ''}`}
            onClick={() => { setMode('theme'); resetResults() }}>テーマでさがす</button>
        </div>

        {!loggedIn ? (
          <div className={styles.aiLoginBox}>
            <p>AI機能のご利用には Google ログインが必要です。</p>
            <p className={styles.aiLoginNote}>（手動での銘柄登録は、ログインなしで今まで通り使えます）</p>
            <button className={styles.btnPrimary} onClick={onSignIn}>Googleでログイン</button>
          </div>
        ) : mode === 'add' ? (
          <div className={styles.aiBody}>
            <div className={styles.aiHint}>追加したい銘柄を、ふだんの言葉のまま書いてください（最大20社）</div>
            <textarea
              className={styles.aiTextarea}
              placeholder={'例: トヨタとソニーとキーエンス追加して。\nあとファーストリテイリングも。'}
              value={input}
              onChange={e => setInput(e.target.value)}
              rows={3}
            />
            <div className={styles.aiActions}>
              {speechAvailable && (
                <button className={`${styles.aiMicBtn} ${listening ? styles.aiMicBtnOn : ''}`} onClick={() => toggleMic('add')}
                  title="音声で入力（話した内容が上の欄に追記されます）">
                  {listening ? '🎤 認識中…（タップで停止）' : '🎤 音声で入力'}
                </button>
              )}
              <div className={styles.spacer} />
              <button className={styles.btnPrimary} onClick={runAdd} disabled={loading || !input.trim()}>
                {loading ? '解析中…' : '銘柄を探す'}
              </button>
            </div>

            {error && <div className={styles.aiError}>{error}</div>}
            {doneMsg && <div className={styles.aiDone}>{doneMsg}</div>}

            {groups && groups.length > 0 && (
              <div className={styles.aiResult}>
                <div className={styles.aiResultLabel}>見つかった銘柄（チェックした銘柄をまとめて追加します）</div>
                {groups.map(g => (
                  <div key={g.input} className={styles.aiCandGroup}>
                    {/* あいまい一致は「近い銘柄」と明示（自動チェックもされない）＝誤変換でも別会社が紛れ込まない */}
                    {(g.matches.length > 1 || !g.matches[0].exact) && (
                      <div className={styles.aiCandGroupLabel}>「{g.input}」に近い銘柄（確認してチェック）:</div>
                    )}
                    {g.matches.map(checkRow)}
                  </div>
                ))}
                {unmatched.length > 0 && (
                  <div className={styles.aiUnmatched}>見つかりませんでした: {unmatched.join('、')}</div>
                )}
                <button className={styles.btnPrimary} onClick={() => commitAdd()} disabled={checked.size === 0}>
                  ✓ {checked.size}件をウォッチリストに追加
                </button>
              </div>
            )}
            {groups && groups.length === 0 && unmatched.length > 0 && (
              <div className={styles.aiUnmatched}>見つかりませんでした: {unmatched.join('、')}</div>
            )}
          </div>
        ) : (
          <div className={styles.aiBody}>
            <div className={styles.aiHint}>気になるテーマから、事業が関連する上場銘柄をさがします</div>
            <div className={styles.aiThemeRow}>
              <input
                className={styles.aiThemeInput}
                placeholder="例: レアアース、半導体製造装置、宇宙"
                value={themeInput}
                onChange={e => setThemeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runTheme() }}
              />
              {speechAvailable && (
                <button className={`${styles.aiMicBtnSmall} ${listening ? styles.aiMicBtnOn : ''}`}
                  onClick={() => toggleMic('theme')} title="音声でテーマを入力" aria-label="音声でテーマを入力">🎤</button>
              )}
              <button className={styles.btnPrimary} onClick={runTheme} disabled={loading || !themeInput.trim()}>
                {loading ? '検索中…' : 'さがす'}
              </button>
            </div>

            {error && <div className={styles.aiError}>{error}</div>}
            {doneMsg && <div className={styles.aiDone}>{doneMsg}</div>}

            {themeItems && themeItems.length > 0 && (
              <div className={styles.aiResult}>
                <div className={styles.aiResultLabel}>
                  「{themeLabel}」に事業が関連する銘柄（公開情報ベース・タップで選択）
                </div>
                {themeItems.map(it => {
                  const isFav = favorites.has(it.code)
                  return (
                    <div key={it.code}
                      className={`${styles.aiThemeCard} ${checked.has(it.code) ? styles.aiThemeCardOn : ''} ${isFav ? styles.aiCandRowDone : ''}`}
                      onClick={() => { if (!isFav) toggleCheck(it.code) }}>
                      <div className={styles.aiThemeCardHead}>
                        <input type="checkbox" disabled={isFav} checked={checked.has(it.code)} readOnly />
                        <span className={styles.aiCandName}>{it.name}</span>
                        <span className={styles.aiCandCode}>{it.code}</span>
                        <span className={styles.aiCandMkt}>{it.market.replace('市場', '')}</span>
                        {isFav && <span className={styles.aiCandDoneBadge}>登録済み</span>}
                      </div>
                      {it.relation && <div className={styles.aiThemeRelation}>{it.relation}</div>}
                      {it.factsheet && (
                        <div className={styles.aiEvidence}>
                          <span className={styles.aiEvidenceTag}>EDINET有価証券報告書</span>
                          <span className={styles.aiEvidenceText}>
                            {it.factsheet.bizDesc.length > 90 ? it.factsheet.bizDesc.slice(0, 90) + '…' : it.factsheet.bizDesc}
                          </span>
                          {it.factsheet.docUrl && (
                            <a href={it.factsheet.docUrl} target="_blank" rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()} className={styles.aiEvidenceLink}>原文</a>
                          )}
                        </div>
                      )}
                      {it.news.map(n => (
                        <div key={n.link} className={styles.aiEvidence}>
                          <span className={styles.aiEvidenceTag}>ニュース</span>
                          <a href={n.link} target="_blank" rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()} className={styles.aiEvidenceLink}>
                            {n.title}{n.source ? `（${n.source}）` : ''}
                          </a>
                        </div>
                      ))}
                    </div>
                  )
                })}
                {unmatched.length > 0 && (
                  <div className={styles.aiUnmatched}>上場銘柄として確認できませんでした: {unmatched.join('、')}</div>
                )}
                <button className={styles.btnPrimary} onClick={() => commitAdd(themeLabel)} disabled={checked.size === 0}>
                  ✓ {checked.size}件をウォッチリストに追加
                </button>
              </div>
            )}
          </div>
        )}

        {/* 常設の免責（コンプラ第3層・モード共通） */}
        <div className={styles.aiDisclaimer}>
          ※投資勧誘・推奨ではありません。公開情報（EDINET・適時開示等）に基づく事実の整理です。投資判断はご自身の責任で行ってください。
        </div>
      </div>
    </div>
  )
}
