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
type UsHit = { ticker: string; name: string; nameKana: string | null; market: string; mcap: number | null }
type ThemeItem = {
  code: string; name: string; nameKana: string | null; market: string; country: 'JP' | 'US'
  mcap: number | null; per: number | null; relation: string; sicLabel: string | null
  factsheet: { bizDesc: string; docUrl: string | null; docDate: string | null } | null
  news: { title: string; link: string; source: string; pubDate: string }[]
}

// テーマのプリセット（選んだ瞬間に検索。文字入力が苦手な人向け・カテゴリ別）
const THEME_GROUPS: { label: string; items: string[] }[] = [
  { label: 'AI・半導体', items: ['生成AI', 'AIエージェント', 'AI半導体', '半導体製造装置', '半導体材料', '半導体商社', 'パワー半導体', '画像センサー', 'データセンター', 'AIサーバー冷却', 'HBM・先端メモリ', '後工程・テスト装置', '光通信・シリコンフォトニクス', 'エッジAI'] },
  { label: 'ロボット・機械', items: ['産業用ロボット', 'ヒューマノイド・フィジカルAI', 'FA・工場自動化', '工作機械', '建設機械', '減速機・モーター部品'] },
  { label: 'エネルギー', items: ['原子力', '再生可能エネルギー', '太陽光', '風力', '水素', '蓄電池・電池材料', '送電網・電線', '電力会社', '都市ガス', '石油・資源開発'] },
  { label: '防衛・宇宙', items: ['防衛', '宇宙開発', '人工衛星', 'ドローン', 'サイバーセキュリティ'] },
  { label: '素材・資源', items: ['レアアース', '銅・非鉄金属', '鉄鋼', '化学', '炭素繊維', 'ガラス・セラミックス', '金（ゴールド）関連'] },
  { label: '自動車・モビリティ', items: ['自動車', '自動車部品', 'EV関連', '自動運転', 'タイヤ', '二輪車'] },
  { label: 'IT・ネット', items: ['SaaS', 'EC・ネット通販', 'フィンテック', 'キャッシュレス決済', 'ゲーム', 'アニメ・IP', 'ネット広告', '人材・HRテック', 'DX支援', 'クラウド'] },
  { label: '金融', items: ['銀行', '地方銀行', '証券', '保険', 'リース', '取引所'] },
  { label: '消費・小売', items: ['コンビニ・小売', '百貨店', 'アパレル', '外食', '食品', '飲料', '化粧品', '日用品', 'ディスカウントストア'] },
  { label: 'インバウンド・レジャー', items: ['インバウンド', 'ホテル', '鉄道', '空運', '旅行', 'テーマパーク', 'エンタメ・興行'] },
  { label: 'ヘルスケア', items: ['製薬', 'バイオ', '医療機器', '介護', '調剤薬局', '再生医療'] },
  { label: '建設・不動産', items: ['建設', '不動産', '住宅', 'リフォーム', '物流施設・倉庫', 'データセンター建設'] },
  { label: '運輸・物流', items: ['海運', '造船', '物流・宅配', '港湾'] },
  { label: 'その他テーマ', items: ['総合商社', '教育', '農業・食料', '水産', '防災', '高齢化・シニア', '子育て・少子化対策', 'M&A・事業承継', '株主優待で人気', '猛暑・気候変動'] },
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

// 一括適用の差分（追加だけでなく、既存登録の解除もその場でできる）
export type AiMarkChanges = {
  addEye: string[]; removeEye: string[]; addHeart: string[]; removeHeart: string[]
}

export default function AiAssist({
  masterDB, favorites, superFavorites, loggedIn, onSignIn, onApply, onClose,
}: {
  masterDB: Record<string, MasterRecord>
  favorites: Set<string>
  superFavorites: Set<string>
  loggedIn: boolean
  onSignIn: () => void
  // 戻り値 = {added, removed}（実際に変更された件数）
  onApply: (changes: AiMarkChanges, themeLabel?: string) => { added: number; removed: number }
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
  const [loadingMore, setLoadingMore] = useState(false)  // テーマの追加読み込み中
  const [usKana, setUsKana] = useState(false)            // 米国株の社名を英語⇄カタカナ表示切替
  const [others, setOthers] = useState<string[]>([])     // テーマ: 日米以外の主要関連企業（参考表示）
  // きょうの利用状況（add=ことばで追加20回/日, theme=テーマ検索10回/日）
  const [usage, setUsage] = useState<Record<string, { used: number; limit: number }> | null>(null)
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const speechAvailable = !!getSpeechRecognition()

  // 閉じるときに音声認識を止める
  useEffect(() => () => { try { recRef.current?.stop() } catch { /* noop */ } }, [])

  // 開いたときに本日の利用状況を取得（回数は消費しない）
  useEffect(() => {
    if (!loggedIn) return
    fetch('/api/ai-usage').then(r => r.ok ? r.json() : null).then(d => { if (d && !d.error) setUsage(d) }).catch(() => {})
  }, [loggedIn])

  // API応答の remaining から利用状況を更新
  function noteRemaining(kind: 'add' | 'theme', remaining: number | undefined) {
    if (typeof remaining !== 'number') return
    setUsage(prev => {
      const limit = prev?.[kind]?.limit ?? (kind === 'add' ? 20 : 10)
      return { ...(prev ?? {}), [kind]: { used: Math.max(0, limit - remaining), limit } }
    })
  }
  const remainOf = (kind: 'add' | 'theme') =>
    usage?.[kind] ? Math.max(0, usage[kind].limit - usage[kind].used) : null

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
    setGroups(null); setUsHits([]); setUnmatched([]); setThemeItems(null); setOthers([])
    setChecked(new Set()); setHearts(new Set()); setError(''); setDoneMsg('')
  }

  // ── ことばで追加 ──
  async function runAdd() {
    const text = input.trim()
    if (!text || loading) return
    resetResults(); setLoading(true)
    try {
      // 銘柄コードの直書き（7203 や 285A 等）は LLM を介さずその場でマスタ照合
      // （旧「＋まとめて追加」のコード貼り付け運用はここに統合）
      const gs: AddGroup[] = []
      const seenCodes = new Set<string>()
      const codeTokens = (text.normalize('NFKC').toUpperCase().match(/(?<![0-9A-Z])\d{4}[A-Z]?(?![0-9A-Z])/g) ?? [])
      for (const code of codeTokens) {
        const rec = masterDB[code]
        if (!rec || seenCodes.has(code)) continue
        seenCodes.add(code)
        gs.push({ input: code, matches: [{ code, name: rec.name, market: rec.market, exact: true }] })
      }

      const res = await fetch('/api/ai-add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      })
      const d = (await res.json()) as { names?: string[]; us?: UsHit[]; usUnmatched?: string[]; remaining?: number; error?: string }
      if (!res.ok) { setError(d.error ?? `エラー（${res.status}）`); return }
      noteRemaining('add', d.remaining)
      // 日本株: クライアントで JPX マスタ照合（LLMにコードを答えさせない＝幻覚が登録に直結しない）
      const miss: string[] = [...(d.usUnmatched ?? [])]
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
      // 初期状態:
      //  - 登録済み銘柄 → いまの登録状態をそのまま反映（👁オン・♥は超お気に入りならオン）。その場で外すこともできる
      //  - 未登録 → 完全一致＋米国株（サーバー照合済み）は👁オン。あいまい一致は自動オンにしない
      //    ＝誤変換由来の別会社が勝手に選ばれる事故を防ぐ（本人フィードバック）
      const initEye = new Set<string>(); const initHeart = new Set<string>()
      const initFromCurrent = (code: string, defaultOn: boolean) => {
        if (favorites.has(code)) { initEye.add(code); if (superFavorites.has(code)) initHeart.add(code) }
        else if (defaultOn) initEye.add(code)
      }
      for (const g of gs) g.matches.forEach(m => initFromCurrent(m.code, m.exact))
      us.forEach(u => initFromCurrent(u.ticker, true))
      setChecked(initEye); setHearts(initHeart)
      if (gs.length === 0 && us.length === 0 && miss.length === 0) setError('文章から上場企業名を見つけられませんでした')
    } catch {
      setError('通信に失敗しました。もう一度お試しください')
    } finally { setLoading(false) }
  }

  // ── テーマでさがす（more=true なら表示済みを除外して追加読み込み）──
  async function runTheme(presetTheme?: string, more = false) {
    const theme = more ? themeLabel : (presetTheme ?? themeInput).trim()
    if (presetTheme) setThemeInput(presetTheme)
    if (!theme || loading || loadingMore) return
    const prevItems = more ? (themeItems ?? []) : []
    if (more) { setLoadingMore(true); setError(''); setDoneMsg('') } else { resetResults(); setLoading(true) }
    try {
      // 追加読み込み時は表示済みの社名＋コードを除外指定（同じ銘柄ばかり返るのを防ぐ）
      const exclude = prevItems.flatMap(i => [i.name, i.code])
      const res = await fetch('/api/ai-theme', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, exclude }),
      })
      const d = (await res.json()) as { items?: ThemeItem[]; unmatched?: string[]; others?: string[]; remaining?: number; error?: string }
      if (!res.ok) { setError(d.error ?? `エラー（${res.status}）`); return }
      noteRemaining('theme', d.remaining)
      if (!more || (d.others ?? []).length > 0) setOthers(d.others ?? [])
      const have = new Set(prevItems.map(i => i.code))
      const fresh = (d.items ?? []).filter(i => !have.has(i.code))
      const items = [...prevItems, ...fresh]
      setThemeItems(items); setUnmatched(d.unmatched ?? []); setThemeLabel(theme)
      // 登録済みは現状態を反映（未登録の自動オンはしない＝選んで追加）。選択中の分は維持
      setChecked(prev => {
        const next = more ? new Set(prev) : new Set<string>()
        for (const it of items) if (favorites.has(it.code)) next.add(it.code)
        return next
      })
      setHearts(prev => {
        const next = more ? new Set(prev) : new Set<string>()
        for (const it of items) if (favorites.has(it.code) && superFavorites.has(it.code)) next.add(it.code)
        return next
      })
      if (items.length === 0) setError('該当する上場銘柄が見つかりませんでした')
      else if (more && fresh.length === 0) setDoneMsg('これ以上の候補は見つかりませんでした')
    } catch {
      setError('通信に失敗しました。もう一度お試しください')
    } finally { setLoading(false); setLoadingMore(false) }
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

  // いま画面に出ている全銘柄コード（差分計算の対象）
  function displayedCodes(): string[] {
    if (mode === 'theme') return (themeItems ?? []).map(i => i.code)
    const codes: string[] = []
    for (const g of groups ?? []) for (const m of g.matches) codes.push(m.code)
    for (const u of usHits) codes.push(u.ticker)
    return codes
  }

  // 現在の登録状態との差分を計算（追加も解除もこの1ボタンでまとめて適用）
  function calcChanges(): AiMarkChanges {
    const c: AiMarkChanges = { addEye: [], removeEye: [], addHeart: [], removeHeart: [] }
    for (const code of displayedCodes()) {
      const eyeNow = favorites.has(code), heartNow = superFavorites.has(code)
      const eyeNext = checked.has(code), heartNext = hearts.has(code)
      if (eyeNext && !eyeNow) c.addEye.push(code)
      if (!eyeNext && eyeNow) c.removeEye.push(code)
      if (heartNext && !heartNow) c.addHeart.push(code)
      if (!heartNext && heartNow) c.removeHeart.push(code)
    }
    return c
  }
  const changes = calcChanges()
  const changeCount = changes.addEye.length + changes.removeEye.length + changes.addHeart.length + changes.removeHeart.length

  // 適用したらポップアップを閉じて確定（「変更なし」ボタンが残る分かりにくさを解消＝本人FB）
  function commitAdd(theme?: string) {
    if (changeCount === 0) return
    onApply(changes, theme)
    onClose()
  }

  // 米国株の社名表示（カナ切替対応）
  const usName = (name: string, kana: string | null) => (usKana && kana ? kana : name)
  const usSectionLabel = (
    <div className={styles.aiSectionLabel}>
      🇺🇸 米国株
      <button className={styles.aiKanaBtn} onClick={() => setUsKana(k => !k)}
        title="米国株の社名を英語⇄カタカナで切替">{usKana ? 'あ→A 英語表示' : 'A→あ カナ表示'}</button>
    </div>
  )

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
        className={`${styles.aiCandRow} ${checked.has(m.code) ? styles.aiCandRowOn : ''}`}
        onClick={() => toggleCheck(m.code)}>
        <span className={styles.aiCandName}>{m.name}</span>
        <span className={styles.aiCandCode}>{m.code}</span>
        <span className={styles.aiCandMkt}>{usBadge ? `🇺🇸 ${m.market}` : m.market.replace('市場', '')}</span>
        {isFav && <span className={styles.aiCandDoneBadge}>登録済み</span>}
        {markBtns(m.code)}
      </div>
    )
  }

  const commitBar = (theme?: string) => {
    const label = [
      changes.addEye.length > 0 ? `追加${changes.addEye.length}件` : '',
      changes.removeEye.length > 0 ? `解除${changes.removeEye.length}件` : '',
      (changes.addHeart.length > 0 || changes.removeHeart.length > 0) ? `♥変更${changes.addHeart.length + changes.removeHeart.length}件` : '',
    ].filter(Boolean).join('・')
    return (
      <>
        <div className={styles.aiHeartHint}>👁=ウォッチ ／ ♥=超お気に入り（銘柄管理のマークと同じ）。登録済みもここでオン/オフできます</div>
        <button className={styles.btnPrimary} onClick={() => commitAdd(theme)} disabled={changeCount === 0}>
          {changeCount === 0 ? '変更なし' : `✓ 適用する（${label}）`}
        </button>
      </>
    )
  }

  // テーマ結果: 日本株/米国株に分け、時価総額の大きい順のまま（登録済みも混ぜて状態マークで見せる＝本人FB）
  const themeJp = themeItems ? themeItems.filter(i => i.country === 'JP') : []
  const themeUs = themeItems ? themeItems.filter(i => i.country === 'US') : []

  const themeCard = (it: ThemeItem) => {
    const isFav = favorites.has(it.code)
    return (
      <div key={it.code}
        className={`${styles.aiThemeCard} ${checked.has(it.code) ? styles.aiThemeCardOn : ''}`}
        onClick={() => toggleCheck(it.code)}>
        <div className={styles.aiThemeCardHead}>
          <span className={styles.aiCandName}>{it.country === 'US' ? usName(it.name, it.nameKana) : it.name}</span>
          <span className={styles.aiCandCode}>{it.code}</span>
          <span className={styles.aiCandMkt}>{it.country === 'US' ? `🇺🇸 ${it.market}` : it.market.replace('市場', '')}</span>
          {isFav && <span className={styles.aiCandDoneBadge}>登録済み</span>}
          {markBtns(it.code)}
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
        {loggedIn && usage && (
          <div className={styles.aiUsageNote}>
            きょうの残り回数: ことばで追加 {remainOf('add') ?? '-'}/{usage.add?.limit ?? 20}回 ・ テーマ検索 {remainOf('theme') ?? '-'}/{usage.theme?.limit ?? 10}回（毎日0時リセット）
          </div>
        )}

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

            {loading && (
              <div className={styles.aiLoadingBox}>
                <span className={styles.aiSpinner} aria-hidden />
                文章から銘柄をAIが読み取っています…（数秒）
              </div>
            )}
            {error && <div className={styles.aiError}>{error}</div>}
            {doneMsg && <div className={styles.aiDone}>{doneMsg}</div>}

            {groups && (groups.length > 0 || usHits.length > 0) && (
              <div className={styles.aiResult}>
                <div className={styles.aiResultLabel}>見つかった銘柄（チェックした銘柄をまとめて追加します）</div>
                {groups.length > 0 && (
                  <>
                    {usHits.length > 0 && <div className={styles.aiSectionLabel}>🇯🇵 日本株</div>}
                    {groups.map(g => (
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
                    {usSectionLabel}
                    {usHits.map(u => checkRow({ code: u.ticker, name: usName(u.name, u.nameKana), market: u.market }, true))}
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
            {/* 文字入力なしでも使えるテーマのプルダウン（選んだ瞬間に検索。チップ羅列は廃止＝本人FB） */}
            <select
              className={styles.aiPresetSelect}
              value=""
              disabled={loading}
              onChange={e => { const t = e.target.value; if (t) runTheme(t) }}
              aria-label="テーマを選んで検索"
            >
              <option value="">📋 テーマを選んで検索（約100テーマ）</option>
              {THEME_GROUPS.map(g => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map(t => <option key={t} value={t}>{t}</option>)}
                </optgroup>
              ))}
            </select>

            {loading && (
              <div className={styles.aiLoadingBox}>
                <span className={styles.aiSpinner} aria-hidden />
                「{themeInput.trim() || themeLabel}」に関連する銘柄をAIが検索中…（10〜20秒かかります）
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
                    {usSectionLabel}
                    {themeUs.map(themeCard)}
                  </>
                )}
                {others.length > 0 && (
                  <div className={styles.aiOthersNote}>
                    📎 参考: このテーマでは {others.join('、')} など海外企業も主要プレーヤーです（本アプリは日本株・米国株のみ対応のため追加はできません）
                  </div>
                )}
                {unmatched.length > 0 && (
                  <div className={styles.aiUnmatched}>上場銘柄として確認できませんでした: {unmatched.join('、')}</div>
                )}
                {remainOf('theme') !== 0 ? (
                  <button className={styles.aiMoreBtn} onClick={() => runTheme(undefined, true)} disabled={loadingMore}>
                    {loadingMore ? <><span className={styles.aiSpinner} aria-hidden /> さらにさがしています…</> : `＋ さらにさがす（AI利用1回ぶん${remainOf('theme') !== null ? `・残り${remainOf('theme')}回` : ''}）`}
                  </button>
                ) : (
                  <div className={styles.aiUnmatched}>本日のテーマ検索の上限に達したため「さらにさがす」は明日また使えます</div>
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
