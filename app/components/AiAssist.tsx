'use client'
import React, { useEffect, useRef, useState } from 'react'
import type { MasterRecord } from '../lib/types'
import { matchNameToCode, type NameMatch } from '../lib/searchText'
import styles from '../page.module.css'

// ── AIアシスト（✨）─────────────────────────────────────────────────
// 2モード:
//   ことばで追加: 「トヨタとNVIDIA追加して」と書く/喋る → 社名抽出(API) → 日本株はmasterDB照合・
//                米国株はus_master照合(サーバー) → 候補にチェック＋♥ → 一括追加
//   テーマでさがす: 「レアアース」→ 日本株/米国株の候補＋一次情報の根拠(API) → 選んで一括追加
// コンプラ: 推奨ではなく事実共有。免責文は常設（下部固定）。
// 幻覚対策: 表示されるのは JPX / us_master 照合を通った実在銘柄のみ。
// 並び: 未登録が上・登録済みは下。テーマ結果は時価総額の大きい順。

type AddGroup = { input: string; matches: NameMatch[] }
type UsHit = { ticker: string; name: string; market: string; mcap: number | null }
type ThemeItem = {
  code: string; name: string; market: string; country: 'JP' | 'US'
  mcap: number | null; per: number | null; relation: string; sicLabel: string | null
  factsheet: { bizDesc: string; docUrl: string | null; docDate: string | null } | null
  news: { title: string; link: string; source: string; pubDate: string }[]
}

// テーマのプリセット（タップで即検索。文字入力が苦手な人向け）
const THEME_PRESETS = [
  '半導体製造装置', '半導体材料', 'データセンター', '生成AI', 'ロボット・フィジカルAI',
  '防衛', '宇宙', 'レアアース', '原子力・電力', '電線・送電網',
  'サイバーセキュリティ', 'インバウンド', 'ゲーム・IP', '医療機器', '造船', '銀行',
]

// 👁ウォッチの目印アイコン（page.tsx の EyeIcon と同形・銘柄管理と同じ作法）
function EyeMark({ on, size = 17 }: { on: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/>
      <circle cx="12" cy="12" r="2.9" fill={on ? 'currentColor' : 'none'}/>
    </svg>
  )
}

function fmtMcapJp(mcap: number | null): string {
  if (!mcap) return ''
  return mcap >= 10000 ? `${(mcap / 10000).toFixed(1)}兆円` : `${Math.round(mcap).toLocaleString()}億円`
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
  // hearts ⊆ codes。戻り値=実際に追加した件数
  onBulkAdd: (codes: string[], themeLabel: string | undefined, hearts: string[]) => number
  onClose: () => void
}) {
  const [mode, setMode] = useState<'add' | 'theme'>('add')
  const [input, setInput] = useState('')
  const [themeInput, setThemeInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [groups, setGroups] = useState<AddGroup[] | null>(null)       // ことばで追加: 日本株の照合結果
  const [usHits, setUsHits] = useState<UsHit[]>([])                   // ことばで追加: 米国株（サーバー照合済み）
  const [unmatched, setUnmatched] = useState<string[]>([])
  const [themeItems, setThemeItems] = useState<ThemeItem[] | null>(null)
  const [themeLabel, setThemeLabel] = useState('')                    // 検索したテーマ（メモ記録用）
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [hearts, setHearts] = useState<Set<string>>(new Set())        // ♥超お気に入りにも登録する銘柄
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
    setGroups(null); setUsHits([]); setUnmatched([]); setThemeItems(null)
    setChecked(new Set()); setHearts(new Set()); setError(''); setDoneMsg('')
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
      const d = (await res.json()) as { names?: string[]; us?: UsHit[]; usUnmatched?: string[]; error?: string }
      if (!res.ok) { setError(d.error ?? `エラー（${res.status}）`); return }
      // 日本株: クライアントで JPX マスタ照合（LLMにコードを答えさせない＝幻覚が登録に直結しない）
      const gs: AddGroup[] = []
      const miss: string[] = [...(d.usUnmatched ?? [])]
      const seenCodes = new Set<string>()
      for (const n of d.names ?? []) {
        const all = matchNameToCode(n, masterDB)
        if (all.length === 0) { miss.push(n); continue } // 本当に照合できなかったものだけ「見つかりません」
        const hits = all.filter(h => !seenCodes.has(h.code))
        if (hits.length === 0) continue // 全候補が他の社名で表示済み（例: ソフトバンクとソフトバンクグループ）→ スキップ
        hits.forEach(h => seenCodes.add(h.code))
        gs.push({ input: n, matches: hits })
      }
      const us = (d.us ?? []).filter(u => !seenCodes.has(u.ticker))
      setGroups(gs); setUsHits(us); setUnmatched(miss)
      // 既定ON: 完全一致＋米国株（サーバー照合済み）。あいまい一致は自動チェックしない
      // ＝誤変換由来の別会社が勝手に選ばれる事故を防ぐ（本人フィードバック）。
      const init = new Set<string>()
      for (const g of gs) g.matches.filter(m => m.exact).forEach(m => { if (!favorites.has(m.code)) init.add(m.code) })
      us.forEach(u => { if (!favorites.has(u.ticker)) init.add(u.ticker) })
      setChecked(init)
      if (gs.length === 0 && us.length === 0 && miss.length === 0) setError('文章から上場企業名を見つけられませんでした')
    } catch {
      setError('通信に失敗しました。もう一度お試しください')
    } finally { setLoading(false) }
  }

  // ── テーマでさがす ──
  async function runTheme(presetTheme?: string) {
    const theme = (presetTheme ?? themeInput).trim()
    if (presetTheme) setThemeInput(presetTheme)
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
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(code)) { next.delete(code); setHearts(h => { const n = new Set(h); n.delete(code); return n }) }
      else next.add(code)
      return next
    })
  }
  // ♥ON時はチェックも自動でON（♥だけ付いて追加されない状態を作らない）
  function toggleHeart(code: string) {
    setHearts(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else { next.add(code); setChecked(c => new Set(c).add(code)) }
      return next
    })
  }

  function commitAdd(theme?: string) {
    const codes = Array.from(checked)
    if (codes.length === 0) return
    const added = onBulkAdd(codes, theme, Array.from(hearts))
    setDoneMsg(added > 0 ? `${added}件をウォッチリストに追加しました` : '選択した銘柄はすべて登録済みでした')
    setChecked(new Set()); setHearts(new Set())
  }

  // 未登録を上・登録済みを下に（表示順の共通ルール）
  const regLast = <T,>(arr: T[], codeOf: (t: T) => string): T[] =>
    [...arr].sort((a, b) => Number(favorites.has(codeOf(a))) - Number(favorites.has(codeOf(b))))

  // 右側の 👁/♥ トグル（銘柄管理と同じ作法: 👁=ウォッチに追加・♥=超お気に入りにも）
  const markBtns = (code: string) => (
    <span className={styles.aiMarkCol}>
      <button
        className={`${styles.aiEyeBtn} ${checked.has(code) ? styles.aiEyeBtnOn : ''}`}
        onClick={e => { e.preventDefault(); e.stopPropagation(); toggleCheck(code) }}
        title="👁ウォッチリストに追加する銘柄として選択"
        aria-label="ウォッチに追加"
      ><EyeMark on={checked.has(code)} /></button>
      <button
        className={`${styles.aiHeartBtn} ${hearts.has(code) ? styles.aiHeartBtnOn : ''}`}
        onClick={e => { e.preventDefault(); e.stopPropagation(); toggleHeart(code) }}
        title="♥にすると「超お気に入り」にも登録"
        aria-label="超お気に入りにも登録"
      >♥</button>
    </span>
  )

  const checkRow = (m: { code: string; name: string; market: string }, usBadge?: boolean) => {
    const isFav = favorites.has(m.code)
    return (
      <div key={m.code}
        className={`${styles.aiCandRow} ${checked.has(m.code) ? styles.aiCandRowOn : ''} ${isFav ? styles.aiCandRowDone : ''}`}
        onClick={() => { if (!isFav) toggleCheck(m.code) }}>
        <span className={styles.aiCandName}>{m.name}</span>
        <span className={styles.aiCandCode}>{m.code}</span>
        <span className={styles.aiCandMkt}>{usBadge ? `🇺🇸 ${m.market}` : m.market.replace('市場', '')}</span>
        {isFav ? <span className={styles.aiCandDoneBadge}>登録済み</span> : markBtns(m.code)}
      </div>
    )
  }

  const commitBar = (theme?: string) => (
    <>
      <div className={styles.aiHeartHint}>👁=ウォッチに追加 ／ ♥=「超お気に入り」にも登録（銘柄管理のマークと同じ）</div>
      <button className={styles.btnPrimary} onClick={() => commitAdd(theme)} disabled={checked.size === 0}>
        ✓ {checked.size}件をウォッチリストに追加{hearts.size > 0 ? `（うち♥${hearts.size}件）` : ''}
      </button>
    </>
  )

  // テーマ結果: 日本株/米国株に分け、それぞれ 未登録(時価総額順)↑ → 登録済み↓
  const themeJp = themeItems ? regLast(themeItems.filter(i => i.country === 'JP'), i => i.code) : []
  const themeUs = themeItems ? regLast(themeItems.filter(i => i.country === 'US'), i => i.code) : []

  const themeCard = (it: ThemeItem) => {
    const isFav = favorites.has(it.code)
    return (
      <div key={it.code}
        className={`${styles.aiThemeCard} ${checked.has(it.code) ? styles.aiThemeCardOn : ''} ${isFav ? styles.aiCandRowDone : ''}`}
        onClick={() => { if (!isFav) toggleCheck(it.code) }}>
        <div className={styles.aiThemeCardHead}>
          <span className={styles.aiCandName}>{it.name}</span>
          <span className={styles.aiCandCode}>{it.code}</span>
          <span className={styles.aiCandMkt}>{it.country === 'US' ? `🇺🇸 ${it.market}` : it.market.replace('市場', '')}</span>
          {isFav ? <span className={styles.aiCandDoneBadge}>登録済み</span> : markBtns(it.code)}
        </div>
        {(it.mcap || it.per) && (
          <div className={styles.aiThemeMetrics}>
            {it.mcap ? <span>時価総額 {fmtMcapJp(it.mcap)}</span> : null}
            {it.per ? <span>PER今期 {it.per}倍</span> : null}
          </div>
        )}
        {it.relation && <div className={styles.aiThemeRelation}>{it.relation}</div>}
        {it.sicLabel && (
          <div className={styles.aiEvidence}>
            <span className={styles.aiEvidenceTag}>SEC業種</span>
            <span className={styles.aiEvidenceText}>{it.sicLabel}</span>
          </div>
        )}
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
            <div className={styles.aiHint}>追加したい銘柄をことばで（日本株・米国株、最大30社）</div>
            <textarea
              className={styles.aiTextarea}
              placeholder={'例: トヨタとソニーとNVIDIA追加して'}
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

            {groups && (groups.length > 0 || usHits.length > 0) && (
              <div className={styles.aiResult}>
                <div className={styles.aiResultLabel}>見つかった銘柄（チェックした銘柄をまとめて追加します）</div>
                {groups.length > 0 && (
                  <>
                    {usHits.length > 0 && <div className={styles.aiSectionLabel}>🇯🇵 日本株</div>}
                    {regLast(groups, g => g.matches[0].code).map(g => (
                      <div key={g.input} className={styles.aiCandGroup}>
                        {/* あいまい一致は「近い銘柄」と明示（自動チェックもされない）＝誤変換でも別会社が紛れ込まない */}
                        {(g.matches.length > 1 || !g.matches[0].exact) && (
                          <div className={styles.aiCandGroupLabel}>「{g.input}」に近い銘柄（確認してチェック）:</div>
                        )}
                        {g.matches.map(m => checkRow(m))}
                      </div>
                    ))}
                  </>
                )}
                {usHits.length > 0 && (
                  <>
                    <div className={styles.aiSectionLabel}>🇺🇸 米国株</div>
                    {regLast(usHits, u => u.ticker).map(u => checkRow({ code: u.ticker, name: u.name, market: u.market }, true))}
                  </>
                )}
                {unmatched.length > 0 && (
                  <div className={styles.aiUnmatched}>見つかりませんでした: {unmatched.join('、')}</div>
                )}
                {commitBar()}
              </div>
            )}
            {groups && groups.length === 0 && usHits.length === 0 && unmatched.length > 0 && (
              <div className={styles.aiUnmatched}>見つかりませんでした: {unmatched.join('、')}</div>
            )}
          </div>
        ) : (
          <div className={styles.aiBody}>
            <div className={styles.aiHint}>気になるテーマから、事業が関連する銘柄をさがします</div>
            <div className={styles.aiThemeRow}>
              <input
                className={styles.aiThemeInput}
                placeholder="例: レアアース、半導体製造装置"
                value={themeInput}
                onChange={e => setThemeInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runTheme() }}
              />
              {speechAvailable && (
                <button className={`${styles.aiMicBtnSmall} ${listening ? styles.aiMicBtnOn : ''}`}
                  onClick={() => toggleMic('theme')} title="音声でテーマを入力" aria-label="音声でテーマを入力">🎤</button>
              )}
              <button className={styles.btnPrimary} onClick={() => runTheme()} disabled={loading || !themeInput.trim()}>
                {loading ? '検索中…' : 'さがす'}
              </button>
            </div>
            {/* 文字入力なしでも使えるテーマのプリセット（タップで即検索） */}
            {!themeItems && (
              <div className={styles.aiPresetWrap}>
                {THEME_PRESETS.map(t => (
                  <button key={t} className={styles.aiPresetChip} onClick={() => runTheme(t)} disabled={loading}>{t}</button>
                ))}
              </div>
            )}

            {error && <div className={styles.aiError}>{error}</div>}
            {doneMsg && <div className={styles.aiDone}>{doneMsg}</div>}

            {themeItems && themeItems.length > 0 && (
              <div className={styles.aiResult}>
                <div className={styles.aiResultLabel}>
                  「{themeLabel}」に事業が関連する銘柄（公開情報ベース・時価総額の大きい順・タップで選択）
                </div>
                {themeJp.length > 0 && (
                  <>
                    {themeUs.length > 0 && <div className={styles.aiSectionLabel}>🇯🇵 日本株</div>}
                    {themeJp.map(themeCard)}
                  </>
                )}
                {themeUs.length > 0 && (
                  <>
                    <div className={styles.aiSectionLabel}>🇺🇸 米国株</div>
                    {themeUs.map(themeCard)}
                  </>
                )}
                {unmatched.length > 0 && (
                  <div className={styles.aiUnmatched}>上場銘柄として確認できませんでした: {unmatched.join('、')}</div>
                )}
                {commitBar(themeLabel)}
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
