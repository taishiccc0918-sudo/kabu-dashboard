'use client'
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  DEFAULT_WATCHLIST, StockRow, FinRecord, PriceRecord, MasterRecord,
  TabKey, StatusType, ALL_GENRE_OPTIONS, DEFAULT_GENRES,
} from './lib/types'
import {
  findLatestBizDate, fetchMaster, fetchPrices, fetchFinancials, fetchAnnouncements,
} from './lib/api'
import { buildStockRow, fmtN, fmtPct, pctClass, pctBg, marketShort } from './lib/format'
import styles from './page.module.css'

function ls<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback } catch { return fallback }
}
function lsSet(key: string, val: unknown) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* quota */ }
}

export default function Page() {
  const [apiKey,     setApiKey]     = useState<string>(() => ls('apiKey', ''))
  const [watchlist,  setWatchlist]  = useState<string[]>(() => ls('watchlist', DEFAULT_WATCHLIST))
  const [memos,      setMemos]      = useState<Record<string,string>>(() => ls('memos', {}))
  const [priceDB,    setPriceDB]    = useState<Record<string, PriceRecord>>({})
  const [finDB,      setFinDB]      = useState<Record<string, FinRecord>>({})
  const [masterDB,   setMasterDB]   = useState<Record<string, MasterRecord>>({})
  const [lastUpdate, setLastUpdate] = useState<string>(() => ls('lastUpdate', ''))
  const [status,     setStatus]     = useState<StatusType>('idle')
  const [statusMsg,  setStatusMsg]  = useState('待機中 — APIキーを入力して「全更新」を押してください')
  const [progress,   setProgress]   = useState(0)
  const [tab,        setTab]        = useState<TabKey>('dashboard')
  const [filter,     setFilter]     = useState<'all'|'buy'>('all')
  const [mktFilter,  setMktFilter]  = useState<string>('all')
  const [genreFilter, setGenreFilter] = useState<string>('all')
  const [mcapMin,    setMcapMin]    = useState<string>('')
  const [perFMax,    setPerFMax]    = useState<string>('')
  const [divYMin,    setDivYMin]    = useState<string>('')
  const [showFilter, setShowFilter] = useState(false)
  const [customGenres, setCustomGenres] = useState<Record<string,string>>(() => ls('customGenres', {}))
  const [customGenreOptions, setCustomGenreOptions] = useState<string[]>(() => ls('customGenreOptions', []))
  const [removedDefaultGenres, setRemovedDefaultGenres] = useState<string[]>(() => ls('removedDefaultGenres', []))
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{code:string;name:string}[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [search,     setSearch]     = useState('')
  const [sortKey,    setSortKey]    = useState<keyof StockRow | null>(null)
  const [sortDir,    setSortDir]    = useState<1|-1>(-1)
  const [sortSel,    setSortSel]    = useState('default')
  const [detailCode, setDetailCode] = useState<string | null>(null)
  const [addCode,    setAddCode]    = useState('')
  const [loading,    setLoading]    = useState(false)
  const theadTop = 96  // header(52px) + toolbar(44px)
  const [forcePc, setForcePc] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!apiKey.trim()) { alert('APIキーを入力してください'); return }
    if (loading) return
    setLoading(true); setStatus('loading')
    const st = (msg: string, pct: number) => { setStatusMsg(msg); setProgress(pct) }
    try {
      st('最新営業日を確認中...', 5)
      const { dateStr, dateDisp } = await findLatestBizDate(apiKey)
      st('銘柄マスタを取得中...', 15)
      const master = await fetchMaster(apiKey)
      setMasterDB(master)
      st(`株価取得中 (${dateDisp})...`, 30)
      const prices = await fetchPrices(apiKey, dateStr)
      setPriceDB(prices)
      st('財務データ取得中...', 55)
      const { finDB: fins, shOutDB } = await fetchFinancials(apiKey, watchlist)
      for (const [code, sh] of Object.entries(shOutDB)) {
        if (prices[code]?.close) {
          prices[code].mcap = Math.round(prices[code].close * sh / 1e8)
        }
      }
      setPriceDB({ ...prices })
      st('決算予定日取得中...', 90)
      await fetchAnnouncements(apiKey, fins)
      setFinDB(fins)
      setLastUpdate(dateDisp)
      lsSet('lastUpdate', dateDisp)
      lsSet('apiKey', apiKey)
      st(`完了 — 基準日: ${dateDisp}`, 100)
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
  }, [apiKey, loading, watchlist])

  const allRows = useMemo(
    () => watchlist.map(code => buildStockRow(code, priceDB, finDB, masterDB, customGenres)),
    [watchlist, priceDB, finDB, masterDB, customGenres]
  )

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = allRows.filter(r => {
      if (q && !r.code.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
      if (filter === 'buy' && r.judgment !== '買い') return false
      if (mktFilter !== 'all' && marketShort(r.market).cls !== mktFilter) return false
      if (genreFilter !== 'all' && !r.genres.includes(genreFilter)) return false
      if (mcapMin !== '' && r.mcap < parseFloat(mcapMin)) return false
      if (perFMax !== '' && (r.perF == null || r.perF > parseFloat(perFMax))) return false
      if (divYMin !== '' && (r.divY == null || r.divY * 100 < parseFloat(divYMin))) return false
      return true
    })
    const sortMap: Record<string, (a: StockRow, b: StockRow) => number> = {
      price_asc:  (a,b) => a.close - b.close,
      price_desc: (a,b) => b.close - a.close,
      chg1d_desc: (a,b) => (a.chg1d??0) - (b.chg1d??0),
      chg1d_asc:  (a,b) => (b.chg1d??0) - (a.chg1d??0),
      chg3m_asc:  (a,b) => (a.chg3m??0) - (b.chg3m??0),
      chg3m_desc: (a,b) => (b.chg3m??0) - (a.chg3m??0),
      per_asc:    (a,b) => (a.perF??999) - (b.perF??999),
      per_desc:   (a,b) => (b.perF??0)   - (a.perF??0),
      mcap_desc:  (a,b) => b.mcap - a.mcap,
      div_desc:   (a,b) => (b.divY??0) - (a.divY??0),
      peg_asc:    (a,b) => (a.peg??999) - (b.peg??999),
    }
    if (sortSel !== 'default' && sortMap[sortSel]) rows = [...rows].sort(sortMap[sortSel])
    else if (sortKey) {
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
  }, [allRows, search, filter, mktFilter, genreFilter, mcapMin, perFMax, divYMin, sortKey, sortDir, sortSel])

  const stats = useMemo(() => ({
    total: allRows.length,
    up:    allRows.filter(r => (r.chg1d ?? 0) > 0).length,
    down:  allRows.filter(r => (r.chg1d ?? 0) < 0).length,
  }), [allRows])

  function handleSort(key: keyof StockRow) {
    if (sortKey === key) setSortDir(d => d === 1 ? -1 : 1)
    else { setSortKey(key); setSortDir(-1) }
    setSortSel('default')
  }

  const allGenreOptions = [...ALL_GENRE_OPTIONS.filter(g => !removedDefaultGenres.includes(g)), ...customGenreOptions]

  function addGenreOption(name: string) {
    const trimmed = name.trim()
    if (!trimmed || allGenreOptions.includes(trimmed)) return
    const next = [...customGenreOptions, trimmed]
    setCustomGenreOptions(next); lsSet('customGenreOptions', next)
  }
  function removeGenreOption(name: string) {
    if (customGenreOptions.includes(name)) {
      const next = customGenreOptions.filter(g => g !== name)
      setCustomGenreOptions(next); lsSet('customGenreOptions', next)
    } else {
      // デフォルトジャンルは「削除済み」として記録
      const next = [...removedDefaultGenres, name]
      setRemovedDefaultGenres(next); lsSet('removedDefaultGenres', next)
    }
  }
  function restoreDefaultGenres() {
    setRemovedDefaultGenres([]); lsSet('removedDefaultGenres', [])
  }

  // masterDBから銘柄検索
  function searchMaster(q: string) {
    setSearchQuery(q)
    if (!q.trim()) { setSearchResults([]); setSearchOpen(false); return }
    const lower = q.toLowerCase()
    const results = Object.entries(masterDB)
      .filter(([code, rec]) =>
        code.toLowerCase().includes(lower) ||
        rec.name.toLowerCase().includes(lower)
      )
      .slice(0, 10)
      .map(([code, rec]) => ({ code, name: rec.name }))
    setSearchResults(results)
    setSearchOpen(results.length > 0)
  }

  function addStockFromSearch(code: string) {
    if (!watchlist.includes(code)) {
      const next = [...watchlist, code]
      setWatchlist(next); lsSet('watchlist', next)
    }
    setSearchQuery(''); setSearchResults([]); setSearchOpen(false)
  }

  function saveCustomGenre(code: string, genreStr: string) {
    const next = { ...customGenres, [code]: genreStr }
    setCustomGenres(next); lsSet('customGenres', next)
  }
  function resetCustomGenre(code: string) {
    const next = { ...customGenres }
    delete next[code]
    setCustomGenres(next); lsSet('customGenres', next)
  }

  function addStock() {
    const code = addCode.trim().toUpperCase()
    if (!code) return
    if (!watchlist.includes(code)) {
      const next = [...watchlist, code]
      setWatchlist(next); lsSet('watchlist', next)
    }
    setAddCode('')
  }
  function removeStock(code: string) {
    const next = watchlist.filter(c => c !== code)
    setWatchlist(next); lsSet('watchlist', next)
  }
  function saveMemo(code: string, text: string) {
    const next = { ...memos, [code]: text }
    setMemos(next); lsSet('memos', next)
  }

  const detailRow = detailCode ? buildStockRow(detailCode, priceDB, finDB, masterDB, customGenres) : null
  const detailFin = detailCode ? finDB[detailCode] : null

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo} onClick={() => setTab('dashboard')} style={{cursor:'pointer'}}>株式<span>ウォッチ</span></div>
          <div className={styles.lastUpdate}>{lastUpdate ? <><strong>{lastUpdate}</strong></>  : '未取得'}{stats.total > 0 && <span style={{marginLeft:10,color:'var(--text3)',fontSize:11}}>&#9679; {stats.total}銘柄</span>}</div>
        </div>
        <div className={styles.headerRight}>
          <label className={styles.apiLabel}>API Key</label>
          <input
            type="password"
            className={styles.apiInput}
            placeholder="J-Quants APIキーを入力..."
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
          />
          <button className={styles.btnPrimary} onClick={fetchAll} disabled={loading}>
            {loading ? '取得中...' : '全更新'}
          </button>
          <button className={`${styles.btnSecondary} ${tab === 'watchlist' ? styles.btnSecondaryActive : ''}`} onClick={() => setTab(tab === 'watchlist' ? 'dashboard' : 'watchlist')}>銘柄管理</button>
        </div>
      </header>


      <div className={`${styles.toolbar} ${tab === 'watchlist' ? styles.toolbarHidden : ''}`} data-toolbar="">
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            className={styles.searchInput}
            placeholder="銘柄名・コード検索..."
            value={search}
            onChange={e => setSearch(e.target.value)}
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
        <select className={styles.sortSelect} value={sortSel} onChange={e => setSortSel(e.target.value)}>
          <option value="default">並び順: デフォルト</option>
          <option value="chg1d_desc">前日比 ↓</option>
          <option value="chg1d_asc">前日比 ↑</option>
          <option value="chg3m_asc">3ヶ月比 ↑</option>
          <option value="chg3m_desc">3ヶ月比 ↓</option>
          <option value="per_asc">PER今期 ↑</option>
          <option value="per_desc">PER今期 ↓</option>
          <option value="mcap_desc">時価総額 ↓</option>
          <option value="div_desc">配当利回り ↓</option>
          <option value="peg_asc">PEG ↑</option>
        </select>
        <div className={styles.spacer} />
        <button className={styles.pcToggleBtn} onClick={() => setForcePc(f => !f)}>
          {forcePc ? '📱 最適化' : '🖥 PC表示'}
        </button>
        <button
          className={`${styles.filterToggleBtn} ${showFilter ? styles.filterToggleBtnActive : ''}`}
          onClick={() => setShowFilter(s => !s)}
        >
          ▼ 絞り込み{(mcapMin||perFMax||divYMin||genreFilter!=='all') ? ' ●' : ''}
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
                {['all','防衛','宇宙','半導体','造船','IP','スポーツ','保険','銀行','素材','化学','機械','IT','サービス','小売','エネルギー','自動車','その他'].map(g => (
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
            <div className={styles.filterPanelGroup}>
              <label className={styles.filterPanelLabel}>配当利回り（%）以上</label>
              <input type="number" className={styles.filterPanelInput} placeholder="例: 2"
                value={divYMin} onChange={e => setDivYMin(e.target.value)} />
            </div>
          </div>
          <button className={styles.filterPanelClear}
            onClick={() => { setMcapMin(''); setPerFMax(''); setDivYMin(''); setGenreFilter('all') }}>
            条件をクリア
          </button>
        </div>
      )}
      <main className={styles.main}>
        {tab === 'dashboard' && (
          <>
            {/* PC: フルテーブル */}
            <div className={forcePc ? styles.forcePcOn : styles.pcOnly}>
              <DashboardTable
                filteredRows={filteredRows}
                sortKey={sortKey}
                sortDir={sortDir}
                handleSort={handleSort}
                onRowClick={(code) => setDetailCode(code)}
              />
            </div>
            {/* スマホ: コンパクトリスト */}
            <div className={forcePc ? styles.forceMobileOff : styles.mobileOnly}>
              <div className={styles.mobileList}>
                {filteredRows.length === 0
                  ? <div className={styles.emptyCell}>該当銘柄なし</div>
                  : filteredRows.map(r => (
                    <MobileRow key={r.code} row={r} onClick={() => setDetailCode(r.code)} />
                  ))
                }
              </div>
            </div>
          </>
        )}

        {tab === 'card' && (
          <div className={styles.cardGrid}>
            {filteredRows.map(r => (
              <StockCard key={r.code} row={r} apiKey={apiKey} onClick={() => setDetailCode(r.code)} />
            ))}
          </div>
        )}

        {tab === 'watchlist' && (
          <div className={styles.wlManager}>
            {/* ── ヘッダー ── */}
            <div className={styles.wlHeader}>
              <div className={styles.wlTitle}>銘柄管理 <span className={styles.wlCount}>{watchlist.length}銘柄</span></div>
              <div style={{display:'flex', gap:8}}>
                <button className={styles.btnSecondary} onClick={() => {
                  navigator.clipboard.writeText(watchlist.join(','))
                    .then(() => alert('コピーしました'))
                }}>エクスポート</button>
                <button className={styles.btnSecondary} onClick={() => {
                  const text = prompt('銘柄コードをカンマ区切りで入力:')
                  if (!text) return
                  const codes = text.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
                  const next = Array.from(new Set([...watchlist, ...codes]))
                  setWatchlist(next); lsSet('watchlist', next)
                }}>インポート</button>
              </div>
            </div>

            {/* ── ジャンル管理 ── */}
            <div className={styles.wlGenreBar}>
              <span className={styles.wlGenreLabel}>ジャンル:</span>
              {allGenreOptions.map(g => (
                <span key={g} className={styles.genreBadgeEditable}>
                  {g}
                  <button className={styles.genreRemoveBtn} onClick={() => removeGenreOption(g)} title="削除">×</button>
                </span>
              ))}
              <AddGenreInput onAdd={addGenreOption} />
              {removedDefaultGenres.length > 0 && (
                <button className={styles.genreRestoreBtn} onClick={restoreDefaultGenres}>
                  ↩ デフォルト復元
                </button>
              )}
            </div>

            {/* ── 銘柄検索・追加 ── */}
            <div className={styles.wlSearchRow}>
              <div className={styles.wlSearchWrap}>
                <input
                  className={styles.wlSearchInput}
                  placeholder="銘柄名またはコードで検索して追加..."
                  value={searchQuery}
                  onChange={e => searchMaster(e.target.value)}
                  onFocus={() => searchQuery && setSearchOpen(true)}
                  onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                />
                {searchOpen && searchResults.length > 0 && (
                  <div className={styles.searchDropdown}>
                    {searchResults.map(r => (
                      <div
                        key={r.code}
                        className={styles.searchDropdownItem}
                        onMouseDown={() => addStockFromSearch(r.code)}
                      >
                        <span className={styles.searchItemCode}>{r.code}</span>
                        <span className={styles.searchItemName}>{r.name}</span>
                        {watchlist.includes(r.code) && <span className={styles.searchItemAdded}>登録済</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── 銘柄テーブル ── */}
            <table className={styles.wlTableInner}>
                <thead>
                  <tr>
                    <th className={styles.wlTh} style={{width:70, top:52}}>コード</th>
                    <th className={styles.wlTh} style={{top:52}}>銘柄名</th>
                    <th className={styles.wlTh} style={{width:'auto', top:52}}>ジャンル（複数選択可）</th>
                    <th className={styles.wlTh} style={{width:50, top:52}}></th>
                  </tr>
                </thead>
                <tbody>
                  {watchlist.map(code => (
                    <WatchlistRow
                      key={code} code={code}
                      name={masterDB[code]?.name ?? ''}
                      currentGenre={customGenres[code] ?? DEFAULT_GENRES[code] ?? 'その他'}
                      allGenreOptions={allGenreOptions}
                      customGenreOptions={customGenreOptions}
                      onSave={saveCustomGenre}
                      onReset={resetCustomGenre}
                      onRemove={removeStock}
                      onAddGenre={addGenreOption}
                    />
                  ))}
                </tbody>
            </table>
          </div>
        )}
      </main>

      {detailCode && detailRow && (
        <div className={styles.detailOverlay} onClick={e => { if (e.target === e.currentTarget) setDetailCode(null) }}>
          <div className={styles.detailPanel}>
            <button className={styles.detailClose} onClick={() => setDetailCode(null)}>×</button>
            <DetailPanel
              row={detailRow}
              fin={detailFin}
              memo={memos[detailCode] ?? ''}
              onSaveMemo={text => saveMemo(detailCode, text)}
              apiKey={apiKey}
            />
          </div>
        </div>
      )}

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

// ─── MiniChart ───────────────────────────────────────────────────────
type ChartMode = 'daily' | 'monthly'

function MiniChart({ code, apiKey }: { code: string; apiKey: string }) {
  const [mode, setMode] = useState<ChartMode>('daily')
  const [chartData, setChartData] = useState<number[]>([])
  const [chartLoading, setChartLoading] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!apiKey || !code) return
    setChartLoading(true)
    const today = new Date()
    const fmt = (d: Date) => d.toISOString().slice(0,10).replace(/-/g,'')

    let from: Date
    if (mode === 'daily') {
      from = new Date(today); from.setMonth(from.getMonth() - 6)
    } else {
      from = new Date(today); from.setFullYear(from.getFullYear() - 5)
    }

    const url = `/api/jquants?path=/v2/equities/bars/daily&code=${code}&dateFrom=${fmt(from)}&dateTo=${fmt(today)}`
    fetch(url, { headers: { 'x-api-key': apiKey } })
      .then(r => r.json())
      .then(json => {
        const data = json?.data ?? []
        if (mode === 'daily') {
          setChartData(data.map((d: Record<string,number>) => d.AdjC ?? d.C ?? 0))
        } else {
          // 月足: 月末終値のみ抽出
          const monthly: Record<string, number> = {}
          for (const d of data) {
            const mon = (d.Date as string)?.slice(0,7) ?? ''
            if (mon) monthly[mon] = d.AdjC ?? d.C ?? 0
          }
          setChartData(Object.values(monthly))
        }
      })
      .catch(() => setChartData([]))
      .finally(() => setChartLoading(false))
  }, [code, apiKey, mode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || chartData.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.offsetWidth || 280
    const h = 120
    canvas.width = w
    canvas.height = h

    const min = Math.min(...chartData)
    const max = Math.max(...chartData)
    const range = max - min || 1

    const isUp = chartData[chartData.length - 1] >= chartData[0]
    const color = isUp ? '#34d399' : '#f87171'

    ctx.clearRect(0, 0, w, h)

    // グラデーション塗りつぶし
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, isUp ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')

    ctx.beginPath()
    chartData.forEach((v, i) => {
      const x = (i / (chartData.length - 1)) * w
      const y = h - ((v - min) / range) * (h - 12) - 6
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()

    // ライン
    ctx.beginPath()
    chartData.forEach((v, i) => {
      const x = (i / (chartData.length - 1)) * w
      const y = h - ((v - min) / range) * (h - 12) - 6
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.stroke()
  }, [chartData])

  return (
    <div className={styles.chartArea}>
      <div className={styles.chartTabs}>
        {(['daily','monthly'] as ChartMode[]).map(m => (
          <button
            key={m}
            className={`${styles.chartTab} ${mode === m ? styles.chartTabActive : ''}`}
            onClick={e => { e.stopPropagation(); setMode(m) }}
          >
            {m === 'daily' ? '日足(6ヶ月)' : '月足(5年)'}
          </button>
        ))}
      </div>
      {chartLoading ? (
        <div className={styles.chartLoading}>読込中...</div>
      ) : chartData.length < 2 ? (
        <div className={styles.chartLoading}>データなし</div>
      ) : (
        <canvas ref={canvasRef} className={styles.chartCanvas} />
      )}
    </div>
  )
}


// ─── DashboardTable ──────────────────────────────────────────────────
// theadとtbodyを別コンテナに分離し、横スクロールをJS同期することで
// 縦スクロール時のheader固定と横スクロールを両立する
function DashboardTable({
  filteredRows, sortKey, sortDir, handleSort, onRowClick
}: {
  filteredRows: StockRow[]
  sortKey: keyof StockRow | null
  sortDir: 1 | -1
  handleSort: (k: keyof StockRow) => void
  onRowClick: (code: string) => void
}) {
  const headRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 横スクロール同期
  const onBodyScroll = () => {
    if (headRef.current && bodyRef.current)
      headRef.current.scrollLeft = bodyRef.current.scrollLeft
  }

  const SortArrow = ({ k }: { k: keyof StockRow }) => (
    <span className={`${styles.sortArrow} ${sortKey===k ? styles.sorted : ''}`}>↕</span>
  )

  const cols: { label: string; cls: string; key: keyof StockRow | null; group: string; width?: number; tooltip?: string }[] = [
    { label: '', cls: styles.thLeft, key: null, width: 32, group: '' },
    { label: 'コード', cls: `${styles.thLeft} ${styles.stickyCol0}`, key: 'code' as keyof StockRow, group: '' },
    { label: '銘柄名', cls: `${styles.thLeft} ${styles.stickyCol1}`, key: 'name' as keyof StockRow, group: '' },
    { label: 'ジャンル', cls: styles.thLeft, key: 'genre' as keyof StockRow, group: '' },
    { label: '市場', cls: styles.thLeft, key: 'market' as keyof StockRow, group: '' },
    { label: '時価総額(億)', cls: styles.thRight, key: 'mcap' as keyof StockRow, group: '' },
    { label: '株価',    cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'close' as keyof StockRow, group: 'price' },
    { label: '前日比%', cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1d' as keyof StockRow, group: 'price' },
    { label: '1週間%',  cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1w' as keyof StockRow, group: 'price' },
    { label: '3ヶ月%',  cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg3m' as keyof StockRow, group: 'price' },
    { label: '1年%',    cls: `${styles.thRight} ${styles.thPriceGroup}`, key: 'chg1y' as keyof StockRow, group: 'price' },
    { label: 'PER実績',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perA' as keyof StockRow, group: 'per' },
    { label: 'PER今期',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perF' as keyof StockRow, group: 'per' },
    { label: 'PER来期',    cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perN' as keyof StockRow, group: 'per' },
    { label: 'PER今期の1ヶ月前成長率', cls: `${styles.thRight} ${styles.thPerGroup}`, key: 'perFChg1m' as keyof StockRow, group: 'per', tooltip: '1ヶ月前のPER今期と現在のPER今期の比較。セルにホバーすると詳細表示' },
    { label: 'PBR',        cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'pbr' as keyof StockRow, group: 'other' },
    { label: 'ROE',        cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'roe' as keyof StockRow, group: 'other' },
    { label: '配当利回り', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'divY' as keyof StockRow, group: 'other' },
    { label: 'EPS成長率',  cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'epsGr' as keyof StockRow, group: 'other' },
    { label: 'PEG',        cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'peg' as keyof StockRow, group: 'other' },
    { label: '営業利益率', cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'opMgn' as keyof StockRow, group: 'other' },
    { label: '来期売上成長',cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'nySalesGr' as keyof StockRow, group: 'other' },
    { label: '判定',       cls: `${styles.thRight} ${styles.thOtherGroup}`, key: 'judgment' as keyof StockRow, group: 'other' },
    { label: '四季報',     cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
    { label: 'YF',         cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
    { label: 'かぶたん',   cls: `${styles.thRight} ${styles.thInfoGroup}`, key: null, group: 'info' },
  ]

  return (
    <div className={styles.dashWrap}>
      {/* 固定ヘッダー行 */}
      <div className={styles.theadOuter} ref={headRef}>
        <table className={`${styles.table} ${styles.theadTable}`}>
            <colgroup>
              <col style={{width:32, minWidth:32}} />
              <col style={{width:60, minWidth:60}} />
              <col style={{width:150, minWidth:150}} />
              <col style={{width:80, minWidth:80}} />
              <col style={{width:72, minWidth:72}} />
              <col style={{width:100, minWidth:100}} />
              <col style={{width:80, minWidth:80}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:130, minWidth:130}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:88, minWidth:88}} />
              <col style={{width:88, minWidth:88}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:88, minWidth:88}} />
              <col style={{width:100, minWidth:100}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:72, minWidth:72}} />
              <col style={{width:60, minWidth:60}} />
              <col style={{width:80, minWidth:80}} />
            </colgroup>
          <thead>
            <tr>
              {cols.map((col, i) => (
                <th
                  key={i}
                  className={`${col.cls} ${col.key ? styles.thSort : ''} ${(col as {tooltip?:string}).tooltip ? styles.thTooltip : ''}`}
                  style={col.width ? {width: col.width, minWidth: col.width} : undefined}
                  onClick={col.key ? () => handleSort(col.key!) : undefined}
                  title={(col as {tooltip?:string}).tooltip}
                >
                  {col.label}{(col as {tooltip?:string}).tooltip && <span className={styles.tooltipIcon}>?</span>}{col.key && <SortArrow k={col.key} />}
                </th>
              ))}
            </tr>
          </thead>
        </table>
      </div>
      {/* スクロールするボディ */}
      <div className={styles.tbodyOuter} ref={bodyRef} onScroll={onBodyScroll}>
        <table className={styles.table}>
            <colgroup>
              <col style={{width:32, minWidth:32}} />
              <col style={{width:60, minWidth:60}} />
              <col style={{width:150, minWidth:150}} />
              <col style={{width:80, minWidth:80}} />
              <col style={{width:72, minWidth:72}} />
              <col style={{width:100, minWidth:100}} />
              <col style={{width:80, minWidth:80}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:76, minWidth:76}} />
              <col style={{width:130, minWidth:130}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:88, minWidth:88}} />
              <col style={{width:88, minWidth:88}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:88, minWidth:88}} />
              <col style={{width:100, minWidth:100}} />
              <col style={{width:64, minWidth:64}} />
              <col style={{width:72, minWidth:72}} />
              <col style={{width:60, minWidth:60}} />
              <col style={{width:80, minWidth:80}} />
            </colgroup>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr><td colSpan={24} className={styles.emptyCell}>該当銘柄なし</td></tr>
            ) : filteredRows.map((r, i) => (
              <TableRow key={r.code} row={r} idx={i} onClick={() => onRowClick(r.code)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── TableRow ────────────────────────────────────────────────────────
function TableRow({ row: r, idx, onClick }: { row: StockRow; idx: number; onClick: () => void }) {
  const stickyBg = idx % 2 === 0 ? '#0d1219' : 'rgba(17,24,37,0.9)'
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onClick}>
      <td className={styles.tdStar} style={{background: stickyBg}}>★</td>
      <td className={`${styles.tdCode} ${styles.stickyCol0}`} style={{background: stickyBg}}>{r.code}</td>
      <td className={`${styles.tdName} ${styles.stickyCol1}`} style={{background: stickyBg}}>{r.name || '—'}</td>
      <td className={styles.tdGenres}>{r.genres.map(g => <span key={g} className={styles.genreBadge}>{g}</span>)}</td>
      <td><span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span></td>
      <td className={styles.tdNum}>{r.mcap ? r.mcap.toLocaleString() : '—'}</td>
      <td className={styles.tdNum}>{r.close ? r.close.toLocaleString() : '—'}</td>
      {[r.chg1d, r.chg1w, r.chg3m, r.chg1y].map((v, i) => (
        <td key={i} className={`${styles.tdPct} ${styles[pctClass(v)]}`}
          style={{ background: pctBg(v) }}>{fmtPct(v)}</td>
      ))}
      <td className={`${styles.tdNum} ${styles.tdPerGroup}`}>{r.perA ? fmtN(r.perA) : '—'}</td>
      <td className={`${styles.tdNum} ${styles.tdPerGroup}`}>{r.perF ? fmtN(r.perF) : '—'}</td>
      <td className={`${styles.tdNum} ${styles.tdPerGroup}`}>{r.perN ? fmtN(r.perN) : '—'}</td>
      <td className={`${styles.tdPct} ${styles[pctClass(r.perFChg1m)]} ${styles.tdPerGroup} ${styles.hasTooltip}`}
        style={{background: pctBg(r.perFChg1m)}}
        title={r.perFChg1mPrev && r.perF ? `1M前: ${fmtN(r.perFChg1mPrev)}倍 → 現在: ${fmtN(r.perF)}倍 ／ 差: ${(r.perF - r.perFChg1mPrev).toFixed(1)}倍 ／ 比: ${fmtPct(r.perFChg1m)}` : undefined}
      >{fmtPct(r.perFChg1m)}</td>
      <td className={styles.tdNum}>{r.pbr  ? fmtN(r.pbr)  : '—'}</td>
      <td className={`${styles.tdNum} ${r.roe && r.roe > 0.1 ? styles.up : ''}`}>{r.roe ? fmtPct(r.roe) : '—'}</td>
      <td className={`${styles.tdNum} ${r.divY && r.divY > 0.03 ? styles.up : ''}`}>{r.divY ? fmtPct(r.divY) : '—'}</td>
      <td className={`${styles.tdPct} ${styles[pctClass(r.epsGr)]}`}>{r.epsGr !== null ? fmtPct(r.epsGr) : '—'}</td>
      <td className={`${styles.tdNum} ${r.peg && r.peg < 1 ? styles.up : ''}`}>{r.peg ? fmtN(r.peg, 2) : '—'}</td>
      <td className={`${styles.tdNum} ${r.opMgn && r.opMgn > 0.15 ? styles.up : ''}`}>{r.opMgn ? fmtPct(r.opMgn) : '—'}</td>
      <td className={`${styles.tdPct} ${styles[pctClass(r.nySalesGr)]}`}>{r.nySalesGr !== null ? fmtPct(r.nySalesGr) : '—'}</td>

      <td><JudgmentBadge j={r.judgment} /></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>四季報</a></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://finance.yahoo.co.jp/quote/${r.code}.T`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>YF</a></td>
      <td className={styles.tdInfoLink} onClick={e => e.stopPropagation()}><a href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank" rel="noopener noreferrer" className={styles.infoLinkBtn}>かぶたん</a></td>
    </tr>
  )
}


// ─── MobileRow (スマホ専用コンパクトリスト) ──────────────────────────
function MobileRow({ row: r, onClick }: { row: StockRow; onClick: () => void }) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <div className={styles.mobileRow} onClick={onClick}>
      <div className={styles.mobileRowLeft}>
        <div className={styles.mobileRowTop}>
          <span className={styles.mobileCode}>{r.code}</span>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
          <JudgmentBadge j={r.judgment} />
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

// ─── StockCard (チャート付き) ─────────────────────────────────────────
function StockCard({ row: r, apiKey, onClick }: { row: StockRow; apiKey: string; onClick: () => void }) {
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  const [showChart, setShowChart] = useState(false)

  return (
    <div className={styles.card} onClick={onClick}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.cardCode}>{r.code}</div>
          <div className={styles.cardName}>{r.name || '—'}</div>
          <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        </div>
        <div className={styles.cardRight}>
          <JudgmentBadge j={r.judgment} />
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
    </div>
  )
}


// ─── InlineGenreAdd ─────────────────────────────────────────────────
function InlineGenreAdd({ onAdd }: { onAdd: (name: string) => void }) {
  const [val, setVal] = useState('')
  const [open, setOpen] = useState(false)
  if (!open) return (
    <button className={styles.genreTag} style={{borderStyle:'dashed'}} onClick={() => setOpen(true)}>
      ＋ 新規
    </button>
  )
  return (
    <span style={{display:'inline-flex', gap:3, alignItems:'center'}}>
      <input
        autoFocus
        className={styles.genreNewInput}
        placeholder="ジャンル名..."
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && val.trim()) { onAdd(val.trim()); setVal(''); setOpen(false) }
          if (e.key === 'Escape') { setVal(''); setOpen(false) }
        }}
        maxLength={10}
        style={{width:80}}
      />
      <button className={styles.genreAddBtn}
        onClick={() => { if (val.trim()) { onAdd(val.trim()); setVal(''); setOpen(false) } }}>追加</button>
      <button className={styles.genreResetBtn} onClick={() => { setVal(''); setOpen(false) }}>✕</button>
    </span>
  )
}

// ─── AddGenreInput ──────────────────────────────────────────────────
function AddGenreInput({ onAdd }: { onAdd: (name: string) => void }) {
  const [val, setVal] = useState('')
  return (
    <span style={{display:'inline-flex', gap:4, alignItems:'center'}}>
      <input
        className={styles.genreNewInput}
        placeholder="新ジャンル名..."
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && val.trim()) { onAdd(val); setVal('') } }}
        maxLength={10}
      />
      <button className={styles.genreAddBtn}
        onClick={() => { if (val.trim()) { onAdd(val); setVal('') } }}>+追加</button>
    </span>
  )
}

// ─── WatchlistRow ────────────────────────────────────────────────────
function WatchlistRow({ code, name, currentGenre, allGenreOptions, customGenreOptions, onSave, onReset, onRemove, onAddGenre }: {
  code: string
  name: string
  currentGenre: string
  allGenreOptions: string[]
  customGenreOptions: string[]
  onSave: (code: string, genre: string) => void
  onReset: (code: string) => void
  onRemove: (code: string) => void
  onAddGenre: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const selected = currentGenre.split(',').map(g => g.trim()).filter(Boolean)
  const isModified = currentGenre !== (DEFAULT_GENRES[code] ?? 'その他')

  function toggle(tag: string) {
    const next = selected.includes(tag)
      ? selected.filter(g => g !== tag)
      : [...selected, tag]
    onSave(code, next.join(',') || 'その他')
  }

  return (
    <>
      <tr className={styles.wlTr}>
        <td className={styles.wlTd}>
          <span className={styles.wlChipCode}>{code}</span>
        </td>
        <td className={styles.wlTd}>
          <span className={styles.wlTdName}>{name || '—'}</span>
        </td>
        <td className={styles.wlTd}>
          <div className={styles.wlGenreCell}>
            {/* 選択済みタグを表示 */}
            {selected.map(g => (
              <span key={g} className={`${styles.genreTag} ${styles.genreTagOn}`}>{g}</span>
            ))}
            {/* 編集ボタン */}
            <button
              className={`${styles.genreEditToggleBtn} ${editing ? styles.genreEditToggleBtnOn : ''}`}
              onClick={() => setEditing(e => !e)}
            >{editing ? '▲ 閉じる' : '✏️ 編集'}</button>

          </div>
        </td>
        <td className={styles.wlTd} style={{textAlign:'center'}}>
          <button className={styles.wlRemoveBtn} onClick={() => onRemove(code)}>✕</button>
        </td>
      </tr>
      {editing && (
        <tr className={styles.wlEditRow}>
          <td colSpan={4} className={styles.wlEditTd}>
            <div className={styles.wlGenreEditPanel}>
              {allGenreOptions.map(g => (
                <button key={g}
                  className={`${styles.genreTag} ${selected.includes(g) ? styles.genreTagOn : ''}`}
                  onClick={() => toggle(g)}
                >{g}</button>
              ))}
              <InlineGenreAdd onAdd={(name) => {
                onAddGenre(name)
                toggle(name)
              }} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function JudgmentBadge({ j }: { j: string }) {
  if (j === '買い') return <span className={`${styles.jBadge} ${styles.jBuy}`}>買い</span>
  return <span className={`${styles.jBadge} ${styles.jNone}`}>—</span>
}

function DetailPanel({
  row: r, fin: f, memo, onSaveMemo, apiKey,
}: {
  row: StockRow
  fin: FinRecord | null | undefined
  memo: string
  onSaveMemo: (t: string) => void
  apiKey: string
}) {
  const [localMemo, setLocalMemo] = useState(memo)
  const [saved, setSaved] = useState(false)
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)

  function save() {
    onSaveMemo(localMemo)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <>
      <div className={styles.detailCode}>{r.code}</div>
      <div className={styles.detailName}>{r.name || '—'}</div>
      <div className={styles.detailBadgeRow}>
        <span className={`${styles.mktBadge} ${styles['mkt_' + mktCls]}`}>{mktLabel}</span>
        <JudgmentBadge j={r.judgment} />
      </div>
      <div className={`${styles.detailPrice} ${styles[pctClass(r.chg1d)]}`}>
        {r.close ? r.close.toLocaleString() : '—'}
      </div>
      <div className={styles.detailSubPrice}>
        前日比: <span className={styles[pctClass(r.chg1d)]}>{fmtPct(r.chg1d)}</span>
      </div>

      <Section title="チャート">
        <MiniChart code={r.code} apiKey={apiKey} />
      </Section>

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
        <textarea
          className={styles.detailMemo}
          value={localMemo}
          onChange={e => setLocalMemo(e.target.value)}
          placeholder="メモを入力..."
        />
        <button
          className={styles.btnPrimary}
          style={{ width: '100%', marginTop: 8, ...(saved ? { background: '#34d399' } : {}) }}
          onClick={save}
        >
          {saved ? '保存しました ✓' : 'メモを保存'}
        </button>
      </Section>

      <Section title="リンク">
        <div className={styles.detailLinks}>
          <a className={styles.detailLinkBtn} href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank">四季報オンライン</a>
          <a className={styles.detailLinkBtn} href={`https://irbank.net/${r.code}`} target="_blank">IRBank</a>
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
