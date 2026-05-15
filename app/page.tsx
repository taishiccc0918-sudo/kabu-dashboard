'use client'
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  DEFAULT_WATCHLIST, StockRow, FinRecord, PriceRecord, MasterRecord, StockMeta,
  TabKey, StatusType, ALL_GENRE_OPTIONS, DEFAULT_GENRES,
  JudgmentSettings, JudgmentLogic, MetricRange,
} from './lib/types'
import { evaluateLogic } from './lib/judgmentEngine'
import { DEFAULT_LOGICS } from './lib/defaultLogics'
import { METRIC_LABELS, AVAILABLE_METRICS } from './lib/metricLabels'
import {
  findLatestBizDate, fetchMaster, fetchPrices, fetchAnnouncements, fetchAllFinancials,
} from './lib/api'
import { buildStockRow, fmtN, fmtPct, pctClass, pctBg, pctCellColor, marketShort } from './lib/format'
import styles from './page.module.css'

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

// ── 初期化（マイグレーション含む）──────────────────────────────────────
function initFavorites(): Set<string> {
  if (typeof window === 'undefined') return new Set(DEFAULT_WATCHLIST)
  const favArr = ls<string[] | null>('favorites', null)
  if (favArr !== null) return new Set(favArr)
  // 旧 watchlist から移行
  const oldWl = ls<string[] | null>('watchlist', null)
  if (oldWl !== null) {
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
  const [favorites,  setFavorites]  = useState<Set<string>>(new Set())
  const favoritesRef = useRef<Set<string>>(new Set())
  const [superFavorites,    setSuperFavorites]    = useState<Set<string>>(new Set())
  const [judgmentSettings,  setJudgmentSettings]  = useState<JudgmentSettings | null>(null)
  const [stockMeta,  setStockMeta]  = useState<Record<string, StockMeta>>({})
  const [priceDB,    setPriceDB]    = useState<Record<string, PriceRecord>>({})
  const [finDB,      setFinDB]      = useState<Record<string, FinRecord>>({})
  const [masterDB,   setMasterDB]   = useState<Record<string, MasterRecord>>({})
  const [lastUpdate, setLastUpdate] = useState('')
  const [status,     setStatus]     = useState<StatusType>('idle')
  const [statusMsg,  setStatusMsg]  = useState('待機中 — APIキーを入力して「全更新」を押してください')
  const [progress,   setProgress]   = useState(0)
  const [tab,        setTab]        = useState<TabKey>('dashboard')
  const [filter,     setFilter]     = useState<'all'|'buy'>('all')
  const [mktFilter,  setMktFilter]  = useState<string>('all')
  const [genreFilter, setGenreFilter] = useState<string>('all')
  const [mcapMin,    setMcapMin]    = useState<string>('')
  const [perFMax,    setPerFMax]    = useState<string>('')
  const [darkMode,   setDarkMode]   = useState<boolean>(true)
  const [showFilter,   setShowFilter]   = useState(false)
  const [showHelp,     setShowHelp]     = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [filterHeart,  setFilterHeart]  = useState(false)
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
  const [earningsDates, setEarningsDates] = useState<Record<string,string>>({})
  const abortSignalRef = useRef({ aborted: false })
  const searchWrapRef  = useRef<HTMLDivElement>(null)

  useEffect(() => { favoritesRef.current = favorites }, [favorites])
  useEffect(() => { if (apiKey) lsSet('apiKey', apiKey) }, [apiKey])
  useEffect(() => { localStorage.setItem('darkMode', String(darkMode)) }, [darkMode])

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
    setMounted(true)
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
  const fetchAll = useCallback(async () => {
    if (!apiKey.trim()) { alert('APIキーを入力してください'); return }
    if (loading) {
      abortSignalRef.current.aborted = true
      return
    }
    abortSignalRef.current = { aborted: false }
    setLoading(true); setStatus('loading')
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
      lsSet('lastUpdate', dateDisp)
      lsSet('apiKey', apiKey)
      const missing = currentFavorites.filter(c => !fins[c])
      const failMsg = missing.length > 0 ? ` (未取得${missing.length}銘柄)` : ''
      const elapsedSec = Math.round((Date.now() - startTime) / 1000)
      const elapsedStr = elapsedSec < 60 ? `${elapsedSec}秒` : `${Math.floor(elapsedSec/60)}分${elapsedSec%60}秒`
      st(`完了 — ${gotCount}/${total}銘柄取得 基準日: ${dateDisp}${failMsg} (所要${elapsedStr})`, 100)
      setStatus('ok')
      setTab('dashboard')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setStatusMsg(`エラー: ${msg}`)
      setStatus('error')
    } finally {
      setLoading(false)
      setTimeout(() => setProgress(0), 1200)
    }
  }, [apiKey, loading])

  // ── お気に入り操作 ────────────────────────────────────────────────
  function toggleFavorite(code: string) {
    setFavorites(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      lsSet('favorites', Array.from(next))
      return next
    })
  }
  function toggleSuperFavorite(code: string) {
    const isSuper = superFavorites.has(code)
    if (!isSuper && !favorites.has(code)) toggleFavorite(code)
    setSuperFavorites(prev => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      lsSet('superFavorites', Array.from(next))
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

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = allRows.filter(r => {
      if (q && !r.code.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
      if (filter === 'buy' && judgmentResultsMap[r.code] == null) return false
      if (filterHeart && !superFavorites.has(r.code)) return false
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
  }, [allRows, search, filter, filterHeart, superFavorites, judgmentResultsMap, mktFilter, genreFilter, mcapMin, perFMax, sortKey, sortDir])

  // ── 検索ドロップダウン候補生成（debounce 300ms）────────────────────
  useEffect(() => {
    const q = search.trim().toLowerCase()
    if (!q) { setDropdownResults([]); setDropdownActive(-1); return }
    const timer = setTimeout(() => {
      const codeNameHits: DropdownResult[] = []
      const memoHits: DropdownResult[] = []
      for (const r of allRows) {
        if (codeNameHits.length >= 5) break
        if (r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) {
          codeNameHits.push({ code: r.code, name: r.name, matchType: 'code_name' })
        }
      }
      for (const [code, meta] of Object.entries(stockMeta)) {
        if (memoHits.length >= 5) break
        if (!favorites.has(code) || !meta.memo) continue
        if (meta.memo.toLowerCase().includes(q)) {
          if (codeNameHits.some(r => r.code === code)) continue
          const idx = meta.memo.toLowerCase().indexOf(q)
          const start = Math.max(0, idx - 20)
          const end = Math.min(meta.memo.length, idx + q.length + 20)
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

  function saveMemo(code: string, text: string) {
    const prev = stockMeta[code] ?? { genres: [], memo: '' }
    saveStockMeta(code, { ...prev, memo: text })
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
          <div className={styles.lastUpdate}>{lastUpdate ? <><strong>{lastUpdate}</strong></> : '未取得'}{stats.total > 0 && <span style={{marginLeft:10,color:'var(--text3)',fontSize:11}}>&#9679; ★{favorites.size}銘柄</span>}</div>
        </div>
        <div className={styles.headerRight}>
          <label className={styles.apiLabel}>
            API Key{apiKey ? <span style={{color:'#34d399',marginLeft:5,fontSize:10}}>✓ 保存済み</span> : ''}
          </label>
          <input
            type="password"
            className={styles.apiInput}
            placeholder="J-Quants APIキーを入力..."
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
          />
          <button
            className={`${styles.btnPrimary} ${!loading && lastUpdate ? styles.btnDone : ''} ${loading ? styles.btnAbort : ''}`}
            onClick={fetchAll}
          >
            {loading ? '⏸ 中断' : lastUpdate ? '更新済み ↺' : '全更新'}
          </button>
          <button className={`${styles.btnSecondary} ${tab === 'watchlist' ? styles.btnSecondaryActive : ''}`} onClick={() => setTab(tab === 'watchlist' ? 'dashboard' : 'watchlist')}>銘柄管理</button>
          <button className={styles.helpBtn} onClick={() => setShowHelp(h => !h)} title="ヘルプ">?</button>
          <button className={styles.settingsBtn} onClick={() => setShowSettings(s => !s)} title="判定設定">⚙️</button>
          <button className={styles.themeToggle} onClick={() => setDarkMode(d => !d)} title={darkMode ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}>
            {darkMode ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      <div className={`${styles.toolbar} ${tab === 'watchlist' ? styles.toolbarHidden : ''}`} data-toolbar="">
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
        <div className={styles.filterGroup}>
          {(['all','buy'] as ('all'|'buy')[]).map(f => (
            <button
              key={f}
              className={`${styles.filterBtn} ${filter === f ? styles.filterBtnActive : ''}`}
              onClick={() => setFilter(f as 'all'|'buy')}
            >
              {{ all:'全て', buy:'買い' }[f]}
            </button>
          ))}
          <button
            className={`${styles.filterBtn} ${styles.heartFilterBtn} ${filterHeart ? styles.heartFilterBtnActive : ''}`}
            onClick={() => setFilterHeart(h => !h)}
            title="超お気に入り（♥）銘柄のみ表示"
          >♥のみ</button>
        </div>
        <div className={styles.filterDivider} />
        <div className={styles.filterGroup}>
          {([
            { key: 'all',      label: '全市場' },
            { key: 'prime',    label: 'Prime' },
            { key: 'standard', label: 'Standard' },
            { key: 'growth',   label: 'Growth' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              className={`${styles.filterBtn} ${styles['mktBtn_'+key]} ${mktFilter === key ? styles.filterBtnActive : ''}`}
              onClick={() => setMktFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className={`${styles.filterToggleBtn} ${showFilter ? styles.filterToggleBtnActive : ''}`}
          onClick={() => setShowFilter(s => !s)}
        >
          ▼ 絞り込み{(mcapMin||perFMax||genreFilter!=='all') ? ' ●' : ''}
        </button>
        <div className={styles.spacer} />
        <button className={styles.pcToggleBtn} onClick={() => setForcePc(f => !f)}>
          {forcePc ? '📱 最適化' : '🖥 PC表示'}
        </button>
        <div className={styles.tabGroup}>
          {(['dashboard','card'] as TabKey[]).map(t => (
            <button
              key={t}
              className={`${styles.tabBtn} ${tab === t ? styles.tabBtnActive : ''}`}
              onClick={() => setTab(t)}
            >
              {{ dashboard:'ダッシュボード', card:'カード' }[t as 'dashboard'|'card']}
            </button>
          ))}
        </div>
      </div>

      {showFilter && tab !== 'watchlist' && (
        <div className={styles.filterPanel}>
          <div className={styles.filterPanelGrid}>
            <div className={styles.filterPanelGroup}>
              <label className={styles.filterPanelLabel}>ジャンル</label>
              <div className={styles.filterPanelChips}>
                {['all', ...allGenreOptions].map(g => (
                  <button key={g}
                    className={`${styles.filterChip} ${genreFilter===g ? styles.filterChipActive : ''}`}
                    onClick={() => setGenreFilter(g)}
                  >{g==='all'?'全て':g}</button>
                ))}
              </div>
            </div>
            <div className={styles.filterPanelGroup}>
              <label className={styles.filterPanelLabel}>時価総額（億円）以上</label>
              <input type="number" className={styles.filterPanelInput} placeholder="例: 500"
                value={mcapMin} onChange={e => setMcapMin(e.target.value)} />
            </div>
            <div className={styles.filterPanelGroup}>
              <label className={styles.filterPanelLabel}>PER今期 以下</label>
              <input type="number" className={styles.filterPanelInput} placeholder="例: 30"
                value={perFMax} onChange={e => setPerFMax(e.target.value)} />
            </div>
          </div>
          <button className={styles.filterPanelClear}
            onClick={() => { setMcapMin(''); setPerFMax(''); setGenreFilter('all') }}>
            条件をクリア
          </button>
        </div>
      )}

      <main className={styles.main} style={{ visibility: mounted ? 'visible' : 'hidden' }}>
        {tab === 'dashboard' && (
          <>
            <div className={forcePc ? styles.forcePcOn : styles.pcOnly}>
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
              />
            </div>
            <div className={forcePc ? styles.forceMobileOff : styles.mobileOnly}>
              <div className={styles.mobileList}>
                {filteredRows.length === 0
                  ? <div className={styles.emptyCell}>該当銘柄なし</div>
                  : filteredRows.map(r => (
                    <MobileRow key={r.code} row={r} onClick={() => setDetailCode(r.code)} judgment={judgmentResultsMap[r.code] ?? null} />
                  ))
                }
              </div>
            </div>
          </>
        )}

        {tab === 'card' && (
          <div className={styles.cardGrid}>
            {filteredRows.map(r => (
              <StockCard key={r.code} row={r} apiKey={apiKey} onClick={() => setDetailCode(r.code)} judgment={judgmentResultsMap[r.code] ?? null} />
            ))}
          </div>
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
            onExport={exportToExcel}
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
              onSaveMemo={text => saveMemo(detailCode!, text)}
              apiKey={apiKey}
              earningsDate={earningsDates[detailCode] ?? ''}
              onSaveEarningsDate={date => saveEarningsDate(detailCode!, date)}
              judgment={judgmentResultsMap[detailCode] ?? null}
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
      />

      <div className={styles.statusBar}>
        <div className={`${styles.statusDot} ${
          status === 'loading' ? styles.statusLoading :
          status === 'error'   ? styles.statusError   : ''
        }`} />
        <span>{statusMsg}</span>
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
  masterDB, favorites, superFavorites, stockMeta, allGenreOptions,
  onToggleFavorite, onToggleSuperFav, onSaveStockMeta, onAddGenre, onRemoveGenre, onExport,
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
  onExport: () => void
}) {
  const [wlSearch, setWlSearch] = useState('')
  const [showFavOnly,   setShowFavOnly]   = useState(false)
  const [showHeartOnly, setShowHeartOnly] = useState(false)
  const [mktF, setMktF] = useState('all')
  const [page, setPage] = useState(1)
  const [wlShowDropdown,    setWlShowDropdown]    = useState(false)
  const [wlDropdownResults, setWlDropdownResults] = useState<DropdownResult[]>([])
  const [wlDropdownActive,  setWlDropdownActive]  = useState(-1)
  const [wlHighlightCode,   setWlHighlightCode]   = useState<string | null>(null)
  const wlSearchWrapRef = useRef<HTMLDivElement>(null)

  const allCodes = useMemo(() => Object.keys(masterDB).sort(), [masterDB])

  const filteredCodes = useMemo(() => {
    const q = wlSearch.trim().toLowerCase()
    return allCodes.filter(code => {
      const rec = masterDB[code]
      if (!rec) return false
      if (showFavOnly   && !favorites.has(code))      return false
      if (showHeartOnly && !superFavorites.has(code)) return false
      if (mktF === 'prime'    && !rec.market.includes('プライム'))     return false
      if (mktF === 'standard' && !rec.market.includes('スタンダード')) return false
      if (mktF === 'growth'   && !rec.market.includes('グロース'))     return false
      if (q && !code.toLowerCase().includes(q) && !rec.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [allCodes, masterDB, favorites, superFavorites, showFavOnly, showHeartOnly, mktF, wlSearch])

  useEffect(() => {
    const q = wlSearch.trim().toLowerCase()
    if (!q) { setWlDropdownResults([]); setWlDropdownActive(-1); return }
    const timer = setTimeout(() => {
      const codeNameHits: DropdownResult[] = []
      const memoHits: DropdownResult[] = []
      for (const code of allCodes) {
        if (codeNameHits.length >= 5) break
        const rec = masterDB[code]
        if (!rec) continue
        if (code.toLowerCase().includes(q) || rec.name.toLowerCase().includes(q)) {
          codeNameHits.push({ code, name: rec.name, matchType: 'code_name' })
        }
      }
      for (const [code, meta] of Object.entries(stockMeta)) {
        if (memoHits.length >= 5) break
        if (!favorites.has(code) || !meta.memo) continue
        if (meta.memo.toLowerCase().includes(q)) {
          if (codeNameHits.some(r => r.code === code)) continue
          const idx = meta.memo.toLowerCase().indexOf(q)
          const start = Math.max(0, idx - 20)
          const end = Math.min(meta.memo.length, idx + q.length + 20)
          const snippet = (start > 0 ? '…' : '') + meta.memo.slice(start, end) + (end < meta.memo.length ? '…' : '')
          memoHits.push({ code, name: masterDB[code]?.name ?? '', matchType: 'memo', memoSnippet: snippet })
        }
      }
      setWlDropdownResults([...codeNameHits, ...memoHits])
      setWlDropdownActive(-1)
    }, 300)
    return () => clearTimeout(timer)
  }, [wlSearch, allCodes, masterDB, stockMeta, favorites])

  useEffect(() => { setPage(1) }, [wlSearch, showFavOnly, mktF])

  useEffect(() => {
    if (!wlHighlightCode) return
    const el = document.querySelector<HTMLElement>(`[data-code-wl="${wlHighlightCode}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const timer = setTimeout(() => setWlHighlightCode(null), 2500)
    return () => clearTimeout(timer)
  }, [wlHighlightCode])

  useEffect(() => {
    function onOutsideDown(e: MouseEvent) {
      if (wlSearchWrapRef.current && !wlSearchWrapRef.current.contains(e.target as Node)) {
        setWlShowDropdown(false); setWlDropdownActive(-1)
      }
    }
    document.addEventListener('mousedown', onOutsideDown)
    return () => document.removeEventListener('mousedown', onOutsideDown)
  }, [])

  function scrollToWlRow(code: string) {
    setWlShowDropdown(false); setWlDropdownActive(-1)
    // wlSearch はクリアしない（候補は filteredCodes に既にマッチ済み）
    // → useEffect(() => setPage(1), [wlSearch]) が発火せずページが保たれる
    const idx = filteredCodes.indexOf(code)
    if (idx >= 0) setPage(Math.floor(idx / PER_PAGE) + 1)
    setWlHighlightCode(null)
    setTimeout(() => setWlHighlightCode(code), 0)
  }

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
      <div className={styles.wlHeader}>
        <div className={styles.wlTitle}>
          銘柄管理
          <span className={styles.wlCount}>★{favorites.size}件 / 全{allCodes.length}件</span>
        </div>
        <button className={styles.btnSecondary} onClick={onExport} title="お気に入り銘柄をExcelにエクスポート">
          ↓ Excelエクスポート
        </button>
      </div>

      <div className={styles.wlGenreBar}>
        <span className={styles.wlGenreLabel}>ジャンル:</span>
        {allGenreOptions.map(g => (
          <span key={g} className={styles.genreBadgeEditable}>
            {g}
            <button className={styles.genreRemoveBtn} onClick={() => onRemoveGenre(g)} title="削除">×</button>
          </span>
        ))}
        <AddGenreInput onAdd={onAddGenre} />
      </div>

      <div className={styles.wlFilterBar}>
        <div style={{ position: 'relative' }} ref={wlSearchWrapRef}>
          <input
            className={styles.wlSearchInput}
            placeholder="銘柄名・コードで絞り込み..."
            value={wlSearch}
            onChange={e => setWlSearch(e.target.value)}
            onFocus={() => setWlShowDropdown(true)}
            onBlur={() => setTimeout(() => setWlShowDropdown(false), 150)}
            onKeyDown={e => {
              if (!wlShowDropdown || !wlSearch.trim()) return
              if (e.key === 'ArrowDown') { e.preventDefault(); setWlDropdownActive(i => Math.min(i + 1, wlDropdownResults.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setWlDropdownActive(i => Math.max(i - 1, 0)) }
              else if (e.key === 'Escape') { setWlShowDropdown(false); setWlDropdownActive(-1) }
              else if (e.key === 'Enter' && wlDropdownResults[wlDropdownActive]) { scrollToWlRow(wlDropdownResults[wlDropdownActive].code) }
            }}
          />
          <SearchDropdown
            results={wlDropdownResults}
            activeIndex={wlDropdownActive}
            visible={wlShowDropdown && wlSearch.trim().length > 0}
            onSelect={code => scrollToWlRow(code)}
          />
        </div>
        <button
          className={`${styles.filterBtn} ${showFavOnly ? styles.filterBtnActive : ''}`}
          onClick={() => setShowFavOnly(f => !f)}
          style={{fontWeight: showFavOnly ? 700 : undefined}}
        >★ お気に入りのみ</button>
        <button
          className={`${styles.filterBtn} ${styles.heartFilterBtn} ${showHeartOnly ? styles.heartFilterBtnActive : ''}`}
          onClick={() => setShowHeartOnly(h => !h)}
          title="超お気に入り（♥）銘柄のみ表示"
        >♥のみ</button>
        {(['all','prime','standard','growth'] as const).map(k => (
          <button key={k}
            className={`${styles.filterBtn} ${mktF === k ? styles.filterBtnActive : ''}`}
            onClick={() => setMktF(k)}
          >{{all:'全市場',prime:'Prime',standard:'Standard',growth:'Growth'}[k]}</button>
        ))}
        <span className={styles.wlResultCount}>{filteredCodes.length}件</span>
      </div>

      <div className={styles.wlTableScroll}>
        <table className={styles.wlTableInner}>
          <thead>
            <tr>
              <th className={styles.wlTh} style={{width:64}}>♥ ★</th>
              <th className={styles.wlTh} style={{width:68}}>コード</th>
              <th className={styles.wlTh} style={{width:190}}>銘柄名</th>
              <th className={styles.wlTh} style={{width:80}}>市場</th>
              <th className={styles.wlTh} style={{width:220}}>ジャンル</th>
              <th className={styles.wlTh}>メモ</th>
              <th className={styles.wlTh} style={{width:180}}>リンク</th>
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
                allGenreOptions={allGenreOptions}
                onToggleFav={() => onToggleFavorite(code)}
                onToggleSuperFav={() => onToggleSuperFav(code)}
                onSaveMeta={(meta) => onSaveStockMeta(code, meta)}
                onAddGenre={onAddGenre}
                highlighted={wlHighlightCode === code}
              />
            ))}
          </tbody>
        </table>
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

// ─── StockManagerRow ─────────────────────────────────────────────────
const StockManagerRow = React.memo(function StockManagerRow({
  code, rec, isFav, isSuperFav, meta, allGenreOptions, onToggleFav, onToggleSuperFav, onSaveMeta, onAddGenre, highlighted,
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
  highlighted: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [localMemo, setLocalMemo] = useState(meta.memo)
  const { label: mktLabel, cls: mktCls } = marketShort(rec.market)

  const genres = meta.genres

  function toggleGenre(tag: string) {
    const next = genres.includes(tag) ? genres.filter(g => g !== tag) : [...genres, tag]
    onSaveMeta({ ...meta, genres: next })
  }

  // メモがpropsで変わったとき（他の行の更新等）は同期
  useEffect(() => { setLocalMemo(meta.memo) }, [meta.memo])

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
              : genres.map(g => <span key={g} className={`${styles.genreTag} ${styles.genreTagOn}`}>{g}</span>)}
            <button
              className={`${styles.genreEditToggleBtn} ${editing ? styles.genreEditToggleBtnOn : ''}`}
              onClick={() => setEditing(e => !e)}
            >{editing ? '▲' : '✏️'}</button>
          </div>
        </td>
        <td className={styles.wlTd}>
          <input
            className={styles.wlMemoInput}
            placeholder="メモ"
            value={localMemo}
            onChange={e => setLocalMemo(e.target.value)}
            onBlur={() => onSaveMeta({ ...meta, memo: localMemo })}
            onKeyDown={e => { if (e.key === 'Enter') { onSaveMeta({ ...meta, memo: localMemo }); e.currentTarget.blur() } }}
          />
        </td>
        <td className={styles.wlTd} style={{whiteSpace:'nowrap'}}>
          <div style={{display:'flex', gap:4}}>
            <a href={`https://shikiho.toyokeizai.net/stocks/${code}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>四季報</a>
            <a href={`https://finance.yahoo.co.jp/quote/${code}.T`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>Yahoo</a>
            <a href={`https://kabutan.jp/stock/?code=${code}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>かぶたん</a>
            <a href={`https://www.google.com/search?q=${encodeURIComponent((rec.name || code) + ' 公式サイト')}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>公式HP</a>
          </div>
        </td>
      </tr>
      {editing && (
        <tr className={styles.wlEditRow}>
          <td colSpan={7} className={styles.wlEditTd}>
            <div className={styles.wlGenreEditPanel}>
              {allGenreOptions.map(g => (
                <button key={g}
                  className={`${styles.genreTag} ${genres.includes(g) ? styles.genreTagOn : ''}`}
                  onClick={() => toggleGenre(g)}
                >{g}</button>
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
type ChartMode = 'daily' | 'monthly'
interface SeriesData { prices: number[]; label: string; color: string }

async function fetchIndex(stooqSymbol: string, from: string, to: string): Promise<number[]> {
  const fd = `${from.slice(0,4)}-${from.slice(4,6)}-${from.slice(6,8)}`
  const td = `${to.slice(0,4)}-${to.slice(4,6)}-${to.slice(6,8)}`
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&d1=${fd.replace(/-/g,'')}&d2=${td.replace(/-/g,'')}&i=d`
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

function normalizeSeries(prices: number[]): number[] {
  if (prices.length === 0) return []
  const base = prices[0]
  return prices.map(v => v / base)
}

function MiniChart({ code, apiKey }: { code: string; apiKey: string }) {
  const [mode, setMode] = useState<ChartMode>('daily')
  const [cachedData, setCachedData] = useState<Record<ChartMode, SeriesData[] | null>>({ daily: null, monthly: null })
  const [chartLoading, setChartLoading] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const fmt = (d: Date) => d.toISOString().slice(0,10).replace(/-/g,'')

  useEffect(() => {
    if (!apiKey || !code) return
    if (cachedData[mode] !== null) return
    setChartLoading(true)
    const today = new Date()
    const from = new Date(today)
    if (mode === 'daily') from.setFullYear(from.getFullYear() - 1)
    else from.setFullYear(from.getFullYear() - 5)
    const fromStr = fmt(from)
    const toStr = fmt(today)
    const path = encodeURIComponent(`/equities/bars/daily?code=${code}&dateFrom=${fromStr}&dateTo=${toStr}`)
    const url = `/api/jquants?path=${path}`
    Promise.all([
      fetch(url, { headers: { 'x-api-key': apiKey } }).then(r => r.json()),
      fetchIndex('n225.jp', fromStr, toStr),
      fetchIndex('ixic', fromStr, toStr),
    ]).then(([json, nkPrices, ndqPrices]) => {
      const data = json?.data ?? []
      let stockPrices: number[]
      if (mode === 'daily') {
        stockPrices = data.map((d: Record<string,number>) => d.AdjC ?? d.C ?? 0).filter((v: number) => v > 0)
      } else {
        const monthly: Record<string, number> = {}
        for (const d of data) {
          const mon = (d.Date as string)?.slice(0,7) ?? ''
          if (mon) monthly[mon] = d.AdjC ?? d.C ?? 0
        }
        stockPrices = Object.values(monthly).filter(v => v > 0)
      }
      const series: SeriesData[] = [
        { prices: normalizeSeries(stockPrices), label: code, color: stockPrices.length > 1 && stockPrices[stockPrices.length-1] >= stockPrices[0] ? '#34d399' : '#f87171' },
        { prices: normalizeSeries(nkPrices), label: '日経', color: 'rgba(251,191,36,0.7)' },
        { prices: normalizeSeries(ndqPrices), label: 'NASDAQ', color: 'rgba(139,92,246,0.7)' },
      ]
      setCachedData(prev => ({ ...prev, [mode]: series }))
    }).catch(() => {
      setCachedData(prev => ({ ...prev, [mode]: [] }))
    }).finally(() => setChartLoading(false))
  }, [code, apiKey, mode])

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
      const h = 140
      canvas.width = w; canvas.height = h
      ctx.clearRect(0, 0, w, h)
      const allValues = series.flatMap(s => s.prices).filter(v => v > 0)
      const min = Math.min(...allValues) * 0.98
      const max = Math.max(...allValues) * 1.02
      const range = max - min || 1
      const toX = (i: number, len: number) => (i / (len - 1)) * w
      const toY = (v: number) => h - ((v - min) / range) * (h - 16) - 8
      const stockColor = series[0].color
      const grad = ctx.createLinearGradient(0, 0, 0, h)
      grad.addColorStop(0, stockColor.includes('34d') ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)')
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
      series.filter(s => s.prices.length > 1).forEach((s, i) => {
        ctx.fillStyle = s.color; ctx.fillRect(8 + i * 72, 4, 10, 2)
        ctx.fillStyle = 'rgba(200,220,240,0.7)'; ctx.font = '10px JetBrains Mono, monospace'
        ctx.fillText(s.label === code ? code : s.label, 22 + i * 72, 12)
      })
    }
    requestAnimationFrame(draw)
  }, [cachedData, mode, code])

  const currentData = cachedData[mode]
  const hasData = currentData !== null && currentData[0]?.prices.length >= 2
  return (
    <div className={styles.chartArea}>
      <div className={styles.chartTabs}>
        {(['daily','monthly'] as ChartMode[]).map(m => (
          <button key={m} className={`${styles.chartTab} ${mode === m ? styles.chartTabActive : ''}`}
            onClick={e => { e.stopPropagation(); setMode(m) }}>
            {m === 'daily' ? '日足(1年)' : '月足(5年)'}
          </button>
        ))}
      </div>
      <canvas ref={canvasRef} className={styles.chartCanvas} style={{ display: hasData && !chartLoading ? 'block' : 'none' }} />
      {chartLoading && <div className={styles.chartLoading}>読込中...</div>}
      {!chartLoading && !hasData && <div className={styles.chartLoading}>データなし</div>}
    </div>
  )
}

// ─── DashboardTable ──────────────────────────────────────────────────
function DashboardTable({
  filteredRows, finDB, earningsDates, onSaveEarningsDate, sortKey, sortDir, handleSort, onRowClick, highlightCode, superFavorites, onToggleSuperFav, judgmentResultsMap
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
    { label: '銘柄名', cls: `${styles.thLeft} ${styles.stickyCol1}`, key: 'name' as keyof StockRow, group: '' },
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
    { label: 'PER来期',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perN' as keyof StockRow, group: 'per', tooltip: '株価÷来期予想EPS。\n来期の成長性を加味した割安度。\n来期の業績改善が見込まれるか確認できる。' },
    { label: 'PER今期の1ヶ月前比', cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perFChg1m' as keyof StockRow, group: 'per', tooltip: '1ヶ月前のPER今期→現在のPER今期の変化。\nセルにホバーで詳細(1M前XX倍→現在YY倍/差・比)' },
    { label: 'PBR', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'pbr' as keyof StockRow, group: 'other', tooltip: '株価÷1株あたり純資産（BPS）。\n1倍未満=純資産より安く買える。\n1〜2倍が標準的とされる。' },
    { label: 'ROE', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'roe' as keyof StockRow, group: 'other', tooltip: '純利益÷自己資本。\n資本をどれだけ効率よく使って利益を出しているか。\n10%超で優良、15%超で高収益企業。' },
    { label: '配当利回り', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'divY' as keyof StockRow, group: 'other', tooltip: '年間配当÷株価。\nインカムゲインの目安。\n3%超で高配当株とされる。' },
    { label: 'EPS成長率',  cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'epsGr' as keyof StockRow, group: 'other', tooltip: 'EPS（1株あたり利益）の成長率（今期予想÷直近実績−1）。\n高成長の目安は15%超。' },
    { label: 'PEG', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'peg' as keyof StockRow, group: 'other', tooltip: 'PER÷EPS成長率（%）。\n1未満=成長率に対して株価が割安と判断される指標。\n成長株の割安度を見るのに使う。' },
    { label: '営業利益率', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'opMgn' as keyof StockRow, group: 'other', tooltip: '営業利益÷売上高。\n本業でどれだけ稼げるかの収益性指標。\n15%超で高収益、20%超は非常に優秀。' },
    { label: '来期売上成長',cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'nySalesGr' as keyof StockRow, group: 'other', tooltip: '来期予想売上÷今期予想売上−1。\n来期の成長性の目安。\n15%超で高成長企業の目安。' },
    { label: '判定', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: null, group: 'other', tooltip: '【判定ロジック（新エンジン）】\n割安株: PER今期<15 AND PBR<1.5 AND ROE>8%\nグロース株: 来期売上成長>15% AND 営業利益率>15%\n押し目: 株価1ヶ月変化率≤−5%\nいずれか1グループ以上に該当で「買い」' },
    { label: '四季報',     cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
    { label: 'Yahoo\nFinance', cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
    { label: 'かぶたん',   cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
    { label: '公式HP',     cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
    { label: '次決算',     cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info', tooltip: '次回決算予定日。クリックして入力/編集できます。\n2週間以内:黄色、1週間以内:赤で警告。' },
  ]
  const colWidths = [48,60,150,80,72,108,80,80,76,80,76,76,76,76,140,64,64,88,92,64,92,108,64,72,64,84,72,80]
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
                  title={col.tooltip}
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
              <tr><td colSpan={28} className={styles.emptyCell}>該当銘柄なし</td></tr>
            ) : filteredRows.map((r, i) => (
              <TableRow key={r.code} row={r} idx={i} fin={finDB?.[r.code]} earningsDates={earningsDates} onSaveEarningsDate={onSaveEarningsDate} onClick={() => onRowClick(r.code)} highlighted={highlightCode === r.code} isSuperFav={superFavorites.has(r.code)} onToggleSuperFav={() => onToggleSuperFav(r.code)} judgment={judgmentResultsMap[r.code] ?? null} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── TableRow ────────────────────────────────────────────────────────
function TableRow({ row: r, idx, fin, earningsDates, onSaveEarningsDate, onClick, highlighted, isSuperFav, onToggleSuperFav, judgment }: {
  row: StockRow; idx: number; fin?: import('./lib/types').FinRecord
  earningsDates: Record<string,string>; onSaveEarningsDate: (code: string, date: string) => void; onClick: () => void
  highlighted: boolean; isSuperFav: boolean; onToggleSuperFav: () => void; judgment: string | null
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
      <td className={`${styles.tdName} ${styles.stickyCol1}`} style={{background: stickyNameBg}}>{r.name || '—'}</td>
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
      <td className={`${styles.tdNum} ${styles.tdPerGroup} ${fin?.perType ? styles.hasTooltip : ''}`}
        title={fin?.perType ? `今期予想EPS基準 (${fin.perType === 'FY' ? '通期' : fin.perType + '四半期'}) / 開示: ${fin.discDate}` : undefined}
      >{r.perF ? fmtN(r.perF) : '—'}</td>
      <td className={`${styles.tdNum} ${styles.tdPerGroup} ${fin?.discDate ? styles.hasTooltip : ''}`}
        title={fin?.discDate ? `来期予想EPS基準 / 参照決算: ${fin.discDate}` : undefined}
      >{r.perN ? fmtN(r.perN) : '—'}</td>
      <td className={`${styles.tdPct} ${styles.tdPerGroup} ${styles.hasTooltip}`}
        style={{background: pctBg(r.perFChg1m), color: pctCellColor(r.perFChg1m)}}
        title={r.perFChg1mPrev && r.perF ? `1M前: ${fmtN(r.perFChg1mPrev)}倍 → 現在: ${fmtN(r.perF)}倍 ／ 差: ${(r.perF - r.perFChg1mPrev).toFixed(1)}倍 ／ 比: ${fmtPct(r.perFChg1m)}` : undefined}
      >{fmtPct(r.perFChg1m)}</td>
      <td className={styles.tdNum}>{r.pbr  ? fmtN(r.pbr)  : '—'}</td>
      <td className={styles.tdNum} style={{color: r.roe && r.roe > 0.1 ? '#10b981' : undefined}}>{r.roe ? fmtPct(r.roe) : '—'}</td>
      <td className={styles.tdNum} style={{color: r.divY && r.divY > 0.03 ? '#10b981' : undefined}}>{r.divY ? fmtPct(r.divY) : '—'}</td>
      <td className={styles.tdPct} style={{color: pctCellColor(r.epsGr)}}>{r.epsGr !== null ? fmtPct(r.epsGr) : '—'}</td>
      <td className={styles.tdNum} style={{color: r.peg && r.peg < 1 ? '#10b981' : undefined}}>{r.peg ? fmtN(r.peg, 2) : '—'}</td>
      <td className={styles.tdNum} style={{color: r.opMgn && r.opMgn > 0.15 ? '#10b981' : undefined}}>{r.opMgn ? fmtPct(r.opMgn) : '—'}</td>
      <td className={styles.tdPct} style={{color: pctCellColor(r.nySalesGr)}}>{r.nySalesGr !== null ? fmtPct(r.nySalesGr) : '—'}</td>
      <td className={styles.hasTooltip} title={judgment != null ? `該当: ${judgment}` : '買い条件に非該当'}><JudgmentBadge result={judgment} /></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>四季報</a></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://finance.yahoo.co.jp/quote/${r.code}.T`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn} style={{lineHeight:1.1}}>Yahoo<br/>Finance</a></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>かぶたん</a></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://www.google.com/search?q=${encodeURIComponent((r.name || r.code) + ' 公式サイト')}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>公式HP</a></td>
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
      onClick={() => { setVal(date); setEditing(true) }}
    >
      {displayDate ? formatShort(displayDate) : '+'}
    </span>
  )
}

// ─── MobileRow ───────────────────────────────────────────────────────
function MobileRow({ row: r, onClick, judgment }: { row: StockRow; onClick: () => void; judgment: string | null }) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.mobileRow} onClick={onClick}>
      <div className={styles.mobileRowLeft}>
        <div className={styles.mobileRowTop}>
          <span className={styles.mobileCode}>{r.code}</span>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
          <JudgmentBadge result={judgment} />
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
function StockCard({ row: r, apiKey, onClick, judgment }: { row: StockRow; apiKey: string; onClick: () => void; judgment: string | null }) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.cardCode}>{r.code}</div>
          <div className={styles.cardName}>{r.name || '—'}</div>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        </div>
        <div className={styles.cardRight}>
          <JudgmentBadge result={judgment} />
          {r.mcap ? <div className={styles.cardMcap}>{r.mcap.toLocaleString()}億</div> : null}
        </div>
      </div>
      <div className={styles.cardPriceRow}>
        <div className={styles.cardPrice}>{r.close ? r.close.toLocaleString() : '—'}</div>
        <div className={`${styles.cardChange} ${styles[pctClass(r.chg1d)]}`}>{fmtPct(r.chg1d)}</div>
      </div>
      <div className={styles.cardMetrics}>
        {[
          ['PER今期', r.perF ? fmtN(r.perF) : '—', ''],
          ['PBR',    r.pbr  ? fmtN(r.pbr)  : '—', ''],
          ['ROE',    r.roe  ? fmtPct(r.roe) : '—', r.roe && r.roe > 0.1 ? 'up' : ''],
          ['配当',   r.divY ? fmtPct(r.divY): '—', r.divY && r.divY > 0.03 ? 'up' : ''],
          ['3ヶ月',  fmtPct(r.chg3m), pctClass(r.chg3m)],
          ['PEG',    r.peg  ? fmtN(r.peg,2) : '—', r.peg && r.peg < 1 ? 'up' : ''],
        ].map(([l, v, c]) => (
          <div key={l} className={styles.cardMetric}>
            <div className={styles.cardMetricLabel}>{l}</div>
            <div className={`${styles.cardMetricValue} ${c ? styles[c] : ''}`}>{v}</div>
          </div>
        ))}
      </div>
      {apiKey && (
        <div onClick={e => e.stopPropagation()}>
          <MiniChart code={r.code} apiKey={apiKey} />
        </div>
      )}
      <div className={styles.cardLinks} onClick={e => e.stopPropagation()}>
        <a className={styles.cardLinkBtn} href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank" rel="noopener noreferrer">かぶたん</a>
        <a className={styles.cardLinkBtn} href={`https://www.google.com/search?q=${encodeURIComponent((r.name || r.code) + ' 公式サイト')}`} target="_blank" rel="noopener noreferrer">公式HP</a>
      </div>
    </div>
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

function JudgmentBadge({ result }: { result: string | null }) {
  if (result != null) {
    return <span className={`${styles.jBadge} ${styles.jBuy}`} title={`該当: ${result}`}>買い</span>
  }
  return <span className={`${styles.jBadge} ${styles.jNone}`}>—</span>
}

// ─── DetailPanel ─────────────────────────────────────────────────────
function DetailPanel({
  row: r, fin: f, memo, onSaveMemo, apiKey, earningsDate, onSaveEarningsDate, judgment,
}: {
  row: StockRow; fin: FinRecord | null | undefined
  memo: string; onSaveMemo: (t: string) => void
  apiKey: string; earningsDate: string; onSaveEarningsDate: (date: string) => void
  judgment: string | null
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
        <JudgmentBadge result={judgment} />
      </div>
      {judgment != null && (
        <div className={styles.judgmentGroups}>該当: {judgment}</div>
      )}
      <div className={`${styles.detailPrice} ${styles[pctClass(r.chg1d)]}`}>
        {r.close ? r.close.toLocaleString() : '—'}
      </div>
      <div className={styles.detailSubPrice}>
        前日比: <span className={styles[pctClass(r.chg1d)]}>{fmtPct(r.chg1d)}</span>
      </div>
      <Section title="チャート"><MiniChart code={r.code} apiKey={apiKey} /></Section>
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
          ['PER来期',    null, r.perN ? fmtN(r.perN) : '—', ''],
          ['PBR',        null, r.pbr  ? fmtN(r.pbr)  : '—', ''],
          ['ROE',        null, r.roe  ? fmtPct(r.roe) : '—', r.roe && r.roe > 0.1 ? 'up' : ''],
          ['配当利回り', null, r.divY ? fmtPct(r.divY): '—', r.divY && r.divY > 0.03 ? 'up' : ''],
          ['EPS成長率',  null, r.epsGr !== null ? fmtPct(r.epsGr) : '—', pctClass(r.epsGr)],
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
        <button className={styles.btnPrimary}
          style={{ width: '100%', marginTop: 8, ...(saved ? { background: '#34d399' } : {}) }}
          onClick={save}
        >{saved ? '保存しました ✓' : 'メモを保存'}</button>
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
          <a className={styles.detailLinkBtn} href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank">四季報オンライン</a>
          <a className={styles.detailLinkBtn} href={`https://irbank.net/${r.code}`} target="_blank">IRBank</a>
          <a className={styles.detailLinkBtn} href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank">かぶたん</a>
          <a className={styles.detailLinkBtn} href={`https://www.google.com/search?q=${encodeURIComponent((r.name || r.code) + ' 公式サイト')}`} target="_blank">公式HP</a>
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

// ─── HelpPanel ────────────────────────────────────────────────────────
const USAGE_ITEMS = [
  { title: 'データ取得',   desc: 'APIキーを入力して「全更新」ボタンを押すとJ-Quants APIから株価・財務データを取得します。取得済みデータはlocalStorageに保存されます。' },
  { title: '銘柄検索',     desc: 'ツールバーの検索欄で銘柄名・コード・メモキーワードを入力するとドロップダウンが表示されます。選択するとその銘柄の行にジャンプしてハイライトします。' },
  { title: '絞り込み',     desc: '「フィルター」ボタンでジャンル・時価総額・PER今期による絞り込みができます。ツールバーの市場ボタン（Prime/Standard/Growth）でも絞り込めます。' },
  { title: 'ソート',       desc: 'テーブルのヘッダーをクリックするとその列でソートされます。再クリックで昇順/降順が切り替わります。' },
  { title: '詳細パネル',   desc: '行をクリックすると右側から詳細パネルが開き、財務情報・チャート・メモを確認できます。パネル外クリックまたは×ボタンで閉じます。' },
  { title: '銘柄管理',     desc: '「銘柄管理」ボタンでウォッチリストの追加・削除、ジャンルタグ・メモの編集ができます。メモ内容からも銘柄を検索できます。' },
  { title: 'ジャンルタグ', desc: '各銘柄に複数のジャンルタグを設定できます。ツールバーのフィルターでジャンルを絞り込んで素早く対象銘柄を確認できます。' },
  { title: 'データ保存',   desc: 'APIキー・ウォッチリスト・ジャンル・メモはすべてブラウザのlocalStorageに自動保存されます。エクスポートボタンでExcel形式でダウンロードできます。' },
]
const INDICATOR_ITEMS = [
  { label: '株価',        desc: '直近営業日の終値（円）' },
  { label: '1D / 1W',    desc: '前日・前週比の株価変化率' },
  { label: '3M / 1Y',    desc: '3ヶ月前・1年前比の株価変化率' },
  { label: '時価総額',    desc: '発行済み株数 × 株価（億円単位）。会社全体の市場評価額' },
  { label: 'PER実績',     desc: '株価 ÷ 実績EPS。過去の利益ベースの割安度。低いほど割安' },
  { label: 'PER今期',     desc: '株価 ÷ 今期予想EPS。今年度の利益ベースの割安度' },
  { label: 'PER来期',     desc: '株価 ÷ 来期予想EPS。翌年度の利益ベースの割安度' },
  { label: 'PER変化',     desc: '1週・1ヶ月・3ヶ月・1年前の株価で計算したPER今期との差分（株価変化率）。−5%以下で「買い」判定' },
  { label: 'PBR',         desc: '株価 ÷ BPS（1株純資産）。1倍以下は理論上の解散価値以下で割安とみなされやすい' },
  { label: 'ROE',         desc: '自己資本利益率（純利益 ÷ 自己資本）。株主資本の効率性。一般的に10%以上が優良' },
  { label: '配当利回り',  desc: '年間配当 ÷ 株価。高いほど配当が多い。ただし株価下落で高くなることに注意' },
  { label: 'EPS成長率',   desc: '実績EPS → 今期予想EPSの成長率。プラスなら増益予想' },
  { label: 'PEG',         desc: 'PER今期 ÷ EPS成長率(%)。1倍未満が目安。成長率を考慮した割安度指標' },
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
  visible, onClose, judgmentSettings, onSettingsChange,
}: {
  visible: boolean
  onClose: () => void
  judgmentSettings: JudgmentSettings | null
  onSettingsChange: (s: JudgmentSettings) => void
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
          <span className={styles.judgmentPanelTitle}>判定ロジック設定</span>
          <button className={styles.judgmentClose} onClick={onClose}>×</button>
        </div>

        <div className={styles.judgmentLogicRow}>
          <select
            className={styles.judgmentLogicSelect}
            value={s.activeLogicId}
            onChange={e => switchLogic(e.target.value)}
          >
            {s.logics.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <button className={styles.judgmentAddBtn} onClick={addLogic} title="ロジックを追加">＋</button>
        </div>

        <div className={styles.judgmentBody}>
          <div className={styles.logicNameRow}>
            <input
              className={styles.logicNameInput}
              value={activeLogic.name}
              onChange={e => renameLogic(activeLogic.id, e.target.value)}
              placeholder="ロジック名"
            />
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
}: {
  results: DropdownResult[]
  activeIndex: number
  onSelect: (code: string) => void
  visible: boolean
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
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
