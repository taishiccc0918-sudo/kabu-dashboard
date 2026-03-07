'use client'
import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import {
  DEFAULT_WATCHLIST, StockRow, FinRecord, PriceRecord, MasterRecord,
  TabKey, StatusType,
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
  const [filter,     setFilter]     = useState<'all'|'buy'|'up'|'down'>('all')
  const [search,     setSearch]     = useState('')
  const [sortKey,    setSortKey]    = useState<keyof StockRow | null>(null)
  const [sortDir,    setSortDir]    = useState<1|-1>(-1)
  const [sortSel,    setSortSel]    = useState('default')
  const [detailCode, setDetailCode] = useState<string | null>(null)
  const [addCode,    setAddCode]    = useState('')
  const [loading,    setLoading]    = useState(false)

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
    () => watchlist.map(code => buildStockRow(code, priceDB, finDB, masterDB)),
    [watchlist, priceDB, finDB, masterDB]
  )

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = allRows.filter(r => {
      if (q && !r.code.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
      if (filter === 'buy')   return r.judgment === '買い'
      if (filter === 'up')    return (r.chg1d ?? 0) > 0
      if (filter === 'down')  return (r.chg1d ?? 0) < 0
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
        const av = (a[sortKey] as number) ?? (sortDir > 0 ? Infinity : -Infinity)
        const bv = (b[sortKey] as number) ?? (sortDir > 0 ? Infinity : -Infinity)
        return (av - bv) * sortDir
      })
    }
    return rows
  }, [allRows, search, filter, sortKey, sortDir, sortSel])

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

  const detailRow = detailCode ? buildStockRow(detailCode, priceDB, finDB, masterDB) : null
  const detailFin = detailCode ? finDB[detailCode] : null

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo} onClick={() => setTab('dashboard')} style={{cursor:'pointer'}}>株式<span>ウォッチ</span></div>
          <div className={styles.lastUpdate}>{lastUpdate ? `基準日: ${lastUpdate}` : '未取得'}{stats.total > 0 && <span style={{marginLeft:12,color:'#60a5fa',fontSize:13,fontWeight:600}}>お気に入り {stats.total}銘柄</span>}</div>
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
          <button className={styles.btnSecondary} onClick={() => setTab('watchlist')}>銘柄管理</button>
        </div>
      </header>


      <div className={styles.toolbar}>
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
          {(['all','buy','up','down'] as ('all'|'buy'|'up'|'down')[]).map(f => (
            <button
              key={f}
              className={`${styles.filterBtn} ${filter === f ? styles.filterBtnActive : ''}`}
              onClick={() => setFilter(f)}
            >
              {{ all:'全て', buy:'買い', up:'上昇', down:'下落' }[f]}
            </button>
          ))}
        </div>
        <select className={styles.sortSelect} value={sortSel} onChange={e => setSortSel(e.target.value)}>
          <option value="default">並び順: デフォルト</option>
          <option value="price_asc">株価 ↑</option>
          <option value="price_desc">株価 ↓</option>
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

      <main className={styles.main}>
        {tab === 'dashboard' && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                {/* グループ行 */}
                <tr>
                  <th colSpan={5} style={{background:'#0f1520',borderBottom:'1px solid #2a3342'}}></th>
                  <th colSpan={5} style={{background:'rgba(30,107,77,0.15)',borderBottom:'2px solid #1e6b4d',textAlign:'center',fontSize:10,color:'#4ade80',letterSpacing:2}}>── 株価 ──</th>
                  <th colSpan={4} style={{background:'rgba(30,77,107,0.15)',borderBottom:'2px solid #1e4d6b',textAlign:'center',fontSize:10,color:'#60a5fa',letterSpacing:2}}>── PER ──</th>
                  <th colSpan={8} style={{background:'rgba(107,77,30,0.15)',borderBottom:'2px solid #6b4d1e',textAlign:'center',fontSize:10,color:'#fbbf24',letterSpacing:2}}>── 他指標 ──</th>
                </tr>
                {/* カラム行 */}
                <tr>
                  <th className={styles.thLeft} style={{width:28}}></th>
                  {([['code','コード'],['name','銘柄名']] as [keyof StockRow, string][]).map(([k,l],i) => (
                    <th key={k} className={`${styles.thLeft} ${styles.thSort} ${i===0?styles.stickyCol0:styles.stickyCol1}`} onClick={() => handleSort(k)}>
                      {l}<span className={`${styles.sortArrow} ${sortKey===k?styles.sorted:''}`}>↕</span>
                    </th>
                  ))}
                  <th className={styles.thLeft}>市場</th>
                  <th className={`${styles.thRight} ${styles.thSort}`} onClick={() => handleSort('mcap')}>
                    時価総額(億)<span className={`${styles.sortArrow} ${sortKey==='mcap'?styles.sorted:''}`}>↕</span>
                  </th>
                  {([
                    ['close','株価'],['chg1d','前日比%'],['chg1w','1週間%'],
                    ['chg3m','3ヶ月%'],['chg1y','1年%'],
                  ] as [keyof StockRow, string][]).map(([k,l]) => (
                    <th key={k} className={`${styles.thRight} ${styles.thSort} ${styles.thPriceGroup}`} onClick={() => handleSort(k)}>
                      {l}<span className={`${styles.sortArrow} ${sortKey===k?styles.sorted:''}`}>↕</span>
                    </th>
                  ))}
                  {([
                    ['perA','PER実績'],['perF','PER今期'],['perN','PER来期'],['perFChg1m','PER今期(1M)'],
                  ] as [keyof StockRow, string][]).map(([k,l]) => (
                    <th key={k} className={`${styles.thRight} ${styles.thSort} ${styles.thPerGroup}`} onClick={() => handleSort(k)}>
                      {l}<span className={`${styles.sortArrow} ${sortKey===k?styles.sorted:''}`}>↕</span>
                    </th>
                  ))}
                  {([
                    ['pbr','PBR'],['roe','ROE'],['divY','配当利回り'],
                    ['epsGr','EPS成長率'],['peg','PEG'],['nySalesGr','来期売上成長'],
                  ] as [keyof StockRow, string][]).map(([k,l]) => (
                    <th key={k} className={`${styles.thRight} ${styles.thSort} ${styles.thOtherGroup}`} onClick={() => handleSort(k)}>
                      {l}<span className={`${styles.sortArrow} ${sortKey===k?styles.sorted:''}`}>↕</span>
                    </th>
                  ))}
                  <th className={`${styles.thRight} ${styles.thOtherGroup}`}>判定</th>
                  <th className={`${styles.thRight} ${styles.thOtherGroup}`}>四季報</th>
                  <th className={`${styles.thRight} ${styles.thOtherGroup}`}>YF</th>
                  <th className={`${styles.thRight} ${styles.thOtherGroup}`}>かぶたん</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr><td colSpan={21} className={styles.emptyCell}>該当銘柄なし</td></tr>
                ) : filteredRows.map((r, i) => (
                  <TableRow key={r.code} row={r} idx={i} onClick={() => setDetailCode(r.code)} />
                ))}
              </tbody>
            </table>
          </div>
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
            <div className={styles.wlTitle}>銘柄管理</div>
            <div className={styles.wlAddRow}>
              <input
                className={styles.wlInput}
                placeholder="証券コード (例: 7203)"
                value={addCode}
                onChange={e => setAddCode(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addStock()}
                maxLength={5}
              />
              <button className={styles.btnPrimary} onClick={addStock}>追加</button>
              <button className={styles.btnSecondary} onClick={() => {
                navigator.clipboard.writeText(watchlist.join(','))
                  .then(() => alert('クリップボードにコピーしました'))
              }}>エクスポート</button>
              <button className={styles.btnSecondary} onClick={() => {
                const text = prompt('銘柄コードをカンマ区切りで入力:')
                if (!text) return
                const codes = text.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
                const next = Array.from(new Set([...watchlist, ...codes]))
                setWatchlist(next); lsSet('watchlist', next)
              }}>インポート</button>
            </div>
            <div className={styles.wlCount}>{watchlist.length}銘柄登録中</div>
            <div className={styles.wlChips}>
              {watchlist.map(code => (
                <div key={code} className={styles.wlChip}>
                  <span className={styles.wlChipCode}>{code}</span>
                  <span className={styles.wlChipName}>{masterDB[code]?.name ?? ''}</span>
                  <span className={styles.wlChipRemove} onClick={() => removeStock(code)}>×</span>
                </div>
              ))}
            </div>
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

// ─── TableRow ────────────────────────────────────────────────────────
function TableRow({ row: r, idx, onClick }: { row: StockRow; idx: number; onClick: () => void }) {
  const stickyBg = idx % 2 === 0 ? '#0d1117' : 'rgba(20,28,42,0.9)'
  const { label: mktLabel, cls: mktCls } = marketShort(r.market)
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onClick}>
      <td className={styles.tdStar} style={{background: stickyBg}}>★</td>
      <td className={`${styles.tdCode} ${styles.stickyCol0}`} style={{background: stickyBg}}>{r.code}</td>
      <td className={`${styles.tdName} ${styles.stickyCol1}`} style={{background: stickyBg}}>{r.name || '—'}</td>
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
      <td className={`${styles.tdPct} ${styles[pctClass(r.perFChg1m)]} ${styles.tdPerGroup}`}
        style={{background: pctBg(r.perFChg1m)}}>{fmtPct(r.perFChg1m)}</td>
      <td className={styles.tdNum}>{r.pbr  ? fmtN(r.pbr)  : '—'}</td>
      <td className={`${styles.tdNum} ${r.roe && r.roe > 0.1 ? styles.up : ''}`}>{r.roe ? fmtPct(r.roe) : '—'}</td>
      <td className={`${styles.tdNum} ${r.divY && r.divY > 0.03 ? styles.up : ''}`}>{r.divY ? fmtPct(r.divY) : '—'}</td>
      <td className={`${styles.tdPct} ${styles[pctClass(r.epsGr)]}`}>{r.epsGr !== null ? fmtPct(r.epsGr) : '—'}</td>
      <td className={`${styles.tdNum} ${r.peg && r.peg < 1 ? styles.up : ''}`}>{r.peg ? fmtN(r.peg, 2) : '—'}</td>
      <td className={`${styles.tdPct} ${styles[pctClass(r.nySalesGr)]}`}>{r.nySalesGr !== null ? fmtPct(r.nySalesGr) : '—'}</td>

      <td><JudgmentBadge j={r.judgment} /></td>
      <td className={styles.tdLink} onClick={e => e.stopPropagation()}><a href={`https://shikiho.toyokeizai.net/stocks/${r.code}`} target="_blank" rel="noopener noreferrer">→</a></td>
      <td className={styles.tdLink} onClick={e => e.stopPropagation()}><a href={`https://finance.yahoo.co.jp/quote/${r.code}.T`} target="_blank" rel="noopener noreferrer">→</a></td>
      <td className={styles.tdLink} onClick={e => e.stopPropagation()}><a href={`https://kabutan.jp/stock/?code=${r.code}`} target="_blank" rel="noopener noreferrer">→</a></td>
    </tr>
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
