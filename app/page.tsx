'use client'
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  DEFAULT_WATCHLIST, StockRow, FinRecord, PriceRecord, MasterRecord, StockMeta,
  TabKey, StatusType, ALL_GENRE_OPTIONS, DEFAULT_GENRES,
} from './lib/types'
import {
  findLatestBizDate, fetchMaster, fetchPrices, fetchAnnouncements, fetchAllFinancials, fetchDailyBars, fetchFyEpsForCode,
} from './lib/api'
import { buildPerBand, PerBand, FyEps } from './lib/perBand'
import { buildStockRow, fmtN, fmtPct, pctClass, pctBg, pctCellColor, marketShort, daysSince, isDataStale } from './lib/format'
import styles from './page.module.css'
import { createClient } from './lib/supabase/client'

// ソートキー: StockRow の実キー＋ジャンル列用の擬似キー 'genre'
// （StockRow は genres:string[] のため、見出しクリックは「主ジャンル genres[0]」で並び替える）
type SortKeyEx = keyof StockRow | 'genre'

interface DropdownResult {
  code: string
  name: string
  matchType: 'code_name' | 'memo'
  memoSnippet?: string
}

function ls<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* quota */ }
}

// ── Supabase シングルトン（環境変数未設定時は null）────────────────
let _sbClient: ReturnType<typeof createClient> | null = null
function getSb() {
  if (typeof window === 'undefined') return null
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null
  if (!_sbClient) _sbClient = createClient()
  return _sbClient
}

function localDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
const CHART_CACHE_VER = 'v4'  // 期間変更のたびに変更してキャッシュを無効化
const STOCK_DATA_CACHE_KEY = 'stock_data_v2'
const CACHE_STALE_MS = 12 * 60 * 60 * 1000 // 12時間でstale判定
const GENRE_UNSET = '__UNSET__'              // ジャンル未設定フィルター用マーカー
function getChartCache(code: string, mode: string): unknown[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(`chart_cache_${CHART_CACHE_VER}_${code}_${mode}`)
    if (!raw) return null
    const { data, date } = JSON.parse(raw) as { data: unknown[]; date: string }
    if (date !== localDateStr()) return null
    return data
  } catch { return null }
}
function setChartCache(code: string, mode: string, data: unknown[]) {
  try {
    localStorage.setItem(`chart_cache_${CHART_CACHE_VER}_${code}_${mode}`, JSON.stringify({ data, date: localDateStr() }))
  } catch { /* quota exceeded */ }
}
function clearChartCaches() {
  if (typeof window === 'undefined') return
  try {
    Object.keys(localStorage).filter(k => k.startsWith('chart_cache_')).forEach(k => localStorage.removeItem(k))
  } catch { /* ignore */ }
}

// ── PERバンド（四季報式）キャッシュ：当日内は再計算しない ──────────────
const PER_BAND_CACHE_VER = 'v1'
function getPerBandCache(code: string): PerBand | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(`per_band_cache_${PER_BAND_CACHE_VER}_${code}`)
    if (!raw) return null
    const { band, date } = JSON.parse(raw) as { band: PerBand; date: string }
    if (date !== localDateStr()) return null
    return band
  } catch { return null }
}
function setPerBandCache(code: string, band: PerBand) {
  try {
    localStorage.setItem(`per_band_cache_${PER_BAND_CACHE_VER}_${code}`,
      JSON.stringify({ band, date: localDateStr() }))
  } catch { /* quota */ }
}
// FY EPS実績ヒストリーの当日キャッシュ（per-code取得を1日1回に抑える）
function getFyEpsCache(code: string): FyEps[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(`fyeps_cache_${PER_BAND_CACHE_VER}_${code}`)
    if (!raw) return null
    const { fyEps, date } = JSON.parse(raw) as { fyEps: FyEps[]; date: string }
    if (date !== localDateStr()) return null
    return fyEps
  } catch { return null }
}
function setFyEpsCache(code: string, fyEps: FyEps[]) {
  try {
    localStorage.setItem(`fyeps_cache_${PER_BAND_CACHE_VER}_${code}`,
      JSON.stringify({ fyEps, date: localDateStr() }))
  } catch { /* quota */ }
}

function fmtJpDate(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getFullYear()).slice(2)}年${d.getMonth() + 1}月${d.getDate()}日`
}

// 検索正規化: ひらがな→カタカナ + NFKC全角→半角 + 小文字化
function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .toLowerCase()
}

// ── Escape スタック（LIFO: 最後に開いたパネルのみ閉じる）────────────────
const _escapeStack: Array<() => void> = []
let _escapeListenerAttached = false
function initEscapeListener() {
  if (typeof document === 'undefined' || _escapeListenerAttached) return
  _escapeListenerAttached = true
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _escapeStack.length > 0) {
      e.preventDefault()
      _escapeStack[_escapeStack.length - 1]()
    }
  })
}
function useEscapeClose(open: boolean, close: () => void) {
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close }, [close])
  useEffect(() => {
    if (!open) return
    initEscapeListener()
    const fn = () => closeRef.current()
    _escapeStack.push(fn)
    return () => {
      const idx = _escapeStack.lastIndexOf(fn)
      if (idx >= 0) _escapeStack.splice(idx, 1)
    }
  }, [open])
}

// ── 初期化（マイグレーション含む）──────────────────────────────────────
function initFavorites(): Set<string> {
  if (typeof window === 'undefined') return new Set(DEFAULT_WATCHLIST)
  const favArr = ls<string[] | null>('favorites', null)
  // null または [] (ログインバグで空になった) は未設定扱いでフォールバック
  if (favArr !== null && favArr.length > 0) return new Set(favArr)
  // 旧 watchlist から移行
  const oldWl = ls<string[] | null>('watchlist', null)
  if (oldWl !== null && oldWl.length > 0) {
    const set = new Set<string>(oldWl)
    lsSet('favorites', Array.from(set))
    return set
  }
  return new Set(DEFAULT_WATCHLIST)
}

function initStockMeta(): Record<string, StockMeta> {
  if (typeof window === 'undefined') return {}
  let meta = ls<Record<string, StockMeta> | null>('stockMetadata', null)
  let needSave = false
  const removedGenres = ls<string[]>('removedDefaultGenres', [])

  if (meta === null) {
    // 旧 customGenres + memos から移行
    const oldGenres = ls<Record<string, string>>('customGenres', {})
    const oldMemos  = ls<Record<string, string>>('memos', {})
    meta = {}
    const allCodes = Array.from(new Set(Object.keys(oldGenres).concat(Object.keys(oldMemos))))
    for (const code of allCodes) {
      meta[code] = {
        genres: oldGenres[code] ? oldGenres[code].split(',').map(g => g.trim()).filter(Boolean) : [],
        memo:   oldMemos[code] ?? '',
      }
    }
    needSave = true
  }

  // DEFAULT_GENRESの初期化（一度だけ実行）— ジャンル未設定の銘柄にデフォルトを設定
  if (!ls<boolean>('metadataInitialized', false)) {
    for (const [code, genreStr] of Object.entries(DEFAULT_GENRES)) {
      if (!meta[code] || meta[code].genres.length === 0) {
        meta[code] = {
          genres: genreStr.split(',').map(g => g.trim()).filter(Boolean)
            .filter(g => !removedGenres.includes(g)),
          memo: meta[code]?.memo ?? '',
        }
      }
    }
    lsSet('metadataInitialized', true)
    needSave = true
  }

  // 毎回起動時: 削除済みジャンルが stockMeta に残っていればサニタイズ
  if (removedGenres.length > 0) {
    for (const [code, m] of Object.entries(meta)) {
      const cleaned = m.genres.filter(g => !removedGenres.includes(g))
      if (cleaned.length !== m.genres.length) {
        meta[code] = { ...m, genres: cleaned }
        needSave = true
      }
    }
  }

  if (needSave) lsSet('stockMetadata', meta)
  return meta
}

export default function Page() {
  const [mounted,    setMounted]    = useState(false)
  const [apiKey,     setApiKey]     = useState('')
  const [serverHasKey, setServerHasKey] = useState(false)
  const [favorites,  setFavorites]  = useState<Set<string>>(new Set())
  const favoritesRef = useRef<Set<string>>(new Set())
  const [superFavorites,    setSuperFavorites]    = useState<Set<string>>(new Set())
  const [stockMeta,  setStockMeta]  = useState<Record<string, StockMeta>>({})
  const [priceDB,    setPriceDB]    = useState<Record<string, PriceRecord>>({})
  const [finDB,      setFinDB]      = useState<Record<string, FinRecord>>({})
  const [perBandDB,  setPerBandDB]  = useState<Record<string, PerBand | null>>({})
  const [masterDB,   setMasterDB]   = useState<Record<string, MasterRecord>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [dataLoaded, setDataLoaded] = useState(false)   // このセッションで実際にデータ取得済みか
  const [status,     setStatus]     = useState<StatusType>('idle')
  const [statusMsg,  setStatusMsg]  = useState('準備中...')
  const [progress,   setProgress]   = useState(0)
  const [tab,        setTab]        = useState<TabKey>('dashboard')
  const [mktFilter,  setMktFilter]  = useState<string>('all')
  const [genreFilters, setGenreFilters] = useState<Set<string>>(new Set())
  const [mcapMin,    setMcapMin]    = useState<string>('')
  const [perFMax,    setPerFMax]    = useState<string>('')
  const [darkMode,   setDarkMode]   = useState<boolean>(true)
  const [showHelp,     setShowHelp]     = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDetail,   setShowDetail]   = useState(false)  // 詳細列の表示（判定設定の隣のボタンで切替）
  const [filterHeart,  setFilterHeart]  = useState(false)
  const [filterFav,    setFilterFav]    = useState(false)
  const [customGenreOptions, setCustomGenreOptions] = useState<string[]>([])
  const [removedDefaultGenres, setRemovedDefaultGenres] = useState<string[]>([])
  const [search,     setSearch]     = useState('')
  const [showDropdown,     setShowDropdown]     = useState(false)
  const [dropdownResults,  setDropdownResults]  = useState<DropdownResult[]>([])
  const [dropdownActive,   setDropdownActive]   = useState(-1)
  const [highlightCode,    setHighlightCode]    = useState<string | null>(null)
  const [sortKey,    setSortKey]    = useState<SortKeyEx | null>(null)
  const [sortDir,    setSortDir]    = useState<1|-1>(-1)
  const [detailCode, setDetailCode] = useState<string | null>(null)
  const [loading,    setLoading]    = useState(false)
  const [forcePc,    setForcePc]    = useState(false)
  const [isMobileView, setIsMobileView] = useState(false)
  const [chartRefreshKey, setChartRefreshKey] = useState(0)
  const [globalChartMode, setGlobalChartMode] = useState<ChartMode>('1year')
  const [earningsDates, setEarningsDates] = useState<Record<string,string>>({})
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showFilterBar, setShowFilterBar] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const abortSignalRef = useRef({ aborted: false })
  const autoFetchedRef = useRef(false)
  const bandFetchingRef = useRef(false)
  const perBandDBRef = useRef<Record<string, PerBand | null>>({})
  const priceDBRef = useRef<Record<string, PriceRecord>>({})
  const snapshotTriedRef = useRef(false)
  // Supabaseが設定されていれば、まずサーバー事前計算(snapshot)を試す間ライブ取得を抑止
  const liveSuppressedRef = useRef(
    !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  )
  const [bgFetching, setBgFetching] = useState(false)
  const cacheStaleRef = useRef(false)
  // ── 銘柄管理 Undo/Redo（★/♥操作のみ） ──────────────────────────
  const [undoStack, setUndoStack] = useState<Array<{fav: string[], sfav: string[]}>>([])
  const [redoStack, setRedoStack] = useState<Array<{fav: string[], sfav: string[]}>>([])


  // ── 銘柄管理フィルター状態（ツールバーと共有）────────────────────────
  const [wlSearch, setWlSearch] = useState('')
  const [wlShowFavOnly, setWlShowFavOnly] = useState(false)
  const [wlShowHeartOnly, setWlShowHeartOnly] = useState(false)
  const [wlMktF, setWlMktF] = useState<'all'|'prime'|'standard'|'growth'>('all')
  const [wlPage, setWlPage] = useState(1)
  const [wlShowBulkAdd, setWlShowBulkAdd] = useState(false)
  const [wlBulkText, setWlBulkText] = useState('')
  const [wlShowDropdown, setWlShowDropdown] = useState(false)
  const [wlDropdownResults, setWlDropdownResults] = useState<DropdownResult[]>([])
  const [wlDropdownActive, setWlDropdownActive] = useState(-1)
  const [wlFilteredCount, setWlFilteredCount] = useState(0)
  const wlSearchWrapRef = useRef<HTMLDivElement>(null)
  const wlScrollFnRef = useRef<((code: string) => void) | null>(null)

  // ── 認証ユーザー状態 ───────────────────────────────────────────────
  type AuthUser = { id: string; email?: string; name?: string; picture?: string }
  const [user, setUser] = useState<AuthUser | null>(null)
  const userRef = useRef<AuthUser | null>(null)
  useEffect(() => { userRef.current = user }, [user])
  const searchWrapRef  = useRef<HTMLDivElement>(null)

  useEffect(() => { favoritesRef.current = favorites }, [favorites])
  useEffect(() => { if (apiKey) lsSet('apiKey', apiKey) }, [apiKey])
  useEffect(() => { localStorage.setItem('darkMode', String(darkMode)) }, [darkMode])
  useEffect(() => { if (tab === 'dashboard' || tab === 'card') lsSet('preferredTab', tab) }, [tab])
  // レポート・銘柄管理タブに切り替えたらフィルターバーを自動で閉じる
  useEffect(() => { if (tab === 'report' || tab === 'watchlist' || tab === 'news') setShowFilterBar(false) }, [tab])

  // ── Ctrl+Z でタブ履歴を戻る ────────────────────────────────────────
  const [tabHistory, setTabHistory] = useState<TabKey[]>([])
  const prevTabRef = useRef<TabKey | null>(null)
  // タブ変更を履歴に積む（stale closure 不要なので useEffect で追跡）
  useEffect(() => {
    if (prevTabRef.current !== null && prevTabRef.current !== tab) {
      setTabHistory(prev => [...prev.slice(-19), prevTabRef.current!])
    }
    prevTabRef.current = tab
  }, [tab])
  // Ctrl+Z / Ctrl+Y キーハンドラー
  //  ・銘柄管理タブ: Ctrl+Z=元に戻す / Ctrl+Y（or Ctrl+Shift+Z）=やり直し（★/♥操作）
  //  ・それ以外: Ctrl+Z=直前のタブへ戻る（従来動作）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement
      // 入力欄内では標準のundoを邪魔しない
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      const k = e.key.toLowerCase()
      if (tabRef.current === 'watchlist') {
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); handleUndoRef.current() }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); handleRedoRef.current() }
        return
      }
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        setTabHistory(prev => {
          if (prev.length === 0) return prev
          const next = [...prev]
          const backTo = next.pop()!
          setTab(backTo)
          return next
        })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  useEffect(() => { lsSet('forcePc', forcePc) }, [forcePc])

  // ── ⋯ More Menu: 外クリックで閉じる ──────────────────────────────────
  useEffect(() => {
    if (!showMoreMenu) return
    function handler(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMoreMenu])

  // ── 銘柄管理検索ドロップダウン（ツールバー用）────────────────────────
  useEffect(() => {
    const allCodes = Object.keys(masterDB).sort()
    const q = normalizeSearchText(wlSearch.trim())
    const rawQ = wlSearch.trim().toLowerCase()
    if (!q) { setWlDropdownResults([]); setWlDropdownActive(-1); return }
    const timer = setTimeout(() => {
      const codeNameHits: DropdownResult[] = []
      const memoHits: DropdownResult[] = []
      for (const code of allCodes) {
        if (codeNameHits.length >= 5) break
        const rec = masterDB[code]
        if (!rec) continue
        if (normalizeSearchText(code + ' ' + rec.name).includes(q)) {
          codeNameHits.push({ code, name: rec.name, matchType: 'code_name' })
        }
      }
      for (const [code, meta] of Object.entries(stockMeta)) {
        if (memoHits.length >= 5) break
        if (!favorites.has(code) || !meta.memo) continue
        if (normalizeSearchText(meta.memo).includes(q)) {
          if (codeNameHits.some(r => r.code === code)) continue
          const rawIdx = meta.memo.toLowerCase().indexOf(rawQ)
          const idx = rawIdx >= 0 ? rawIdx : 0
          const start = Math.max(0, idx - 20)
          const end = Math.min(meta.memo.length, idx + Math.max(rawQ.length, 1) + 20)
          const snippet = (start > 0 ? '…' : '') + meta.memo.slice(start, end) + (end < meta.memo.length ? '…' : '')
          memoHits.push({ code, name: masterDB[code]?.name ?? '', matchType: 'memo', memoSnippet: snippet })
        }
      }
      setWlDropdownResults([...codeNameHits, ...memoHits])
      setWlDropdownActive(-1)
    }, 300)
    return () => clearTimeout(timer)
  }, [wlSearch, masterDB, stockMeta, favorites])

  useEffect(() => {
    function onOutsideDownWl(e: MouseEvent) {
      if (wlSearchWrapRef.current && !wlSearchWrapRef.current.contains(e.target as Node)) {
        setWlShowDropdown(false); setWlDropdownActive(-1)
      }
    }
    document.addEventListener('mousedown', onOutsideDownWl)
    return () => document.removeEventListener('mousedown', onOutsideDownWl)
  }, [])

  // ── Supabase: ★/♥/メモを DB からロード（ログイン時）────────────────
  const loadFromSupabase = useCallback(async (userId: string) => {
    const sb = getSb()
    if (!sb) return
    const [{ data: favData }, { data: memoData }] = await Promise.all([
      sb.from('favorites').select('code, type').eq('user_id', userId),
      sb.from('memos').select('*').eq('user_id', userId), // '*' なら genres 列が未追加でも400にならない
    ])
    if (favData) {
      const stars  = new Set(favData.filter(f => f.type === 'star').map(f => f.code as string))
      const hearts = new Set(favData.filter(f => f.type === 'heart').map(f => f.code as string))
      if (stars.size === 0 && hearts.size === 0) {
        // Supabase が空 = 初回ログイン → localStorage のデータを Supabase に移行
        const localStars  = ls<string[]>('favorites', [])
        const localHearts = ls<string[]>('superFavorites', [])
        // localStorage も空なら新規ユーザー → DEFAULT_WATCHLIST で初期化
        const effectiveStars = localStars.length > 0 ? localStars : DEFAULT_WATCHLIST
        const rows = [
          ...effectiveStars.map(code => ({ user_id: userId, code, type: 'star'  as const })),
          ...localHearts.map(code    => ({ user_id: userId, code, type: 'heart' as const })),
        ]
        await sb.from('favorites').upsert(rows)
        setFavorites(new Set(effectiveStars))
        lsSet('favorites', effectiveStars)
        console.log(`[Supabase移行] ★${effectiveStars.length}件 ♥${localHearts.length}件 をクラウドに保存しました`)
      } else {
        // Supabase にデータあり → 基本は Supabase のデータで同期
        setFavorites(stars)
        lsSet('favorites', Array.from(stars))
        if (hearts.size > 0) {
          // ♥ が Supabase にある → そのまま同期
          setSuperFavorites(hearts)
          lsSet('superFavorites', Array.from(hearts))
        } else {
          // ♥ が Supabase にない（★だけSQLで手動追加されたケース等）→ localStorage から移行を試みる
          const localHearts = ls<string[]>('superFavorites', [])
          if (localHearts.length > 0) {
            const heartRows = localHearts.map(code => ({ user_id: userId, code, type: 'heart' as const }))
            await sb.from('favorites').upsert(heartRows)
            setSuperFavorites(new Set(localHearts))
            console.log(`[Supabase移行] ♥${localHearts.length}件 をクラウドに保存しました`)
          }
          // localStorage も空の場合は何もしない
        }
      }
    }
    if (memoData) {
      if (memoData.length === 0) {
        // Supabase が空 = 初回ログイン → localStorage のメモを Supabase に移行
        const localMeta = ls<Record<string, StockMeta>>('stockMetadata', {})
        const memoRows = Object.entries(localMeta)
          .filter(([, meta]) => (meta.memo && meta.memo.trim()) || (meta.genres && meta.genres.length > 0))
          .map(([code, meta]) => ({ user_id: userId, code, memo: meta.memo ?? '', genres: meta.genres ?? [] }))
        if (memoRows.length > 0) {
          await sb.from('memos').upsert(memoRows)
          console.log(`[Supabase移行] メモ/ジャンル${memoRows.length}件 をクラウドに保存しました`)
        }
        // ローカルメモはそのまま維持
      } else {
        setStockMeta(prev => {
          const next = { ...prev }
          for (const m of memoData) {
            const code = m.code as string
            const cloudGenres = Array.isArray((m as { genres?: unknown }).genres) ? ((m as { genres: string[] }).genres) : null
            if (!next[code]) next[code] = { genres: cloudGenres ?? (DEFAULT_GENRES[code] ?? '').split(',').filter(Boolean), memo: '' }
            next[code] = {
              ...next[code],
              memo: m.memo as string,
              memoUpdatedAt: m.updated_at as string,
              // クラウドにジャンルがあれば正として反映（無ければローカルを維持）
              ...(cloudGenres && cloudGenres.length ? { genres: cloudGenres } : {}),
            }
          }
          lsSet('stockMetadata', next)
          return next
        })
      }
      // 既存ユーザーのジャンルをクラウドに後追い同期（ローカルにあってクラウドにまだ無い分）。
      // ドメイン移行などでローカルにしか無いジャンルを、次回以降どの端末でも残るようにする。
      const localMeta = ls<Record<string, StockMeta>>('stockMetadata', {})
      const cloudHasGenres = new Set(
        (memoData as { code: string; genres?: unknown }[])
          .filter(m => Array.isArray(m.genres) && (m.genres as unknown[]).length > 0)
          .map(m => m.code)
      )
      const backfill = Object.entries(localMeta)
        .filter(([code, meta]) => meta.genres && meta.genres.length > 0 && !cloudHasGenres.has(code))
        .map(([code, meta]) => ({ user_id: userId, code, memo: meta.memo ?? '', genres: meta.genres }))
      if (backfill.length > 0) {
        sb.from('memos').upsert(backfill).then(() => {
          console.log(`[Supabase] ローカルのジャンル${backfill.length}件をクラウドに後追い保存しました`)
        })
      }
    }
  }, [])

  // ── Supabase: 認証リスナー ──────────────────────────────────────────
  useEffect(() => {
    const sb = getSb()
    if (!sb) return
    sb.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        const u = { id: session.user.id, email: session.user.email, name: session.user.user_metadata?.full_name ?? session.user.email, picture: session.user.user_metadata?.avatar_url ?? session.user.user_metadata?.picture }
        setUser(u)
        loadFromSupabase(session.user.id)
      }
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        const u = { id: session.user.id, email: session.user.email, name: session.user.user_metadata?.full_name ?? session.user.email, picture: session.user.user_metadata?.avatar_url ?? session.user.user_metadata?.picture }
        setUser(u)
        if (event === 'SIGNED_IN') loadFromSupabase(session.user.id)
      } else {
        setUser(null)
      }
    })
    return () => subscription.unsubscribe()
  }, [loadFromSupabase])

  // localStorage からの読み込みを一箇所に集約し、最後に mounted = true でコンテンツを表示
  useEffect(() => {
    const savedDark = localStorage.getItem('darkMode')
    if (savedDark !== null) setDarkMode(savedDark !== 'false')
    setFavorites(initFavorites())
    setApiKey(ls('apiKey', ''))
    setLastUpdate(ls('lastUpdate', ''))
    setCustomGenreOptions(ls('customGenreOptions', []))
    setRemovedDefaultGenres(ls('removedDefaultGenres', []))
    setEarningsDates(ls('earningsDates', {}))
    setSuperFavorites(new Set(ls<string[]>('superFavorites', [])))
    setStockMeta(initStockMeta())
    // 表示モード: 保存済み優先、なければ画面幅で自動判定
    const savedTab = ls<string>('preferredTab', '')
    if (savedTab === 'card' || savedTab === 'dashboard') {
      setTab(savedTab as TabKey)
    } else if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setTab('card')
    }
    setForcePc(ls('forcePc', false))
    setIsMobileView(typeof window !== 'undefined' && window.innerWidth < 768)

    // ── 前回取得データをキャッシュから即時復元（UX高速化）────────────
    try {
      const cached = ls<{
        priceDB: Record<string, PriceRecord>
        finDB: Record<string, FinRecord>
        masterDB: Record<string, MasterRecord>
        bizDate: string; fetchedAt: number
      } | null>(STOCK_DATA_CACHE_KEY, null)
      if (cached && cached.fetchedAt && cached.priceDB) {
        setPriceDB(cached.priceDB)
        setFinDB(cached.finDB)
        setMasterDB(cached.masterDB)
        setLastUpdate(cached.bizDate)
        setDataLoaded(true)
        setStatus('ok')
        const ageMs = Date.now() - cached.fetchedAt
        const ageH = Math.floor(ageMs / 3600000)
        const isStale = ageMs >= CACHE_STALE_MS
        setStatusMsg(isStale
          ? `キャッシュ表示中 (基準日: ${cached.bizDate}) — バックグラウンドで更新します`
          : `キャッシュ表示中 (${ageH < 1 ? '1時間以内' : ageH + '時間前'}取得 / 基準日: ${cached.bizDate})`)
        if (isStale) cacheStaleRef.current = true
      }
    } catch { /* cache corrupt, ignore */ }

    setMounted(true)
    // サーバー側に JQUANTS_API_KEY が設定されているか確認
    fetch('/api/has-key').then(r => r.json()).then((d: { hasKey: boolean }) => {
      if (d.hasKey) {
        setServerHasKey(true)
      }
    }).catch(() => {})
  }, [])

  // ── 全銘柄マスタ（銘柄管理タブ用） ────────────────────────────────
  useEffect(() => {
    if (tab === 'watchlist' && Object.keys(masterDB).length === 0) {
      fetch('/api/listed-info')
        .then(r => r.json())
        .then((data: Record<string, { name: string; market: string }>) => {
          const db: Record<string, MasterRecord> = {}
          for (const [code, rec] of Object.entries(data)) {
            if (rec.name && rec.market) db[code] = rec
          }
          setMasterDB(db)
        })
        .catch(e => console.error('[listed-info]', e))
    }
  }, [tab])

  // ── データ取得 ────────────────────────────────────────────────────
  const fetchAll = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false
    if (!apiKey.trim() && !serverHasKey) { if (!silent) alert('APIキーを入力してください'); return }
    if (loading || bgFetching) {
      if (!silent) abortSignalRef.current.aborted = true
      return
    }
    abortSignalRef.current = { aborted: false }
    if (!silent) setLoading(true)
    else setBgFetching(true)
    setStatus('loading')
    const startTime = Date.now()
    const st = (msg: string, pct: number) => {
      if (pct > 5 && pct < 100) {
        const elapsed = (Date.now() - startTime) / 1000
        const estimated = elapsed / (pct / 100)
        const remaining = Math.ceil(estimated - elapsed)
        const remStr = remaining > 3 ? ` (残約${remaining < 60 ? remaining + '秒' : Math.ceil(remaining/60) + '分'})` : ''
        setStatusMsg(msg + remStr)
      } else { setStatusMsg(msg) }
      setProgress(pct)
    }
    try {
      st('最新営業日を確認中...', 5)
      const { dateStr, dateDisp } = await findLatestBizDate(apiKey)

      const currentFavorites = Array.from(favoritesRef.current)
      const total = currentFavorites.length

      st('株価データ取得中...', 10)
      const prices = await fetchPrices(apiKey, currentFavorites, dateStr, (msg) => st(msg, 15))
      setPriceDB({ ...prices })

      st('銘柄マスタ取得中 (JPX)...', 28)
      const master = await fetchMaster(apiKey, currentFavorites)
      setMasterDB(master)

      st(`財務データ取得中... (全${total}銘柄)`, 40)
      const { finDB: fins, shOutDB: localShOut, aborted } = await fetchAllFinancials(
        apiKey,
        currentFavorites,
        (done, total) => {
          st(`財務データ取得中... (${done}/${total})`, 40 + Math.round((done / total) * 45))
          setFinDB(prev => ({ ...prev }))
        },
        (msg) => setStatusMsg(msg),
        abortSignalRef.current
      )

      if (aborted) {
        st('中断しました', 0)
        setStatus('idle')
        setLoading(false)
        setTimeout(() => setProgress(0), 800)
        return
      }

      const gotCount = Object.keys(fins).length
      setFinDB({ ...fins })

      for (const [code, sh] of Object.entries(localShOut)) {
        if (prices[code]?.close) prices[code].mcap = Math.round(prices[code].close * sh / 1e8)
      }
      setPriceDB({ ...prices })

      st('決算予定日取得中...', 92)
      const announcements = await fetchAnnouncements(apiKey, currentFavorites)
      for (const [code, date] of Object.entries(announcements)) {
        if (fins[code]) fins[code] = { ...fins[code], nextAnnouncementDate: date }
      }
      setFinDB({ ...fins })
      setLastUpdate(dateDisp)
      setDataLoaded(true)
      lsSet('lastUpdate', dateDisp)
      lsSet('apiKey', apiKey)
      // ── 取得データをlocalStorageにキャッシュ保存（次回即時表示用）──
      try {
        lsSet(STOCK_DATA_CACHE_KEY, { priceDB: prices, finDB: fins, masterDB: master, bizDate: dateDisp, fetchedAt: Date.now() })
      } catch { /* quota */ }
      cacheStaleRef.current = false
      const missing = currentFavorites.filter(c => !fins[c])
      const failMsg = missing.length > 0 ? ` (未取得${missing.length}銘柄)` : ''
      const elapsedSec = Math.round((Date.now() - startTime) / 1000)
      const elapsedStr = elapsedSec < 60 ? `${elapsedSec}秒` : `${Math.floor(elapsedSec/60)}分${elapsedSec%60}秒`
      st(`完了 — ${gotCount}/${total}銘柄取得 基準日: ${dateDisp}${failMsg} (所要${elapsedStr})`, 100)
      setStatus('ok')
      clearChartCaches()
      setChartRefreshKey(k => k + 1)
      if (!silent) setTab('dashboard')  // バックグラウンド更新時はタブ維持
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatusMsg(`エラー: ${msg}`)
      setStatus('error')
    } finally {
      if (!silent) setLoading(false)
      else setBgFetching(false)
      setTimeout(() => setProgress(0), 1200)
    }
  }, [apiKey, serverHasKey, loading, bgFetching])

  // ── PERバンド（四季報式）をバックグラウンド計算 ───────────────────────
  // finDB と favorites が揃ったら、♥優先で3年日次株価を取得しバンドを算出。
  // 当日キャッシュがある銘柄はスキップ。重さは並列数で律速。
  // perBandDB/priceDB は ref 経由で読み、再トリガーのチャーンを避ける。
  perBandDBRef.current = perBandDB
  priceDBRef.current = priceDB
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!serverHasKey && !apiKey.trim()) return
    if (Object.keys(finDB).length === 0) return
    if (bandFetchingRef.current) return

    // 表示対象（★）を ♥優先で並べ、まだバンド未確定の銘柄を抽出
    const heart = Array.from(superFavorites)
    const rest  = Array.from(favorites).filter(c => !superFavorites.has(c))
    const ordered = [...heart, ...rest]

    const cachedUpdates: Record<string, PerBand | null> = {}
    const need: string[] = []
    for (const code of ordered) {
      if (code in perBandDBRef.current) continue   // 既に算出済み（このセッション）
      const cached = getPerBandCache(code)
      if (cached) { cachedUpdates[code] = cached; continue }
      need.push(code)   // fyEpsの有無は算出時に解決（♥は履歴を取りに行く）
    }
    if (Object.keys(cachedUpdates).length > 0) setPerBandDB(prev => ({ ...prev, ...cachedUpdates }))
    if (need.length === 0) return

    bandFetchingRef.current = true
    let cancelled = false
    const today = new Date()
    const from = new Date(today); from.setFullYear(from.getFullYear() - 1); from.setDate(from.getDate() - 14)  // 直近1年（営業日確保で+2週）
    const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
    const fromStr = fmt(from), toStr = fmt(today)
    const CONCURRENCY = 5

    // fyEps を解決：①一括取得ぶん ②当日キャッシュ ③不足なら個別取得で補完（全銘柄対象）
    async function resolveFyEps(code: string): Promise<FyEps[]> {
      const fromBulk = finDB[code]?.fyEps ?? []
      if (fromBulk.length >= 2) return fromBulk
      const cached = getFyEpsCache(code)
      if (cached && cached.length >= 1) return cached
      try {
        const fetched = await fetchFyEpsForCode(code, apiKey)
        if (fetched.length > 0) { setFyEpsCache(code, fetched); return fetched }
      } catch { /* fall through */ }
      return fromBulk
    }

    ;(async () => {
      for (let i = 0; i < need.length; i += CONCURRENCY) {
        if (cancelled) break
        const batch = need.slice(i, i + CONCURRENCY)
        const results = await Promise.all(batch.map(async code => {
          try {
            const fyEps = await resolveFyEps(code)
            if (fyEps.length === 0) return { code, band: null as PerBand | null }
            const daily = await fetchDailyBars(code, fromStr, toStr, apiKey)
            const close = priceDBRef.current[code]?.close ?? 0
            const feps = finDB[code]?.feps ?? null
            const fwdPER = (close && feps) ? close / feps : null
            const band = buildPerBand(daily, fyEps, fwdPER)
            return { code, band }
          } catch { return { code, band: null as PerBand | null } }
        }))
        if (cancelled) break
        const updates: Record<string, PerBand | null> = {}
        for (const r of results) {
          updates[r.code] = r.band
          if (r.band) setPerBandCache(r.code, r.band)
        }
        setPerBandDB(prev => ({ ...prev, ...updates }))
      }
      bandFetchingRef.current = false
    })()

    return () => { cancelled = true; bandFetchingRef.current = false }
  }, [finDB, favorites, superFavorites, apiKey, serverHasKey])

  // ── Phase3: サーバー事前計算(snapshot)を読んで即時表示。成功すればライブ取得を回避 ──
  useEffect(() => {
    if (!mounted || snapshotTriedRef.current) return
    snapshotTriedRef.current = true
    const sb = getSb()
    if (!sb) { liveSuppressedRef.current = false; return }
    ;(async () => {
      try {
        const [snapRes, metaRes, listed] = await Promise.all([
          sb.from('stock_snapshot').select('code, price, fin, per_band, biz_date'),
          sb.from('snapshot_meta').select('biz_date, count, updated_at').eq('id', 1).maybeSingle(),
          fetch('/api/listed-info').then(r => r.ok ? r.json() : {}).catch(() => ({})),
        ])
        const rows = (snapRes.data ?? []) as { code: string; price: PriceRecord; fin: FinRecord | null; per_band: PerBand | null; biz_date: string }[]
        if (rows.length === 0) { liveSuppressedRef.current = false; if (!autoFetchedRef.current && (serverHasKey || apiKey.trim())) { autoFetchedRef.current = true; fetchAll(dataLoaded ? { silent: true } : undefined) } return }
        const pDB: Record<string, PriceRecord> = {}, fDB: Record<string, FinRecord> = {}, bDB: Record<string, PerBand | null> = {}
        for (const r of rows) { pDB[r.code] = r.price ?? { close: 0 }; if (r.fin) fDB[r.code] = r.fin; bDB[r.code] = r.per_band ?? null }
        const mDB: Record<string, MasterRecord> = {}
        for (const [code, rec] of Object.entries(listed as Record<string, { name: string; market: string }>)) if (rec?.name && rec?.market) mDB[code] = rec
        setPriceDB(pDB); setFinDB(fDB); setPerBandDB(bDB)
        if (Object.keys(mDB).length) setMasterDB(mDB)
        const meta = metaRes.data as { biz_date?: string; updated_at?: string } | null
        const biz = meta?.biz_date ?? rows[0]?.biz_date ?? ''
        setLastUpdate(biz); setDataLoaded(true); setStatus('ok'); cacheStaleRef.current = false
        autoFetchedRef.current = true   // サーバー版で表示済み → 自動ライブ取得は抑止（再読込ボタンで手動更新可）
        const upd = meta?.updated_at ? new Date(meta.updated_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
        setStatusMsg(`サーバー更新済み (${rows.length}銘柄 / 基準日 ${biz}${upd ? ` / ${upd}更新` : ''}) — 毎平日16:30に自動更新（引け後の決算開示・データ反映を待つため）。最新が必要なら「再読込」`)
      } catch (e) {
        console.warn('[snapshot] 読込失敗 → ライブ取得にフォールバック', e)
        liveSuppressedRef.current = false
        if (!autoFetchedRef.current && (serverHasKey || apiKey.trim())) { autoFetchedRef.current = true; fetchAll(dataLoaded ? { silent: true } : undefined) }
      }
    })()
  }, [mounted, serverHasKey, apiKey, dataLoaded, fetchAll])

  // ── 自動更新: ページ読み込み時にデータ取得（キャッシュがある場合はバックグラウンド更新）
  useEffect(() => {
    if (!mounted) return               // マウント完了を待つ
    if (liveSuppressedRef.current) return // Supabase事前計算を試行中/採用中 → ライブ取得しない
    if (autoFetchedRef.current) return // 1度だけ実行
    if (loading || bgFetching) return  // すでに取得中
    if (!serverHasKey && !apiKey.trim()) return  // APIキーがない場合は待機
    if (dataLoaded && !cacheStaleRef.current) return // 新鮮なキャッシュあり → 自動取得不要
    autoFetchedRef.current = true
    // キャッシュがある（stale）→ silent=true でバックグラウンド更新、なければ通常取得
    fetchAll(dataLoaded ? { silent: true } : undefined)
  }, [mounted, serverHasKey, apiKey, dataLoaded, loading, bgFetching, fetchAll])

  // ── Supabase 同期ヘルパー ─────────────────────────────────────────
  function sbSyncFav(code: string, type: 'star' | 'heart', add: boolean) {
    const u = userRef.current; const sb = getSb()
    if (!u || !sb) return
    if (add) sb.from('favorites').upsert({ user_id: u.id, code, type }).then(() => {})
    else sb.from('favorites').delete().eq('user_id', u.id).eq('code', code).eq('type', type).then(() => {})
  }
  // メモ＋ジャンルをまとめてSupabaseに同期（ドメイン/端末をまたいで残る）
  function sbSyncMeta(code: string, meta: StockMeta) {
    const u = userRef.current; const sb = getSb()
    if (!u || !sb) return
    sb.from('memos').upsert({ user_id: u.id, code, memo: meta.memo ?? '', genres: meta.genres ?? [], updated_at: new Date().toISOString() }).then(() => {})
  }
  // 一括ジャンル操作（改名/削除）後に、ローカルの最新ジャンルをまとめてクラウドへ反映
  function sbSyncAllMetaFromLS() {
    const u = userRef.current; const sb = getSb()
    if (!u || !sb) return
    const meta = ls<Record<string, StockMeta>>('stockMetadata', {})
    const rows = Object.entries(meta)
      .filter(([, m]) => (m.genres && m.genres.length > 0) || (m.memo && m.memo.trim()))
      .map(([code, m]) => ({ user_id: u.id, code, memo: m.memo ?? '', genres: m.genres ?? [] }))
    for (let i = 0; i < rows.length; i += 200) sb.from('memos').upsert(rows.slice(i, i + 200)).then(() => {})
  }

  // 手動の最新取得（重い・数分）。確認ポップで時点と所要を伝えてから実行
  function handleManualRefresh() {
    setShowMoreMenu(false)
    if (loading || bgFetching) return
    const ok = window.confirm(
      `最新の株価・財務を取得して更新しますか？\n\n`
      + `・いま表示中: ${lastUpdate || '—'} 時点のデータ\n`
      + `・取得には数分（目安5〜8分）かかります\n`
      + `・完了するまで今の表示のまま使えます\n\n`
      + `※通常は毎平日16:30に自動更新されるので、急ぎでなければ押す必要はありません。`
    )
    if (ok) fetchAll()
  }

  // テーマ切替：切替の一瞬だけ全トランジションを無効化して即時に切り替える
  function toggleTheme() {
    if (typeof document !== 'undefined') {
      document.body.classList.add('themeSwitching')
      requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('themeSwitching')))
    }
    setDarkMode(d => !d)
  }

  // ── お気に入り操作 ────────────────────────────────────────────────
  function pushUndo() {
    setUndoStack(prev => [...prev.slice(-9), { fav: Array.from(favorites), sfav: Array.from(superFavorites) }])
    setRedoStack([])
  }
  function applyFavSnapshot(snapshot: {fav: string[], sfav: string[]}, prevFav: Set<string>, prevSFav: Set<string>) {
    const newFav  = new Set(snapshot.fav)
    const newSFav = new Set(snapshot.sfav)
    // 変更分だけ Supabase 同期
    for (const code of new Set([...Array.from(prevFav), ...snapshot.fav])) {
      if (prevFav.has(code) !== newFav.has(code)) sbSyncFav(code, 'star', newFav.has(code))
    }
    for (const code of new Set([...Array.from(prevSFav), ...snapshot.sfav])) {
      if (prevSFav.has(code) !== newSFav.has(code)) sbSyncFav(code, 'heart', newSFav.has(code))
    }
    setFavorites(newFav);    lsSet('favorites',      snapshot.fav)
    setSuperFavorites(newSFav); lsSet('superFavorites', snapshot.sfav)
  }
  function handleUndo() {
    if (undoStack.length === 0) return
    const snapshot = undoStack[undoStack.length - 1]
    setRedoStack(rd => [...rd, { fav: Array.from(favorites), sfav: Array.from(superFavorites) }])
    applyFavSnapshot(snapshot, favorites, superFavorites)
    setUndoStack(ud => ud.slice(0, -1))
  }
  function handleRedo() {
    if (redoStack.length === 0) return
    const snapshot = redoStack[redoStack.length - 1]
    setUndoStack(ud => [...ud, { fav: Array.from(favorites), sfav: Array.from(superFavorites) }])
    applyFavSnapshot(snapshot, favorites, superFavorites)
    setRedoStack(rd => rd.slice(0, -1))
  }
  // キーボードショートカット(Ctrl+Z/Y)から最新の関数/タブを参照するためのref
  const handleUndoRef = useRef(handleUndo); handleUndoRef.current = handleUndo
  const handleRedoRef = useRef(handleRedo); handleRedoRef.current = handleRedo
  const tabRef = useRef(tab); tabRef.current = tab
  function toggleFavorite(code: string) {
    pushUndo()
    setFavorites(prev => {
      const next = new Set(prev)
      const adding = !next.has(code)
      if (adding) next.add(code); else next.delete(code)
      lsSet('favorites', Array.from(next))
      sbSyncFav(code, 'star', adding)
      return next
    })
  }
  function toggleSuperFavorite(code: string) {
    pushUndo()
    const isSuper = superFavorites.has(code)
    if (!isSuper && !favorites.has(code)) {
      // ★と♥を同時に追加する場合は pushUndo が2回呼ばれないよう直接 setFavorites
      setFavorites(prev => {
        const next = new Set(prev); next.add(code)
        lsSet('favorites', Array.from(next))
        sbSyncFav(code, 'star', true)
        return next
      })
    }
    setSuperFavorites(prev => {
      const next = new Set(prev)
      const adding = !next.has(code)
      if (adding) next.add(code); else next.delete(code)
      lsSet('superFavorites', Array.from(next))
      sbSyncFav(code, 'heart', adding)
      return next
    })
  }

  // ── StockMeta 操作 ────────────────────────────────────────────────
  function saveStockMeta(code: string, meta: StockMeta) {
    setStockMeta(prev => {
      const next = { ...prev, [code]: meta }
      lsSet('stockMetadata', next)
      return next
    })
    sbSyncMeta(code, meta) // メモ＋ジャンルをクラウドへ
  }

  // ── allRows（★銘柄のみ） ──────────────────────────────────────────
  const allRows = useMemo(
    () => Array.from(favorites).map(code => buildStockRow(code, priceDB, finDB, masterDB, stockMeta, perBandDB)),
    [favorites, priceDB, finDB, masterDB, stockMeta, perBandDB]
  )

  const maxDiscDate = useMemo(() => {
    const dates = Object.values(finDB).map(f => f.discDate).filter(Boolean)
    return dates.length > 0 ? [...dates].sort().at(-1)! : ''
  }, [finDB])

  const filteredRows = useMemo(() => {
    const q = normalizeSearchText(search.trim())
    let rows = allRows.filter(r => {
      if (q) {
        const norm = normalizeSearchText(r.code + ' ' + r.name)
        const memoNorm = normalizeSearchText(stockMeta[r.code]?.memo ?? '')
        if (!norm.includes(q) && !memoNorm.includes(q)) return false
      }
      if (filterHeart && !superFavorites.has(r.code)) return false
      if (filterFav   && !favorites.has(r.code))      return false
      if (mktFilter !== 'all' && marketShort(r.market).cls !== mktFilter) return false
      if (genreFilters.size > 0) {
        const matchRegular = r.genres.some(g => genreFilters.has(g))
        const matchUnset = genreFilters.has(GENRE_UNSET) && r.genres.length === 0
        if (!matchRegular && !matchUnset) return false
      }
      if (mcapMin !== '' && r.mcap < parseFloat(mcapMin)) return false
      if (perFMax !== '' && (r.perF == null || r.perF > parseFloat(perFMax))) return false
      return true
    })
    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        // ジャンル列: 各銘柄の「主ジャンル（1つ目のタグ）」でグルーピング。未設定は常に末尾、同ジャンル内はコード順
        if (sortKey === 'genre') {
          const ag = a.genres[0] ?? ''
          const bg = b.genres[0] ?? ''
          if (!ag && !bg) return a.code.localeCompare(b.code)
          if (!ag) return 1
          if (!bg) return -1
          const c = ag.localeCompare(bg, 'ja') * sortDir
          return c !== 0 ? c : a.code.localeCompare(b.code)
        }
        const av = a[sortKey]
        const bv = b[sortKey]
        if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * sortDir
        const an = (av as number) ?? (sortDir > 0 ? Infinity : -Infinity)
        const bn = (bv as number) ?? (sortDir > 0 ? Infinity : -Infinity)
        return (an - bn) * sortDir
      })
    }
    return rows
  }, [allRows, search, stockMeta, filterHeart, filterFav, superFavorites, favorites, mktFilter, genreFilters, mcapMin, perFMax, sortKey, sortDir])

  // ── 検索ドロップダウン候補生成（debounce 300ms）────────────────────
  useEffect(() => {
    const q = normalizeSearchText(search.trim())
    const rawQ = search.trim().toLowerCase()
    if (!q) { setDropdownResults([]); setDropdownActive(-1); return }
    const timer = setTimeout(() => {
      const codeNameHits: DropdownResult[] = []
      const memoHits: DropdownResult[] = []
      for (const r of allRows) {
        if (codeNameHits.length >= 5) break
        if (normalizeSearchText(r.code).includes(q) || normalizeSearchText(r.name).includes(q)) {
          codeNameHits.push({ code: r.code, name: r.name, matchType: 'code_name' })
        }
      }
      for (const [code, meta] of Object.entries(stockMeta)) {
        if (memoHits.length >= 5) break
        if (!favorites.has(code) || !meta.memo) continue
        if (normalizeSearchText(meta.memo).includes(q)) {
          if (codeNameHits.some(r => r.code === code)) continue
          const rawIdx = meta.memo.toLowerCase().indexOf(rawQ)
          const idx = rawIdx >= 0 ? rawIdx : 0
          const start = Math.max(0, idx - 20)
          const end = Math.min(meta.memo.length, idx + Math.max(rawQ.length, 1) + 20)
          const snippet = (start > 0 ? '…' : '') + meta.memo.slice(start, end) + (end < meta.memo.length ? '…' : '')
          memoHits.push({ code, name: masterDB[code]?.name ?? '', matchType: 'memo', memoSnippet: snippet })
        }
      }
      setDropdownResults([...codeNameHits, ...memoHits])
      setDropdownActive(-1)
    }, 300)
    return () => clearTimeout(timer)
  }, [search, allRows, stockMeta, masterDB, favorites])

  useEffect(() => {
    if (!highlightCode) return
    const el = document.querySelector<HTMLElement>(`tr[data-code="${highlightCode}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setHighlightCode(null), 2500)
    return () => clearTimeout(timer)
  }, [highlightCode])

  useEffect(() => {
    function onOutsideDown(e: MouseEvent) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setShowDropdown(false); setDropdownActive(-1)
      }
    }
    document.addEventListener('mousedown', onOutsideDown)
    return () => document.removeEventListener('mousedown', onOutsideDown)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setShowHelp(false); setShowSettings(false) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const stats = useMemo(() => ({
    total: allRows.length,
    up:    allRows.filter(r => (r.chg1d ?? 0) > 0).length,
    down:  allRows.filter(r => (r.chg1d ?? 0) < 0).length,
  }), [allRows])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (filterHeart) n++
    if (filterFav) n++
    if (mktFilter !== 'all') n++
    if (genreFilters.size > 0) n++
    if (mcapMin || perFMax) n++
    return n
  }, [filterHeart, filterFav, mktFilter, genreFilters, mcapMin, perFMax])

  function handleSort(key: SortKeyEx) {
    if (sortKey === key) setSortDir(d => d === 1 ? -1 : 1)
    // ジャンルは昇順(あ→ん)でグルーピングするのが自然なので初期方向を +1 に
    else { setSortKey(key); setSortDir(key === 'genre' ? 1 : -1) }
  }

  function clearAllFilters() {
    setMktFilter('all'); setGenreFilters(new Set())
    setMcapMin(''); setPerFMax(''); setSortKey(null); setSortDir(-1)
  }

  function scrollToAndHighlight(code: string) {
    clearAllFilters()
    setSearch(''); setShowDropdown(false); setDropdownActive(-1)
    setHighlightCode(null)
    setTimeout(() => setHighlightCode(code), 0)
  }

  // 候補 = 既定(除外済みを引く) ＋ カスタム ＋ 実際に銘柄で使われているジャンル。
  // 「銘柄にはAI・半導体が付いてるのに候補に出ない」等の不連動を自己修復する。
  const allGenreOptions = useMemo(() => {
    const set = new Set<string>([
      ...ALL_GENRE_OPTIONS.filter(g => !removedDefaultGenres.includes(g)),
      ...customGenreOptions,
    ])
    for (const m of Object.values(stockMeta)) {
      for (const g of (m.genres ?? [])) if (!removedDefaultGenres.includes(g)) set.add(g)
    }
    return Array.from(set)
  }, [removedDefaultGenres, customGenreOptions, stockMeta])

  function addGenreOption(name: string) {
    const trimmed = name.trim()
    if (!trimmed || allGenreOptions.includes(trimmed)) return
    const next = [...customGenreOptions, trimmed]
    setCustomGenreOptions(next); lsSet('customGenreOptions', next)
  }

  function removeGenreOption(name: string) {
    setGenreFilters(prev => { if (!prev.has(name)) return prev; const n = new Set(prev); n.delete(name); return n })
    setStockMeta(prev => {
      const next = { ...prev }
      // 明示的に設定されたジャンルから削除
      for (const [code, meta] of Object.entries(next)) {
        if (meta.genres.includes(name)) {
          next[code] = { ...meta, genres: meta.genres.filter(g => g !== name) }
        }
      }
      // DEFAULT_GENRESのフォールバックを使っていた銘柄も明示的に更新
      for (const [code, genreStr] of Object.entries(DEFAULT_GENRES)) {
        const defaults = genreStr.split(',').map(g => g.trim()).filter(Boolean)
        if (defaults.includes(name)) {
          const existing = next[code]
          if (!existing || existing.genres.length === 0) {
            next[code] = { genres: defaults.filter(g => g !== name), memo: existing?.memo ?? '' }
          }
        }
      }
      lsSet('stockMetadata', next)
      return next
    })
    if (customGenreOptions.includes(name)) {
      const next = customGenreOptions.filter(g => g !== name)
      setCustomGenreOptions(next); lsSet('customGenreOptions', next)
    } else {
      const next = [...removedDefaultGenres, name]
      setRemovedDefaultGenres(next); lsSet('removedDefaultGenres', next)
    }
    setTimeout(sbSyncAllMetaFromLS, 0) // 変更後のジャンルをクラウドへ
  }

  function renameGenre(oldName: string, newName: string) {
    const trimmed = newName.replace(/[\s　]+/g, ' ').trim()
    if (!trimmed || trimmed === oldName) return

    // ① stockMeta 一括置換（Set で重複排除）
    setStockMeta(prev => {
      const next = { ...prev }
      for (const [code, meta] of Object.entries(next)) {
        if (meta.genres.includes(oldName)) {
          const replaced = meta.genres.map(g => g === oldName ? trimmed : g)
          next[code] = { ...meta, genres: Array.from(new Set(replaced)) }
        }
      }
      lsSet('stockMetadata', next)
      return next
    })

    // ② + ③ removedDefaultGenres / customGenreOptions を一括計算（state 競合防止）
    const isCustom = customGenreOptions.includes(oldName)
    let nextRemoved = [...removedDefaultGenres]
    let nextCustom  = customGenreOptions.filter(g => g !== oldName)

    if (!isCustom) {
      nextRemoved = [...nextRemoved, oldName]
    }

    // 変更後のリストで新名の存在確認
    const visibleAfter = ALL_GENRE_OPTIONS
      .filter(g => !nextRemoved.includes(g))
      .concat(nextCustom)
    if (!visibleAfter.includes(trimmed)) {
      if (ALL_GENRE_OPTIONS.includes(trimmed)) {
        // ハードコード元から復活（removedDefaultGenres から除去）
        nextRemoved = nextRemoved.filter(g => g !== trimmed)
      } else {
        nextCustom = [...nextCustom, trimmed]
      }
    }

    setRemovedDefaultGenres(nextRemoved); lsSet('removedDefaultGenres', nextRemoved)
    setCustomGenreOptions(nextCustom);    lsSet('customGenreOptions',    nextCustom)
    setTimeout(sbSyncAllMetaFromLS, 0) // 改名後のジャンルをクラウドへ
  }

  function saveMemo(code: string, text: string) {
    const prev = stockMeta[code] ?? { genres: [], memo: '' }
    const trimmed = text.trim()
    saveStockMeta(code, {
      ...prev,
      memo: text,
      memoUpdatedAt: trimmed ? new Date().toISOString() : undefined,
    }) // saveStockMeta内でメモ＋ジャンルをSupabaseへ同期
  }
  function saveEarningsDate(code: string, date: string) {
    const next = { ...earningsDates, [code]: date }
    setEarningsDates(next); lsSet('earningsDates', next)
  }

  async function exportToExcel() {
    const XLSX = await import('xlsx')
    const rows: string[][] = Array.from(favorites).map(code => {
      const meta = stockMeta[code] ?? { genres: [], memo: '' }
      const master = masterDB[code] ?? { name: '', market: '' }
      return [code, master.name, master.market, meta.genres.join(','), meta.memo]
    })
    const ws = XLSX.utils.aoa_to_sheet([['コード','銘柄名','市場','ジャンル','メモ'], ...rows])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'お気に入り')
    const date = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `kabu-favorites-${date}.xlsx`)
  }

  const detailRow = detailCode ? buildStockRow(detailCode, priceDB, finDB, masterDB, stockMeta, perBandDB) : null
  const detailFin = detailCode ? finDB[detailCode] : null

  return (
    <div className={`${styles.root}${darkMode ? '' : ' ' + styles.lightMode}`}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo} onClick={() => setTab('dashboard')} style={{cursor:'pointer'}}>
            <svg width="24" height="24" viewBox="0 0 64 64" style={{flexShrink:0}} aria-hidden="true">
              <defs>
                <linearGradient id="hdrRing" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#818cf8"/><stop offset="1" stopColor="#3b82f6"/>
                </linearGradient>
              </defs>
              <circle cx="32" cy="32" r="19" fill="none" stroke="url(#hdrRing)" strokeWidth="5"
                      strokeLinecap="round" strokeDasharray="104 30" transform="rotate(125 32 32)"/>
              <polyline points="21,40 28,32 34,36 43,23" fill="none" stroke="#34d399"
                        strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="43" cy="23" r="3.8" fill="#34d399"/>
            </svg>
            株式<span>ウォッチ</span>
          </div>
          <div className={styles.lastUpdate}>{lastUpdate ? <><span className={styles.todayLabel}>本日</span><strong>{lastUpdate}</strong></> : '未取得'}{maxDiscDate && <span className={styles.discDateLabel}>財務 {maxDiscDate}</span>}{stats.total > 0 && <span style={{marginLeft:10,fontSize:12,fontWeight:600,letterSpacing:'0.02em',whiteSpace:'nowrap',flexShrink:0}}>
            <span style={{color:'#ef4444'}}>❤{superFavorites.size}</span>
            <span style={{color:'rgba(200,200,220,0.4)',margin:'0 4px'}}>·</span>
            <span style={{color:'#fbbf24'}}>★{favorites.size}</span>
          </span>}</div>
        </div>
        <div className={styles.headerRight}>
          {!apiKey && !serverHasKey && (
            <button className={styles.apiKeyWarning} onClick={() => setShowSettings(true)} title="⚙ をクリックしてAPIキーを設定してください">
              ⚙ APIキー未設定
            </button>
          )}
          {loading && <span className={styles.btnSecondary} style={{cursor:'default'}}>更新中…</span>}
          <button className={`${styles.btnSecondary} ${tab === 'watchlist' ? styles.btnSecondaryActive : ''}`} onClick={() => setTab(tab === 'watchlist' ? 'dashboard' : 'watchlist')}>銘柄管理</button>
          {/* ⋯ More Menu */}
          <div ref={moreMenuRef} style={{position:'relative'}}>
            <button
              className={styles.moreBtn}
              onClick={() => setShowMoreMenu(m => !m)}
              title="その他のメニュー"
            >メニュー</button>
            {showMoreMenu && (
              <div className={styles.moreMenu}>
                <button className={styles.moreMenuItem} onClick={handleManualRefresh} disabled={loading || bgFetching}>
                  <span>↺</span> 最新に更新（数分かかる）
                </button>
                <button className={styles.moreMenuItem} onClick={() => { setShowHelp(h => !h); setShowMoreMenu(false) }}>
                  <span className={styles.helpBadge}>?</span> ヘルプ
                </button>
                <button className={styles.moreMenuItem} onClick={() => { setShowSettings(s => !s); setShowMoreMenu(false) }}>
                  <span>⚙️</span> APIキー設定
                </button>
                <button className={styles.moreMenuItem} onClick={() => { toggleTheme(); setShowMoreMenu(false) }}>
                  <span>{darkMode ? '☀️' : '🌙'}</span> {darkMode ? 'ライトモード' : 'ダークモード'}
                </button>
                {isMobileView && (
                  <button className={styles.moreMenuItem} onClick={() => { setForcePc(f => !f); setShowMoreMenu(false) }}>
                    <span>{forcePc ? '📱' : '🖥'}</span>
                    {forcePc ? 'SP版に戻す' : 'PC版表示に切替'}
                  </button>
                )}
                <button className={styles.moreMenuItem} onClick={() => { exportToExcel(); setShowMoreMenu(false) }}>
                  <span>📥</span> ★リストをExcel保存
                </button>
              </div>
            )}
          </div>
          {/* ── ログイン/ログアウト（Supabase設定済みの場合のみ表示）── */}
          {getSb() && (
            user ? (
              <UserMenu user={user} onLogout={() => getSb()?.auth.signOut()} />
            ) : (
              <button
                className={styles.loginBtn}
                onClick={() => getSb()?.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/auth/callback` } })}
                title="Googleアカウントでログインするとスマホ/PCでデータが同期されます"
              >
                🔑 ログイン
              </button>
            )
          )}
        </div>
      </header>

      <div className={styles.toolbar} data-toolbar="">
        {tab !== 'watchlist' && tab !== 'report' && tab !== 'news' && (
          <div className={styles.searchWrap} ref={searchWrapRef}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              className={styles.searchInput}
              placeholder="銘柄名・コード・メモ検索..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              onKeyDown={e => {
                if (!showDropdown || !search.trim()) return
                if (e.key === 'ArrowDown') { e.preventDefault(); setDropdownActive(i => Math.min(i + 1, dropdownResults.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setDropdownActive(i => Math.max(i - 1, 0)) }
                else if (e.key === 'Escape') { setShowDropdown(false); setDropdownActive(-1) }
                else if (e.key === 'Enter' && dropdownResults[dropdownActive]) { scrollToAndHighlight(dropdownResults[dropdownActive].code) }
              }}
            />
            <SearchDropdown
              results={dropdownResults}
              activeIndex={dropdownActive}
              visible={showDropdown && search.trim().length > 0}
              onSelect={code => scrollToAndHighlight(code)}
            />
          </div>
        )}
        {tab !== 'watchlist' && tab !== 'report' && tab !== 'news' && (
          <>
            <button
              className={`${styles.filterToggleBtn} ${(showFilterBar || activeFilterCount > 0) ? styles.filterToggleBtnActive : ''}`}
              onClick={() => setShowFilterBar(f => !f)}
            >
              {activeFilterCount > 0 ? `フィルター(${activeFilterCount}) ${showFilterBar ? '▲' : '▼'}` : `フィルター ${showFilterBar ? '▲' : '▼'}`}
            </button>
            <button
              className={`${styles.filterToggleBtn} ${showDetail ? styles.filterToggleBtnActive : ''}`}
              onClick={() => setShowDetail(s => !s)}
              title="時価総額・PBR・ROE・営業利益率・配当・EPS成長率 の表示を切替"
              style={{padding:'4px 10px'}}
            >{showDetail ? '指標を絞る' : '＋ 詳細指標'}</button>
          </>
        )}
        {tab === 'card' && (
          <div className={styles.chartModeGroup}>
            {(['3months','1year','3years'] as ChartMode[]).map(m => (
              <button key={m}
                className={`${styles.chartModePill} ${globalChartMode === m ? styles.chartModePillActive : ''}`}
                onClick={() => setGlobalChartMode(m)}>
                {m === '3months' ? '3ヶ月' : m === '1year' ? '1年' : '3年'}
              </button>
            ))}
          </div>
        )}
        {tab === 'watchlist' && (
          <>
            {/* SP行1: ← 一覧 + 検索窓（full-width on SP） */}
            <div className={styles.wlTbRow1}>
              <button
                className={`${styles.btnSecondary} ${styles.spOnly}`}
                onClick={() => setTab('card')}
                style={{flexShrink:0, whiteSpace:'nowrap'}}
              >← 一覧</button>
              <div className={styles.wlToolbarSearch} ref={wlSearchWrapRef}>
                <input
                  className={styles.wlHeaderSearch}
                  placeholder="🔍 銘柄検索（複数は , 区切りで一括登録）"
                  value={wlSearch}
                  onChange={e => { setWlSearch(e.target.value); setWlShowDropdown(true); setWlPage(1) }}
                  onFocus={() => setWlShowDropdown(true)}
                  onBlur={() => setTimeout(() => setWlShowDropdown(false), 150)}
                  onKeyDown={e => {
                    // カンマ区切り一括登録: "7203,6758" + Enter
                    if (e.key === 'Enter' && wlSearch.includes(',')) {
                      e.preventDefault()
                      const codes = wlSearch.split(/[,，\s　]+/).map(s => s.trim()).filter(Boolean)
                      if (codes.length > 0) {
                        pushUndo()
                        const toAdd = codes.filter(c => masterDB[c] && !favorites.has(c))
                        if (toAdd.length > 0) {
                          setFavorites(prev => {
                            const next = new Set(prev)
                            toAdd.forEach(c => { next.add(c); sbSyncFav(c, 'star', true) })
                            lsSet('favorites', Array.from(next))
                            return next
                          })
                        }
                        setWlSearch(''); setWlPage(1); setWlShowDropdown(false)
                        return
                      }
                    }
                    if (!wlShowDropdown || !wlSearch.trim()) return
                    if (e.key === 'ArrowDown') { e.preventDefault(); setWlDropdownActive(i => Math.min(i + 1, wlDropdownResults.length - 1)) }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setWlDropdownActive(i => Math.max(i - 1, 0)) }
                    else if (e.key === 'Escape') { setWlShowDropdown(false); setWlDropdownActive(-1) }
                    else if (e.key === 'Enter') { const ti = wlDropdownActive >= 0 ? wlDropdownActive : 0; if (wlDropdownResults[ti]) { wlScrollFnRef.current?.(wlDropdownResults[ti].code); setWlShowDropdown(false) } }
                  }}
                />
                <SearchDropdown
                  results={wlDropdownResults}
                  activeIndex={wlDropdownActive}
                  visible={wlShowDropdown && wlSearch.trim().length > 0}
                  onSelect={code => { wlScrollFnRef.current?.(code); setWlShowDropdown(false) }}
                  onToggleFavorite={toggleFavorite}
                  favorites={favorites}
                />
              </div>
            </div>
            {/* SP行2: ♥ ★ 市場 件数 ↩ ↪ */}
            <div className={styles.wlTbRow2}>
              <button
                className={`${styles.wlIconFilterBtn} ${styles.wlIconFilterBtnHeart} ${wlShowHeartOnly ? styles.wlIconFilterBtnHeartActive : ''}`}
                onClick={() => { setWlShowHeartOnly(h => !h); setWlPage(1) }}
                title="超お気に入り（♥）のみ表示"
              >♥</button>
              <button
                className={`${styles.wlIconFilterBtn} ${wlShowFavOnly ? styles.wlIconFilterBtnActive : ''}`}
                onClick={() => { setWlShowFavOnly(f => !f); setWlPage(1) }}
                title="お気に入りのみ表示"
              >★</button>
              <div className={styles.wlMktSegment}>
                {(['all','prime','standard','growth'] as const).map(k => (
                  <button key={k}
                    className={`${styles.wlMktBtn} ${styles['wlMktBtn_' + k]} ${wlMktF === k ? styles.wlMktBtnActive : ''}`}
                    onClick={() => { setWlMktF(k); setWlPage(1) }}
                  >{{all:'全市場',prime:'Prime',standard:'Standard',growth:'Growth'}[k]}</button>
                ))}
              </div>
              <span className={styles.wlHeaderCount}>{wlFilteredCount}件</span>
            </div>
          </>
        )}
        <div className={styles.spacer} />
        <div className={`${styles.tabGroup} ${styles.spHide}`}>
          {(['dashboard','card','news','report'] as TabKey[]).map(t => (
            <button
              key={t}
              className={`${styles.tabBtn} ${tab === t ? styles.tabBtnActive : ''}`}
              onClick={() => setTab(t)}
            >
              {{ dashboard:'ダッシュボード', card:'カード', news:'ニュース', report:'レポート' }[t as 'dashboard'|'card'|'news'|'report']}
            </button>
          ))}
        </div>
      </div>

      {showFilterBar && tab !== 'watchlist' && (
        <div className={styles.filterBar}>
          {/* 1行にまとめて余白を減らす（折り返しあり） */}
          <div className={styles.filterBarRow}>
            <div className={styles.filterGroup}>
              <button
                className={`${styles.filterBtn} ${styles.heartFilterBtn} ${filterHeart ? styles.heartFilterBtnActive : ''}`}
                onClick={() => setFilterHeart(h => !h)}
                title="超お気に入り（♥）銘柄のみ表示"
              >♥</button>
              <button
                className={`${styles.filterBtn} ${styles.starFilterBtn} ${filterFav ? styles.starFilterBtnActive : ''}`}
                onClick={() => setFilterFav(f => !f)}
                title="お気に入り（★）銘柄のみ表示"
              >★</button>
            </div>
            <div className={styles.filterDivider} />
            <div className={styles.filterGroup}>
              {(['all','prime','standard','growth'] as const).map(k => (
                <button key={k}
                  className={`${styles.filterBtn} ${styles['mktBtn_'+k]} ${mktFilter === k ? styles.filterBtnActive : ''}`}
                  onClick={() => setMktFilter(k)}
                >{{all:'全市場',prime:'Prime',standard:'Standard',growth:'Growth'}[k]}</button>
              ))}
            </div>
            <div className={styles.filterDivider} />
            <div className={styles.filterGenreWrap}>
              <span className={styles.filterPanelLabel}>ジャンル</span>
              <GenreFilterDropdown
                label="ジャンルを選ぶ"
                genres={allGenreOptions}
                activeFilters={genreFilters}
                onApply={setGenreFilters}
                onClear={() => setGenreFilters(new Set())}
              />
              {genreFilters.size > 0 && (
                <div className={styles.filterGenreChips}>
                  {Array.from(genreFilters).map(g => (
                    <span key={g} className={styles.filterGenreActiveChip} onClick={() => setGenreFilters(prev => { const n = new Set(prev); n.delete(g); return n })}>
                      {g === GENRE_UNSET ? '未設定' : g} <span className={styles.filterGenreChipX}>×</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className={styles.filterDivider} />
            <label className={styles.filterPanelLabel}>時価総額(億)以上</label>
            <input type="number" className={styles.filterPanelInput} placeholder="例: 500"
              value={mcapMin} onChange={e => setMcapMin(e.target.value)} />
            <label className={styles.filterPanelLabel}>PER今期以下</label>
            <input type="number" className={styles.filterPanelInput} placeholder="例: 30"
              value={perFMax} onChange={e => setPerFMax(e.target.value)} />
            <button className={styles.filterPanelClear}
              onClick={() => { setMktFilter('all'); setGenreFilters(new Set()); setMcapMin(''); setPerFMax(''); setFilterHeart(false); setFilterFav(false) }}>
              全クリア
            </button>
          </div>
        </div>
      )}

      <main className={styles.main} style={{ visibility: mounted ? 'visible' : 'hidden' }}>
        {/* SP専用メモ重視ビュー（ウォッチリスト以外のタブで表示） */}
        {tab !== 'watchlist' && tab !== 'news' && (
          <div className={forcePc ? styles.forceMobileOff : styles.mobileOnly}>
            <div className={styles.spMemoList}>
              {filteredRows.length === 0
                ? <div className={styles.emptyCell}>該当銘柄なし</div>
                : filteredRows.map(r => (
                  <SpMemoCard
                    key={r.code}
                    row={r}
                    memo={stockMeta[r.code]?.memo ?? ''}
                    memoUpdatedAt={stockMeta[r.code]?.memoUpdatedAt}
                    onSaveMemo={saveMemo}
                    isFav={favorites.has(r.code)}
                    isSuperFav={superFavorites.has(r.code)}
                    onToggleFav={toggleFavorite}
                    onToggleSuperFav={toggleSuperFavorite}
                  />
                ))
              }
            </div>
          </div>
        )}

        {tab === 'dashboard' && (
          <div className={forcePc ? styles.forcePcOn : styles.pcOnly}>
            {/* SP上でposition:stickyなtheadOuterがdisplay:none親から脱走するiOS Safariバグ対策: isMobileView時は非レンダリング */}
            {(!isMobileView || forcePc) && (
              <DashboardTable
                filteredRows={filteredRows}
                finDB={finDB}
                earningsDates={earningsDates}
                onSaveEarningsDate={saveEarningsDate}
                sortKey={sortKey}
                sortDir={sortDir}
                handleSort={handleSort}
                onRowClick={(code) => setDetailCode(code)}
                highlightCode={highlightCode}
                superFavorites={superFavorites}
                onToggleSuperFav={toggleSuperFavorite}
                showDetail={showDetail}
              />
            )}
          </div>
        )}

        {tab === 'card' && (
          <div className={forcePc ? styles.forcePcOn : styles.pcOnly}>
            <div className={styles.cardGrid}>
              {filteredRows.map(r => (
                <StockCard key={r.code} row={r} apiKey={apiKey} serverHasKey={serverHasKey} onClick={() => setDetailCode(r.code)} refreshKey={chartRefreshKey} chartMode={globalChartMode} onChartModeChange={setGlobalChartMode} />
              ))}
            </div>
          </div>
        )}

        {tab === 'report' && (
          <WeeklyReport
            allRows={allRows}
            finDB={finDB}
            favorites={favorites}
            superFavorites={superFavorites}
            onClickCode={(code) => setDetailCode(code)}
          />
        )}

        {tab === 'news' && (
          <NewsFeed
            heartCodes={Array.from(superFavorites)}
            starCodes={Array.from(favorites)}
            nameOf={(code) => allRows.find(r => r.code === code)?.name || masterDB[code]?.name || code}
            onClickCode={(code) => setDetailCode(code)}
          />
        )}

        {tab === 'watchlist' && (
          <StockManager
            masterDB={masterDB}
            favorites={favorites}
            superFavorites={superFavorites}
            stockMeta={stockMeta}
            allGenreOptions={allGenreOptions}
            onToggleFavorite={toggleFavorite}
            onToggleSuperFav={toggleSuperFavorite}
            onSaveStockMeta={saveStockMeta}
            onAddGenre={addGenreOption}
            onRemoveGenre={removeGenreOption}
            onRenameGenre={renameGenre}
            onExport={exportToExcel}
            earningsDates={earningsDates}
            onSaveEarningsDate={saveEarningsDate}
            wlSearch={wlSearch}
            setWlSearch={setWlSearch}
            showFavOnly={wlShowFavOnly}
            setShowFavOnly={setWlShowFavOnly}
            showHeartOnly={wlShowHeartOnly}
            setShowHeartOnly={setWlShowHeartOnly}
            mktF={wlMktF}
            setMktF={setWlMktF}
            page={wlPage}
            setPage={setWlPage}
            showBulkAdd={wlShowBulkAdd}
            setShowBulkAdd={setWlShowBulkAdd}
            bulkText={wlBulkText}
            setBulkText={setWlBulkText}
            wlShowDropdown={wlShowDropdown}
            wlDropdownResults={wlDropdownResults}
            wlDropdownActive={wlDropdownActive}
            setWlDropdownActive={setWlDropdownActive}
            onFilteredCountChange={setWlFilteredCount}
            onRegisterScrollFn={(fn) => { wlScrollFnRef.current = fn }}
          />
        )}
      </main>

      {detailCode && detailRow && (
        <div className={styles.detailOverlay} onClick={e => { if (e.target === e.currentTarget) setDetailCode(null) }}>
          <div className={styles.detailPanel}>
            <button className={styles.detailClose} onClick={() => setDetailCode(null)}>×</button>
            <DetailPanel
              row={detailRow}
              fin={detailFin}
              memo={stockMeta[detailCode]?.memo ?? ''}
              memoUpdatedAt={stockMeta[detailCode]?.memoUpdatedAt}
              onSaveMemo={text => saveMemo(detailCode!, text)}
              apiKey={apiKey}
              serverHasKey={serverHasKey}
              earningsDate={earningsDates[detailCode] ?? ''}
              onSaveEarningsDate={date => saveEarningsDate(detailCode!, date)}
              chartMode={globalChartMode}
              onChartModeChange={setGlobalChartMode}
            />
          </div>
        </div>
      )}

      <HelpPanel visible={showHelp} onClose={() => setShowHelp(false)} />
      <SettingsPanel
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        serverHasKey={serverHasKey}
      />

      <ScrollTopButton />
      <div className={`${styles.statusBar} ${(loading || bgFetching) ? styles.statusBarLoading : ''}`}>
        <div className={`${styles.statusDot} ${
          status === 'loading' ? styles.statusLoading :
          status === 'error'   ? styles.statusError   : ''
        }`} />
        <span>{bgFetching ? '🔄 バックグラウンド更新中...' : statusMsg}</span>
        <div className={styles.spacer} />
        {progress > 0 && progress < 100 && (
          <div className={styles.progressWrap}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* SP専用: 固定ボトムナビ（PCでは非表示） */}
      <BottomNav tab={tab} onSelect={setTab} />
    </div>
  )
}

// ─── StockManager（銘柄管理画面）────────────────────────────────────
const PER_PAGE = 100

function StockManager({
  masterDB, favorites, superFavorites, stockMeta,
  allGenreOptions: managedGenreOptions,
  onToggleFavorite, onToggleSuperFav, onSaveStockMeta, onAddGenre, onRemoveGenre, onRenameGenre, onExport,
  earningsDates, onSaveEarningsDate,
  wlSearch, setWlSearch,
  showFavOnly, setShowFavOnly,
  showHeartOnly, setShowHeartOnly,
  mktF, setMktF,
  page, setPage,
  showBulkAdd, setShowBulkAdd,
  bulkText, setBulkText,
  wlShowDropdown, wlDropdownResults, wlDropdownActive, setWlDropdownActive,
  onFilteredCountChange, onRegisterScrollFn,
}: {
  masterDB: Record<string, MasterRecord>
  favorites: Set<string>
  superFavorites: Set<string>
  stockMeta: Record<string, StockMeta>
  allGenreOptions: string[]
  onToggleFavorite: (code: string) => void
  onToggleSuperFav: (code: string) => void
  onSaveStockMeta: (code: string, meta: StockMeta) => void
  onAddGenre: (name: string) => void
  onRemoveGenre: (name: string) => void
  onRenameGenre: (oldName: string, newName: string) => void
  onExport: () => void
  earningsDates: Record<string, string>
  onSaveEarningsDate: (code: string, date: string) => void
  wlSearch: string
  setWlSearch: React.Dispatch<React.SetStateAction<string>>
  showFavOnly: boolean
  setShowFavOnly: React.Dispatch<React.SetStateAction<boolean>>
  showHeartOnly: boolean
  setShowHeartOnly: React.Dispatch<React.SetStateAction<boolean>>
  mktF: string
  setMktF: React.Dispatch<React.SetStateAction<'all'|'prime'|'standard'|'growth'>>
  page: number
  setPage: React.Dispatch<React.SetStateAction<number>>
  showBulkAdd: boolean
  setShowBulkAdd: React.Dispatch<React.SetStateAction<boolean>>
  bulkText: string
  setBulkText: React.Dispatch<React.SetStateAction<string>>
  wlShowDropdown: boolean
  wlDropdownResults: DropdownResult[]
  wlDropdownActive: number
  setWlDropdownActive: React.Dispatch<React.SetStateAction<number>>
  onFilteredCountChange: (count: number) => void
  onRegisterScrollFn: (fn: (code: string) => void) => void
}) {
  const [wlHighlightCode,   setWlHighlightCode]   = useState<string | null>(null)

  const allCodes = useMemo(() => Object.keys(masterDB).sort(), [masterDB])

  const allGenreOptions = useMemo(() => {
    const set = new Set<string>()
    Object.values(stockMeta).forEach(meta => {
      meta?.genres?.forEach(g => set.add(g))
    })
    return Array.from(set).sort()
  }, [stockMeta])

  const [genreFilters, setGenreFilters] = useState<Set<string>>(new Set())

  const filteredCodes = useMemo(() => {
    const q = normalizeSearchText(wlSearch.trim())
    return allCodes.filter(code => {
      const rec = masterDB[code]
      if (!rec) return false
      if (showFavOnly   && !favorites.has(code))      return false
      if (showHeartOnly && !superFavorites.has(code)) return false
      if (mktF === 'prime'    && !rec.market.includes('プライム'))     return false
      if (mktF === 'standard' && !rec.market.includes('スタンダード')) return false
      if (mktF === 'growth'   && !rec.market.includes('グロース'))     return false
      if (genreFilters.size > 0) {
        const genres = stockMeta[code]?.genres ?? []
        const matchRegular = genres.some(g => genreFilters.has(g))
        const matchUnset = genreFilters.has(GENRE_UNSET) && genres.length === 0
        if (!matchRegular && !matchUnset) return false
      }
      if (q && !normalizeSearchText(code + ' ' + rec.name).includes(q)) return false
      return true
    })
  }, [allCodes, masterDB, favorites, superFavorites, showFavOnly, showHeartOnly, mktF, wlSearch, genreFilters, stockMeta])

  useEffect(() => {
    if (!wlHighlightCode) return
    const el = document.querySelector<HTMLElement>(`[data-code-wl="${wlHighlightCode}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setWlHighlightCode(null), 2500)
    return () => clearTimeout(timer)
  }, [wlHighlightCode])

  const handleRename = useCallback((oldName: string, rawNewName: string) => {
    const trimmed = rawNewName.replace(/[\s　]+/g, ' ').trim()
    if (trimmed && trimmed !== oldName) {
      onRenameGenre(oldName, rawNewName)
      setGenreFilters(prev => {
        if (!prev.has(oldName)) return prev
        const next = new Set(prev)
        next.delete(oldName)
        next.add(trimmed)
        return next
      })
    }
  }, [onRenameGenre])

  function scrollToWlRow(code: string) {
    setWlDropdownActive(-1)

    // ★/♥フィルターで対象銘柄が除外されている場合、フィルターを解除
    if (showFavOnly && !favorites.has(code)) setShowFavOnly(false)
    if (showHeartOnly && !superFavorites.has(code)) setShowHeartOnly(false)

    let idx = filteredCodes.indexOf(code)

    if (idx < 0) {
      // wlSearch テキストフィルターで除外されているケース（メモ検索結果等）
      // wlSearch を除いた現在のフィルター条件でインデックスを再計算してからクリア
      const noSearchCodes = allCodes.filter(c => {
        const rec = masterDB[c]
        if (!rec) return false
        // フィルター解除後の状態を考慮
        if (mktF === 'prime'    && !rec.market.includes('プライム'))     return false
        if (mktF === 'standard' && !rec.market.includes('スタンダード')) return false
        if (mktF === 'growth'   && !rec.market.includes('グロース'))     return false
        if (genreFilters.size > 0) {
          const genres = stockMeta[c]?.genres ?? []
          const matchRegular = genres.some(g => genreFilters.has(g))
          const matchUnset = genreFilters.has(GENRE_UNSET) && genres.length === 0
          if (!matchRegular && !matchUnset) return false
        }
        return true
      })
      idx = noSearchCodes.indexOf(code)
      setWlSearch('')
    }

    if (idx >= 0) setPage(Math.floor(idx / PER_PAGE) + 1)
    setWlHighlightCode(null)
    setTimeout(() => setWlHighlightCode(code), 0)
  }

  useEffect(() => { onFilteredCountChange(filteredCodes.length) }, [filteredCodes.length, onFilteredCountChange])

  // stale closure 対策: レンダーごとに最新の scrollToWlRow を ref に保持し、
  // 安定したラッパー関数を一度だけ登録する
  const scrollFnLatestRef = useRef(scrollToWlRow)
  scrollFnLatestRef.current = scrollToWlRow  // 毎レンダーで最新化（同期的に更新）

  useEffect(() => {
    onRegisterScrollFn((code) => scrollFnLatestRef.current(code))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 安定ラッパーを初回のみ登録

  const totalPages = Math.max(1, Math.ceil(filteredCodes.length / PER_PAGE))
  const pageCodes = filteredCodes.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  function renderPageNums() {
    const pages: number[] = []
    const start = Math.max(1, Math.min(totalPages - 4, page - 2))
    for (let i = start; i <= Math.min(totalPages, start + 4); i++) pages.push(i)
    return pages
  }

  return (
    <div className={styles.wlManager}>
      {/* 一括登録パネル */}
      {showBulkAdd && (
        <div className={styles.bulkAddPanel}>
          <div className={styles.bulkAddLabel}>
            銘柄コードを改行またはカンマ区切りで貼り付け → ★に一括追加します
          </div>
          <textarea
            className={styles.bulkAddTextarea}
            placeholder={'例:\n7203\n6758, 9984\n4063'}
            value={bulkText}
            onChange={e => setBulkText(e.target.value)}
            rows={5}
          />
          <div className={styles.bulkAddActions}>
            <button
              className={styles.btnPrimary}
              onClick={() => {
                const codes = bulkText.split(/[\n,，\s　]+/).map(s => s.trim()).filter(s => s.length > 0)
                let added = 0
                codes.forEach(c => {
                  if (masterDB[c] && !favorites.has(c)) { onToggleFavorite(c); added++ }
                })
                setBulkText(''); setShowBulkAdd(false)
                if (added > 0) alert(`${added}件を★に追加しました`)
                else alert('追加できる銘柄が見つかりませんでした（コードが存在しないか既に登録済み）')
              }}
            >登録する</button>
            <button className={styles.btnSecondary} onClick={() => { setBulkText(''); setShowBulkAdd(false) }}>
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* PC: テーブル表示 */}
      <div className={`${styles.wlTableScroll} ${styles.spHide}`}>
        <table className={styles.wlTableInner}>
          <thead>
            <tr>
              <th className={styles.wlTh} style={{width:64}}>♥ ★</th>
              <th className={styles.wlTh} style={{width:68}}>コード</th>
              <th className={styles.wlTh} style={{width:190}}>銘柄名</th>
              <th className={styles.wlTh} style={{width:80}}>市場</th>
              <th className={styles.wlTh} style={{width:160}}>
                ジャンル
                <GenreFilterDropdown
                  genres={allGenreOptions}
                  activeFilters={genreFilters}
                  onApply={filters => setGenreFilters(filters)}
                  onClear={() => setGenreFilters(new Set())}
                />
              </th>
              <th className={styles.wlTh} style={{minWidth:160}}>メモ</th>
              <th className={styles.wlTh} style={{width:70}}>決算日</th>
              <th className={styles.wlTh} style={{width:48}}>リンク</th>
            </tr>
          </thead>
          <tbody>
            {allCodes.length === 0 ? (
              <tr><td colSpan={6} className={styles.emptyCell}>銘柄マスタ読込中...</td></tr>
            ) : pageCodes.length === 0 ? (
              <tr><td colSpan={6} className={styles.emptyCell}>該当銘柄なし</td></tr>
            ) : pageCodes.map(code => (
              <StockManagerRow
                key={code}
                code={code}
                rec={masterDB[code]}
                isFav={favorites.has(code)}
                isSuperFav={superFavorites.has(code)}
                meta={stockMeta[code] ?? { genres: [], memo: '' }}
                allGenreOptions={managedGenreOptions}
                onToggleFav={() => onToggleFavorite(code)}
                onToggleSuperFav={() => onToggleSuperFav(code)}
                onSaveMeta={(meta) => onSaveStockMeta(code, meta)}
                onAddGenre={onAddGenre}
                onRenameGenre={handleRename}
                earningsDate={earningsDates[code] ?? ''}
                onSaveEarningsDate={onSaveEarningsDate}
                highlighted={wlHighlightCode === code}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* SP: ジャンルフィルターバー */}
      {allGenreOptions.length > 0 && (
        <div className={styles.wlSpGenreBar}>
          <span className={styles.wlSpGenreBarLabel}>ジャンル</span>
          <div className={styles.wlSpGenreChips}>
            {allGenreOptions.map(g => (
              <button
                key={g}
                className={`${styles.wlSpGenreChip} ${genreFilters.has(g) ? styles.wlSpGenreChipActive : ''}`}
                onClick={() => { setGenreFilters(prev => { const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g); return n }); setPage(1) }}
              >{g}</button>
            ))}
          </div>
          {genreFilters.size > 0 && (
            <button className={styles.wlSpGenreClearBtn} onClick={() => { setGenreFilters(new Set()); setPage(1) }}>✕</button>
          )}
        </div>
      )}

      {/* SP: コンパクト1行リスト */}
      <div className={`${styles.wlSpList} ${styles.mobileOnly}`}>
        {/* SP: 固定列ヘッダー */}
        <div className={styles.wlSpStickyHeader}>
          <span className={styles.wlSpHdrHeart}>♥</span>
          <span className={styles.wlSpHdrStar}>★</span>
          <span className={styles.wlSpHdrCode}>コード</span>
          <span className={styles.wlSpHdrName}>銘柄名</span>
          <span className={styles.wlSpHdrMkt}>市場</span>
          <span className={styles.wlSpHdrGenre}>ジャンル</span>
          <span className={styles.wlSpHdrMemo}>メモ</span>
        </div>
        {allCodes.length === 0
          ? <div className={styles.emptyCell}>銘柄マスタ読込中...</div>
          : pageCodes.length === 0
          ? <div className={styles.emptyCell}>該当銘柄なし</div>
          : pageCodes.map(code => (
            <WlMobileRow
              key={code}
              code={code}
              rec={masterDB[code]}
              isFav={favorites.has(code)}
              isSuperFav={superFavorites.has(code)}
              meta={stockMeta[code] ?? { genres: [], memo: '' }}
              onToggleFav={() => onToggleFavorite(code)}
              onToggleSuperFav={() => onToggleSuperFav(code)}
              onSaveMeta={(meta) => onSaveStockMeta(code, meta)}
              highlighted={wlHighlightCode === code}
            />
          ))
        }
      </div>

      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button className={styles.pageBtn} onClick={() => setPage(1)} disabled={page === 1}>«</button>
          <button className={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1}>‹</button>
          {renderPageNums().map(p => (
            <button key={p} className={`${styles.pageBtn} ${p === page ? styles.pageBtnActive : ''}`} onClick={() => setPage(p)}>{p}</button>
          ))}
          <button className={styles.pageBtn} onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page === totalPages}>›</button>
          <button className={styles.pageBtn} onClick={() => setPage(totalPages)} disabled={page === totalPages}>»</button>
          <span className={styles.pageInfo}>{page}/{totalPages}ページ</span>
        </div>
      )}
    </div>
  )
}

// ─── MemoTooltip ─────────────────────────────────────────────────────
function MemoTooltip({ text, updatedAt, children }: { text: string; updatedAt?: string; children: React.ReactNode }) {
  const [visible, setVisible] = useState(false)
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({})
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  function scheduleShow() {
    if (!text) return
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
    showTimerRef.current = setTimeout(() => {
      if (!wrapRef.current) return
      const r = wrapRef.current.getBoundingClientRect()
      const spaceAbove = r.top
      const spaceBelow = window.innerHeight - r.bottom
      const placeAbove = spaceAbove > 220 || spaceAbove > spaceBelow
      const left = Math.max(4, Math.min(r.left, window.innerWidth - 420))
      setTooltipStyle({
        position: 'fixed',
        left,
        ...(placeAbove
          ? { bottom: window.innerHeight - r.top + 6 }
          : { top: r.bottom + 6 }),
      })
      setVisible(true)
    }, 200)
  }

  function scheduleHide() {
    if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null }
    hideTimerRef.current = setTimeout(() => setVisible(false), 100)
  }

  function cancelHide() {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
  }

  useEffect(() => () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }, [])

  return (
    <div ref={wrapRef} className={styles.memoTooltipWrap} onMouseEnter={scheduleShow} onMouseLeave={scheduleHide}>
      {children}
      {visible && text && (
        <div className={styles.memoTooltip} style={tooltipStyle} onMouseEnter={cancelHide} onMouseLeave={scheduleHide}>
          <div>{text}</div>
          {updatedAt && (
            <>
              <div className={styles.memoTooltipDivider} />
              <div className={styles.memoTooltipDate}>最終更新: {fmtJpDate(updatedAt)}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── WlMobileRow（銘柄管理 SP 用コンパクト1行） ─────────────────────
function WlMobileRow({ code, rec, isFav, isSuperFav, meta, onToggleFav, onToggleSuperFav, onSaveMeta, highlighted }: {
  code: string
  rec: MasterRecord
  isFav: boolean; isSuperFav: boolean
  meta: StockMeta
  onToggleFav: () => void; onToggleSuperFav: () => void
  onSaveMeta: (meta: StockMeta) => void
  highlighted: boolean
}) {
  const [editingMemo, setEditingMemo] = useState(false)
  const [showLinks, setShowLinks] = useState(false)
  const [draft, setDraft] = useState(meta.memo)
  const { label: mktLabel, cls: mktCls } = marketShort(rec.market)
  const mainGenre = meta.genres[0] ?? null

  useEffect(() => { setDraft(meta.memo) }, [meta.memo])

  function handleMemoBlur() {
    setEditingMemo(false)
    if (draft !== meta.memo) onSaveMeta({ ...meta, memo: draft, memoUpdatedAt: draft.trim() ? new Date().toISOString() : undefined })
  }

  const links = [
    { label: '四季報',      href: `https://shikiho.toyokeizai.net/stocks/${code}` },
    { label: 'かぶたん',    href: `https://kabutan.jp/stock/?code=${code}` },
    { label: 'Yahoo',       href: `https://finance.yahoo.co.jp/quote/${code}.T` },
    { label: 'IRBank',      href: `https://irbank.net/${code}` },
    { label: 'みんかぶ',   href: `https://minkabu.jp/stock/${code}` },
    { label: 'Buffett',     href: `https://www.buffett-code.com/company/${code}` },
    { label: 'TV',          href: `https://jp.tradingview.com/chart/?symbol=TSE:${code}` },
    { label: 'X検索',       href: `https://x.com/search?q=${encodeURIComponent(code + ' ' + rec.name)}&f=live` },
    { label: '公式IR',      href: `https://www.google.com/search?q=${encodeURIComponent(code + ' ' + rec.name + ' IR 投資家情報')}` },
  ]

  return (
    <div className={`${styles.wlMobileItem} ${highlighted ? styles.wlHighlight : ''}`} data-code-wl={code}>
      <div className={styles.wlMobileRow}>
        <button onClick={onToggleSuperFav}
          className={`${styles.wlMobileIconBtn} ${isSuperFav ? styles.heartBtnOn : styles.heartBtn}`}>♥</button>
        <button onClick={onToggleFav}
          className={`${styles.wlMobileIconBtn} ${isFav ? styles.favBtnOn : styles.favBtn}`}>{isFav ? '★' : '☆'}</button>
        <span className={styles.wlMobileCode}>{code}</span>
        {/* 銘柄名タップでリンク展開 */}
        <span
          className={`${styles.wlMobileName} ${styles.wlMobileNameTap}`}
          onClick={() => { setShowLinks(l => !l); if (editingMemo) setEditingMemo(false) }}
        >
          {rec.name}
          <span className={styles.wlMobileNameCaret}>{showLinks ? ' ▲' : ' ▾'}</span>
        </span>
        <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        {mainGenre && <span className={styles.wlMobileGenre}>{mainGenre}</span>}
        <button className={`${styles.wlMobileEditBtn} ${meta.memo ? styles.wlMobileEditBtnActive : ''}`}
          onClick={() => { setEditingMemo(e => !e); if (showLinks) setShowLinks(false) }}
          title={meta.memo ? meta.memo.slice(0, 30) : 'メモなし'}
        >✏</button>
      </div>
      {/* リンク展開パネル */}
      {showLinks && (
        <div className={styles.wlMobileLinkRow}>
          {links.map(l => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer"
              className={styles.wlMobileLinkBtn}
              onClick={e => e.stopPropagation()}
            >{l.label}</a>
          ))}
        </div>
      )}
      {editingMemo && (
        <div className={styles.wlMobileMemoEdit}>
          <textarea
            className={styles.wlMobileMemoTextarea}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={handleMemoBlur}
            autoFocus
            rows={3}
          />
        </div>
      )}
    </div>
  )
}

// ─── LinkDropdown（銘柄管理リンクドロップダウン）────────────────────────
function LinkDropdown({ code, name }: { code: string; name: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])
  return (
    <div ref={ref} className={styles.linkDropWrap}>
      <button
        className={styles.linkDropBtn}
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        title="外部リンクを開く"
      >🔗</button>
      {open && (
        <div className={styles.linkDropMenu}>
          <a href={`https://shikiho.toyokeizai.net/stocks/${code}`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>四季報</a>
          <a href={`https://kabutan.jp/stock/?code=${code}`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>かぶたん</a>
          <a href={`https://x.com/search?q=${encodeURIComponent(code + ' ' + name)}&f=live`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>X検索</a>
          <a href={`https://finance.yahoo.co.jp/quote/${code}.T`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>Yahoo Finance</a>
          <a href={`https://irbank.net/${code}`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>IRBank</a>
          <a href={`https://minkabu.jp/stock/${code}`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>みんかぶ</a>
          <a href={`https://www.buffett-code.com/company/${code}`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>Buffett Code</a>
          <a href={`https://jp.tradingview.com/chart/?symbol=TSE:${code}`} target="_blank" rel="noopener noreferrer" className={styles.linkDropItem}>TradingView</a>
        </div>
      )}
    </div>
  )
}

// ─── StockManagerRow ─────────────────────────────────────────────────
const StockManagerRow = React.memo(function StockManagerRow({
  code, rec, isFav, isSuperFav, meta, allGenreOptions, onToggleFav, onToggleSuperFav, onSaveMeta, onAddGenre, onRenameGenre, earningsDate, onSaveEarningsDate, highlighted,
}: {
  code: string
  rec: MasterRecord
  isFav: boolean
  isSuperFav: boolean
  meta: StockMeta
  allGenreOptions: string[]
  onToggleFav: () => void
  onToggleSuperFav: () => void
  onSaveMeta: (meta: StockMeta) => void
  onAddGenre: (name: string) => void
  onRenameGenre?: (oldName: string, newName: string) => void
  earningsDate: string
  onSaveEarningsDate: (code: string, date: string) => void
  highlighted: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [localMemo, setLocalMemo] = useState(meta.memo)
  const [localDate, setLocalDate] = useState(earningsDate)
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [editingGenreInRow, setEditingGenreInRow] = useState<string | null>(null)
  const [genreQuery, setGenreQuery] = useState('')
  const { label: mktLabel, cls: mktCls } = marketShort(rec.market)

  const genres = meta.genres
  const displayGenres = genres.slice(0, 2)
  const extraGenreCount = genres.length - 2

  function toggleGenre(tag: string) {
    const next = genres.includes(tag) ? genres.filter(g => g !== tag) : [...genres, tag]
    onSaveMeta({ ...meta, genres: next })
  }

  // メモ・決算日がpropsで変わったとき（外部変更等）は同期
  useEffect(() => { setLocalMemo(meta.memo) }, [meta.memo])
  useEffect(() => { setLocalDate(earningsDate) }, [earningsDate])

  return (
    <>
      <tr data-code-wl={code} className={`${styles.wlTr}${highlighted ? ' ' + styles.wlHighlight : ''}`}>
        <td className={styles.wlTd} style={{textAlign:'center', whiteSpace:'nowrap'}}>
          <button
            onClick={onToggleSuperFav}
            className={isSuperFav ? styles.heartBtnOn : styles.heartBtn}
            title={isSuperFav ? '超お気に入り解除' : '超お気に入りに追加'}
          >♥</button>
          <button
            onClick={onToggleFav}
            className={isFav ? styles.favBtnOn : styles.favBtn}
            title={isFav ? 'お気に入り解除' : 'お気に入りに追加'}
          >{isFav ? '★' : '☆'}</button>
        </td>
        <td className={styles.wlTd}><span className={styles.wlChipCode}>{code}</span></td>
        <td className={styles.wlTd}><span className={styles.wlTdName}>{rec.name}</span></td>
        <td className={styles.wlTd}>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        </td>
        <td className={styles.wlTd}>
          <div className={styles.wlGenreCell}>
            {genres.length === 0
              ? <span className={styles.genreTag} style={{color:'#4e6280',borderStyle:'dashed'}}>未設定</span>
              : <>
                  {displayGenres.map(g => <span key={g} className={`${styles.genreTag} ${styles.genreTagOn}`}>{g}</span>)}
                  {extraGenreCount > 0 && (
                    <span className={styles.genreExtraBadge} title={genres.slice(2).join(', ')}>+{extraGenreCount}</span>
                  )}
                </>}
            <button
              className={`${styles.genreEditToggleBtn} ${editing ? styles.genreEditToggleBtnOn : ''}`}
              onClick={() => setEditing(e => !e)}
            >{editing ? '▲' : '✏️'}</button>
          </div>
        </td>
        <td className={styles.wlTd}>
          <MemoTooltip text={editing ? '' : localMemo} updatedAt={editing ? undefined : meta.memoUpdatedAt}>
            <input
              className={styles.wlMemoInput}
              placeholder="メモ"
              value={localMemo}
              onChange={e => setLocalMemo(e.target.value)}
              onBlur={() => onSaveMeta({ ...meta, memo: localMemo })}
              onKeyDown={e => { if (e.key === 'Enter') { onSaveMeta({ ...meta, memo: localMemo }); e.currentTarget.blur() } }}
            />
          </MemoTooltip>
        </td>
        <td className={styles.wlTd} style={{textAlign:'center'}}>
          {datePickerOpen ? (
            <input
              type="date"
              autoFocus
              className={styles.wlEarningsInput}
              value={localDate}
              onChange={e => setLocalDate(e.target.value)}
              onBlur={() => { setDatePickerOpen(false); onSaveEarningsDate(code, localDate) }}
              onKeyDown={e => { if (e.key === 'Enter') { setDatePickerOpen(false); onSaveEarningsDate(code, localDate); e.currentTarget.blur() } else if (e.key === 'Escape') { setDatePickerOpen(false) } }}
            />
          ) : (
            <button
              className={styles.wlDateBtn}
              onClick={() => setDatePickerOpen(true)}
              title={localDate ? `決算日: ${localDate}` : '決算日を設定'}
            >
              {localDate ? localDate.slice(5).replace('-', '/') : <span style={{color:'#2a3a52'}}>—</span>}
            </button>
          )}
        </td>
        <td className={styles.wlTd} style={{textAlign:'center', padding:'5px 4px'}}>
          <LinkDropdown code={code} name={rec.name || code} />
        </td>
      </tr>
      {editing && (
        <tr className={styles.wlEditRow}>
          <td colSpan={8} className={styles.wlEditTd}>
            <div className={styles.wlGenreSearchRow}>
              <input
                className={styles.wlGenreSearch}
                placeholder="ジャンルを検索（入力で絞り込み）"
                value={genreQuery}
                onChange={e => setGenreQuery(e.target.value)}
                autoFocus
              />
              {genreQuery && <button className={styles.wlGenreSearchClear} onClick={() => setGenreQuery('')}>×</button>}
              <InlineGenreAdd onAdd={(name) => { onAddGenre(name); toggleGenre(name); setGenreQuery('') }} />
            </div>
            <div className={styles.wlGenreEditPanel}>
              {(() => {
                const q = normJa(genreQuery.trim())
                // 選択中は常に表示、それ以外は検索で絞り込み
                const list = allGenreOptions.filter(g => genres.includes(g) || !q || normJa(g).includes(q))
                if (list.length === 0) return <span className={styles.wlGenreNoHit}>該当なし（「＋新規」で追加できます）</span>
                return list.map(g => (
                  <span key={g} className={styles.genreChipWrap}>
                    {editingGenreInRow === g ? (
                      <GenreRenameInput
                        defaultValue={g}
                        onConfirm={newName => { onRenameGenre?.(g, newName); setEditingGenreInRow(null) }}
                        onCancel={() => setEditingGenreInRow(null)}
                      />
                    ) : (
                      <>
                        <button
                          className={`${styles.genreTag} ${genres.includes(g) ? styles.genreTagOn : ''}`}
                          onClick={() => toggleGenre(g)}
                        >{g}</button>
                        <button
                          className={styles.genreChipRenameBtn}
                          onClick={() => setEditingGenreInRow(g)}
                          title="リネーム"
                        >✏️</button>
                      </>
                    )}
                  </span>
                ))
              })()}
            </div>
          </td>
        </tr>
      )}
    </>
  )
})

// ─── MiniChart ───────────────────────────────────────────────────────
type ChartMode = '3months' | '1year' | '3years'

/** 単純移動平均を計算。データ不足のインデックスはnullを返す */
function calcMA(arr: number[], period: number): (number | null)[] {
  return arr.map((_, i) => {
    if (i < period - 1) return null
    return arr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  })
}
interface SeriesData { prices: number[]; label: string; color: string; dates?: string[] }

function getWeekKey(dateStr: string): string {
  const dt = new Date(dateStr)
  const start = new Date(dt.getFullYear(), 0, 1)
  const week = Math.floor((dt.getTime() - start.getTime()) / 604800000)
  return `${dt.getFullYear()}-${String(week).padStart(2, '0')}`
}

async function fetchIndex(stooqSymbol: string, from: string, to: string, interval: 'd'|'w'|'m' = 'd'): Promise<number[]> {
  const fd = `${from.slice(0,4)}-${from.slice(4,6)}-${from.slice(6,8)}`
  const td = `${to.slice(0,4)}-${to.slice(4,6)}-${to.slice(6,8)}`
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${fd.replace(/-/g,'')}&d2=${td.replace(/-/g,'')}&i=${interval}`
  try {
    const r = await fetch(url)
    const text = await r.text()
    if (!text || text.includes('No data') || text.trim().length < 20) return []
    const lines = text.trim().split('\n').slice(1)
    const closes: number[] = []
    for (const line of lines) {
      const cols = line.split(',')
      const c = parseFloat(cols[4] ?? '')
      if (!isNaN(c) && c > 0) closes.push(c)
    }
    return closes
  } catch { return [] }
}
// 日経・NASDAQは全銘柄共通 → Promiseキャッシュで重複リクエストを防ぐ
const _idxCache: Record<string, Promise<number[]>> = {}
function fetchIndexCached(sym: string, from: string, to: string, interval: 'd'|'w'|'m' = 'd'): Promise<number[]> {
  const key = `${sym}_${from}_${to}_${interval}`
  if (!_idxCache[key]) _idxCache[key] = fetchIndex(sym, from, to, interval)
  return _idxCache[key]
}

function normalizeSeries(prices: number[]): number[] {
  if (prices.length === 0) return []
  const base = prices[0]
  return prices.map(v => v / base)
}

function MiniChart({ code, apiKey, serverHasKey = false, refreshKey = 0, mode, onModeChange }: {
  code: string; apiKey: string; serverHasKey?: boolean; refreshKey?: number
  mode: ChartMode; onModeChange: (m: ChartMode) => void
}) {
  // サーバーにJ-Quantsキーがあれば、クライアントキー未入力でもプロキシ経由で取得できる
  const canFetch = !!apiKey || serverHasKey
  const [cachedData, setCachedData] = useState<Record<ChartMode, SeriesData[] | null>>({ '3months': null, '1year': null, '3years': null })
  const [errored, setErrored] = useState<Record<ChartMode, boolean>>({ '3months': false, '1year': false, '3years': false })
  const [chartLoading, setChartLoading] = useState(false)
  const [retryCount, setRetryCount] = useState(0)  // retry()時にuseEffectを再トリガーするカウンター
  // キャッシュが存在する場合は即visible=true（リマウントされても即再表示）
  const [visible, setVisible] = useState(() =>
    (['3months','1year','3years'] as ChartMode[]).some(m => getChartCache(code, m) !== null)
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const lastRefreshKeyRef = useRef(refreshKey)

  const fmt = (d: Date) => d.toISOString().slice(0,10).replace(/-/g,'')

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect() } },
      { rootMargin: '200px', threshold: 0.1 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !canFetch || !code) return
    const isForcedRefresh = refreshKey !== lastRefreshKeyRef.current
    lastRefreshKeyRef.current = refreshKey

    if (!isForcedRefresh) {
      if (cachedData[mode] !== null) return
      if (errored[mode]) return
      const cached = getChartCache(code, mode)
      if (cached) {
        setCachedData(prev => ({ ...prev, [mode]: cached as SeriesData[] }))
        return
      }
    } else {
      setCachedData({ '3months': null, '1year': null, '3years': null })
      setErrored({ '3months': false, '1year': false, '3years': false })
    }

    let cancelled = false
    setChartLoading(true)
    const today = new Date()
    const from = new Date(today)
    if (mode === '3months') from.setMonth(from.getMonth() - 3)
    else if (mode === '1year') from.setFullYear(from.getFullYear() - 1)
    else from.setFullYear(from.getFullYear() - 3)
    const fromStr = fmt(from)
    const toStr = fmt(today)
    const idxInterval: 'd'|'w' = mode === '3years' ? 'w' : 'd'
    const path = encodeURIComponent(`/equities/bars/daily?code=${code}&dateFrom=${fromStr}&dateTo=${toStr}`)
    const url = `/api/jquants?path=${path}`
    Promise.all([
      fetch(url, { headers: { 'x-api-key': apiKey } }).then(r => r.json()),
      fetchIndexCached('n225.jp', fromStr, toStr, idxInterval),
      fetchIndexCached('ixic', fromStr, toStr, idxInterval),
    ]).then(([json, nkPrices, ndqPrices]) => {
      if (cancelled) return
      // fromStr は '20230521' 形式 → ISO形式 '2023-05-21' に変換して日付フィルタに使用
      const fromISO = `${fromStr.slice(0,4)}-${fromStr.slice(4,6)}-${fromStr.slice(6,8)}`
      const rawData = ((json?.data ?? []) as Record<string,unknown>[])
        .filter(d => (d.Date as string) >= fromISO)  // APIが余分な過去データを返す場合に備えてフィルタ

      let stockPrices: number[]
      let stockDates: string[]
      if (mode === '3months' || mode === '1year') {
        const pairs = rawData
          .map(d => ({ date: d.Date as string, price: (d.AdjC ?? d.C ?? 0) as number }))
          .filter(p => p.price > 0)
        stockPrices = pairs.map(p => p.price)
        stockDates  = pairs.map(p => p.date)
      } else {
        // '3years': 週次サンプリング（各週の最終日の終値）
        const weekMap: Record<string, {date:string; price:number}> = {}
        for (const d of rawData) {
          const date = (d.Date as string) ?? ''
          const price = (d.AdjC ?? d.C ?? 0) as number
          if (date && price > 0) weekMap[getWeekKey(date)] = { date, price }
        }
        const entries = Object.values(weekMap)
        stockPrices = entries.map(e => e.price)
        stockDates  = entries.map(e => e.date)
      }
      // データが2点未満の場合はキャッシュしないでエラー扱い
      if (stockPrices.length < 2) {
        setErrored(prev => ({ ...prev, [mode]: true }))
        return
      }
      const series: SeriesData[] = [
        { prices: normalizeSeries(stockPrices), label: code, color: '#34d399', dates: stockDates },
        { prices: normalizeSeries(nkPrices), label: '日経', color: 'rgba(251,191,36,0.7)' },
        { prices: normalizeSeries(ndqPrices), label: 'NASDAQ', color: 'rgba(139,92,246,0.7)' },
      ]
      setChartCache(code, mode, series)
      setCachedData(prev => ({ ...prev, [mode]: series }))
    }).catch(() => {
      if (cancelled) return
      setErrored(prev => ({ ...prev, [mode]: true }))
    }).finally(() => {
      if (!cancelled) setChartLoading(false)
    })
    return () => { cancelled = true }
  }, [code, apiKey, canFetch, mode, visible, refreshKey, retryCount])

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current
      const series = cachedData[mode]
      if (!canvas || !series || series.length === 0) return
      const stockSeries = series[0].prices
      if (stockSeries.length < 2) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const w = canvas.clientWidth || canvas.offsetWidth || (canvas.parentElement?.clientWidth ?? 280)
      const h = 155  // 下部15pxをX軸ラベル用に確保
      canvas.width = w; canvas.height = h
      ctx.clearRect(0, 0, w, h)
      const allValues = series.flatMap(s => s.prices).filter(v => v > 0)
      const min = Math.min(...allValues) * 0.98
      const max = Math.max(...allValues) * 1.02
      const range = max - min || 1
      const toX = (i: number, len: number) => (i / (len - 1)) * w
      const toY = (v: number) => h - ((v - min) / range) * (h - 28) - 18  // 下18px確保
      const stockColor = series[0].color
      const grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, 'rgba(52,211,153,0.15)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      const sp = stockSeries
      ctx.beginPath()
      sp.forEach((v, i) => { i === 0 ? ctx.moveTo(toX(i, sp.length), toY(v)) : ctx.lineTo(toX(i, sp.length), toY(v)) })
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath()
      ctx.fillStyle = grad; ctx.fill()
      for (const s of series) {
        if (s.prices.length < 2) continue
        ctx.beginPath()
        s.prices.forEach((v, i) => { i === 0 ? ctx.moveTo(toX(i, s.prices.length), toY(v)) : ctx.lineTo(toX(i, s.prices.length), toY(v)) })
        ctx.strokeStyle = s.color; ctx.lineWidth = s.label === code ? 1.8 : 1.2; ctx.stroke()
      }
      // ── 移動平均線（モード別）────────────────────────────
      const maDefs: [number, string, string][] =
        mode === '3years'
          ? [[13, 'rgba(251,191,36,0.85)','13週'], [26, 'rgba(167,139,250,0.85)','26週']]
          : mode === '3months'
          ? [[5,  'rgba(251,191,36,0.85)','5日'],  [25, 'rgba(167,139,250,0.85)','25日']]
          : [[25, 'rgba(251,191,36,0.85)','25日'], [75, 'rgba(167,139,250,0.85)','75日']]

      maDefs.forEach(([period, color, label], maIdx) => {
        const ma = calcMA(sp, period)
        ctx.beginPath()
        let started = false
        ma.forEach((v, i) => {
          if (v === null) return
          const x = toX(i, sp.length), y = toY(v)
          if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([])
        ctx.stroke()
        // 凡例（右上に逆順で配置）
        const legX = w - 8 - maIdx * 46
        ctx.fillStyle = color; ctx.fillRect(legX - 38, 5, 10, 1.5)
        ctx.fillStyle = 'rgba(200,220,240,0.6)'; ctx.font = '9px JetBrains Mono, monospace'
        ctx.fillText(label, legX - 26, 12)
      })

      // ── X軸ラベル（年月） ─────────────────────────────
      const chartDates = series[0].dates
      if (chartDates && chartDates.length > 1) {
        const len = chartDates.length
        ctx.save()
        ctx.textAlign = 'center'
        ctx.font = '8px JetBrains Mono, monospace'
        if (mode === '3years') {
          // 年ラベル: データの年範囲から直接計算して配置（ラベル欠け防止）
          const firstYear = parseInt(chartDates[0].slice(0, 4))
          const lastYear  = parseInt(chartDates[len - 1].slice(0, 4))
          for (let yr = firstYear; yr <= lastYear; yr++) {
            const idx = chartDates.findIndex(d => d.slice(0, 4) === String(yr))
            if (idx < 0) continue
            const x = toX(idx, len)
            if (x < 20 || x > w - 20) continue  // 端すぎる場合はスキップ
            ctx.fillStyle = 'rgba(140,155,170,0.1)'
            ctx.fillRect(Math.round(x), 16, 1, h - 34)
            ctx.fillStyle = 'rgba(140,155,170,0.55)'
            ctx.fillText(String(yr), x, h - 3)
          }
        } else {
          // 月ラベル（3ヶ月・1年）
          let lastKey = ''; let lastLabelX = -40
          chartDates.forEach((d, i) => {
            const key   = d.slice(0, 7)
            const label = parseInt(d.slice(5, 7), 10) + '月'
            if (key !== lastKey) {
              lastKey = key
              const x = toX(i, len)
              if (x > 16 && x < w - 16 && x - lastLabelX > 30) {
                lastLabelX = x
                ctx.fillStyle = 'rgba(140,155,170,0.1)'
                ctx.fillRect(Math.round(x), 16, 1, h - 34)
                ctx.fillStyle = 'rgba(140,155,170,0.55)'
                ctx.fillText(label, x, h - 3)
              }
            }
          })
        }
        ctx.restore()
      }
    }
    requestAnimationFrame(draw)
  }, [cachedData, mode, code])

  function retry() {
    setErrored(prev => ({ ...prev, [mode]: false }))
    setCachedData(prev => ({ ...prev, [mode]: null }))
    setRetryCount(c => c + 1)  // useEffectを再トリガーしてフェッチを再実行
  }

  const currentData = cachedData[mode]
  const hasData = currentData !== null && currentData[0]?.prices.length >= 2
  const isError = errored[mode]
  return (
    <div ref={areaRef} className={styles.chartArea}>
      <div className={styles.chartTabs}>
        {(['3months','1year','3years'] as ChartMode[]).map(m => (
          <button key={m} className={`${styles.chartTab} ${mode === m ? styles.chartTabActive : ''}`}
            onClick={e => { e.stopPropagation(); onModeChange(m) }}>
            {m === '3months' ? '3ヶ月' : m === '1year' ? '1年' : '3年'}
          </button>
        ))}
      </div>
      <canvas ref={canvasRef} className={styles.chartCanvas} style={{ display: hasData && !chartLoading ? 'block' : 'none' }} />
      {(() => {
        if (!visible) return <div className={styles.chartLoading} />
        if (chartLoading) return <div className={styles.chartLoading}>読込中...</div>
        if (isError) return <div className={styles.chartLoading}><button className={styles.chartRetryBtn} onClick={e => { e.stopPropagation(); retry() }}>再読込</button></div>
        if (!hasData && currentData !== null) return <div className={styles.chartLoading}>データなし</div>
        return null
      })()}
    </div>
  )
}

// ─── DashboardTable ──────────────────────────────────────────────────
function DashboardTable({
  filteredRows, finDB, earningsDates, onSaveEarningsDate, sortKey, sortDir, handleSort, onRowClick, highlightCode, superFavorites, onToggleSuperFav, showDetail
}: {
  filteredRows: StockRow[]
  finDB: Record<string, import('./lib/types').FinRecord>
  earningsDates: Record<string, string>
  onSaveEarningsDate: (code: string, date: string) => void
  sortKey: SortKeyEx | null
  sortDir: 1 | -1
  handleSort: (k: SortKeyEx) => void
  onRowClick: (code: string) => void
  highlightCode: string | null
  superFavorites: Set<string>
  onToggleSuperFav: (code: string) => void
  showDetail: boolean
}) {
  const headRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const sbRef = useRef<HTMLDivElement>(null)   // ビューポート下端の連動スクロールバー
  const syncingRef = useRef(false)
  const [scrollW, setScrollW] = useState(0)
  // 横スクロールを head / body / 下端バー で双方向同期（ループ防止フラグ付き）
  const syncScroll = (x: number) => {
    if (syncingRef.current) return
    syncingRef.current = true
    if (headRef.current) headRef.current.scrollLeft = x
    if (bodyRef.current && bodyRef.current.scrollLeft !== x) bodyRef.current.scrollLeft = x
    if (sbRef.current && sbRef.current.scrollLeft !== x) sbRef.current.scrollLeft = x
    syncingRef.current = false
  }
  const onBodyScroll = () => { if (bodyRef.current) syncScroll(bodyRef.current.scrollLeft) }
  const onSbScroll = () => { if (sbRef.current) syncScroll(sbRef.current.scrollLeft) }
  useEffect(() => {
    const update = () => { if (bodyRef.current) setScrollW(bodyRef.current.scrollWidth) }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [showDetail, filteredRows.length])
  const SortArrow = ({ k }: { k: SortKeyEx }) => (
    <span className={`${styles.sortArrow} ${sortKey===k ? styles.sorted : ''}`}>↕</span>
  )
  // detail:true の列は「詳細」トグルON時のみ表示（脱Excle・PER/PEG/売上成長に注力）
  type Col = { label: string; cls: string; key: SortKeyEx | null; group: string; w: number; tooltip?: string; detail?: boolean }
  const allCols: Col[] = [
    { label: '', cls: styles.thLeft, key: null, w: 48, group: '' },
    { label: 'コード', cls: `${styles.thLeft} ${styles.stickyCol0}`, key: 'code' as keyof StockRow, w: 60, group: '' },
    { label: '銘柄名 ⓘ', cls: `${styles.thLeft} ${styles.stickyCol1}`, key: 'name' as keyof StockRow, w: 150, group: '', tooltip: '⚠ マークの意味:\n直近の財務開示から90日以上経過した銘柄を示します。\n上場企業は通常3か月ごとに決算開示しますが、開示が遅れている場合や3Q/4Q決算をまたぐ期間中に表示されます。\nこのマークが付いている銘柄は財務指標が古いデータに基づく可能性があります。' },
    { label: 'ジャンル', cls: styles.thLeft, key: 'genre', w: 112, group: '', tooltip: 'クリックでジャンルごとにまとめて並び替え。\n複数ジャンルを持つ銘柄は「1つ目のジャンル」を基準にグルーピングします。\n（未設定の銘柄は末尾／同ジャンル内はコード順）' },
    { label: '市場', cls: styles.thLeft, key: 'market' as keyof StockRow, w: 72, group: '' },
    { label: '時価総額(億)', cls: styles.thRight, key: 'mcap' as keyof StockRow, w: 108, group: '', detail: true, tooltip: '会社の市場での評価額（株価×発行株式数）。\n100億未満=小型株、1000億超=大型株。' },
    { label: '株価',    cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'close' as keyof StockRow, w: 80, group: 'price' },
    { label: '前日比%', cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1d' as keyof StockRow, w: 80, group: 'price', tooltip: '前営業日の終値からの変化率（J-Quants生値・スプリット調整なし）。\n週末を挟む場合は前金曜日との比較。\n四季報等と若干ズレる場合があります。' },
    { label: '1週間%',  cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1w' as keyof StockRow, w: 76, group: 'price', tooltip: '約5営業日前の終値からの変化率。\n短〜中期トレンドの確認に使う。' },
    { label: '3ヶ月%',  cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg3m' as keyof StockRow, w: 80, group: 'price', tooltip: '約65営業日前の終値からの変化率。\n中期トレンドや季節性の確認に使う。' },
    { label: '1年%',    cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1y' as keyof StockRow, w: 76, group: 'price', tooltip: '約250営業日前の終値からの変化率。\n長期トレンドの確認に使う。' },
    { label: 'PER実績',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perA' as keyof StockRow, w: 76, group: 'per', tooltip: '株価÷直近実績EPS。\n会社が利益の何年分で買えるかの指標。\n同業界平均と比較して割安かを判断する。' },
    { label: 'PER今期',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perF' as keyof StockRow, w: 76, group: 'per', tooltip: '株価÷今期予想EPS（会社予想ベース）。\n企業が公式発表した予想EPSを使用。\n四季報は東洋経済の独自予想を使うため数字がズレる場合があります（特に期初・FY確定直後の保守的予想時）。' },
    { label: 'PER今期\n1ヶ月前比', cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perFChg1m' as keyof StockRow, w: 76, group: 'per', tooltip: 'PER今期の1ヶ月前との変化率。\n(現在PER÷1M前PER−1)で計算。\nセルにホバーで過去FEPS・現在FEPSなど詳細表示。\n\n⚠ 大きなズレが出る場合の主な原因:\n① 期末後に予想EPS(FEPS)が翌期に切替わったとき\n② 会社が業績予想を大幅修正したとき\n→ いずれも株価ではなくEPS基準の変化が原因' },
    { label: 'PEG', cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'peg' as keyof StockRow, w: 64, group: 'per', tooltip: 'PER今期÷EPS今期成長率（%）。\n1未満=成長率に対して株価が割安と判断される指標。\n成長株の割安度を見るのに使う。' },
    { label: 'PER位置', cls: `${styles.thRight} ${styles.thPerGroup}`, key: null, w: 168, group: 'per', tooltip: '直近1年のPER高値〜安値の中で、\n今の予想PER（会社予想ベース）がどこにあるかを示すバー。\n左=安値(割安)、右=高値(割高)、●=現在の予想PER。\n赤字/非開示などで出せない時は理由を表示。' },
    { label: '来期売上成長',cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'nySalesGr' as keyof StockRow, w: 100, group: 'per', tooltip: '来期予想売上÷最新FY確定売上−1。\nPEGの構成要素（成長率）。\n15%超で高成長企業の目安。' },
    { label: 'PBR', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'pbr' as keyof StockRow, w: 64, group: 'other', detail: true, tooltip: '株価÷1株あたり純資産（BPS）。\n1倍未満=純資産より安く買える。\n1〜2倍が標準的とされる。' },
    { label: 'ROE', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'roe' as keyof StockRow, w: 88, group: 'other', detail: true, tooltip: '純利益÷自己資本。\n資本をどれだけ効率よく使って利益を出しているか。\n10%超で優良、15%超で高収益企業。' },
    { label: 'EPS今期\n成長率', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'epsCurGr' as keyof StockRow, w: 64, group: 'other', detail: true, tooltip: '今期予想EPS÷直近実績EPS−1。\nFY確定後の銘柄は次期予想EPSを充当。\n業績V字回復や急減速の発見に使う。' },
    { label: '営業利益率', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'opMgn' as keyof StockRow, w: 88, group: 'other', detail: true, tooltip: '営業利益÷売上高。\n本業でどれだけ稼げるかの収益性指標。\n15%超で高収益、20%超は非常に優秀。' },
    { label: '配当利回り', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'divY' as keyof StockRow, w: 88, group: 'other', detail: true, tooltip: '年間配当÷株価。\nインカムゲインの目安。\n3%超で高配当株とされる。' },
    { label: '外部\nリンク', cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, w: 64, group: 'info', tooltip: '外部リンク（四季報・Yahoo・かぶたん・公式HP）' },
    { label: '次決算',     cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, w: 80, group: 'info', tooltip: '次回決算予定日。クリックして入力/編集できます。\n2週間以内:黄色、1週間以内:赤で警告。' },
  ]
  const cols = showDetail ? allCols : allCols.filter(c => !c.detail)
  const colGroup = (
    <colgroup>
      {cols.map((c, i) => <col key={i} style={{width:c.w, minWidth:c.w}} />)}
    </colgroup>
  )
  return (
    <div className={styles.dashWrap}>
      <div className={styles.theadOuter} ref={headRef}>
        <table className={`${styles.table} ${styles.theadTable}`}>
          {colGroup}
          <thead>
            <tr>
              {cols.map((col, i) => (
                <th
                  key={i}
                  className={`${col.cls} ${col.key ? styles.thSort : ''} ${col.tooltip ? styles.thTooltip : ''}`}
                  style={{width: col.w, minWidth: col.w}}
                  onClick={col.key ? () => handleSort(col.key!) : undefined}
                  title={col.tooltip ?? col.label.replace(/\n/g, ' ')}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      <div className={styles.tbodyOuter} ref={bodyRef} onScroll={onBodyScroll}>
        <table className={styles.table}>
          {colGroup}
          <tbody>
            {filteredRows.length === 0 ? (
              <tr><td colSpan={cols.length} className={styles.emptyCell}>該当銘柄なし</td></tr>
            ) : filteredRows.map((r, i) => (
              <TableRow key={r.code} row={r} idx={i} fin={finDB?.[r.code]} earningsDates={earningsDates} onSaveEarningsDate={onSaveEarningsDate} onClick={() => onRowClick(r.code)} highlighted={highlightCode === r.code} isSuperFav={superFavorites.has(r.code)} onToggleSuperFav={() => onToggleSuperFav(r.code)} showDetail={showDetail} />
            ))}
          </tbody>
        </table>
      </div>
      {/* ビューポート下端に貼り付く横スクロールバー（マウスでドラッグ可・head/bodyと連動） */}
      <div className={styles.hScrollbar} ref={sbRef} onScroll={onSbScroll}>
        <div style={{ width: scrollW, height: 1 }} />
      </div>
    </div>
  )
}

// ─── PerBandBar（PER位置バー・直近1年）──────────────────────────────
function perBandZone(pos: number): { label: string; color: string } {
  if (pos <= 0.33) return { label: '割安', color: '#34d399' }
  if (pos >= 0.67) return { label: '割高', color: '#f87171' }
  return { label: '中立', color: '#fbbf24' }
}
const PER_BAND_REASON_LABEL: Record<string, string> = {
  no_history: '履歴待ち',
  loss: '赤字',
  no_price: 'データ不足',
}
function PerBandBar({ band, likePer, big = false }: { band?: PerBand | null; likePer?: number | null; big?: boolean }) {
  // レンジ自体が出せない（赤字・履歴待ち・データ不足）→ 理由を表示
  if (!band || band.highPER == null || band.lowPER == null) {
    const label = band?.reason ? (PER_BAND_REASON_LABEL[band.reason] ?? '—') : '—'
    return <span className={styles.tdNonDisclosure} style={{ fontSize: 10 }}>{label}</span>
  }
  const hasPos = band.position != null
  const pos = hasPos ? Math.max(0, Math.min(1, band.position!)) : 0.5
  const zone = hasPos ? perBandZone(pos) : { label: '予想なし', color: '#94a3b8' }
  const title =
    (hasPos ? `予想PER ${fmtN(band.fwdPER)}倍 → ${zone.label}\n` : '予想EPS非開示（現在位置なし）\n') +
    `直近1年 PER 安値 ${fmtN(band.lowPER)}倍 ｜ 高値 ${fmtN(band.highPER)}倍`
  const h = big ? 9 : 7
  const dot = big ? 13 : 10
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%' }}>
      <div style={{ position: 'relative', width: '100%', height: h, borderRadius: h / 2, background: 'linear-gradient(90deg,#34d399 0%,#fbbf24 50%,#f87171 100%)' }}>
        {hasPos && (
          <span style={{ position: 'absolute', top: '50%', left: `${pos * 100}%`, transform: 'translate(-50%,-50%)', width: dot, height: dot, borderRadius: '50%', background: '#fff', border: '2px solid #0d1219', boxShadow: '0 0 3px rgba(0,0,0,0.85)' }} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: big ? 11 : 10, lineHeight: 1, color: '#a9b6c6', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        <span title="直近1年のPER安値">{fmtN(band.lowPER, 0)}</span>
        <span style={{ color: zone.color, fontWeight: 800, fontSize: big ? 13 : 11.5 }}>{hasPos ? `${fmtN(band.fwdPER)}倍 ${zone.label}` : zone.label}</span>
        <span title="直近1年のPER高値">{fmtN(band.highPER, 0)}</span>
      </div>
    </div>
  )
}

// ─── セルの具体計算式ツールチップ（実数を当てはめて表示）─────────────
// 「この数字どうやって出てる？」「この数字イレギュラーかも？」を深掘りできるよう、
// 各セルにホバーすると実際の数値を当てはめた計算式を表示する。
function fmtYen0(v: number | null | undefined): string {
  return v == null ? '—' : Math.round(v).toLocaleString('ja-JP')
}
function fmtOku(v: number | null | undefined): string {
  return v == null ? '—' : fmtN(v / 1e8, 1) + '億円'
}
// PEGは「黒字かつEPSがプラス成長」の銘柄でのみ意味を持つ。
// 赤字・減益・成長率ゼロ近辺では巨大値/負値になりミスリードなので、数値表示せず理由を出す。
function pegDisplay(r: StockRow, fin?: import('./lib/types').FinRecord): { text: string; muted: boolean; green: boolean } {
  if (fin?.feps === null) return { text: '非開示', muted: true, green: false }
  if (r.perF != null && r.perF <= 0) return { text: '赤字', muted: true, green: false }
  if (r.epsCurGr != null && r.epsCurGr <= 0) return { text: '減益', muted: true, green: false }
  if (r.peg != null && r.peg > 0) return { text: fmtN(r.peg, 2), muted: false, green: r.peg < 1 }
  return { text: '—', muted: true, green: false }
}
function cellFormula(metric: string, r: StockRow, fin?: import('./lib/types').FinRecord): string | undefined {
  const close = r.close
  switch (metric) {
    case 'close':
      return close ? '株価 ＝ 直近営業日の終値（J-Quants生値・スプリット調整なし）' : undefined
    case 'chg1d': case 'chg1w': case 'chg3m': case 'chg1y': {
      const map: Record<string, [number | null, string]> = {
        chg1d: [r.chg1d, '前営業日'], chg1w: [r.chg1w, '約5営業日前'],
        chg3m: [r.chg3m, '約65営業日前'], chg1y: [r.chg1y, '約250営業日前'],
      }
      const [chg, base] = map[metric]
      if (chg == null || !close) return undefined
      const prev = close / (1 + chg)
      return `騰落率 ＝ (株価 ÷ ${base}終値) − 1\n＝ (${fmtYen0(close)} ÷ ${fmtYen0(prev)}) − 1\n＝ ${fmtPct(chg)}`
    }
    case 'perA':
      if (r.perA == null || !fin?.eps) return undefined
      return `PER実績 ＝ 株価 ÷ 実績EPS\n＝ ${fmtYen0(close)} ÷ ${fmtN(fin.eps, 1)}\n＝ ${fmtN(r.perA, 1)}倍`
    case 'perF': {
      if (r.perF == null || !fin?.feps) return undefined
      const note = fin.fepsShifted ? '\n※FY確定後のため次期予想EPSを充当' : ''
      return `PER今期 ＝ 株価 ÷ 予想EPS（会社予想）\n＝ ${fmtYen0(close)} ÷ ${fmtN(fin.feps, 1)}\n＝ ${fmtN(r.perF, 1)}倍${note}\n（四季報の独自予想とは異なる場合あり）`
    }
    case 'peg': {
      if (fin?.feps === null) return '業績予想を開示していない銘柄です'
      if (r.perF != null && r.perF <= 0) return 'PEGは今期が赤字予想の銘柄では意味を持ちません（PER今期がマイナスになるため）。\nPEGは「黒字かつEPSがプラス成長」の銘柄でのみ有効な指標です。'
      if (r.epsCurGr != null && r.epsCurGr <= 0) return `PEGは今期がEPS減益予想（成長率 ${fmtPct(r.epsCurGr)}）の銘柄では意味を持ちません。\nPEG ＝ PER ÷ 成長率 なので、成長率がマイナス/ゼロ近辺だと巨大化・負値化してしまいます。\nPEGは「黒字かつEPSがプラス成長」の銘柄でのみ有効です。`
      if (r.peg == null || r.epsCurGr == null) return undefined
      return `PEG ＝ PER今期 ÷ EPS今期成長率(%)\n＝ ${fmtN(r.perF, 1)} ÷ ${fmtN(r.epsCurGr * 100, 1)}\n＝ ${fmtN(r.peg, 2)}\n（0〜1で成長に対し割安の目安）`
    }
    case 'nySalesGr':
      if (r.nySalesGr == null || !fin?.sales || !fin?.nySales) return undefined
      return `来期売上成長 ＝ 来期予想売上 ÷ 今期売上 − 1\n＝ ${fmtOku(fin.nySales)} ÷ ${fmtOku(fin.sales)} − 1\n＝ ${fmtPct(r.nySalesGr)}`
    case 'pbr':
      if (r.pbr == null || !fin?.bps) return undefined
      return `PBR ＝ 株価 ÷ BPS(1株純資産)\n＝ ${fmtYen0(close)} ÷ ${fmtN(fin.bps, 1)}\n＝ ${fmtN(r.pbr, 2)}倍`
    case 'roe':
      if (r.roe == null || !fin?.np || !fin?.equity) return undefined
      return `ROE ＝ 純利益 ÷ 自己資本\n＝ ${fmtOku(fin.np)} ÷ ${fmtOku(fin.equity)}\n＝ ${fmtPct(r.roe)}`
    case 'epsCurGr':
      if (r.epsCurGr == null || !fin?.eps || fin?.feps == null) return undefined
      return `EPS今期成長率 ＝ 予想EPS ÷ 実績EPS − 1\n＝ ${fmtN(fin.feps, 1)} ÷ ${fmtN(fin.eps, 1)} − 1\n＝ ${fmtPct(r.epsCurGr)}`
    case 'opMgn':
      if (r.opMgn == null || !fin?.sales || !fin?.op) return undefined
      return `営業利益率 ＝ 営業利益 ÷ 売上高\n＝ ${fmtOku(fin.op)} ÷ ${fmtOku(fin.sales)}\n＝ ${fmtPct(r.opMgn)}`
    case 'divY': {
      const fdiv = fin?.fdiv || fin?.divAnn
      if (r.divY == null || !fdiv) return undefined
      return `配当利回り ＝ 予想1株配当 ÷ 株価\n＝ ${fmtN(fdiv, 1)} ÷ ${fmtYen0(close)}\n＝ ${fmtPct(r.divY)}`
    }
    case 'mcap':
      if (!r.mcap || !close || !fin?.shOut) return undefined
      return `時価総額 ＝ 株価 × 発行済株式数 ÷ 1億\n＝ ${fmtYen0(close)} × ${fmtYen0(fin.shOut)}株 ÷ 1億\n＝ ${fmtN(r.mcap, 0)}億円`
  }
  return undefined
}

// ─── UserMenu（Gmail風アバター＋誤爆防止のログアウト）─────────────────
// ⏻ ボタンの「押すと即ログアウト」を廃止。アバターをクリック→ドロップダウン内の
// 「ログアウト」を明示的に押して初めてログアウトされる（うっかり押し防止）。
function UserMenu({ user, onLogout }: { user: { email?: string; name?: string; picture?: string }; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onDown(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase()
  /* eslint-disable-next-line @next/next/no-img-element */
  const avatar = (cls: string) => user.picture
    ? <img src={user.picture} alt="" className={cls} referrerPolicy="no-referrer" />
    : <span className={cls}>{initial}</span>
  return (
    <div className={styles.userMenu} ref={ref}>
      <button className={styles.avatarBtn} onClick={() => setOpen(o => !o)} title={user.email || user.name || 'アカウント'} aria-label="アカウントメニュー">
        {avatar(styles.avatarImg)}
      </button>
      {open && (
        <div className={styles.userDropdown}>
          <div className={styles.userDropdownHead}>
            {avatar(styles.avatarImgLg)}
            <div className={styles.userDropdownInfo}>
              <div className={styles.userDropdownName}>{user.name || '—'}</div>
              {user.email && <div className={styles.userDropdownEmail} title={user.email}>{user.email}</div>}
            </div>
          </div>
          <button className={styles.userDropdownLogout} onClick={() => { setOpen(false); onLogout() }}>
            ログアウト
          </button>
          <div className={styles.userDropdownNote}>同期データはログアウトしても消えません</div>
        </div>
      )}
    </div>
  )
}

// ─── TableRow ────────────────────────────────────────────────────────
function TableRow({ row: r, idx, fin, earningsDates, onSaveEarningsDate, onClick, highlighted, isSuperFav, onToggleSuperFav, showDetail }: {
  row: StockRow; idx: number; fin?: import('./lib/types').FinRecord
  earningsDates: Record<string,string>; onSaveEarningsDate: (code: string, date: string) => void; onClick: () => void
  highlighted: boolean; isSuperFav: boolean; onToggleSuperFav: () => void
  showDetail: boolean
}) {
  const stickyBg = highlighted ? 'rgba(59,130,246,0.25)' : (idx % 2 === 0 ? '#0d1219' : '#111825')
  const stickyNameBg = highlighted ? 'rgba(59,130,246,0.25)' : (idx % 2 === 0 ? '#131825' : '#171d2e')
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <tr data-code={r.code} className={highlighted ? styles.trHighlight : undefined} style={{ cursor: 'pointer' }} onClick={onClick}>
      <td className={styles.tdStar} style={{background: stickyBg}}>
        <button
          className={isSuperFav ? styles.heartBtnOn : styles.heartBtn}
          onClick={e => { e.stopPropagation(); onToggleSuperFav() }}
          title={isSuperFav ? '超お気に入り解除' : '超お気に入りに追加'}
        >♥</button>
        <span className={styles.starSymbol}>★</span>
      </td>
      <td className={`${styles.tdCode} ${styles.stickyCol0}`} style={{background: stickyBg}}>{r.code}</td>
      <td className={`${styles.tdName} ${styles.stickyCol1} ${fin?.discDate ? styles.hasTooltip : ''}`} style={{background: stickyNameBg}}
        title={fin?.discDate ? `開示: ${fin.discDate.replace(/-/g,'/')} (${fin.perType === 'FY' ? 'FY通期' : fin.perType || '—'})` : undefined}
      >
        {r.name || '—'}
        {fin?.discDate && isDataStale(fin.discDate) && (
          <span
            className={styles.staleIcon}
            onClick={e => e.stopPropagation()}
            title={`直近決算: ${fin.discDate.replace(/-/g,'/')}（${daysSince(fin.discDate)}日経過）${earningsDates[r.code] ? ` ／ 次決算予定: ${earningsDates[r.code].replace(/-/g, '/')}` : ''}`}
          >⚠</span>
        )}
      </td>
      <td className={styles.tdGenres}>{r.genres.map(g => <span key={g} className={styles.genreBadge}>{g}</span>)}</td>
      <td><span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span></td>
      {showDetail && <td className={`${styles.tdNum} ${styles.hasTooltip}`} title={cellFormula('mcap', r, fin)}>{r.mcap ? r.mcap.toLocaleString() : '—'}</td>}
      <td className={`${styles.tdNum} ${styles.hasTooltip}`} title={cellFormula('close', r, fin)}>{r.close ? r.close.toLocaleString() : '—'}</td>
      <td className={`${styles.tdPct} ${styles.hasTooltip}`} style={{ background: pctBg(r.chg1d), color: pctCellColor(r.chg1d) }} title={cellFormula('chg1d', r, fin)}>{fmtPct(r.chg1d)}</td>
      {([['chg1w', r.chg1w], ['chg3m', r.chg3m], ['chg1y', r.chg1y]] as const).map(([k, v]) => (
        <td key={k} className={`${styles.tdPct} ${styles.hasTooltip}`} style={{ background: pctBg(v), color: pctCellColor(v) }} title={cellFormula(k, r, fin)}>{fmtPct(v)}</td>
      ))}
      <td className={`${styles.tdNum} ${styles.tdPerGroup} ${styles.hasTooltip}`}
        title={cellFormula('perA', r, fin) ?? (fin?.discDate ? `実績EPS基準 / 直近決算: ${fin.discDate}` : undefined)}
      >{r.perA ? fmtN(r.perA) : '—'}</td>
      <td className={`${styles.tdNum} ${styles.tdPerGroup} ${styles.hasTooltip} ${fin?.feps === null ? styles.tdNonDisclosure : ''}`}
        title={cellFormula('perF', r, fin) ?? (fin?.feps === null ? '業績予想を開示していない銘柄です' : undefined)}
      >{r.perF != null ? fmtN(r.perF) : fin?.feps === null ? '非開示' : '—'}</td>
      <td className={`${styles.tdPct} ${styles.tdPerGroup} ${fin?.feps === null ? styles.tdNonDisclosure : styles.hasTooltip}`}
        style={fin?.feps !== null ? {background: pctBg(r.perFChg1m), color: pctCellColor(r.perFChg1m)} : undefined}
        title={fin?.feps === null ? '業績予想を開示していない銘柄です' : (r.perFChg1mPrev && r.perF && fin?.feps1m) ? `1M前: PER ${fmtN(r.perFChg1mPrev)}倍 (FEPS ${fmtN(fin.feps1m, 0)}円) → 現在: PER ${fmtN(r.perF)}倍 (FEPS ${fmtN(fin.feps ?? null, 0)}円) ／ PER変化: ${fmtPct(r.perFChg1m)}` : undefined}
      >{fin?.feps === null ? '非開示' : fmtPct(r.perFChg1m)}</td>
      {(() => { const peg = pegDisplay(r, fin); return (
        <td className={`${styles.tdNum} ${styles.tdPerGroup} ${styles.hasTooltip} ${peg.muted ? styles.tdNonDisclosure : ''}`} title={cellFormula('peg', r, fin)} style={{color: peg.green ? '#10b981' : undefined}}>{peg.text}</td>
      ) })()}
      <td className={styles.tdPerGroup} style={{padding:'4px 8px'}}><PerBandBar band={r.perBand} likePer={r.likePer} /></td>
      <td className={`${styles.tdPct} ${styles.tdPerGroup} ${styles.hasTooltip} ${r.nySalesGr === null ? styles.tdNonDisclosure : ''}`} title={cellFormula('nySalesGr', r, fin)} style={r.nySalesGr !== null ? {color: pctCellColor(r.nySalesGr)} : undefined}>{r.nySalesGr !== null ? fmtPct(r.nySalesGr) : '非開示'}</td>
      {showDetail && <td className={`${styles.tdNum} ${styles.hasTooltip}`} title={cellFormula('pbr', r, fin)}>{r.pbr  ? fmtN(r.pbr)  : '—'}</td>}
      {showDetail && <td className={`${styles.tdNum} ${styles.hasTooltip}`} title={cellFormula('roe', r, fin)} style={{color: r.roe && r.roe > 0.1 ? '#10b981' : undefined}}>{r.roe ? fmtPct(r.roe) : '—'}</td>}
      {showDetail && <td className={`${styles.tdPct} ${styles.hasTooltip} ${fin?.feps === null ? styles.tdNonDisclosure : ''}`} title={cellFormula('epsCurGr', r, fin)} style={{color: r.epsCurGr !== null ? pctCellColor(r.epsCurGr) : undefined}}>{r.epsCurGr !== null ? fmtPct(r.epsCurGr) : fin?.feps === null ? '非開示' : '—'}</td>}
      {showDetail && <td className={`${styles.tdNum} ${styles.hasTooltip}`} title={cellFormula('opMgn', r, fin)} style={{color: r.opMgn && r.opMgn > 0.15 ? '#10b981' : undefined}}>{r.opMgn ? fmtPct(r.opMgn) : '—'}</td>}
      {showDetail && <td className={`${styles.tdNum} ${styles.hasTooltip}`} title={cellFormula('divY', r, fin)} style={{color: r.divY && r.divY > 0.03 ? '#10b981' : undefined}}>{r.divY ? fmtPct(r.divY) : '—'}</td>}
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()} style={{textAlign:'center', padding:'0 4px'}}>
        <LinkDropdown code={r.code} name={r.name || r.code} />
      </td>
      <td onClick={e => e.stopPropagation()} style={{textAlign:'center', padding:'0 4px'}}>
        <EarningsDateCell code={r.code} date={earningsDates[r.code] ?? ''} onSave={onSaveEarningsDate} fin={fin} />
      </td>
    </tr>
  )
}

// ─── EarningsDateCell ────────────────────────────────────────────────
function EarningsDateCell({ code, date, onSave, fin }: {
  code: string; date: string; onSave: (code: string, date: string) => void; fin?: import('./lib/types').FinRecord
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(date)
  const displayDate = fin?.nextAnnouncementDate || date

  function getDaysUntil(d: string): number | null {
    if (!d) return null
    return (new Date(d).getTime() - Date.now()) / 86400000
  }
  function getColor(d: string): string {
    const days = getDaysUntil(d)
    if (days === null) return ''
    if (days < 0) return '#94a3b8'
    if (days <= 7) return '#f87171'
    if (days <= 14) return '#fbbf24'
    return ''
  }
  function formatShort(d: string): string {
    if (!d) return '—'
    const m = d.slice(5, 7).replace(/^0/, '')
    const day = d.slice(8, 10).replace(/^0/, '')
    const days = getDaysUntil(d)
    const label = `${m}/${day}`
    if (days !== null && days >= 0 && days <= 3) return `${label}(${Math.ceil(days)}d)`
    return label
  }
  if (editing) return (
    <span style={{display:'inline-flex', gap:2, alignItems:'center'}}>
      <input type="date" autoFocus value={val} min={new Date().toISOString().slice(0,10)} onChange={e => setVal(e.target.value)}
        style={{fontSize:10, padding:'1px 2px', background:'#1e2735', border:'1px solid #3b82f6', color:'#e2e8f0', borderRadius:3, width:110}}
        onFocus={e => { try { (e.target as HTMLInputElement & {showPicker?:()=>void}).showPicker?.() } catch {} }}
        onClick={e => { e.stopPropagation(); try { (e.target as HTMLInputElement & {showPicker?:()=>void}).showPicker?.() } catch {} }}
        onKeyDown={e => { if (e.key === 'Enter') { onSave(code, val); setEditing(false) } if (e.key === 'Escape') { setVal(date); setEditing(false) } }}
      />
      <button onClick={() => { onSave(code, val); setEditing(false) }}
        style={{fontSize:10, padding:'1px 4px', background:'#3b82f6', border:'none', borderRadius:3, color:'#fff', cursor:'pointer'}}>✓</button>
      <button onClick={() => { setVal(date); setEditing(false) }}
        style={{fontSize:10, padding:'1px 4px', background:'transparent', border:'none', color:'#94a3b8', cursor:'pointer'}}>✕</button>
    </span>
  )
  return (
    <span
      title={displayDate ? `次回決算: ${displayDate}\nクリックして手動設定` : 'クリックして決算予定日を入力'}
      style={{
        fontSize: 11,
        color: displayDate ? (getColor(displayDate) || '#4a7090') : '#60a5fa',
        cursor: 'pointer', padding: '2px 5px', borderRadius: 3,
        border: displayDate ? '1px solid transparent' : '1px dashed rgba(96,165,250,0.5)',
        background: displayDate ? 'transparent' : 'rgba(59,130,246,0.06)',
        whiteSpace: 'nowrap', display: 'inline-block',
      }}
      onClick={() => { setVal(displayDate); setEditing(true) }}
    >
      {displayDate ? formatShort(displayDate) : '+'}
    </span>
  )
}

// ─── SpMemoCard（SP専用メモ重視カード）────────────────────────────────
function SpMemoCard({ row: r, memo, memoUpdatedAt, onSaveMemo, isFav, isSuperFav, onToggleFav, onToggleSuperFav }: {
  row: StockRow; memo: string; memoUpdatedAt?: string
  onSaveMemo: (code: string, text: string) => void
  isFav: boolean; isSuperFav: boolean
  onToggleFav: (code: string) => void; onToggleSuperFav: (code: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memo)
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)

  function handleBlur() {
    setEditing(false)
    if (draft !== memo) onSaveMemo(r.code, draft)
  }

  const dayCls = pctClass(r.chg1d)
  const arrow = r.chg1d == null ? '' : r.chg1d > 0 ? '▲' : r.chg1d < 0 ? '▼' : '—'
  // メトリクス帯（読める大きさ・色分け）
  const metrics: [string, string, string][] = [
    ['1週',     fmtPct(r.chg1w), pctClass(r.chg1w)],
    ['1ヶ月',   fmtPct(r.chg1m), pctClass(r.chg1m)],
    ['PER今期', r.perF != null ? fmtN(r.perF) + '倍' : '—', ''],
    ['PEG',     r.peg  != null ? fmtN(r.peg, 2) : '—', r.peg != null && r.peg > 0 && r.peg < 1 ? 'up' : ''],
  ]

  return (
    <div className={`${styles.spMemoCard} ${styles['spAccent_' + dayCls]}`}>
      {/* 見出し: ★/♥ + 銘柄名 + 市場バッジ */}
      <div className={styles.spCardRow1}>
        <button className={`${styles.spFavBtn} ${isFav ? styles.spFavBtnActive : ''}`}
          onClick={e => { e.stopPropagation(); onToggleFav(r.code) }} aria-label="お気に入り（★）">
          {isFav ? '★' : '☆'}
        </button>
        <button className={`${styles.spSuperFavBtn} ${isSuperFav ? styles.spSuperFavBtnActive : ''}`}
          onClick={e => { e.stopPropagation(); onToggleSuperFav(r.code) }} aria-label="超お気に入り（♥）">
          {isSuperFav ? '♥' : '♡'}
        </button>
        <span className={styles.spCardName}>{r.name || '—'}</span>
        <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
      </div>
      {/* コード + ジャンル */}
      <div className={styles.spCardCodeRow}>
        <span className={styles.spCardCode}>{r.code}</span>
        {r.genres.slice(0, 3).map(g => <span key={g} className={styles.spGenreBadge}>{g}</span>)}
      </div>

      {/* ヒーロー: 株価（大）+ 前日比（大・色付きピル） */}
      <div className={styles.spHero}>
        <div className={styles.spHeroPrice}>
          <span className={styles.spHeroYen}>¥</span>{r.close ? r.close.toLocaleString() : '—'}
        </div>
        <div className={`${styles.spHeroChg} ${styles['spChgBox_' + dayCls]}`}>
          <span className={styles.spHeroArrow}>{arrow}</span>
          <span>{fmtPct(r.chg1d)}</span>
        </div>
      </div>

      {/* メトリクス帯（4分割） */}
      <div className={styles.spMetrics}>
        {metrics.map(([l, v, c]) => (
          <div key={l} className={styles.spMetric}>
            <div className={styles.spMetricLabel}>{l}</div>
            <div className={`${styles.spMetricValue} ${c ? styles[c] : ''}`}>{v}</div>
          </div>
        ))}
      </div>

      {/* PER位置バー */}
      {r.perBand && (r.perBand.highPER != null || r.perBand.reason) && (
        <div className={styles.spBandWrap}>
          <PerBandBar band={r.perBand} likePer={r.likePer} big />
        </div>
      )}

      {/* メモエリア: 空なら1行プレースホルダー */}
      <div className={`${styles.spMemoArea} ${memo ? '' : styles.spMemoAreaEmpty}`}
        onClick={() => !editing && setEditing(true)}>
        {editing ? (
          <textarea
            className={styles.spMemoTextarea}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={handleBlur}
            autoFocus
            rows={3}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <>
            {memo
              ? <div className={styles.spMemoText}>{memo}</div>
              : <div className={styles.spMemoPlaceholder}>📝 メモ（タップして入力）</div>
            }
            {memo && memoUpdatedAt && <div className={styles.spMemoDate}>{fmtJpDate(memoUpdatedAt)}</div>}
          </>
        )}
      </div>
    </div>
  )
}

// ─── BottomNav（SP専用・固定ボトムナビ）──────────────────────────────
function BottomNav({ tab, onSelect }: { tab: TabKey; onSelect: (t: TabKey) => void }) {
  const items: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'card', label: 'ダッシュ', icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
        <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
      </svg>
    ) },
    { key: 'watchlist', label: 'ウォッチ', icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2.5 15 9 22 9.7 16.7 14.2 18.3 21 12 17.3 5.7 21 7.3 14.2 2 9.7 9 9"/>
      </svg>
    ) },
    { key: 'news', label: 'ニュース', icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/>
        <line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/>
      </svg>
    ) },
    { key: 'report', label: 'レポート', icon: (
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="20" x2="20" y2="20"/><rect x="5" y="11" width="3.5" height="7" rx="0.8"/>
        <rect x="10.2" y="6" width="3.5" height="12" rx="0.8"/><rect x="15.5" y="13" width="3.5" height="5" rx="0.8"/>
      </svg>
    ) },
  ]
  const isActive = (k: TabKey) => k === 'card' ? (tab === 'card' || tab === 'dashboard') : tab === k
  return (
    <nav className={styles.bottomNav} aria-label="メインナビゲーション">
      {items.map(it => (
        <button key={it.key}
          className={`${styles.bottomNavBtn} ${isActive(it.key) ? styles.bottomNavBtnActive : ''}`}
          onClick={() => onSelect(it.key)}
          aria-current={isActive(it.key) ? 'page' : undefined}>
          {it.icon}
          <span className={styles.bottomNavLabel}>{it.label}</span>
        </button>
      ))}
    </nav>
  )
}

// ─── MobileRow ───────────────────────────────────────────────────────
function MobileRow({ row: r, onClick }: { row: StockRow; onClick: () => void }) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.mobileRow} onClick={onClick}>
      <div className={styles.mobileRowLeft}>
        <div className={styles.mobileRowTop}>
          <span className={styles.mobileCode}>{r.code}</span>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        </div>
        <div className={styles.mobileName}>{r.name || '—'}</div>
        <div className={styles.mobileMetaRow}>
          <span className={styles.mobileMetaItem}>PER {r.perF ? fmtN(r.perF) : '—'}</span>
          <span className={styles.mobileMetaItem}>PBR {r.pbr ? fmtN(r.pbr) : '—'}</span>
          <span className={styles.mobileMetaItem}>配当 {r.divY ? fmtPct(r.divY) : '—'}</span>
          {r.mcap ? <span className={styles.mobileMetaItem}>{r.mcap.toLocaleString()}億</span> : null}
        </div>
      </div>
      <div className={styles.mobileRowRight}>
        <div className={styles.mobilePrice}>{r.close ? r.close.toLocaleString() : '—'}</div>
        <div className={`${styles.mobileChg} ${styles[pctClass(r.chg1d)]}`}>{fmtPct(r.chg1d)}</div>
        <div className={styles.mobileSubChg}>
          <span className={styles[pctClass(r.chg1w)]}>1W {fmtPct(r.chg1w)}</span>
          <span className={styles[pctClass(r.chg3m)]}>3M {fmtPct(r.chg3m)}</span>
        </div>
      </div>
    </div>
  )
}

// 業種（ジャンル）から決定的に色を作る（同じジャンルは常に同じ色）。ロゴチップ用。
function genreColor(g: string): string {
  if (!g) return 'hsl(210 25% 40%)'
  let h = 0
  for (let i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) % 360
  return `hsl(${h} 58% 44%)`
}

// ─── StockCard ───────────────────────────────────────────────────────
function StockCard({ row: r, apiKey, serverHasKey = false, onClick, refreshKey = 0, chartMode, onChartModeChange }: {
  row: StockRow; apiKey: string; serverHasKey?: boolean; onClick: () => void; refreshKey?: number
  chartMode: ChartMode; onChartModeChange: (m: ChartMode) => void
}) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.cardCode}>{r.code}</div>
          <div className={styles.cardName}>{r.name || '—'}</div>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
          {r.genres[0] && <span className={styles.cardGenreBadge}>{r.genres[0]}</span>}
        </div>
        <div className={styles.cardRight}>
          <div className={styles.cardLogo} style={{ background: genreColor(r.genres[0] || '') }} title={r.genres[0] || ''}>
            {(r.name || r.code).slice(0, 1)}
          </div>
          {r.mcap ? <div className={styles.cardMcap}>{r.mcap.toLocaleString()}億</div> : null}
        </div>
      </div>
      <div className={styles.cardPriceRow}>
        <div className={styles.cardPrice}>{r.close ? r.close.toLocaleString() : '—'}</div>
        <div className={`${styles.cardChange} ${styles[pctClass(r.chg1d)]}`}>{fmtPct(r.chg1d)}</div>
      </div>
      {r.genres.length > 0 && (
        <div className={styles.cardGenreRow}>
          {r.genres.map(g => <span key={g} className={styles.cardGenreTag}>{g}</span>)}
        </div>
      )}
      <div className={styles.cardMetrics}>
        {[
          ['1ヶ月%',   r.chg1m != null ? fmtPct(r.chg1m) : '—',   pctClass(r.chg1m)],
          ['PER今期',  r.perF  != null ? fmtN(r.perF)     : '—',   ''],
          ['PEG',      r.peg   != null ? fmtN(r.peg, 2)   : '—',   r.peg != null && r.peg > 0 && r.peg < 1 ? 'up' : ''],
          ['来期売上%', r.nySalesGr != null ? fmtPct(r.nySalesGr) : '—', r.nySalesGr != null ? pctClass(r.nySalesGr) : ''],
          ['ROE',      r.roe   != null ? fmtPct(r.roe)    : '—',   r.roe != null && r.roe > 0.1 ? 'up' : ''],
          ['営業利益率', r.opMgn != null ? fmtPct(r.opMgn) : '—',  r.opMgn != null && r.opMgn > 0.15 ? 'up' : ''],
        ].map(([l, v, c]) => (
          <div key={l} className={styles.cardMetric}>
            <div className={styles.cardMetricLabel}>{l}</div>
            <div className={`${styles.cardMetricValue} ${c ? styles[c] : ''}`}>{v}</div>
          </div>
        ))}
      </div>
      {(apiKey || serverHasKey) && (
        <div onClick={e => e.stopPropagation()}>
          <MiniChart code={r.code} apiKey={apiKey} serverHasKey={serverHasKey} refreshKey={refreshKey} mode={chartMode} onModeChange={onChartModeChange} />
        </div>
      )}
      <div className={styles.cardLinks} onClick={e => e.stopPropagation()}>
        <a className={styles.cardLinkBtn} href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank" rel="noopener noreferrer">四季報</a>
        <a className={styles.cardLinkBtn} href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank" rel="noopener noreferrer">かぶたん</a>
        <a className={styles.cardLinkBtn} href={`https://x.com/search?q=${encodeURIComponent(r.code + ' ' + (r.name || ''))}&f=live`} target="_blank" rel="noopener noreferrer">X検索</a>
        <a className={styles.cardLinkBtn} href={`https://finance.yahoo.co.jp/quote/${r.code}.T`} target="_blank" rel="noopener noreferrer">Yahoo</a>
        <a className={styles.cardLinkBtn} href={`https://irbank.net/${r.code}`} target="_blank" rel="noopener noreferrer">IRBank</a>
        <a className={styles.cardLinkBtn} href={`https://minkabu.jp/stock/${r.code}`} target="_blank" rel="noopener noreferrer">みんかぶ</a>
        <a className={styles.cardLinkBtn} href={`https://www.buffett-code.com/company/${r.code}`} target="_blank" rel="noopener noreferrer">Buffett</a>
        <a className={styles.cardLinkBtn} href={`https://jp.tradingview.com/chart/?symbol=TSE:${r.code}`} target="_blank" rel="noopener noreferrer">TV</a>
      </div>
    </div>
  )
}

// ─── GenreFilterDropdown（列ヘッダーフィルター）────────────────────────
function GenreFilterDropdown({ genres, activeFilters, onApply, onClear, label }: {
  genres: string[]
  activeFilters: Set<string>
  onApply: (filters: Set<string>) => void
  onClear: () => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set(activeFilters))
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEscapeClose(open, () => setOpen(false))

  useEffect(() => { setPending(new Set(activeFilters)) }, [activeFilters])

  useEffect(() => {
    if (!open) return
    if (btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const left = Math.max(4, r.left - 200 + r.width + 4)
      setPanelStyle({ position: 'fixed', top: r.bottom + 4, left })
    }
    function onDown(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const filtered = genres.filter(g => !search.trim() || g.includes(search.trim()))
  const allSelected = filtered.length > 0 && filtered.every(g => pending.has(g))

  function toggleAll() {
    const next = new Set(pending)
    if (allSelected) { filtered.forEach(g => next.delete(g)) }
    else             { filtered.forEach(g => next.add(g)) }
    setPending(next)
  }

  return (
    <>
      <button
        ref={btnRef}
        className={`${styles.genreFilterBtn} ${activeFilters.size > 0 ? styles.genreFilterBtnActive : ''}`}
        onClick={() => setOpen(o => !o)}
        title="ジャンルで絞り込み"
      >{label ? `${label} ▼` : '▼'}</button>
      {open && (
        <div className={styles.genreFilterPanel} ref={panelRef} style={panelStyle}>
          <input
            className={styles.genreFilterSearch}
            placeholder="🔍 ジャンル検索"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          <div className={styles.genreFilterSelectAll} onClick={toggleAll}>
            <span className={`${styles.genreFilterCheck} ${allSelected ? styles.genreFilterCheckOn : ''}`} />
            <span>{allSelected ? '全解除' : '全選択'}</span>
          </div>
          <div className={styles.genreFilterList}>
            {filtered.map(g => (
              <div key={g} className={styles.genreFilterItem} onClick={() => {
                const next = new Set(pending)
                next.has(g) ? next.delete(g) : next.add(g)
                setPending(next)
              }}>
                <span className={`${styles.genreFilterCheck} ${pending.has(g) ? styles.genreFilterCheckOn : ''}`} />
                <span className={styles.genreFilterLabel}>{g}</span>
              </div>
            ))}
            {/* 未設定フィルター（常に末尾に表示） */}
            {!search.trim() && (
              <div className={styles.genreFilterItem} onClick={() => {
                const next = new Set(pending)
                next.has(GENRE_UNSET) ? next.delete(GENRE_UNSET) : next.add(GENRE_UNSET)
                setPending(next)
              }}>
                <span className={`${styles.genreFilterCheck} ${pending.has(GENRE_UNSET) ? styles.genreFilterCheckOn : ''}`} />
                <span className={styles.genreFilterLabel} style={{color:'#f87171'}}>未設定</span>
              </div>
            )}
          </div>
          <div className={styles.genreFilterDivider} />
          <div className={styles.genreFilterActions}>
            <button className={styles.genreFilterApplyBtn} onClick={() => { onApply(pending); setOpen(false) }}>適用</button>
            <button className={styles.genreFilterClearBtn} onClick={() => { onClear(); setPending(new Set()); setOpen(false) }}>クリア</button>
          </div>
        </div>
      )}
    </>
  )
}

// ─── InlineGenreAdd ──────────────────────────────────────────────────
function InlineGenreAdd({ onAdd }: { onAdd: (name: string) => void }) {
  const [val, setVal] = useState('')
  const [open, setOpen] = useState(false)
  if (!open) return (
    <button className={styles.genreTag} style={{borderStyle:'dashed'}} onClick={() => setOpen(true)}>＋ 新規</button>
  )
  return (
    <span style={{display:'inline-flex', gap:3, alignItems:'center'}}>
      <input autoFocus className={styles.genreNewInput} placeholder="ジャンル名..." value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && val.trim()) { onAdd(val.trim()); setVal(''); setOpen(false) }
          if (e.key === 'Escape') { setVal(''); setOpen(false) }
        }}
        maxLength={10} style={{width:80}}
      />
      <button className={styles.genreAddBtn}
        onClick={() => { if (val.trim()) { onAdd(val.trim()); setVal(''); setOpen(false) } }}>追加</button>
      <button className={styles.genreResetBtn} onClick={() => { setVal(''); setOpen(false) }}>✕</button>
    </span>
  )
}

// ─── GenreRenameInput ────────────────────────────────────────────────
function GenreRenameInput({
  defaultValue, onConfirm, onCancel,
}: {
  defaultValue: string
  onConfirm: (newName: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(defaultValue)
  const cancelledRef = useRef(false)
  return (
    <input
      className={styles.genreRenameInput}
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter')  { e.preventDefault(); onConfirm(value) }
        if (e.key === 'Escape') { e.preventDefault(); cancelledRef.current = true; onCancel() }
      }}
      onBlur={() => { if (!cancelledRef.current) onConfirm(value) }}
      maxLength={20}
      autoFocus
    />
  )
}

// ─── AddGenreInput ───────────────────────────────────────────────────
function AddGenreInput({ onAdd }: { onAdd: (name: string) => void }) {
  const [val, setVal] = useState('')
  return (
    <span style={{display:'inline-flex', gap:4, alignItems:'center'}}>
      <input className={styles.genreNewInput} placeholder="新ジャンル名..." value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && val.trim()) { onAdd(val); setVal('') } }}
        maxLength={10}
      />
      <button className={styles.genreAddBtn}
        onClick={() => { if (val.trim()) { onAdd(val); setVal('') } }}>+追加</button>
    </span>
  )
}

// ─── VoiceMemoInput ──────────────────────────────────────────────────
type VoicePhase = 'idle' | 'recording' | 'review'

function VoiceMemoInput({ onAppend }: { onAppend: (text: string) => void }) {
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
          メモに追加 ↓
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

// ─── NewsSection ─────────────────────────────────────────────────────
// 銘柄別ニュース（GoogleニュースRSS / 無料・キー不要）。
// 公開から3日以内の記事に「NEW」を付ける（何度開いても表示される）。
type NewsArticle = { title: string; link: string; source: string; pubDate: string }
const NEWS_NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000 // 直近3日以内をNEW扱い

function fmtRelTime(pubDate: string): string {
  const t = new Date(pubDate).getTime()
  if (!t || Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}時間前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}日前`
  return `${Math.floor(day / 30)}ヶ月前`
}

type NewsSort = 'date' | 'source'

function NewsSection({ code, name }: { code: string; name: string }) {
  const [articles, setArticles] = useState<NewsArticle[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sort, setSort] = useState<NewsSort>('date')

  useEffect(() => {
    let cancelled = false
    setArticles(null); setErr(null)

    fetch(`/api/news?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: { articles?: NewsArticle[] }) => {
        if (cancelled) return
        setArticles(d.articles ?? [])
      })
      .catch(e => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })

    return () => { cancelled = true }
  }, [code, name])

  const sorted = useMemo(() => {
    if (!articles) return []
    const byDate = (a: NewsArticle, b: NewsArticle) =>
      new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime()
    if (sort === 'date') return [...articles].sort(byDate)
    // メディア別: ソース名でグループ化し、各グループ内は新しい順
    return [...articles].sort((a, b) => {
      const s = (a.source || '').localeCompare(b.source || '', 'ja')
      return s !== 0 ? s : byDate(a, b)
    })
  }, [articles, sort])

  if (err) return <div className={styles.newsEmpty}>ニュース取得に失敗しました（{err}）</div>
  if (articles === null) return <div className={styles.newsEmpty}>読み込み中…</div>
  if (articles.length === 0) return <div className={styles.newsEmpty}>直近のニュースは見つかりませんでした</div>

  return (
    <>
      <div className={styles.newsSortRow}>
        <span className={styles.newsCount}>直近3ヶ月・{articles.length}件</span>
        <div className={styles.newsSortBtns}>
          <button
            className={`${styles.newsSortBtn} ${sort === 'date' ? styles.newsSortBtnActive : ''}`}
            onClick={() => setSort('date')}
          >新しい順</button>
          <button
            className={`${styles.newsSortBtn} ${sort === 'source' ? styles.newsSortBtnActive : ''}`}
            onClick={() => setSort('source')}
          >メディア別</button>
        </div>
      </div>
      <div className={styles.newsList}>
        {sorted.map((a, i) => {
          const t = new Date(a.pubDate).getTime()
          const isNew = !!t && !Number.isNaN(t) && (Date.now() - t) < NEWS_NEW_WINDOW_MS
          return (
            <a key={a.link || i} className={styles.newsItem} href={a.link} target="_blank" rel="noopener noreferrer">
              <div className={styles.newsItemHead}>
                {isNew && <span className={styles.newsBadge}>NEW</span>}
                <span className={styles.newsSource}>{a.source || 'ニュース'}</span>
                <span className={styles.newsTime}>{fmtRelTime(a.pubDate)}</span>
              </div>
              <div className={styles.newsTitle}>{a.title}</div>
            </a>
          )
        })}
      </div>
    </>
  )
}

// ─── ScrollTopButton（下までスクロールすると出る「一番上へ」） ──────────
function ScrollTopButton() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 500)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  if (!show) return null
  return (
    <button
      className={styles.scrollTopBtn}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="一番上へ戻る"
      aria-label="一番上へ戻る"
    >↑ TOP</button>
  )
}

// ─── NewsFeed（お気に入り銘柄のニュース一覧タブ） ─────────────────────
type FeedItem = { title: string; link: string; source: string; sourceUrl: string; pubDate: string; code: string; name: string; ir: boolean; disc: boolean }
type FeedScope = 'all' | 'hearts'
const IR_FILTER = '__IR__'     // 企業公式サイト発
const DISC_FILTER = '__DISC__' // 決算・適時開示（媒体不問）
const FEED_DISPLAY_STEP = 600 // 1度に描画する件数の増分（DOM負荷対策。絞り込みは全件対象）

// タブを行き来しても再取得しないためのモジュールキャッシュ（SPA内で永続）。
let feedCache: { key: string; items: FeedItem[] } | null = null
let feedLastFetched: number | null = null

function faviconUrl(sourceUrl: string): string {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(sourceUrl).hostname}&sz=64` }
  catch { return '' }
}

// 検索用: 全角英数字を半角化＋小文字化（「ＩＭＶ」「imv」どちらでもヒット）
function normJa(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase()
}

// カナ→ローマ字（簡易ヘボン式）。「ファナック」→"fanakku" 等。検索でローマ字/英語入力に対応するため。
const ROMAJI_2: Record<string, string> = {
  'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho','チャ':'cha','チュ':'chu','チョ':'cho',
  'ニャ':'nya','ニュ':'nyu','ニョ':'nyo','ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo','ジャ':'ja','ジュ':'ju','ジョ':'jo',
  'ビャ':'bya','ビュ':'byu','ビョ':'byo','ピャ':'pya','ピュ':'pyu','ピョ':'pyo',
  'ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo','ウィ':'wi','ウェ':'we','ウォ':'wo','ヴァ':'va','ヴィ':'vi','ヴェ':'ve','ヴォ':'vo',
  'ティ':'ti','ディ':'di','トゥ':'tu','ドゥ':'du','チェ':'che','シェ':'she','ジェ':'je',
}
const ROMAJI_1: Record<string, string> = {
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o','カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko','ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so','ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo','タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do','ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no','ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo','パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po','マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
  'ヤ':'ya','ユ':'yu','ヨ':'yo','ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro','ワ':'wa','ヲ':'wo','ン':'n','ヴ':'vu','ー':'','ッ':'','・':' ',
}
function toRomaji(s: string): string {
  // ひらがな→カタカナに寄せる
  const kata = s.replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
  let out = ''
  for (let i = 0; i < kata.length;) {
    const two = kata.slice(i, i + 2)
    if (ROMAJI_2[two]) { out += ROMAJI_2[two]; i += 2; continue }
    const one = kata[i]
    out += ROMAJI_1[one] ?? one
    i++
  }
  return out
}
// あいまい一致用にゆるく正規化（c→k統一・連続文字を1つに・長音記号除去）
function loosen(s: string): string {
  return normJa(s).replace(/[ー\s・,，、。]/g, '').replace(/c/g, 'k').replace(/l/g, 'r').replace(/(.)\1+/g, '$1')
}
// 銘柄1件の検索用テキスト（日本語名＋ローマ字＋コード）
function stockHaystack(name: string, code: string): string {
  return loosen(name) + ' ' + loosen(toRomaji(name)) + ' ' + code.toLowerCase()
}

async function postNewsFeed(stocks: { code: string; name: string }[], fresh: boolean): Promise<FeedItem[]> {
  if (stocks.length === 0) return []
  const res = await fetch('/api/news-feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stocks, fresh }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  return (d.items ?? []) as FeedItem[]
}

function mergeFeed(a: FeedItem[], b: FeedItem[]): FeedItem[] {
  const seen = new Set<string>(); const out: FeedItem[] = []
  for (const it of [...a, ...b]) {
    const k = it.link || it.title.slice(0, 40)
    if (seen.has(k)) continue
    seen.add(k); out.push(it)
  }
  out.sort((x, y) => new Date(y.pubDate).getTime() - new Date(x.pubDate).getTime())
  return out
}

function NewsFeed({ heartCodes, starCodes, nameOf, onClickCode }: {
  heartCodes: string[]; starCodes: string[]
  nameOf: (code: string) => string; onClickCode: (code: string) => void
}) {
  const [scope, setScope] = useState<FeedScope>('all')
  const [items, setItems] = useState<FeedItem[] | null>(feedCache?.items ?? null)
  const [err, setErr] = useState<string | null>(null)
  const [phase, setPhase] = useState('')
  const [loading, setLoading] = useState(false)
  const [stockQuery, setStockQuery] = useState('')           // 銘柄の検索（名前/コード）
  const [mediaSet, setMediaSet] = useState<Set<string>>(new Set()) // メディア絞り込み（複数選択）
  const [mediaOpen, setMediaOpen] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(feedLastFetched)
  const [visible, setVisible] = useState(FEED_DISPLAY_STEP) // 「もっと見る」で増やす表示件数

  // ♥（スコープ絞り込みは表示側で行う。読み込みは全お気に入りを一括で扱う）
  const heartSet = useMemo(() => new Set(heartCodes), [heartCodes])
  const allCodes = useMemo(() => Array.from(new Set([...starCodes, ...heartCodes])), [starCodes, heartCodes])
  const loadKey = [...allCodes].sort().join(',')

  // 蓄積DB(/api/news-stored)を読むだけの即表示。空ならライブ取得にフォールバック。
  const liveFanout = useCallback(async (fresh: boolean) => {
    const hearts = heartCodes.map(c => ({ code: c, name: nameOf(c) }))
    if (!fresh) setPhase(`お気に入り(♥${hearts.length})を取得中…`)
    let all = await postNewsFeed(hearts, fresh)
    setItems(all)
    const rest = starCodes.filter(c => !heartSet.has(c)).map(c => ({ code: c, name: nameOf(c) }))
    if (rest.length > 0) {
      if (!fresh) setPhase(`他のウォッチ銘柄(${rest.length})も取得中…`)
      all = mergeFeed(all, await postNewsFeed(rest, fresh))
      setItems(all)
    }
    return all
  }, [heartCodes, starCodes, heartSet, nameOf])

  const load = useCallback(async (fresh: boolean) => {
    if (!fresh && feedCache && feedCache.key === loadKey) {
      setItems(feedCache.items); setFetchedAt(feedLastFetched); return
    }
    setErr(null); setLoading(true)
    try {
      let all: FeedItem[]
      if (fresh) {
        // 更新ボタン: 最新をライブ取得
        setPhase('最新を取得中…')
        all = await liveFanout(true)
      } else {
        // 初回: 蓄積DBを即表示。未蓄積ならライブ取得にフォールバック。
        setPhase('読み込み中…')
        const res = await fetch('/api/news-stored').then(r => r.json()).catch(() => null)
        if (res?.ready && Array.isArray(res.items) && res.items.length > 0) {
          all = res.items as FeedItem[]
          setItems(all)
        } else {
          all = await liveFanout(false)
        }
      }
      feedCache = { key: loadKey, items: all }
      feedLastFetched = Date.now(); setFetchedAt(feedLastFetched)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPhase(''); setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, liveFanout])

  useEffect(() => { load(false) }, [load])

  // 絞り込み用の一覧（メディア・銘柄）と、適用後のリスト
  const mediaList = useMemo(() => {
    const m = new Map<string, { source: string; sourceUrl: string; n: number }>()
    for (const it of items ?? []) {
      const cur = m.get(it.source) || { source: it.source, sourceUrl: it.sourceUrl, n: 0 }
      cur.n++; if (!cur.sourceUrl && it.sourceUrl) cur.sourceUrl = it.sourceUrl
      m.set(it.source, cur)
    }
    return [...m.values()].sort((a, b) => b.n - a.n)
  }, [items])

  const irCount = useMemo(() => (items ?? []).filter(i => i.ir).length, [items])
  const discCount = useMemo(() => (items ?? []).filter(i => i.disc).length, [items])
  const q = loosen(stockQuery.trim())
  const filtered = useMemo(() =>
    (items ?? []).filter(i => {
      const okScope = scope === 'all' || heartSet.has(i.code)
      if (!okScope) return false
      const okStock = !q || stockHaystack(i.name, i.code).includes(q)
      const okMedia = mediaSet.size === 0
        || mediaSet.has(i.source)
        || (mediaSet.has(IR_FILTER) && i.ir)
        || (mediaSet.has(DISC_FILTER) && i.disc)
      return okStock && okMedia
    }),
    [items, q, mediaSet, scope, heartSet])

  // 絞り込み・スコープが変わったら表示件数をリセット（先頭から見せ直す）
  useEffect(() => { setVisible(FEED_DISPLAY_STEP) }, [q, mediaSet, scope])

  return (
    <div className={styles.feedWrap}>
      <div className={styles.feedHead}>
        <div>
          <div className={styles.feedTitle}>お気に入り銘柄ニュース</div>
          <div className={styles.newsCount}>
            {items !== null ? `${filtered.length} / ${items.length}件・直近3ヶ月・新着順` : '—'}
            {fetchedAt && <span> ・ 取得 {fmtRelTime(new Date(fetchedAt).toISOString())}</span>}
          </div>
        </div>
        <div className={styles.feedActions}>
          <div className={styles.newsSortBtns}>
            <button className={`${styles.newsSortBtn} ${scope === 'all' ? styles.newsSortBtnActive : ''}`} onClick={() => setScope('all')}>
              すべて(<span className={styles.heartGlyph}>♥</span>+<span className={styles.starGlyph}>★</span>)
            </button>
            <button className={`${styles.newsSortBtn} ${scope === 'hearts' ? styles.newsSortBtnActive : ''}`} onClick={() => setScope('hearts')}>
              <span className={styles.heartGlyph}>♥</span>のみ
            </button>
          </div>
          <button className={styles.feedRefreshBtn} disabled={loading} onClick={() => load(true)} title="キャッシュを無視して最新ニュースを取得">
            {loading ? '⏳' : '⟳'} 更新
          </button>
        </div>
      </div>

      {/* 絞り込み: 銘柄（検索）＋ メディア（プルダウン複数選択） */}
      <div className={styles.feedFilterRow}>
        <div className={styles.feedSearchWrap}>
          <span className={styles.feedSearchIcon}>🔍</span>
          <input
            className={styles.feedSearchInput}
            placeholder="銘柄名・コードで絞り込み"
            value={stockQuery}
            onChange={e => setStockQuery(e.target.value)}
          />
          {stockQuery && <button className={styles.feedSearchClear} onClick={() => setStockQuery('')}>×</button>}
        </div>

        <div className={styles.feedMediaWrap}>
          <button className={styles.feedSelect} onClick={() => setMediaOpen(o => !o)}>
            メディア: {mediaSet.size === 0 ? 'すべて' : `${mediaSet.size}社`} ▼
          </button>
          {mediaOpen && (
            <>
              <div className={styles.feedMediaBackdrop} onClick={() => setMediaOpen(false)} />
              <div className={styles.feedMediaPanel}>
                <div className={styles.feedMediaPanelHead}>
                  <span>メディアで絞り込み（複数可）</span>
                  <button className={styles.feedClearBtn} onClick={() => setMediaSet(new Set())}>クリア</button>
                </div>
                <div className={styles.feedMediaPanelList}>
                  <label className={`${styles.feedMediaOpt} ${styles.feedMediaOptIr}`}>
                    <input
                      type="checkbox"
                      checked={mediaSet.has(DISC_FILTER)}
                      onChange={() => setMediaSet(prev => {
                        const n = new Set(prev); n.has(DISC_FILTER) ? n.delete(DISC_FILTER) : n.add(DISC_FILTER); return n
                      })}
                    />
                    <span className={styles.feedIrIcon}>📄</span>
                    <span className={styles.feedMediaName}>決算・適時開示（全社・媒体不問）</span>
                    <span className={styles.feedMediaCount}>{discCount}</span>
                  </label>
                  <label className={`${styles.feedMediaOpt} ${styles.feedMediaOptIr}`}>
                    <input
                      type="checkbox"
                      checked={mediaSet.has(IR_FILTER)}
                      onChange={() => setMediaSet(prev => {
                        const n = new Set(prev); n.has(IR_FILTER) ? n.delete(IR_FILTER) : n.add(IR_FILTER); return n
                      })}
                    />
                    <span className={styles.feedIrIcon}>🏢</span>
                    <span className={styles.feedMediaName}>公式サイト発（新製品・IR等）</span>
                    <span className={styles.feedMediaCount}>{irCount}</span>
                  </label>
                  {mediaList.map(m => (
                    <label key={m.source} className={styles.feedMediaOpt}>
                      <input
                        type="checkbox"
                        checked={mediaSet.has(m.source)}
                        onChange={() => setMediaSet(prev => {
                          const n = new Set(prev); n.has(m.source) ? n.delete(m.source) : n.add(m.source); return n
                        })}
                      />
                      {faviconUrl(m.sourceUrl) && <img className={styles.feedFavicon} src={faviconUrl(m.sourceUrl)} alt="" loading="lazy" />}
                      <span className={styles.feedMediaName}>{m.source}</span>
                      <span className={styles.feedMediaCount}>{m.n}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {(stockQuery || mediaSet.size > 0) && (
          <button className={styles.feedClearBtn} onClick={() => { setStockQuery(''); setMediaSet(new Set()) }}>絞り込み解除</button>
        )}
      </div>

      {phase && <div className={styles.feedPhase}>⏳ {phase}</div>}
      {err && <div className={styles.newsEmpty}>取得に失敗しました（{err}）</div>}
      {items === null && !err && <div className={styles.newsEmpty}>読み込み中…</div>}
      {items !== null && filtered.length === 0 && !phase && <div className={styles.newsEmpty}>該当するニュースはありません</div>}
      {filtered.length > visible && (
        <div className={styles.feedPhase}>新着{visible}件を表示中（全{filtered.length}件）。下の「もっと見る」か、銘柄・メディアでの絞り込みで残りも見られます。</div>
      )}
      <div className={styles.feedList}>
        {filtered.slice(0, visible).map((a, i) => {
          const t = new Date(a.pubDate).getTime()
          const isNew = !!t && !Number.isNaN(t) && (Date.now() - t) < NEWS_NEW_WINDOW_MS
          const fav = faviconUrl(a.sourceUrl)
          return (
            <div key={a.link || i} className={styles.feedItem}>
              <div className={styles.feedItemHead}>
                {isNew && <span className={styles.newsBadge}>NEW</span>}
                <button className={styles.feedStockChip} onClick={() => onClickCode(a.code)} title="詳細を開く">
                  {a.name}<span className={styles.feedStockCode}>{a.code}</span>
                </button>
                {fav && <img className={styles.feedFavicon} src={fav} alt="" loading="lazy" />}
                <span className={styles.newsSource}>{a.source || 'ニュース'}</span>
                <span className={styles.newsTime}>{fmtRelTime(a.pubDate)}</span>
              </div>
              <a className={styles.feedItemTitle} href={a.link} target="_blank" rel="noopener noreferrer">{a.title}</a>
            </div>
          )
        })}
      </div>
      {filtered.length > visible && (
        <button className={styles.feedMoreBtn} onClick={() => setVisible(v => v + FEED_DISPLAY_STEP)}>
          もっと見る（残り{filtered.length - visible}件）
        </button>
      )}
    </div>
  )
}

// ─── DetailPanel ─────────────────────────────────────────────────────
function DetailPanel({
  row: r, fin: f, memo, memoUpdatedAt, onSaveMemo, apiKey, serverHasKey, earningsDate, onSaveEarningsDate, chartMode, onChartModeChange,
}: {
  row: StockRow; fin: FinRecord | null | undefined
  memo: string; memoUpdatedAt?: string; onSaveMemo: (t: string) => void
  apiKey: string; serverHasKey?: boolean; earningsDate: string; onSaveEarningsDate: (date: string) => void
  chartMode: ChartMode; onChartModeChange: (m: ChartMode) => void
}) {
  const [localMemo, setLocalMemo] = useState(memo)
  const [saved, setSaved] = useState(false)
  const [editingDate, setEditingDate] = useState(false)
  const [dateVal, setDateVal] = useState(earningsDate)
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)

  useEffect(() => { setLocalMemo(memo) }, [memo])

  function save() { onSaveMemo(localMemo); setSaved(true); setTimeout(() => setSaved(false), 1500) }

  return (
    <>
      <div className={styles.detailCode}>{r.code}</div>
      <div className={styles.detailName}>{r.name || '—'}</div>
      <div className={styles.detailBadgeRow}>
        <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
      </div>
      <div className={`${styles.detailPrice} ${styles[pctClass(r.chg1d)]}`}>
        {r.close ? r.close.toLocaleString() : '—'}
      </div>
      <div className={styles.detailSubPrice}>
        前日比: <span className={styles[pctClass(r.chg1d)]}>{fmtPct(r.chg1d)}</span>
      </div>
      <Section title="チャート"><MiniChart code={r.code} apiKey={apiKey} serverHasKey={serverHasKey} mode={chartMode} onModeChange={onChartModeChange} /></Section>
      <Section title="株価変化率">
        <Grid2 items={[
          ['前日比', r.chg1d, fmtPct(r.chg1d), pctClass(r.chg1d)],
          ['1週間',  r.chg1w, fmtPct(r.chg1w), pctClass(r.chg1w)],
          ['3ヶ月',  r.chg3m, fmtPct(r.chg3m), pctClass(r.chg3m)],
          ['1年',    r.chg1y, fmtPct(r.chg1y), pctClass(r.chg1y)],
        ]} />
      </Section>
      <Section title="バリュー指標">
        <Grid2 items={[
          ['PER実績',    null, r.perA ? fmtN(r.perA) : '—', ''],
          ['PER今期',    null, r.perF ? fmtN(r.perF) : '—', ''],
          ['PBR',        null, r.pbr  ? fmtN(r.pbr)  : '—', ''],
          ['ROE',        null, r.roe  ? fmtPct(r.roe) : '—', r.roe && r.roe > 0.1 ? 'up' : ''],
          ['配当利回り', null, r.divY ? fmtPct(r.divY): '—', r.divY && r.divY > 0.03 ? 'up' : ''],
          ['EPS今期成長率',null, r.epsCurGr !== null ? fmtPct(r.epsCurGr) : '—', pctClass(r.epsCurGr)],
          ['PEGレシオ',  null, r.peg  ? fmtN(r.peg,2) : '—', r.peg != null && r.peg > 0 && r.peg < 1 ? 'up' : ''],
          ['時価総額(億)',null, r.mcap ? r.mcap.toLocaleString() : '—', ''],
          ['来期売上成長',null, r.nySalesGr !== null ? fmtPct(r.nySalesGr) : '—', pctClass(r.nySalesGr)],
        ]} />
      </Section>
      {f && (
        <Section title={`財務データ${f.discDate ? ` (開示: ${f.discDate})` : ''}`}>
          <Grid2 items={[
            ['EPS実績',     null, f.eps  ? fmtN(f.eps, 2)  : '—', ''],
            ['EPS今期予想', null, f.feps ? fmtN(f.feps, 2) : '—', ''],
            ['BPS',         null, f.bps  ? fmtN(f.bps, 2)  : '—', ''],
            ['自己資本比率',null, f.eqRat ? fmtPct(f.eqRat): '—', ''],
            ['営業利益率',  null, f.opMgn ? fmtPct(f.opMgn): '—', ''],
            ['配当予想',    null, f.fdiv  ? fmtN(f.fdiv, 1) : '—', ''],
          ]} />
        </Section>
      )}
      <Section title="メモ">
        <textarea className={styles.detailMemo} value={localMemo}
          onChange={e => setLocalMemo(e.target.value)} placeholder="メモを入力..." />
        <VoiceMemoInput
          onAppend={text => setLocalMemo(prev => prev ? prev + '\n' + text : text)}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button
            className={styles.btnPrimary}
            style={{ flex: 1, ...(saved ? { background: '#34d399' } : {}) }}
            onClick={save}
          >{saved ? '保存しました ✓' : 'メモを保存'}</button>
          {memoUpdatedAt && (
            <span className={styles.memoTimestamp}>
              最終更新: {fmtJpDate(memoUpdatedAt)}
            </span>
          )}
        </div>
      </Section>
      <Section title="次回決算予定日">
        {(() => {
          const displayDate = f?.nextAnnouncementDate || earningsDate
          const diff = displayDate ? (new Date(displayDate).getTime() - Date.now()) / 86400000 : null
          const color = diff === null ? '' : diff < 0 ? 'rgba(100,100,100,0.7)' : diff <= 7 ? '#f87171' : diff <= 14 ? '#fbbf24' : '#34d399'
          return (
            <div style={{display:'flex', flexDirection:'column', gap:6}}>
              {displayDate && !editingDate && (
                <div style={{fontSize:16, fontWeight:600, color}}>
                  {displayDate}
                  {diff !== null && diff >= 0 && <span style={{fontSize:12, marginLeft:8, color:'rgba(200,220,255,0.6)'}}>あと{Math.ceil(diff)}日</span>}
                  {diff !== null && diff < 0 && <span style={{fontSize:12, marginLeft:8, color:'rgba(100,100,100,0.7)'}}>終了</span>}
                </div>
              )}
              {!displayDate && !editingDate && <div style={{color:'#475569', fontSize:13}}>未設定（APIまたは手動入力）</div>}
              {editingDate ? (
                <div style={{display:'flex', gap:6, alignItems:'center', flexWrap:'wrap'}}>
                  <input type="date" autoFocus value={dateVal} min={new Date().toISOString().slice(0,10)} onChange={e => setDateVal(e.target.value)}
                    style={{padding:'4px 8px', background:'#1e2735', border:'1px solid #3b82f6', color:'#e2e8f0', borderRadius:4, fontSize:14}}
                    onFocus={e => { try { (e.target as HTMLInputElement & {showPicker?:()=>void}).showPicker?.() } catch {} }}
                    onClick={e => { try { (e.target as HTMLInputElement & {showPicker?:()=>void}).showPicker?.() } catch {} }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { onSaveEarningsDate(dateVal); setEditingDate(false) }
                      if (e.key === 'Escape') { setDateVal(earningsDate); setEditingDate(false) }
                    }}
                  />
                  <button className={styles.btnPrimary} style={{padding:'4px 12px', fontSize:13}}
                    onClick={() => { onSaveEarningsDate(dateVal); setEditingDate(false) }}>保存</button>
                  <button className={styles.btnSecondary} style={{padding:'4px 10px', fontSize:13}}
                    onClick={() => { setDateVal(earningsDate); setEditingDate(false) }}>キャンセル</button>
                </div>
              ) : (
                <button className={styles.btnSecondary} style={{padding:'4px 12px', fontSize:12, alignSelf:'flex-start'}}
                  onClick={() => { setDateVal(earningsDate); setEditingDate(true) }}>
                  {earningsDate ? '✏️ 編集' : '＋ 手動入力'}
                </button>
              )}
              {f?.nextAnnouncementDate && <div style={{fontSize:11, color:'#64748b'}}>APIから自動取得済み</div>}
            </div>
          )
        })()}
      </Section>
      <Section title="ニュース"><NewsSection code={r.code} name={r.name || ''} /></Section>
      <Section title="リンク">
        <div className={styles.detailLinks}>
          <a className={styles.detailLinkBtn} href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank" rel="noopener noreferrer">四季報</a>
          <a className={styles.detailLinkBtn} href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank" rel="noopener noreferrer">かぶたん</a>
          <a className={styles.detailLinkBtn} href={`https://x.com/search?q=${encodeURIComponent(r.code + ' ' + (r.name || ''))}&f=live`} target="_blank" rel="noopener noreferrer">X検索</a>
          <a className={styles.detailLinkBtn} href={`https://finance.yahoo.co.jp/quote/${r.code}.T`} target="_blank" rel="noopener noreferrer">Yahoo Finance</a>
          <a className={styles.detailLinkBtn} href={`https://irbank.net/${r.code}`} target="_blank" rel="noopener noreferrer">IRBank</a>
          <a className={styles.detailLinkBtn} href={`https://minkabu.jp/stock/${r.code}`} target="_blank" rel="noopener noreferrer">みんかぶ</a>
          <a className={styles.detailLinkBtn} href={`https://www.buffett-code.com/company/${r.code}`} target="_blank" rel="noopener noreferrer">Buffett Code</a>
          <a className={styles.detailLinkBtn} href={`https://jp.tradingview.com/chart/?symbol=TSE:${r.code}`} target="_blank" rel="noopener noreferrer">TradingView</a>
        </div>
      </Section>
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.detailSection}>
      <div className={styles.detailSectionTitle}>{title}</div>
      {children}
    </div>
  )
}

function Grid2({ items }: { items: [string, unknown, string, string][] }) {
  return (
    <div className={styles.detailGrid}>
      {items.map(([label, , val, cls]) => (
        <div key={label} className={styles.detailItem}>
          <div className={styles.detailItemLabel}>{label}</div>
          <div className={`${styles.detailItemValue} ${cls ? styles[cls] : ''}`}>{val}</div>
        </div>
      ))}
    </div>
  )
}

// ─── WeeklyReport（レポート：俯瞰マップ＋銘柄カルテ）──────────────────
// 設計方針: EPS基準が会社ごとに違う問題を踏まえ、銘柄間の横比較に頼らない。
//   ・俯瞰マップ＝各銘柄の「PER位置（自分の過去1年レンジ内）」×「株価1ヶ月」
//   ・銘柄カルテ＝1社完結の業績ビジュアル（PER位置バー＋EPS実績の推移）
// コンプラ: 事実の提示のみ。買い／売りの判定・推奨は一切しない。
type RepSort = 'move' | 'cheap' | 'growth' | 'code'

function repZone(pos: number | null | undefined): { label: string; color: string } {
  if (pos == null) return { label: '—', color: '#94a3b8' }
  if (pos <= 0.33) return { label: '安値圏', color: '#34d399' }
  if (pos >= 0.67) return { label: '高値圏', color: '#f87171' }
  return { label: '中立', color: '#fbbf24' }
}

// 自動「気づき」（事実のみ。買い／売りは書かない）
function repInsight(r: StockRow): string {
  const parts: string[] = []
  const pos = r.perBand?.position
  if (pos != null) parts.push(`PERは1年レンジの${repZone(pos).label}（${Math.round(pos * 100)}%地点）`)
  if (r.chg1m != null) parts.push(`直近1ヶ月 ${fmtPct(r.chg1m)}`)
  if (r.nySalesGr != null) parts.push(`来期売上 ${fmtPct(r.nySalesGr)}予想`)
  return parts.join('・') || 'データ取得待ち'
}

// 俯瞰マップ（散布図）: 横＝PER位置(0..1)、縦＝株価1ヶ月(±20%でクランプ)
function PositionMap({ rows, hearts, onClickCode }: {
  rows: StockRow[]; hearts: Set<string>; onClickCode: (c: string) => void
}) {
  const pts = rows.filter(r => r.perBand?.position != null && r.chg1m != null)
  const W = 360, H = 240, L = 14, R = 14, T = 14, B = 24
  const pw = W - L - R, ph = H - T - B
  const CAP = 0.2
  const x = (pos: number) => L + pos * pw
  const y = (chg: number) => T + (1 - (Math.max(-CAP, Math.min(CAP, chg)) + CAP) / (2 * CAP)) * ph
  const y0 = y(0)
  return (
    <div className={styles.repMapWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.repMapSvg} preserveAspectRatio="xMidYMid meet">
        {/* PER位置の3ゾーン背景（PER位置バーの配色と一致） */}
        <rect x={L} y={T} width={pw * 0.33} height={ph} fill="rgba(52,211,153,0.07)" />
        <rect x={L + pw * 0.33} y={T} width={pw * 0.34} height={ph} fill="rgba(251,191,36,0.05)" />
        <rect x={L + pw * 0.67} y={T} width={pw * 0.33} height={ph} fill="rgba(248,113,113,0.07)" />
        {/* 株価0%ライン */}
        <line x1={L} y1={y0} x2={W - R} y2={y0} stroke="#3a4a5e" strokeWidth="1" strokeDasharray="4 4" />
        <rect x={L} y={T} width={pw} height={ph} fill="none" stroke="#2a3a52" strokeWidth="1" />
        {pts.map(r => {
          const px = x(r.perBand!.position!), py = y(r.chg1m!)
          const heart = hearts.has(r.code)
          return (
            <g key={r.code} className={styles.repDot} onClick={() => onClickCode(r.code)}>
              <circle cx={px} cy={py} r={heart ? 6.5 : 5}
                fill={genreColor(r.genres[0] || '')}
                stroke={heart ? '#fbbf24' : '#0d1219'} strokeWidth={heart ? 2 : 1} />
              <title>{`${r.name}（${r.code}）\nPER位置 ${Math.round(r.perBand!.position! * 100)}%（${repZone(r.perBand!.position!).label}）\n株価1ヶ月 ${fmtPct(r.chg1m)}`}</title>
            </g>
          )
        })}
      </svg>
      <div className={styles.repMapXax}>
        <span>← 安値圏</span>
        <span>PER位置（自分の過去1年レンジ）</span>
        <span>高値圏 →</span>
      </div>
    </div>
  )
}

// EPS実績の推移（1社完結。銘柄間の基準差の影響を受けない）
function EpsBars({ fyEps }: { fyEps?: { d: string; eps: number }[] }) {
  const hist = (fyEps ?? [])
    .filter(e => e && typeof e.eps === 'number')
    .slice().sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-5)
  if (hist.length < 2) return <span className={styles.repEpsEmpty}>EPS実績の履歴待ち</span>
  const maxAbs = Math.max(...hist.map(h => Math.abs(h.eps)), 1)
  return (
    <div className={styles.repEps}>
      <div className={styles.repEpsLabel}>EPS実績（直近{hist.length}期・自社の推移）</div>
      <div className={styles.repEpsBars}>
        {hist.map((h, i) => {
          const loss = h.eps < 0
          const hgt = Math.max(4, Math.abs(h.eps) / maxAbs * 46)
          const grow = i > 0 ? h.eps - hist[i - 1].eps : 0
          return (
            <div key={h.d} className={styles.repEpsCol} title={`${h.d.slice(0, 7)} ＝ EPS ${fmtN(h.eps, 1)}円`}>
              <div className={styles.repEpsBarTrack}>
                <div className={styles.repEpsBar}
                  style={{ height: hgt, background: loss ? '#f87171' : (grow >= 0 ? '#34d399' : '#7dd3a8') }} />
              </div>
              <div className={styles.repEpsYr}>{`'${h.d.slice(2, 4)}`}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 銘柄カルテ（KaVIEW型のビジュアルカード・1枚で1社）
function KarteCard({ r, fin, newsN, heart, onClick }: {
  r: StockRow; fin?: FinRecord; newsN: number; heart: boolean; onClick: () => void
}) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.repCard} onClick={onClick}>
      <div className={styles.repCardHead}>
        <div className={styles.repLogo} style={{ background: genreColor(r.genres[0] || '') }} title={r.genres[0] || ''}>
          {(r.name || r.code).slice(0, 1)}
        </div>
        <div className={styles.repCardId}>
          <div className={styles.repCardName}>
            {heart && <span className={styles.repHeart}>♥</span>}
            {r.name || r.code}
          </div>
          <div className={styles.repCardMeta}>
            <span className={styles.repCardCode}>{r.code}</span>
            <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
            {r.genres.slice(0, 3).map(g => <span key={g} className={styles.repGenre}>{g}</span>)}
          </div>
        </div>
        <div className={styles.repCardPrice}>
          <div className={styles.repPrice}>{r.close ? r.close.toLocaleString() : '—'}<span className={styles.repYen}>円</span></div>
          <div className={styles.repChg1d} style={{ color: pctCellColor(r.chg1d) }}>{fmtPct(r.chg1d)}</div>
        </div>
      </div>

      {/* 騰落チップ */}
      <div className={styles.repChips}>
        {(([['1W', r.chg1w], ['1M', r.chg1m], ['3M', r.chg3m], ['1Y', r.chg1y]]) as [string, number | null][]).map(([k, v]) => (
          <div key={k} className={styles.repChip}>
            <span className={styles.repChipK}>{k}</span>
            <span className={styles.repChipV} style={{ color: pctCellColor(v) }}>{fmtPct(v)}</span>
          </div>
        ))}
      </div>

      {/* PER位置バー（ヒーロー要素・既存コンポーネント再利用） */}
      <div className={styles.repBandRow}>
        <div className={styles.repBandLabel}>PER位置（過去1年レンジ内）</div>
        <div className={styles.repBandBar}><PerBandBar band={r.perBand} likePer={r.likePer} big /></div>
      </div>

      {/* EPS実績ビジュアル */}
      <EpsBars fyEps={fin?.fyEps} />

      {/* 気づき（事実のみ） */}
      <div className={styles.repInsight}>
        <span className={styles.repInsightDot} style={{ background: repZone(r.perBand?.position).color }} />
        <span>{repInsight(r)}</span>
        {newsN > 0 && <span className={styles.repNews}>📰 今週{newsN}件</span>}
      </div>
    </div>
  )
}

function WeeklyReport({
  allRows, finDB, favorites, superFavorites, onClickCode,
}: {
  allRows: StockRow[]
  finDB: Record<string, FinRecord>
  favorites: Set<string>
  superFavorites: Set<string>
  onClickCode: (code: string) => void
}) {
  const [scope, setScope] = useState<'all' | 'heart'>('all')
  const [sort, setSort] = useState<RepSort>('move')

  const baseRows = useMemo(() =>
    allRows.filter(r => favorites.has(r.code)), [allRows, favorites])
  const scoped = useMemo(() =>
    scope === 'heart' ? baseRows.filter(r => superFavorites.has(r.code)) : baseRows,
    [baseRows, scope, superFavorites])

  // 今週ニュース件数（蓄積DB）
  const [newsCount, setNewsCount] = useState<Record<string, number>>({})
  useEffect(() => {
    let cancelled = false
    fetch('/api/news-stored').then(r => r.json()).then((d: { items?: { code: string; pubDate: string }[] }) => {
      if (cancelled) return
      const wk = Date.now() - 7 * 86400000
      const cnt: Record<string, number> = {}
      for (const it of d.items ?? []) {
        if (!favorites.has(it.code)) continue
        const t = new Date(it.pubDate).getTime()
        if (t && t >= wk) cnt[it.code] = (cnt[it.code] ?? 0) + 1
      }
      setNewsCount(cnt)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [favorites])

  const sorted = useMemo(() => {
    const a = scoped.slice()
    if (sort === 'move') a.sort((x, y) => Math.abs(y.chg1m ?? 0) - Math.abs(x.chg1m ?? 0))
    else if (sort === 'cheap') a.sort((x, y) => (x.perBand?.position ?? 9) - (y.perBand?.position ?? 9))
    else if (sort === 'growth') a.sort((x, y) => (y.nySalesGr ?? -9) - (x.nySalesGr ?? -9))
    else a.sort((x, y) => (x.code < y.code ? -1 : 1))
    return a
  }, [scoped, sort])

  const mapEligible = useMemo(() =>
    scoped.filter(r => r.perBand?.position != null && r.chg1m != null), [scoped])

  const today = new Date()
  const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`

  return (
    <div className={styles.reportRoot}>
      <div className={styles.rpHdr}>
        <span className={styles.rpTitle}>レポート <span className={styles.rpTitleSub}>ウォッチリストの俯瞰と銘柄カルテ</span></span>
        <span className={styles.rpDate}>{dateStr} &nbsp;·&nbsp; ★{baseRows.length}銘柄</span>
      </div>

      {/* スコープ＆並び替え */}
      <div className={styles.repControls}>
        <div className={styles.repToggle}>
          <button className={scope === 'all' ? styles.repTogActive : styles.repTog} onClick={() => setScope('all')}>すべて</button>
          <button className={scope === 'heart' ? styles.repTogActive : styles.repTog} onClick={() => setScope('heart')}>♥のみ</button>
        </div>
        <div className={styles.repToggle}>
          {(([['move', '動き順'], ['cheap', '割安順'], ['growth', '成長順'], ['code', 'コード順']]) as [RepSort, string][]).map(([k, l]) => (
            <button key={k} className={sort === k ? styles.repTogActive : styles.repTog} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* 俯瞰マップ */}
      <div className={styles.repMapCard}>
        <div className={styles.repMapTitle}>俯瞰マップ</div>
        <div className={styles.repMapDesc}>
          横＝PER位置（安値圏←→高値圏／各銘柄の過去1年レンジ内）、縦＝株価1ヶ月（上=上昇）。点をタップで詳細。
        </div>
        {mapEligible.length === 0
          ? <div className={styles.rpEmpty}>マップに出せる銘柄がありません（PER位置の算出待ち）</div>
          : <PositionMap rows={scoped} hearts={superFavorites} onClickCode={onClickCode} />}
        {scoped.length - mapEligible.length > 0 && (
          <div className={styles.repMapNote}>※ {scoped.length - mapEligible.length}銘柄はPER位置を算出できずマップ対象外（赤字・履歴待ち等）</div>
        )}
      </div>

      {/* 銘柄カルテ */}
      <div className={styles.repCardsHead}>銘柄カルテ <span className={styles.repCardsSub}>{sorted.length}銘柄</span></div>
      {sorted.length === 0
        ? <div className={styles.rpEmpty}>表示する銘柄がありません</div>
        : (
          <div className={styles.repCards}>
            {sorted.map(r => (
              <KarteCard key={r.code} r={r} fin={finDB[r.code]} newsN={newsCount[r.code] ?? 0}
                heart={superFavorites.has(r.code)} onClick={() => onClickCode(r.code)} />
            ))}
          </div>
        )}

      <div className={styles.rpSummaryNote} style={{ marginTop: 18 }}>
        ※ 会社予想EPSベースの事実の提示です（買い／売りの判断ではありません）。PER位置・EPS推移はいずれも「その銘柄自身の過去」との比較で、銘柄間のEPS基準差の影響を受けません。
      </div>
    </div>
  )
}

// ─── HelpPanel ────────────────────────────────────────────────────────
const USAGE_ITEMS = [
  { title: 'データ取得',   desc: 'ページを開くと株価・財務データを自動取得します。「再読込 ↺」ボタンで手動再取得も可能です。取得済みデータはブラウザに一時保存されます。' },
  { title: '銘柄検索',     desc: 'ツールバーの検索欄で銘柄名・コード・メモキーワードを入力するとドロップダウンが表示されます。選択するとその銘柄の行にジャンプしてハイライトします。' },
  { title: '絞り込み',     desc: '「フィルター」ボタンでジャンル・時価総額・PER今期による絞り込みができます。ツールバーの市場ボタン（Prime/Standard/Growth）でも絞り込めます。' },
  { title: 'ソート',       desc: 'テーブルのヘッダーをクリックするとその列でソートされます。再クリックで昇順/降順が切り替わります。' },
  { title: '詳細パネル',   desc: '行をクリックすると右側から詳細パネルが開き、財務情報・チャート・メモを確認できます。パネル外クリックまたは×ボタンで閉じます。' },
  { title: '銘柄管理',     desc: '「銘柄管理」ボタンでウォッチリストの追加・削除、ジャンルタグ・メモの編集ができます。メモ内容からも銘柄を検索できます。' },
  { title: 'ジャンルタグ', desc: '各銘柄に複数のジャンルタグを設定できます。ツールバーのフィルターでジャンルを絞り込んで素早く対象銘柄を確認できます。' },
  { title: 'データ保存',   desc: 'ウォッチリスト・ジャンル・メモはすべてクラウドおよびブラウザに自動保存されます。エクスポートボタンでExcel形式でダウンロードできます。' },
]
const INDICATOR_ITEMS = [
  { label: '株価',        desc: '直近営業日の終値（円）' },
  { label: '1D / 1W',    desc: '前日・前週比の株価変化率' },
  { label: '3M / 1Y',    desc: '3ヶ月前・1年前比の株価変化率' },
  { label: '時価総額',    desc: '発行済み株数 × 株価（億円単位）。会社全体の市場評価額' },
  { label: 'PER実績',     desc: '株価 ÷ 実績EPS。過去の利益ベースの割安度。低いほど割安' },
  { label: 'PER今期',     desc: '株価 ÷ 今期予想EPS。今年度の利益ベースの割安度' },
  { label: 'PER来期',     desc: '株価 ÷ 来期予想EPS。翌年度の利益ベースの割安度' },
  { label: 'PER変化',     desc: '1週・1ヶ月・3ヶ月・1年前の株価で計算したPER今期の変化率（現在PER ÷ 過去PER − 1）。「設定・判定条件」で閾値や判定ロジックを自由にカスタマイズできます。' },
  { label: 'PBR',         desc: '株価 ÷ BPS（1株純資産）。1倍以下は理論上の解散価値以下で割安とみなされやすい' },
  { label: 'ROE',         desc: '自己資本利益率（純利益 ÷ 自己資本）。株主資本の効率性。一般的に10%以上が優良' },
  { label: '配当利回り',  desc: '年間配当 ÷ 株価。高いほど配当が多い。ただし株価下落で高くなることに注意' },
  { label: 'EPS今期成長率', desc: '今期予想EPS ÷ 直近実績EPS − 1。FY確定後の銘柄は次期予想EPSを充当。マイナスなら今期減益予想' },
  { label: 'PEG',         desc: 'PER今期 ÷ EPS今期成長率(%)。1倍未満が目安。成長率を考慮した割安度指標' },
]

function HelpPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'usage' | 'indicators'>('usage')
  return (
    <>
      <div
        className={`${styles.helpOverlay} ${visible ? styles.helpOverlayVisible : ''}`}
        onClick={onClose}
      />
      <div className={`${styles.helpPanel} ${visible ? styles.helpPanelOpen : ''}`}>
        <div className={styles.helpPanelHead}>
          <span className={styles.helpPanelTitle}>ヘルプ</span>
          <button className={styles.helpClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.helpTabs}>
          <button
            className={`${styles.helpTab} ${activeTab === 'usage' ? styles.helpTabActive : ''}`}
            onClick={() => setActiveTab('usage')}
          >使い方</button>
          <button
            className={`${styles.helpTab} ${activeTab === 'indicators' ? styles.helpTabActive : ''}`}
            onClick={() => setActiveTab('indicators')}
          >指標の意味</button>
        </div>
        <div className={styles.helpBody}>
          {activeTab === 'usage' ? (
            <div className={styles.helpSection}>
              {USAGE_ITEMS.map(item => (
                <div key={item.title} className={styles.helpItem}>
                  <span className={styles.helpItemTitle}>{item.title}</span>
                  <span className={styles.helpItemDesc}>{item.desc}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.helpIndicators}>
              {INDICATOR_ITEMS.map(item => (
                <div key={item.label} className={styles.helpIndRow}>
                  <span className={styles.helpIndLabel}>{item.label}</span>
                  <span className={styles.helpIndDesc}>{item.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── SettingsPanel ────────────────────────────────────────────────────
// 設定パネル（個人APIキーのみ。判定機能は廃止）
function SettingsPanel({
  visible, onClose, apiKey, onApiKeyChange, serverHasKey,
}: {
  visible: boolean
  onClose: () => void
  apiKey: string
  onApiKeyChange: (key: string) => void
  serverHasKey?: boolean
}) {
  return (
    <>
      <div
        className={`${styles.settingsOverlay} ${visible ? styles.settingsOverlayVisible : ''}`}
        onClick={onClose}
      />
      <div className={`${styles.judgmentPanel} ${visible ? styles.judgmentPanelOpen : ''}`}>
        <div className={styles.judgmentPanelHead}>
          <span className={styles.judgmentPanelTitle}>設定</span>
          <button className={styles.judgmentClose} onClick={onClose}>×</button>
        </div>

        {serverHasKey ? (
          <div className={styles.settingsApiSection}>
            <label className={styles.apiLabel}>API Key</label>
            <p style={{fontSize:12,color:'#9fb0c4',lineHeight:1.6,margin:'4px 0 0'}}>
              サーバー側で設定済みのため、個人での設定は不要です。<br />
              データは毎営業日16:30に自動更新されます。
            </p>
          </div>
        ) : (
          <div className={styles.settingsApiSection}>
            <label className={styles.apiLabel}>
              個人 API Key（任意）
              {apiKey && <span style={{color:'#4ade80',marginLeft:8,fontSize:11}}>✓ 保存済み</span>}
            </label>
            <input
              type="password"
              className={styles.apiInput}
              value={apiKey}
              onChange={e => onApiKeyChange(e.target.value)}
              placeholder="ID Token を貼り付け"
              style={{width:'100%',boxSizing:'border-box'}}
            />
            <p style={{fontSize:11,color:'#64748b',lineHeight:1.6,margin:'8px 0 0'}}>
              J-Quants の ID Token を入れると、最新データをライブ取得できます（任意）。
            </p>
          </div>
        )}
      </div>
    </>
  )
}

// ─── SearchDropdown（共通UIコンポーネント）────────────────────────────
function SearchDropdown({
  results, activeIndex, onSelect, visible,
  onToggleFavorite, favorites,
}: {
  results: DropdownResult[]
  activeIndex: number
  onSelect: (code: string) => void
  visible: boolean
  onToggleFavorite?: (code: string) => void
  favorites?: Set<string>
}) {
  if (!visible) return null
  const codeNameResults = results.filter(r => r.matchType === 'code_name')
  const memoResults     = results.filter(r => r.matchType === 'memo')
  return (
    <div className={styles.searchDropdownPanel}>
      {results.length === 0 ? (
        <div className={styles.searchDropdownEmpty}>該当なし</div>
      ) : (
        <>
          {codeNameResults.length > 0 && (
            <>
              <div className={styles.searchDropdownCategory}>銘柄名・コード</div>
              {codeNameResults.map((r, i) => (
                <div
                  key={r.code}
                  className={`${styles.searchDropdownItem} ${activeIndex === i ? styles.searchDropdownItemActive : ''}`}
                  onMouseDown={e => { e.preventDefault(); onSelect(r.code) }}
                >
                  <span className={styles.searchDropdownCode}>{r.code}</span>
                  <span className={styles.searchDropdownName}>{r.name}</span>
                  {onToggleFavorite && (
                    <button
                      className={styles.dropdownFavBtn}
                      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onToggleFavorite(r.code) }}
                      title={favorites?.has(r.code) ? 'お気に入り解除' : 'お気に入りに追加'}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 14, padding: '0 4px', marginLeft: 'auto',
                        color: favorites?.has(r.code) ? '#fbbf24' : 'rgba(156,163,175,0.4)',
                        transition: 'color .1s',
                        flexShrink: 0,
                      }}
                    >★</button>
                  )}
                </div>
              ))}
            </>
          )}
          {memoResults.length > 0 && (
            <>
              <div className={styles.searchDropdownCategory}>メモ</div>
              {memoResults.map((r, i) => (
                <div
                  key={r.code}
                  className={`${styles.searchDropdownItem} ${activeIndex === codeNameResults.length + i ? styles.searchDropdownItemActive : ''}`}
                  onMouseDown={e => { e.preventDefault(); onSelect(r.code) }}
                >
                  <span className={styles.searchDropdownCode}>{r.code}</span>
                  <span className={styles.searchDropdownName}>{r.name}</span>
                  {r.memoSnippet && <div className={styles.searchDropdownSnippet}>{r.memoSnippet}</div>}
                  {onToggleFavorite && (
                    <button
                      className={styles.dropdownFavBtn}
                      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onToggleFavorite(r.code) }}
                      title={favorites?.has(r.code) ? 'お気に入り解除' : 'お気に入りに追加'}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: 14, padding: '0 4px', marginLeft: 'auto',
                        color: favorites?.has(r.code) ? '#fbbf24' : 'rgba(156,163,175,0.4)',
                        transition: 'color .1s',
                        flexShrink: 0,
                      }}
                    >★</button>
                  )}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
