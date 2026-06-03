/**
 * 企業ロゴ収集エンジン（2段構え・できる限り全上場企業を網羅）:
 *   Phase1: Wikidata（全取引所×ticker）→ JPX上場コードと突合せ。公式ロゴ(P154)優先・無ければ公式サイト(P856)→Clearbit
 *   Phase2: Phase1で取れなかったコードを、EDINETコード一覧の「英語社名」→ Clearbit社名補完でドメイン特定 → Clearbitロゴ
 *           （日本語名は当たらないため英語名で照合。誤ロゴ防止に名前一致スコアの閾値を設定）
 * JPX一覧に無いコードは捨てる＝必ず実在の日本上場銘柄に限定。GitHub Actions（月次cron＋手動）。APIキー不要。
 *
 * 必要な環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（既存シークレットを流用）
 */
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { unzipSync } from 'fflate'
import { decodeShiftJis, EDINET_CODELIST_URL, normSecCode } from '../app/lib/edinet'

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('環境変数未設定（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）'); process.exit(1) }
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const UA = 'kabu-dashboard/1.0 (logo master; contact: enpivot)'
const WDQS = 'https://query.wikidata.org/sparql'
const JPX_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const QUERY = `
SELECT ?ticker ?country ?logo ?site WHERE {
  ?c p:P414 ?st . ?st pq:P249 ?ticker .
  FILTER(REGEX(STR(?ticker), "^[0-9A-Z]{4}$"))
  ?st ps:P414 ?exch .
  OPTIONAL { ?exch wdt:P17 ?country . }
  OPTIONAL { ?c wdt:P154 ?logo . }
  OPTIONAL { ?c wdt:P856 ?site . }
}`

function normCode(raw: string): string | null {
  const c = (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  return (/^[0-9]{4}$/.test(c) || /^[0-9]{3}[0-9A-Z]$/.test(c)) ? c : null
}
function commonsThumb(url: string): string {
  try { const u = new URL(url); if (!u.searchParams.has('width')) u.searchParams.set('width', '128'); return u.toString() } catch { return url }
}
function clearbit(host: string): string { return `https://logo.clearbit.com/${host}?size=128` }
function clearbitFromSite(site: string): string | null {
  try { const h = new URL(site).hostname.replace(/^www\./, ''); return h.includes('.') ? clearbit(h) : null } catch { return null }
}

async function getJpxCodes(): Promise<Set<string>> {
  const res = await fetch(JPX_URL, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`JPX ${res.status}`)
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
  const set = new Set<string>()
  for (const row of rows) {
    if (!row || row.length < 2) continue
    let code = String(row[1] ?? '').trim().toUpperCase()
    if (!/^[0-9A-Z]{3,5}$/.test(code)) continue
    if (code.length === 5 && code.endsWith('0')) code = code.slice(0, 4)
    if (/^[0-9A-Z]{4}$/.test(code)) set.add(code)
  }
  return set
}

// EDINETコード一覧: 証券コード(4桁)→英語社名
async function getEdinetEnglishNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const res = await fetch(EDINET_CODELIST_URL, { headers: { 'User-Agent': UA } })
    if (!res.ok) return out
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    const entry = Object.entries(files).find(([n]) => n.toLowerCase().endsWith('.csv'))
    if (!entry) return out
    const lines = decodeShiftJis(entry[1]).split(/\r?\n/).filter(l => l.length > 0)
    if (lines.length < 3) return out
    const header = lines[1].split(',').map(h => h.replace(/^"|"$/g, ''))
    const iEn = header.findIndex(h => h.includes('英字'))
    const iSec = header.findIndex(h => h.includes('証券コード'))
    if (iEn < 0 || iSec < 0) return out
    for (let i = 2; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, ''))
      const sec = normSecCode((cols[iSec] ?? '').trim())
      const en = (cols[iEn] ?? '').trim()
      if (/^[0-9]{4}$/.test(sec) && en) out.set(sec, en)
    }
  } catch { /* noop */ }
  return out
}

// 英語社名 → Clearbit社名補完でドメイン特定（誤ロゴ防止のため名前一致スコアの閾値あり）
const STOP = new Set(['co', 'ltd', 'inc', 'corp', 'corporation', 'company', 'holdings', 'holding', 'group', 'kk', 'the', 'and', 'co.,', 'ltd.', 'inc.', 'limited', 'incorporated'])
function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 2 && !STOP.has(w))
}
async function clearbitDomain(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`, { headers: { 'User-Agent': UA } })
    if (!res.ok) return null
    const list = await res.json() as { name: string; domain: string }[]
    if (!Array.isArray(list) || list.length === 0) return null
    const qtok = tokens(name); const qkey = qtok[0]
    if (!qkey) return null
    let best: string | null = null, bestScore = 0
    for (const r of list) {
      const dom = (r.domain ?? '').toLowerCase(); if (!dom.includes('.')) continue
      const root = dom.split('.')[0]
      const rtok = tokens(r.name ?? '')
      let s = 0
      if (rtok[0] === qkey) s += 3
      else if (rtok.includes(qkey)) s += 2
      if (qtok.some(t => root.includes(t) || t.includes(root))) s += 2
      if (dom.endsWith('.co.jp') || dom.endsWith('.jp')) s += 2
      else if (dom.endsWith('.com')) s += 1
      if (s > bestScore) { bestScore = s; best = dom }
    }
    return bestScore >= 4 ? best : null   // 閾値4＝名前/ドメインが十分一致した時だけ採用
  } catch { return null }
}

type Cand = { logo_url: string; source: string; jp: boolean }

async function main() {
  console.log('JPX上場一覧を取得中…')
  const jpx = await getJpxCodes()
  console.log(`JPX上場コード: ${jpx.size}件`)

  // Phase1: Wikidata
  console.log('Phase1: Wikidata から取得中…')
  const wres = await fetch(`${WDQS}?query=${encodeURIComponent(QUERY)}`, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA } })
  if (!wres.ok) { console.error('Wikidata SPARQL 失敗', wres.status); process.exit(1) }
  const wrows = (await wres.json() as { results: { bindings: Array<Record<string, { value: string }>> } }).results.bindings
  const best = new Map<string, Cand>()
  const rank = (c: Cand) => (c.jp ? 2 : 0) + (c.source === 'wikidata' ? 1 : 0)
  for (const b of wrows) {
    const code = normCode(b.ticker?.value ?? ''); if (!code || !jpx.has(code)) continue
    const jp = (b.country?.value ?? '').endsWith('Q17')
    let cand: Cand | null = null
    if (b.logo?.value) cand = { logo_url: commonsThumb(b.logo.value), source: 'wikidata', jp }
    else if (b.site?.value) { const cb = clearbitFromSite(b.site.value); if (cb) cand = { logo_url: cb, source: 'clearbit', jp } }
    if (cand) { const cur = best.get(code); if (!cur || rank(cand) > rank(cur)) best.set(code, cand) }
  }
  console.log(`Phase1採用: ${best.size}社`)

  // Phase2: EDINET英語名 → Clearbit社名補完（Phase1で未取得のコードのみ）
  console.log('Phase2: EDINETコード一覧（英語社名）を取得中…')
  const enNames = await getEdinetEnglishNames()
  const missing = [...jpx].filter(c => !best.has(c) && enNames.has(c))
  console.log(`Phase2対象（未取得×英語名あり）: ${missing.length}社 → Clearbit社名補完…`)
  let p2 = 0
  const CONC = 8
  for (let i = 0; i < missing.length; i += CONC) {
    const batch = missing.slice(i, i + CONC)
    await Promise.all(batch.map(async code => {
      const dom = await clearbitDomain(enNames.get(code)!)
      if (dom) { best.set(code, { logo_url: clearbit(dom), source: 'clearbit-name', jp: true }); p2++ }
    }))
    if (i % 200 === 0) await sleep(150)   // 軽いレート制御
  }
  console.log(`Phase2追加: ${p2}社`)

  const records = [...best.entries()].map(([code, v]) => ({ code, logo_url: v.logo_url, source: v.source, updated_at: new Date().toISOString() }))
  const bySrc = records.reduce((m, r) => { m[r.source] = (m[r.source] ?? 0) + 1; return m }, {} as Record<string, number>)
  console.log(`合計: ${records.length}社（内訳 ${JSON.stringify(bySrc)}）／JPX網羅率 ${(records.length / jpx.size * 100).toFixed(1)}%`)

  for (let i = 0; i < records.length; i += 500) {
    const { error } = await sb.from('company_logo').upsert(records.slice(i, i + 500), { onConflict: 'code' })
    if (error) { console.error('upsert失敗', error.message); process.exit(1) }
    console.log(`  upsert ${Math.min(i + 500, records.length)}/${records.length}`)
  }
  console.log('完了')
}

main().catch(e => { console.error(e); process.exit(1) })
