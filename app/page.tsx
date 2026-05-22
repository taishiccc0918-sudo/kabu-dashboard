'use client'
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  DEFAULT_WATCHLIST, StockRow, FinRecord, PriceRecord, MasterRecord, StockMeta,
  TabKey, StatusType, ALL_GENRE_OPTIONS, DEFAULT_GENRES,
  JudgmentSettings, JudgmentLogic, MetricRange,
} from './lib/types'
import { evaluateLogic, formatLogicDescription } from './lib/judgmentEngine'
import { DEFAULT_LOGICS } from './lib/defaultLogics'
import { METRIC_LABELS, AVAILABLE_METRICS } from './lib/metricLabels'
import {
  findLatestBizDate, fetchMaster, fetchPrices, fetchAnnouncements, fetchAllFinancials,
} from './lib/api'
import { buildStockRow, fmtN, fmtPct, pctClass, pctBg, pctCellColor, marketShort, daysSince, isDataStale } from './lib/format'
import styles from './page.module.css'
import { createClient } from './lib/supabase/client'

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
  const [judgmentSettings,  setJudgmentSettings]  = useState<JudgmentSettings | null>(null)
  const [stockMeta,  setStockMeta]  = useState<Record<string, StockMeta>>({})
  const [priceDB,    setPriceDB]    = useState<Record<string, PriceRecord>>({})
  const [finDB,      setFinDB]      = useState<Record<string, FinRecord>>({})
  const [masterDB,   setMasterDB]   = useState<Record<string, MasterRecord>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [dataLoaded, setDataLoaded] = useState(false)   // このセッションで実際にデータ取得済みか
  const [status,     setStatus]     = useState<StatusType>('idle')
  const [statusMsg,  setStatusMsg]  = useState('準備中...')
  const [progress,   setProgress]   = useState(0)
  const [tab,        setTab]        = useState<TabKey>('dashboard')
  const [filter,     setFilter]     = useState<'all'|'buy'>('all')
  const [mktFilter,  setMktFilter]  = useState<string>('all')
  const [genreFilter, setGenreFilter] = useState<string>('all')
  const [mcapMin,    setMcapMin]    = useState<string>('')
  const [perFMax,    setPerFMax]    = useState<string>('')
  const [darkMode,   setDarkMode]   = useState<boolean>(true)
  const [showHelp,     setShowHelp]     = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [filterHeart,  setFilterHeart]  = useState(false)
  const [filterFav,    setFilterFav]    = useState(false)
  const [customGenreOptions, setCustomGenreOptions] = useState<string[]>([])
  const [removedDefaultGenres, setRemovedDefaultGenres] = useState<string[]>([])
  const [search,     setSearch]     = useState('')
  const [showDropdown,     setShowDropdown]     = useState(false)
  const [dropdownResults,  setDropdownResults]  = useState<DropdownResult[]>([])
  const [dropdownActive,   setDropdownActive]   = useState(-1)
  const [highlightCode,    setHighlightCode]    = useState<string | null>(null)
  const [sortKey,    setSortKey]    = useState<keyof StockRow | null>(null)
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
  type AuthUser = { id: string; email?: string; name?: string }
  const [user, setUser] = useState<AuthUser | null>(null)
  const userRef = useRef<AuthUser | null>(null)
  useEffect(() => { userRef.current = user }, [user])
  const searchWrapRef  = useRef<HTMLDivElement>(null)

  useEffect(() => { favoritesRef.current = favorites }, [favorites])
  useEffect(() => { if (apiKey) lsSet('apiKey', apiKey) }, [apiKey])
  useEffect(() => { localStorage.setItem('darkMode', String(darkMode)) }, [darkMode])
  useEffect(() => { if (tab === 'dashboard' || tab === 'card') lsSet('preferredTab', tab) }, [tab])
  // レポート・銘柄管理タブに切り替えたらフィルターバーを自動で閉じる
  useEffect(() => { if (tab === 'report' || tab === 'watchlist') setShowFilterBar(false) }, [tab])

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
  // Ctrl+Z キーハンドラー
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'z' || e.shiftKey) return
      const target = e.target as HTMLElement
      // 入力欄内では標準のundoを邪魔しない
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      e.preventDefault()
      setTabHistory(prev => {
        if (prev.length === 0) return prev
        const next = [...prev]
        const backTo = next.pop()!
        setTab(backTo)
        return next
      })
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
      sb.from('memos').select('code, memo, updated_at').eq('user_id', userId),
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
          .filter(([, meta]) => meta.memo && meta.memo.trim())
          .map(([code, meta]) => ({ user_id: userId, code, memo: meta.memo }))
        if (memoRows.length > 0) {
          await sb.from('memos').upsert(memoRows)
          console.log(`[Supabase移行] メモ${memoRows.length}件 をクラウドに保存しました`)
        }
        // ローカルメモはそのまま維持
      } else {
        setStockMeta(prev => {
          const next = { ...prev }
          for (const m of memoData) {
            const code = m.code as string
            if (!next[code]) next[code] = { genres: (DEFAULT_GENRES[code] ?? '').split(',').filter(Boolean), memo: '' }
            next[code] = { ...next[code], memo: m.memo as string, memoUpdatedAt: m.updated_at as string }
          }
          lsSet('stockMetadata', next)
          return next
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
        const u = { id: session.user.id, email: session.user.email, name: session.user.user_metadata?.full_name ?? session.user.email }
        setUser(u)
        loadFromSupabase(session.user.id)
      }
    })
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (session?.user) {
        const u = { id: session.user.id, email: session.user.email, name: session.user.user_metadata?.full_name ?? session.user.email }
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
    const savedJudgment = ls<JudgmentSettings | null>('judgmentSettings', null)
    setJudgmentSettings(savedJudgment ?? DEFAULT_LOGICS)
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

  // ── 自動更新: ページ読み込み時にデータ取得（キャッシュがある場合はバックグラウンド更新）
  useEffect(() => {
    if (!mounted) return               // マウント完了を待つ
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
  function sbSyncMemo(code: string, memo: string) {
    const u = userRef.current; const sb = getSb()
    if (!u || !sb) return
    sb.from('memos').upsert({ user_id: u.id, code, memo, updated_at: new Date().toISOString() }).then(() => {})
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
  }

  // ── allRows（★銘柄のみ） ──────────────────────────────────────────
  const allRows = useMemo(
    () => Array.from(favorites).map(code => buildStockRow(code, priceDB, finDB, masterDB, stockMeta)),
    [favorites, priceDB, finDB, masterDB, stockMeta]
  )

  // ── 判定エンジン ──────────────────────────────────────────────────
  const activeLogic = useMemo(() => {
    const s = judgmentSettings ?? DEFAULT_LOGICS
    return s.logics.find(l => l.id === s.activeLogicId) ?? s.logics[0]
  }, [judgmentSettings])

  const judgmentResultsMap = useMemo(() => {
    const map: Record<string, string | null> = {}
    for (const row of allRows) {
      map[row.code] = activeLogic ? evaluateLogic(row, activeLogic) : null
    }
    return map
  }, [allRows, activeLogic])

  const activeLogicDesc = useMemo(
    () => activeLogic ? formatLogicDescription(activeLogic) : '',
    [activeLogic]
  )

  const activeLogicTooltip = useMemo(() => {
    if (!judgmentSettings || !activeLogic) return '判定ロジックが設定されていません'
    const idx = judgmentSettings.logics.findIndex(l => l.id === judgmentSettings.activeLogicId)
    const num = ['①','②','③','④','⑤'][idx] ?? `${idx + 1}`
    const desc = formatLogicDescription(activeLogic)
    const condLines = desc ? desc.split(', ').map(s => `  ・${s}`).join('\n') : '  （条件未設定）'
    return `【判定設定 ${num} 「${activeLogic.name}」】\n条件（すべてAND）:\n${condLines}\n\nツールバーの ⚙ 判定設定 から条件・名前を変更できます`
  }, [judgmentSettings, activeLogic])

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
      if (filter === 'buy' && judgmentResultsMap[r.code] == null) return false
      if (filterHeart && !superFavorites.has(r.code)) return false
      if (filterFav   && !favorites.has(r.code))      return false
      if (mktFilter !== 'all' && marketShort(r.market).cls !== mktFilter) return false
      if (genreFilter !== 'all' && !r.genres.includes(genreFilter)) return false
      if (mcapMin !== '' && r.mcap < parseFloat(mcapMin)) return false
      if (perFMax !== '' && (r.perF == null || r.perF > parseFloat(perFMax))) return false
      return true
    })
    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * sortDir
        const an = (av as number) ?? (sortDir > 0 ? Infinity : -Infinity)
        const bn = (bv as number) ?? (sortDir > 0 ? Infinity : -Infinity)
        return (an - bn) * sortDir
      })
    }
    return rows
  }, [allRows, search, stockMeta, filter, filterHeart, filterFav, superFavorites, favorites, judgmentResultsMap, mktFilter, genreFilter, mcapMin, perFMax, sortKey, sortDir])

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
    if (filter === 'buy') n++
    if (filterHeart) n++
    if (filterFav) n++
    if (mktFilter !== 'all') n++
    if (genreFilter !== 'all') n++
    if (mcapMin || perFMax) n++
    return n
  }, [filter, filterHeart, filterFav, mktFilter, genreFilter, mcapMin, perFMax])

  function handleSort(key: keyof StockRow) {
    if (sortKey === key) setSortDir(d => d === 1 ? -1 : 1)
    else { setSortKey(key); setSortDir(-1) }
  }

  function handleSettingsChange(newSettings: JudgmentSettings) {
    setJudgmentSettings(newSettings)
    lsSet('judgmentSettings', newSettings)
  }

  function clearAllFilters() {
    setFilter('all'); setMktFilter('all'); setGenreFilter('all')
    setMcapMin(''); setPerFMax(''); setSortKey(null); setSortDir(-1)
  }

  function scrollToAndHighlight(code: string) {
    clearAllFilters()
    setSearch(''); setShowDropdown(false); setDropdownActive(-1)
    setHighlightCode(null)
    setTimeout(() => setHighlightCode(code), 0)
  }

  const allGenreOptions = [...ALL_GENRE_OPTIONS.filter(g => !removedDefaultGenres.includes(g)), ...customGenreOptions]

  function addGenreOption(name: string) {
    const trimmed = name.trim()
    if (!trimmed || allGenreOptions.includes(trimmed)) return
    const next = [...customGenreOptions, trimmed]
    setCustomGenreOptions(next); lsSet('customGenreOptions', next)
  }

  function removeGenreOption(name: string) {
    if (genreFilter === name) setGenreFilter('all')
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
  }

  function saveMemo(code: string, text: string) {
    const prev = stockMeta[code] ?? { genres: [], memo: '' }
    const trimmed = text.trim()
    saveStockMeta(code, {
      ...prev,
      memo: text,
      memoUpdatedAt: trimmed ? new Date().toISOString() : undefined,
    })
    sbSyncMemo(code, text)
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

  const detailRow = detailCode ? buildStockRow(detailCode, priceDB, finDB, masterDB, stockMeta) : null
  const detailFin = detailCode ? finDB[detailCode] : null

  return (
    <div className={`${styles.root}${darkMode ? '' : ' ' + styles.lightMode}`}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo} onClick={() => setTab('dashboard')} style={{cursor:'pointer'}}>株式<span>ウォッチ</span></div>
          <div className={styles.lastUpdate}>{lastUpdate ? <><span className={styles.todayLabel}>本日</span><strong>{lastUpdate}</strong></> : '未取得'}{maxDiscDate && <span className={styles.discDateLabel}>財務 {maxDiscDate}</span>}{stats.total > 0 && <span style={{marginLeft:10,fontSize:12,fontWeight:600,letterSpacing:'0.02em'}}>
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
          <button
            className={styles.btnSecondary}
            onClick={fetchAll}
            disabled={loading}
            title={lastUpdate && !dataLoaded ? `前回取得: ${lastUpdate}` : undefined}
          >
            {loading ? '更新中...' : dataLoaded ? '再読込 ↺' : '取得中...'}
          </button>
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
                <button className={styles.moreMenuItem} onClick={() => { setShowHelp(h => !h); setShowMoreMenu(false) }}>
                  <span className={styles.helpBadge}>?</span> ヘルプ
                </button>
                <button className={styles.moreMenuItem} onClick={() => { setShowSettings(s => !s); setShowMoreMenu(false) }}>
                  <span>⚙️</span> 買い判定設定
                </button>
                <button className={styles.moreMenuItem} onClick={() => { setDarkMode(d => !d); setShowMoreMenu(false) }}>
                  <span>{darkMode ? '☀️' : '🌙'}</span> {darkMode ? 'ライトモード' : 'ダークモード'}
                </button>
                {isMobileView && (
                  <button className={styles.moreMenuItem} onClick={() => { setForcePc(f => !f); setShowMoreMenu(false) }}>
                    <span>{forcePc ? '📱' : '🖥'}</span>
                    {forcePc ? 'SP版に戻す' : 'PC版表示に切替'}
                  </button>
                )}
              </div>
            )}
          </div>
          {/* ── ログイン/ログアウト（Supabase設定済みの場合のみ表示）── */}
          {getSb() && (
            user ? (
              <div className={styles.userMenu}>
                <span className={styles.userName} title={user.email}>{user.name?.split(' ')[0] ?? '👤'}</span>
                <button className={styles.logoutBtn} onClick={() => getSb()?.auth.signOut()} title="ログアウト">⏻</button>
              </div>
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
        {tab !== 'watchlist' && tab !== 'report' && (
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
        {tab !== 'watchlist' && tab !== 'report' && (
          <>
            <button
              className={`${styles.filterToggleBtn} ${(showFilterBar || activeFilterCount > 0) ? styles.filterToggleBtnActive : ''}`}
              onClick={() => setShowFilterBar(f => !f)}
            >
              {activeFilterCount > 0 ? `フィルター(${activeFilterCount}) ${showFilterBar ? '▲' : '▼'}` : `フィルター ${showFilterBar ? '▲' : '▼'}`}
            </button>
            <button
              className={`${styles.filterToggleBtn} ${showSettings ? styles.filterToggleBtnActive : ''}`}
              onClick={() => setShowSettings(s => !s)}
              title="買い判定設定を開く"
              style={{padding:'4px 10px'}}
            >⚙ 判定設定</button>
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
            <div className={styles.wlToolbarSearch} ref={wlSearchWrapRef}>
              <input
                className={styles.wlHeaderSearch}
                placeholder="🔍 銘柄名・コード検索..."
                value={wlSearch}
                onChange={e => { setWlSearch(e.target.value); setWlShowDropdown(true); setWlPage(1) }}
                onFocus={() => setWlShowDropdown(true)}
                onBlur={() => setTimeout(() => setWlShowDropdown(false), 150)}
                onKeyDown={e => {
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
            <button className={styles.btnSecondary} onClick={() => setWlShowBulkAdd(s => !s)} title="銘柄コードを一括で★に追加">
              + 一括登録
            </button>
            <button className={styles.btnSecondary} onClick={exportToExcel} title="お気に入り銘柄をExcelにエクスポート">
              ↓ Excel
            </button>
            <button
              className={styles.btnSecondary}
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              title={undoStack.length > 0 ? `★/♥の操作を${undoStack.length}件まで元に戻せます` : '元に戻す操作がありません'}
              style={{minWidth:52}}
            >↩ 戻る</button>
            <button
              className={styles.btnSecondary}
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              title={redoStack.length > 0 ? `${redoStack.length}件やり直せます` : 'やり直す操作がありません'}
              style={{minWidth:52}}
            >↪ 進む</button>
          </>
        )}
        <div className={styles.spacer} />
        <div className={`${styles.tabGroup} ${styles.spHide}`}>
          {(['dashboard','card','report'] as TabKey[]).map(t => (
            <button
              key={t}
              className={`${styles.tabBtn} ${tab === t ? styles.tabBtnActive : ''}`}
              onClick={() => setTab(t)}
            >
              {{ dashboard:'ダッシュボード', card:'カード', report:'レポート' }[t as 'dashboard'|'card'|'report']}
            </button>
          ))}
        </div>
      </div>

      {showFilterBar && tab !== 'watchlist' && (
        <div className={styles.filterBar}>
          <div className={styles.filterBarRow}>
            <div className={styles.filterGroup}>
              {(['all','buy'] as ('all'|'buy')[]).map(f => (
                <button
                  key={f}
                  className={`${styles.filterBtn} ${filter === f ? styles.filterBtnActive : ''}`}
                  onClick={() => setFilter(f as 'all'|'buy')}
                  title={f === 'buy' ? activeLogicTooltip : undefined}
                >
                  {f === 'all' ? '全て' : filter === 'buy' && activeLogic?.name
                    ? `買いシグナル (${activeLogic.name})`
                    : '買いシグナル'}
                </button>
              ))}
              <button
                className={`${styles.filterBtn} ${styles.heartFilterBtn} ${filterHeart ? styles.heartFilterBtnActive : ''}`}
                onClick={() => setFilterHeart(h => !h)}
                title="超お気に入り（♥）銘柄のみ表示"
              >♥</button>
              <button
                className={`${styles.filterBtn} ${filterFav ? styles.filterBtnActive : ''}`}
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
            <div className={styles.filterPanelChips}>
              {['all', ...allGenreOptions].map(g => (
                <button key={g}
                  className={`${styles.filterChip} ${genreFilter===g ? styles.filterChipActive : ''}`}
                  onClick={() => setGenreFilter(g)}
                >{g==='all'?'全ジャンル':g}</button>
              ))}
            </div>
          </div>
          <div className={styles.filterBarRow}>
            <label className={styles.filterPanelLabel}>時価総額（億円）以上</label>
            <input type="number" className={styles.filterPanelInput} placeholder="例: 500"
              value={mcapMin} onChange={e => setMcapMin(e.target.value)} />
            <label className={styles.filterPanelLabel} style={{marginLeft:12}}>PER今期 以下</label>
            <input type="number" className={styles.filterPanelInput} placeholder="例: 30"
              value={perFMax} onChange={e => setPerFMax(e.target.value)} />
            <button className={styles.filterPanelClear}
              onClick={() => { setFilter('all'); setMktFilter('all'); setGenreFilter('all'); setMcapMin(''); setPerFMax(''); setFilterHeart(false); setFilterFav(false) }}>
              全クリア
            </button>
          </div>
        </div>
      )}

      <main className={styles.main} style={{ visibility: mounted ? 'visible' : 'hidden' }}>
        {/* SP専用メモ重視ビュー（ウォッチリスト以外のタブで表示） */}
        {tab !== 'watchlist' && (
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
                    judgment={judgmentResultsMap[r.code] ?? null}
                    description={activeLogicDesc}
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
                judgmentResultsMap={judgmentResultsMap}
                activeLogicDesc={activeLogicDesc}
                activeLogicTooltip={activeLogicTooltip}
              />
            )}
          </div>
        )}

        {tab === 'card' && (
          <div className={forcePc ? styles.forcePcOn : styles.pcOnly}>
            <div className={styles.cardGrid}>
              {filteredRows.map(r => (
                <StockCard key={r.code} row={r} apiKey={apiKey} onClick={() => setDetailCode(r.code)} judgment={judgmentResultsMap[r.code] ?? null} description={activeLogicDesc} refreshKey={chartRefreshKey} chartMode={globalChartMode} onChartModeChange={setGlobalChartMode} />
              ))}
            </div>
          </div>
        )}

        {tab === 'report' && (
          <WeeklyReport
            allRows={allRows}
            favorites={favorites}
            judgmentResultsMap={judgmentResultsMap}
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
              earningsDate={earningsDates[detailCode] ?? ''}
              onSaveEarningsDate={date => saveEarningsDate(detailCode!, date)}
              judgment={judgmentResultsMap[detailCode] ?? null}
              description={activeLogicDesc}
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
        judgmentSettings={judgmentSettings}
        onSettingsChange={handleSettingsChange}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        serverHasKey={serverHasKey}
      />

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
  const [draft, setDraft] = useState(meta.memo)
  const { label: mktLabel, cls: mktCls } = marketShort(rec.market)
  const mainGenre = meta.genres[0] ?? null

  useEffect(() => { setDraft(meta.memo) }, [meta.memo])

  function handleMemoBlur() {
    setEditingMemo(false)
    if (draft !== meta.memo) onSaveMeta({ ...meta, memo: draft, memoUpdatedAt: draft.trim() ? new Date().toISOString() : undefined })
  }

  return (
    <div className={`${styles.wlMobileItem} ${highlighted ? styles.wlHighlight : ''}`} data-code-wl={code}>
      <div className={styles.wlMobileRow}>
        <button onClick={onToggleSuperFav}
          className={`${styles.wlMobileIconBtn} ${isSuperFav ? styles.heartBtnOn : styles.heartBtn}`}>♥</button>
        <button onClick={onToggleFav}
          className={`${styles.wlMobileIconBtn} ${isFav ? styles.favBtnOn : styles.favBtn}`}>{isFav ? '★' : '☆'}</button>
        <span className={styles.wlMobileCode}>{code}</span>
        <span className={styles.wlMobileName}>{rec.name}</span>
        <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        {mainGenre && <span className={styles.wlMobileGenre}>{mainGenre}</span>}
        <button className={`${styles.wlMobileEditBtn} ${meta.memo ? styles.wlMobileEditBtnActive : ''}`}
          onClick={() => setEditingMemo(e => !e)}
          title={meta.memo ? meta.memo.slice(0, 30) : 'メモなし'}
        >✏</button>
      </div>
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
            <div className={styles.wlGenreEditPanel}>
              {allGenreOptions.map(g => (
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
              ))}
              <InlineGenreAdd onAdd={(name) => { onAddGenre(name); toggleGenre(name) }} />
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

function MiniChart({ code, apiKey, refreshKey = 0, mode, onModeChange }: {
  code: string; apiKey: string; refreshKey?: number
  mode: ChartMode; onModeChange: (m: ChartMode) => void
}) {
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
    if (!visible || !apiKey || !code) return
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
  }, [code, apiKey, mode, visible, refreshKey, retryCount])

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
  filteredRows, finDB, earningsDates, onSaveEarningsDate, sortKey, sortDir, handleSort, onRowClick, highlightCode, superFavorites, onToggleSuperFav, judgmentResultsMap, activeLogicDesc, activeLogicTooltip
}: {
  filteredRows: StockRow[]
  finDB: Record<string, import('./lib/types').FinRecord>
  earningsDates: Record<string, string>
  onSaveEarningsDate: (code: string, date: string) => void
  sortKey: keyof StockRow | null
  sortDir: 1 | -1
  handleSort: (k: keyof StockRow) => void
  onRowClick: (code: string) => void
  highlightCode: string | null
  superFavorites: Set<string>
  onToggleSuperFav: (code: string) => void
  judgmentResultsMap: Record<string, string | null>
  activeLogicDesc: string
  activeLogicTooltip: string
}) {
  const headRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const onBodyScroll = () => {
    if (headRef.current && bodyRef.current) headRef.current.scrollLeft = bodyRef.current.scrollLeft
  }
  const SortArrow = ({ k }: { k: keyof StockRow }) => (
    <span className={`${styles.sortArrow} ${sortKey===k ? styles.sorted : ''}`}>↕</span>
  )
  const cols: { label: string; cls: string; key: keyof StockRow | null; group: string; width?: number; tooltip?: string }[] = [
    { label: '', cls: styles.thLeft, key: null, width: 48, group: '' },
    { label: 'コード', cls: `${styles.thLeft} ${styles.stickyCol0}`, key: 'code' as keyof StockRow, group: '' },
    { label: '銘柄名 ⓘ', cls: `${styles.thLeft} ${styles.stickyCol1}`, key: 'name' as keyof StockRow, group: '', tooltip: '⚠ マークの意味:\n直近の財務開示から90日以上経過した銘柄を示します。\n上場企業は通常3か月ごとに決算開示しますが、開示が遅れている場合や3Q/4Q決算をまたぐ期間中に表示されます。\nこのマークが付いている銘柄は財務指標が古いデータに基づく可能性があります。' },
    { label: 'ジャンル', cls: styles.thLeft, key: 'genre' as keyof StockRow, group: '' },
    { label: '市場', cls: styles.thLeft, key: 'market' as keyof StockRow, group: '' },
    { label: '時価総額(億)', cls: styles.thRight, key: 'mcap' as keyof StockRow, group: '', tooltip: '会社の市場での評価額（株価×発行株式数）。\n100億未満=小型株、1000億超=大型株。' },
    { label: '株価',    cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'close' as keyof StockRow, group: 'price' },
    { label: '前日比%', cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1d' as keyof StockRow, group: 'price', tooltip: '前営業日の終値からの変化率（J-Quants生値・スプリット調整なし）。\n週末を挟む場合は前金曜日との比較。\n四季報等と若干ズレる場合があります。' },
    { label: '1週間%',  cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1w' as keyof StockRow, group: 'price', tooltip: '約5営業日前の終値からの変化率。\n短〜中期トレンドの確認に使う。' },
    { label: '3ヶ月%',  cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg3m' as keyof StockRow, group: 'price', tooltip: '約65営業日前の終値からの変化率。\n中期トレンドや季節性の確認に使う。' },
    { label: '1年%',    cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1y' as keyof StockRow, group: 'price', tooltip: '約250営業日前の終値からの変化率。\n長期トレンドの確認に使う。' },
    { label: 'PER実績',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perA' as keyof StockRow, group: 'per', tooltip: '株価÷直近実績EPS。\n会社が利益の何年分で買えるかの指標。\n同業界平均と比較して割安かを判断する。' },
    { label: 'PER今期',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perF' as keyof StockRow, group: 'per', tooltip: '株価÷今期予想EPS。\n今期の業績予想を加味した割安度。\n15倍前後が標準的とされる。' },
    { label: 'PER今期\n1ヶ月前比', cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perFChg1m' as keyof StockRow, group: 'per', tooltip: 'PER今期の1ヶ月前との変化率。\n(現在PER÷1M前PER−1)で計算。\nセルにホバーで過去FEPS・現在FEPSなど詳細表示。\n\n⚠ 大きなズレが出る場合の主な原因:\n① 期末後に予想EPS(FEPS)が翌期に切替わったとき\n② 会社が業績予想を大幅修正したとき\n→ いずれも株価ではなくEPS基準の変化が原因' },
    { label: 'PEG', cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'peg' as keyof StockRow, group: 'per', tooltip: 'PER今期÷EPS今期成長率（%）。\n1未満=成長率に対して株価が割安と判断される指標。\n成長株の割安度を見るのに使う。' },
    { label: 'PBR', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'pbr' as keyof StockRow, group: 'other', tooltip: '株価÷1株あたり純資産（BPS）。\n1倍未満=純資産より安く買える。\n1〜2倍が標準的とされる。' },
    { label: 'ROE', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'roe' as keyof StockRow, group: 'other', tooltip: '純利益÷自己資本。\n資本をどれだけ効率よく使って利益を出しているか。\n10%超で優良、15%超で高収益企業。' },
    { label: 'EPS今期\n成長率', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'epsCurGr' as keyof StockRow, group: 'other', tooltip: '今期予想EPS÷直近実績EPS−1。\nFY確定後の銘柄は次期予想EPSを充当。\n業績V字回復や急減速の発見に使う。' },
    { label: '営業利益率', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'opMgn' as keyof StockRow, group: 'other', tooltip: '営業利益÷売上高。\n本業でどれだけ稼げるかの収益性指標。\n15%超で高収益、20%超は非常に優秀。' },
    { label: '来期売上成長',cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'nySalesGr' as keyof StockRow, group: 'other', tooltip: '来期予想売上÷最新FY確定売上−1。\n来期の成長性の目安。\n15%超で高成長企業の目安。' },
    { label: '配当利回り', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'divY' as keyof StockRow, group: 'other', tooltip: '年間配当÷株価。\nインカムゲインの目安。\n3%超で高配当株とされる。' },
    { label: '判定', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: null, group: 'other', tooltip: activeLogicTooltip },
    { label: '外部\nリンク', cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info', tooltip: '外部リンク（四季報・Yahoo・かぶたん・公式HP）' },
    { label: '次決算',     cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info', tooltip: '次回決算予定日。クリックして入力/編集できます。\n2週間以内:黄色、1週間以内:赤で警告。' },
  ]
  const colWidths = [48,60,150,160,72,108,80,80,76,80,76,76,76,76,64,64,88,64,88,108,88,64,64,80]
  const colGroup = (
    <colgroup>
      {colWidths.map((w, i) => <col key={i} style={{width:w, minWidth:w}} />)}
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
                  style={col.width ? {width: col.width, minWidth: col.width} : undefined}
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
              <tr><td colSpan={27} className={styles.emptyCell}>該当銘柄なし</td></tr>
            ) : filteredRows.map((r, i) => (
              <TableRow key={r.code} row={r} idx={i} fin={finDB?.[r.code]} earningsDates={earningsDates} onSaveEarningsDate={onSaveEarningsDate} onClick={() => onRowClick(r.code)} highlighted={highlightCode === r.code} isSuperFav={superFavorites.has(r.code)} onToggleSuperFav={() => onToggleSuperFav(r.code)} judgment={judgmentResultsMap[r.code] ?? null} description={activeLogicDesc} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── TableRow ────────────────────────────────────────────────────────
function TableRow({ row: r, idx, fin, earningsDates, onSaveEarningsDate, onClick, highlighted, isSuperFav, onToggleSuperFav, judgment, description }: {
  row: StockRow; idx: number; fin?: import('./lib/types').FinRecord
  earningsDates: Record<string,string>; onSaveEarningsDate: (code: string, date: string) => void; onClick: () => void
  highlighted: boolean; isSuperFav: boolean; onToggleSuperFav: () => void; judgment: string | null; description?: string
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
      <td className={styles.tdNum}>{r.mcap ? r.mcap.toLocaleString() : '—'}</td>
      <td className={styles.tdNum}>{r.close ? r.close.toLocaleString() : '—'}</td>
      {[r.chg1d, r.chg1w, r.chg3m, r.chg1y].map((v, i) => (
        <td key={i} className={styles.tdPct} style={{ background: pctBg(v), color: pctCellColor(v) }}>{fmtPct(v)}</td>
      ))}
      <td className={`${styles.tdNum} ${styles.tdPerGroup} ${fin?.discDate ? styles.hasTooltip : ''}`}
        title={fin?.discDate ? `実績EPS基準 / 直近決算: ${fin.discDate}` : undefined}
      >{r.perA ? fmtN(r.perA) : '—'}</td>
      <td className={`${styles.tdNum} ${styles.tdPerGroup} ${(fin?.perType || fin?.fepsShifted) ? styles.hasTooltip : ''} ${fin?.feps === null ? styles.tdNonDisclosure : ''}`}
        title={fin?.fepsShifted ? `今期予想EPS基準 ※FY確定後のため次期予想EPSを充当 / 開示: ${fin.discDate}` : fin?.perType ? `今期予想EPS基準 (${fin.perType === 'FY' ? '通期' : fin.perType + '四半期'}) / 開示: ${fin.discDate}` : fin?.feps === null ? '業績予想を開示していない銘柄です' : undefined}
      >{r.perF != null ? fmtN(r.perF) : fin?.feps === null ? '非開示' : '—'}</td>
      <td className={`${styles.tdPct} ${styles.tdPerGroup} ${fin?.feps === null ? styles.tdNonDisclosure : styles.hasTooltip}`}
        style={fin?.feps !== null ? {background: pctBg(r.perFChg1m), color: pctCellColor(r.perFChg1m)} : undefined}
        title={fin?.feps === null ? '業績予想を開示していない銘柄です' : (r.perFChg1mPrev && r.perF && fin?.feps1m) ? `1M前: PER ${fmtN(r.perFChg1mPrev)}倍 (FEPS ${fmtN(fin.feps1m, 0)}円) → 現在: PER ${fmtN(r.perF)}倍 (FEPS ${fmtN(fin.feps ?? null, 0)}円) ／ PER変化: ${fmtPct(r.perFChg1m)}` : undefined}
      >{fin?.feps === null ? '非開示' : fmtPct(r.perFChg1m)}</td>
      <td className={`${styles.tdNum} ${fin?.feps === null ? styles.tdNonDisclosure : ''}`} style={{color: r.peg && r.peg < 1 ? '#10b981' : undefined}}>{r.peg != null ? fmtN(r.peg, 2) : fin?.feps === null ? '非開示' : '—'}</td>
      <td className={styles.tdNum}>{r.pbr  ? fmtN(r.pbr)  : '—'}</td>
      <td className={styles.tdNum} style={{color: r.roe && r.roe > 0.1 ? '#10b981' : undefined}}>{r.roe ? fmtPct(r.roe) : '—'}</td>
      <td className={`${styles.tdPct} ${fin?.feps === null ? styles.tdNonDisclosure : ''}`} style={{color: r.epsCurGr !== null ? pctCellColor(r.epsCurGr) : undefined}}>{r.epsCurGr !== null ? fmtPct(r.epsCurGr) : fin?.feps === null ? '非開示' : '—'}</td>
      <td className={styles.tdNum} style={{color: r.opMgn && r.opMgn > 0.15 ? '#10b981' : undefined}}>{r.opMgn ? fmtPct(r.opMgn) : '—'}</td>
      <td className={`${styles.tdPct} ${r.nySalesGr === null ? styles.tdNonDisclosure : ''}`} style={r.nySalesGr !== null ? {color: pctCellColor(r.nySalesGr)} : undefined}>{r.nySalesGr !== null ? fmtPct(r.nySalesGr) : '非開示'}</td>
      <td className={styles.tdNum} style={{color: r.divY && r.divY > 0.03 ? '#10b981' : undefined}}>{r.divY ? fmtPct(r.divY) : '—'}</td>
      <td className={styles.hasTooltip} title={judgment != null ? (description || `該当: ${judgment}`) : '買い条件に非該当'}><JudgmentBadge result={judgment} description={description} /></td>
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
function SpMemoCard({ row: r, memo, memoUpdatedAt, onSaveMemo, isFav, isSuperFav, onToggleFav, onToggleSuperFav, judgment, description }: {
  row: StockRow; memo: string; memoUpdatedAt?: string
  onSaveMemo: (code: string, text: string) => void
  isFav: boolean; isSuperFav: boolean
  onToggleFav: (code: string) => void; onToggleSuperFav: (code: string) => void
  judgment: string | null; description?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memo)
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)

  function handleBlur() {
    setEditing(false)
    if (draft !== memo) onSaveMemo(r.code, draft)
  }

  return (
    <div className={styles.spMemoCard}>
      {/* Row1: ★/♥ + CODE + Market + Judgment */}
      <div className={styles.spCardRow1}>
        <button className={`${styles.spFavBtn} ${isFav ? styles.spFavBtnActive : ''}`}
          onClick={e => { e.stopPropagation(); onToggleFav(r.code) }}>
          {isFav ? '★' : '☆'}
        </button>
        <button className={`${styles.spSuperFavBtn} ${isSuperFav ? styles.spSuperFavBtnActive : ''}`}
          onClick={e => { e.stopPropagation(); onToggleSuperFav(r.code) }}>
          {isSuperFav ? '♥' : '♡'}
        </button>
        <span className={styles.spCardCode}>{r.code}</span>
        <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        <JudgmentBadge result={judgment} description={description} />
      </div>
      {/* Row2: 銘柄名 (左) | 株価 (右) */}
      <div className={styles.spCardRow2}>
        <span className={styles.spCardName}>{r.name || '—'}</span>
        <span className={styles.spCardPrice}>{r.close ? r.close.toLocaleString() : '—'}</span>
      </div>
      {/* Row3: ジャンル (左) | 前日比/1W (右) */}
      <div className={styles.spCardRow3}>
        <div className={styles.spCardGenres}>
          {r.genres.slice(0, 2).map(g => <span key={g} className={styles.spGenreBadge}>{g}</span>)}
        </div>
        <div className={styles.spCardChgs}>
          <span className={`${styles.spChg} ${styles[pctClass(r.chg1d)]}`}>{fmtPct(r.chg1d)}</span>
          <span className={`${styles.spChgSub} ${styles[pctClass(r.chg1w)]}`}>1W {fmtPct(r.chg1w)}</span>
        </div>
      </div>
      {/* Row4: PER今期 */}
      {r.perF != null && (
        <div className={styles.spCardPerFRow}>
          <span className={styles.spCardPerF}>PER今期 {fmtN(r.perF)}倍</span>
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
              : <div className={styles.spMemoPlaceholder}>メモ（タップして入力）</div>
            }
            {memo && memoUpdatedAt && <div className={styles.spMemoDate}>{fmtJpDate(memoUpdatedAt)}</div>}
          </>
        )}
      </div>
    </div>
  )
}

// ─── MobileRow ───────────────────────────────────────────────────────
function MobileRow({ row: r, onClick, judgment, description }: { row: StockRow; onClick: () => void; judgment: string | null; description?: string }) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.mobileRow} onClick={onClick}>
      <div className={styles.mobileRowLeft}>
        <div className={styles.mobileRowTop}>
          <span className={styles.mobileCode}>{r.code}</span>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
          <JudgmentBadge result={judgment} description={description} />
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

// ─── StockCard ───────────────────────────────────────────────────────
function StockCard({ row: r, apiKey, onClick, judgment, description, refreshKey = 0, chartMode, onChartModeChange }: {
  row: StockRow; apiKey: string; onClick: () => void; judgment: string | null
  description?: string; refreshKey?: number
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
          <JudgmentBadge result={judgment} description={description} />
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
          ['PEG',      r.peg   != null ? fmtN(r.peg, 2)   : '—',   r.peg != null && r.peg < 1 ? 'up' : ''],
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
      {apiKey && (
        <div onClick={e => e.stopPropagation()}>
          <MiniChart code={r.code} apiKey={apiKey} refreshKey={refreshKey} mode={chartMode} onModeChange={onChartModeChange} />
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
function GenreFilterDropdown({ genres, activeFilters, onApply, onClear }: {
  genres: string[]
  activeFilters: Set<string>
  onApply: (filters: Set<string>) => void
  onClear: () => void
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
      >▼</button>
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

function JudgmentBadge({ result, description }: { result: string | null; description?: string }) {
  if (result != null) {
    return <span className={`${styles.jBadge} ${styles.jBuy}`} title={description || `該当: ${result}`}>買い</span>
  }
  return <span className={`${styles.jBadge} ${styles.jNone}`}>—</span>
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

// ─── DetailPanel ─────────────────────────────────────────────────────
function DetailPanel({
  row: r, fin: f, memo, memoUpdatedAt, onSaveMemo, apiKey, earningsDate, onSaveEarningsDate, judgment, description, chartMode, onChartModeChange,
}: {
  row: StockRow; fin: FinRecord | null | undefined
  memo: string; memoUpdatedAt?: string; onSaveMemo: (t: string) => void
  apiKey: string; earningsDate: string; onSaveEarningsDate: (date: string) => void
  judgment: string | null; description?: string
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
        <JudgmentBadge result={judgment} description={description} />
      </div>
      {judgment != null && description && (
        <div className={styles.judgmentGroups}>{description}</div>
      )}
      <div className={`${styles.detailPrice} ${styles[pctClass(r.chg1d)]}`}>
        {r.close ? r.close.toLocaleString() : '—'}
      </div>
      <div className={styles.detailSubPrice}>
        前日比: <span className={styles[pctClass(r.chg1d)]}>{fmtPct(r.chg1d)}</span>
      </div>
      <Section title="チャート"><MiniChart code={r.code} apiKey={apiKey} mode={chartMode} onModeChange={onChartModeChange} /></Section>
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
          ['PEGレシオ',  null, r.peg  ? fmtN(r.peg,2) : '—', r.peg && r.peg < 1 ? 'up' : ''],
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

// ─── WeeklyReport ─────────────────────────────────────────────────────
function WeeklyReport({
  allRows, favorites, judgmentResultsMap, onClickCode,
}: {
  allRows: StockRow[]
  favorites: Set<string>
  judgmentResultsMap: Record<string, string | null>
  onClickCode: (code: string) => void
}) {
  const favRows = useMemo(() =>
    allRows.filter(r => favorites.has(r.code)),
    [allRows, favorites]
  )

  // PER低下中の銘柄（割安化）: 閾値なしで全件、変化量昇順
  const perDownRows = useMemo(() =>
    favRows
      .filter(r => r.perF != null && r.perFChg1m != null && r.perFChg1m < 0)
      .sort((a, b) => (a.perFChg1m ?? 0) - (b.perFChg1m ?? 0))
      .slice(0, 10),
    [favRows]
  )

  // PER上昇中の銘柄（注目・期待上昇）: 変化量降順
  const perUpRows = useMemo(() =>
    favRows
      .filter(r => r.perF != null && r.perFChg1m != null && r.perFChg1m > 0)
      .sort((a, b) => (b.perFChg1m ?? 0) - (a.perFChg1m ?? 0))
      .slice(0, 10),
    [favRows]
  )

  const today = new Date()
  const dateStr = `${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`

  function fmtPer(v: number | null) {
    if (v == null) return '—'
    return v.toFixed(1) + '倍'
  }
  function fmtPct(v: number | null) {
    if (v == null) return '—'
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
  }
  function pctColor(v: number | null) {
    if (v == null) return '#6b7280'
    return v >= 0 ? '#3fb950' : '#f85149'
  }

  function renderTable(rows: typeof perDownRows) {
    return (
      <div className={styles.rpTable}>
        <div className={styles.rpTHead}>
          <span className={styles.rpC0}>#</span>
          <span className={styles.rpC1}>コード</span>
          <span className={styles.rpC2}>銘柄</span>
          <span className={styles.rpC3}>PER今期</span>
          <span className={styles.rpC4}>PER変化</span>
          <span className={styles.rpC5}>株価1M</span>
          <span className={styles.rpC6}></span>
        </div>
        {rows.map((r, i) => {
          const isBuy = judgmentResultsMap[r.code] === 'buy'
          // 1ヶ月前の推定値
          const prevPER   = (r.perF != null && r.perFChg1m != null && (1 + r.perFChg1m) !== 0)
            ? r.perF / (1 + r.perFChg1m) : null
          const prevPrice = (r.chg1m != null && r.chg1m !== -1)
            ? r.close / (1 + r.chg1m) : null
          // 異常値（前期EPS≒0等でPER変化率が±200%超）
          const isAnomaly = r.perFChg1m != null && Math.abs(r.perFChg1m) > 2.0
          return (
            <div key={r.code} className={styles.rpRow} onClick={() => onClickCode(r.code)}>
              <span className={styles.rpC0}>{i + 1}</span>
              <span className={styles.rpC1}>{r.code}</span>
              <span className={styles.rpC2}>
                <span className={styles.rpName}>{r.name}</span>
                {r.genres.length > 0 && (
                  <span className={styles.rpGenres}>
                    {r.genres.map(g => <span key={g} className={styles.rpGenreBadge}>{g}</span>)}
                  </span>
                )}
              </span>
              <span className={styles.rpC3}>
                {fmtPer(r.perF)}
                {prevPER != null && !isAnomaly && (
                  <span className={styles.rpSubText}>{prevPER.toFixed(1)}倍→</span>
                )}
              </span>
              <span className={styles.rpC4} style={{color: isAnomaly ? '#484f58' : pctColor(r.perFChg1m)}}>
                {isAnomaly ? '※' : ''}{fmtPct(r.perFChg1m)}
                {isAnomaly && <span className={styles.rpSubText} style={{color:'#484f58'}}>EPS基準変動</span>}
              </span>
              <span className={styles.rpC5} style={{color: pctColor(r.chg1m)}}>
                {fmtPct(r.chg1m)}
                {prevPrice != null && (
                  <span className={styles.rpSubText}>{Math.round(prevPrice).toLocaleString()}→{r.close.toLocaleString()}</span>
                )}
              </span>
              <span className={styles.rpC6}>{isBuy && <span className={styles.rpBuyTag}>買い</span>}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={styles.reportRoot}>
      <div className={styles.rpHdr}>
        <span className={styles.rpDate}>{dateStr} &nbsp;·&nbsp; ★{favRows.length}銘柄</span>
      </div>

      {/* PER低下 */}
      <div className={`${styles.rpSection} ${styles.rpSectionDown}`}>
        <div className={styles.rpSectionHead}>
          <span className={styles.rpSectionTitle}>PER 低下 上位{perDownRows.length}</span>
          <span className={styles.rpSectionNote}>直近1ヶ月でPERが最も低下した銘柄。株価の下落などで割安化している可能性がある</span>
        </div>
        {perDownRows.length === 0
          ? <div className={styles.rpEmpty}>PERが低下中の銘柄はありません</div>
          : renderTable(perDownRows)
        }
      </div>

      {/* PER上昇 */}
      <div className={`${styles.rpSection} ${styles.rpSectionUp}`}>
        <div className={styles.rpSectionHead}>
          <span className={styles.rpSectionTitle}>PER 上昇 上位{perUpRows.length}</span>
          <span className={styles.rpSectionNote}>直近1ヶ月でPERが最も上昇した銘柄。市場の期待が高まっているサインでもある</span>
        </div>
        {perUpRows.length === 0
          ? <div className={styles.rpEmpty}>PERが上昇中の銘柄はありません</div>
          : renderTable(perUpRows)
        }
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
function SettingsPanel({
  visible, onClose, judgmentSettings, onSettingsChange, apiKey, onApiKeyChange, serverHasKey,
}: {
  visible: boolean
  onClose: () => void
  judgmentSettings: JudgmentSettings | null
  onSettingsChange: (s: JudgmentSettings) => void
  apiKey: string
  onApiKeyChange: (key: string) => void
  serverHasKey?: boolean
}) {
  const [local, setLocal] = useState<JudgmentSettings | null>(null)
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  useEffect(() => {
    if (visible && judgmentSettings) setLocal(judgmentSettings)
  }, [visible])  // sync only on open

  if (!local) return null
  const s = local  // narrowed non-null reference for closures

  const activeLogic = s.logics.find(l => l.id === s.activeLogicId) ?? s.logics[0]

  function commit(next: JudgmentSettings) {
    setLocal(next)
    onSettingsChange(next)
  }

  function debounce(key: string, next: JudgmentSettings) {
    setLocal(next)
    if (debounceRef.current[key]) clearTimeout(debounceRef.current[key])
    debounceRef.current[key] = setTimeout(() => onSettingsChange(next), 300)
  }

  function switchLogic(id: string) {
    commit({ ...s, activeLogicId: id })
  }

  function addLogic() {
    const id = 'logic_' + Date.now()
    const newLogic: JudgmentLogic = { id, name: '新ロジック', ranges: [] }
    commit({ ...s, logics: [...s.logics, newLogic], activeLogicId: id })
  }

  function duplicateLogic(id: string) {
    const src = s.logics.find(l => l.id === id)
    if (!src) return
    const newId = 'logic_' + Date.now()
    const copy: JudgmentLogic = { ...src, id: newId, name: src.name + ' (コピー)', ranges: src.ranges.map(r => ({ ...r })) }
    commit({ ...s, logics: [...s.logics, copy], activeLogicId: newId })
  }

  function deleteLogic(id: string) {
    if (s.logics.length <= 1) return
    const logics = s.logics.filter(l => l.id !== id)
    const activeId = id === s.activeLogicId ? logics[0].id : s.activeLogicId
    commit({ ...s, logics, activeLogicId: activeId })
  }

  function renameLogic(id: string, name: string) {
    const logics = s.logics.map(l => l.id === id ? { ...l, name } : l)
    debounce('rename_' + id, { ...s, logics })
  }

  function patchActiveLogic(logic: JudgmentLogic, debounceKey?: string) {
    const logics = s.logics.map(l => l.id === logic.id ? logic : l)
    const next = { ...s, logics }
    if (debounceKey) debounce(debounceKey, next)
    else commit(next)
  }

  function addRange() {
    patchActiveLogic({ ...activeLogic, ranges: [...activeLogic.ranges, { metric: AVAILABLE_METRICS[0], min: null, max: null }] })
  }

  function deleteRange(idx: number) {
    patchActiveLogic({ ...activeLogic, ranges: activeLogic.ranges.filter((_, i) => i !== idx) })
  }

  function patchRange(idx: number, patch: Partial<MetricRange>, debounceKey?: string) {
    const ranges = activeLogic.ranges.map((r, i) => i === idx ? { ...r, ...patch } : r)
    patchActiveLogic({ ...activeLogic, ranges }, debounceKey)
  }

  function parseNum(val: string, isPercent: boolean): number | null {
    const n = parseFloat(val)
    if (isNaN(n)) return null
    return isPercent ? n / 100 : n
  }

  function fmtNum(v: number | null, isPercent: boolean): string {
    if (v == null) return ''
    const n = isPercent ? v * 100 : v
    return Number.isInteger(n) ? String(n) : n.toFixed(1)
  }

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

        {!serverHasKey && (
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
          </div>
        )}

        <div className={styles.judgmentLogicRow}>
          <select
            className={styles.judgmentLogicSelect}
            value={s.activeLogicId}
            onChange={e => switchLogic(e.target.value)}
          >
            {s.logics.map((l, idx) => (
              <option key={l.id} value={l.id}>{(['①','②','③','④','⑤'][idx] ?? `${idx+1}.`)} {l.name}</option>
            ))}
          </select>
          <button className={styles.judgmentAddBtn} onClick={addLogic} title="ロジックを追加">＋</button>
        </div>

        <div className={styles.judgmentBody}>
          <div className={styles.logicNameRow}>
            <span className={styles.logicNumBadge}>
              {['①','②','③','④','⑤'][s.logics.findIndex(l => l.id === activeLogic.id)] ?? ''}
            </span>
            <input
              className={styles.logicNameInput}
              value={activeLogic.name}
              onChange={e => renameLogic(activeLogic.id, e.target.value)}
              placeholder="ロジック名"
            />
            <button
              className={styles.judgmentDupBtn}
              onClick={() => duplicateLogic(activeLogic.id)}
              title="このロジックを複製"
            >複製</button>
            {s.logics.length > 1 && (
              <button
                className={styles.judgmentDeleteBtn}
                onClick={() => deleteLogic(activeLogic.id)}
                title="このロジックを削除"
              >削除</button>
            )}
          </div>

          <div className={styles.rangesSection}>
            <div className={styles.rangesSectionLabel}>条件（すべてAND）</div>
            {activeLogic.ranges.map((range, idx) => {
              const meta = METRIC_LABELS[range.metric]
              const isPercent = meta?.isPercent ?? false
              return (
                <div key={idx} className={styles.rangeRow}>
                  <select
                    className={styles.metricSelect}
                    value={range.metric}
                    onChange={e => patchRange(idx, { metric: e.target.value })}
                  >
                    {AVAILABLE_METRICS.map(m => (
                      <option key={m} value={m}>{METRIC_LABELS[m].label}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    className={styles.rangeInput}
                    value={fmtNum(range.min, isPercent)}
                    onChange={e => patchRange(idx, { min: parseNum(e.target.value, isPercent) }, 'min_' + idx)}
                    placeholder="下限"
                  />
                  <span className={styles.rangeLabel}>〜</span>
                  <input
                    type="number"
                    className={styles.rangeInput}
                    value={fmtNum(range.max, isPercent)}
                    onChange={e => patchRange(idx, { max: parseNum(e.target.value, isPercent) }, 'max_' + idx)}
                    placeholder="上限"
                  />
                  <span className={styles.rangeUnit}>{meta?.unit ?? ''}</span>
                  <button className={styles.rangeDeleteBtn} onClick={() => deleteRange(idx)}>×</button>
                </div>
              )
            })}
            <button className={styles.addRangeBtn} onClick={addRange}>＋ 条件を追加</button>
          </div>
        </div>
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
