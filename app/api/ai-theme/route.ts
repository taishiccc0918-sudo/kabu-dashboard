import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { geminiJson, hasGeminiKey } from '../../lib/llm'
import { requireUserAndQuota } from '../../lib/api-guard'
import { getJpxMaster } from '../../lib/jpx'
import { matchNameToCode } from '../../lib/searchText'

// ── AIアシスト②: テーマ → 該当銘柄の「事実共有」（日本株＋米国株）──────
// 「レアアース関連は？」→ LLMが社名候補＋事業上の関連事実1行 →
//   日本株: JPXマスタ照合 → EDINET有報の事業内容＋適時開示・ニュース見出し（一次情報）を根拠に添付
//   米国株: us_master照合（ティッカー検証）→ SEC業種ラベルを添付
// 時価総額（mcap・億円）も添付し、クライアントで並べ替えに使う。
//
// コンプラ3層（金商法: 個別銘柄の断定的推奨は禁止）:
//   ①プロンプトで推奨語彙を禁止（事実記述のみ）
//   ②サーバー側ポストフィルタ（禁止語を含む文は破棄して社名のみ表示）
//   ③UI側で常設の免責文＋出典リンク（AiAssist.tsx）
// 根拠は一次情報のみ。AI生成の jp_company_desc / us_master.biz_desc は根拠表示に使わない。

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DAILY_LIMIT = 10
const MAX_INPUT = 200

// ②ポストフィルタ: 投資判断・予測を示唆する語が混じった文は事実として出さない
const BANNED_RE = /買い|売り|推奨|おすすめ|オススメ|割安|割高|上昇|下落|上がる|下がる|有望|狙い目|妙味|期待でき|値上がり|値下がり|目標株価|チャンス|仕込み/

type ThemeItem = {
  code: string            // 日本株=4桁コード / 米国株=ティッカー
  name: string
  market: string
  country: 'JP' | 'US'
  mcap: number | null     // 億円
  per: number | null      // PER今期（会社予想ベース・数値の事実のみ。割安/割高の判定はしない）
  relation: string        // LLMによる事業上の関連（事実記述・禁止語フィルタ済み）
  sicLabel: string | null // 米国: SEC業種（一次情報）
  factsheet: { bizDesc: string; docUrl: string | null; docDate: string | null } | null
  news: { title: string; link: string; source: string; pubDate: string }[]
}

// ── J-Quants 直取得（snapshot未収録の銘柄の時価総額・PERを補完）────────
const JQ_BASE = 'https://api.jquants.com/v2'
function num(v: unknown): number { if (v == null || v === '') return 0; const x = Number(v); return isNaN(x) ? 0 : x }
async function jqFetch(path: string): Promise<Record<string, unknown> | null> {
  const key = (process.env.JQUANTS_API_KEY ?? '').trim()
  if (!key) return null
  try {
    const res = await fetch(`${JQ_BASE}${path}`, { headers: { 'x-api-key': key } })
    if (!res.ok) return null
    return await res.json() as Record<string, unknown>
  } catch { return null }
}
// 1銘柄の {mcap(億円), per(会社予想)} を取得。失敗は null のまま（嘘をつかない）
async function jqMcapPer(code: string): Promise<{ mcap: number | null; per: number | null }> {
  const today = new Date(Date.now() + 9 * 3600_000)
  const toStr = today.toISOString().slice(0, 10)
  const fromStr = new Date(today.getTime() - 14 * 86400_000).toISOString().slice(0, 10)
  const [fins, bars] = await Promise.all([
    jqFetch(`/fins/summary?code=${code}`),
    jqFetch(`/equities/bars/daily?code=${code}&dateFrom=${fromStr}&dateTo=${toStr}`),
  ])
  const rows = ((bars as { data?: Record<string, unknown>[] } | null)?.data ?? [])
  let close = 0; let lastDate = ''
  for (const d of rows) {
    const date = String(d.Date ?? '')
    const price = num(d.AdjC) || num(d.C)
    if (date > lastDate && price > 0) { lastDate = date; close = price }
  }
  const stmts = ((fins as { data?: Record<string, string>[] } | null)?.data ?? [])
  let shOut = 0
  for (let i = stmts.length - 1; i >= 0; i--) { const v = num(stmts[i].ShOutFY) || num(stmts[i].ShOut); if (v > 0) { shOut = v; break } }
  // 予想EPS: 最新開示（DiscDate最大）の FEPS
  let feps = 0; let bestDate = ''
  for (const s of stmts) {
    const v = num(s.FEPS)
    if (v !== 0 && String(s.DiscDate ?? '') > bestDate) { bestDate = String(s.DiscDate ?? ''); feps = v }
  }
  const mcap = close > 0 && shOut > 0 ? Math.round(close * shOut / 1e8) : null
  const per = close > 0 && feps > 0 ? Math.round((close / feps) * 10) / 10 : null
  return { mcap, per }
}

export async function POST(req: NextRequest) {
  if (!hasGeminiKey()) {
    return NextResponse.json({ error: 'AI機能は準備中です（GEMINI_API_KEY 未設定）' }, { status: 503 })
  }
  let theme = ''
  try { theme = String(((await req.json()) as { theme?: unknown }).theme ?? '').trim() } catch { /* fallthrough */ }
  if (!theme) return NextResponse.json({ error: 'テーマを入力してください' }, { status: 400 })
  if (theme.length > MAX_INPUT) theme = theme.slice(0, MAX_INPUT)

  const guard = await requireUserAndQuota('theme', DAILY_LIMIT)
  if (!guard.ok) return NextResponse.json({ error: guard.message }, { status: guard.status })

  // ── 1) LLM: テーマ関連の社名候補＋事実1行（コードは答えさせない。米国はティッカーのみ後で検証）──
  const prompt =
    `テーマ「${theme}」に事業内容が関連する上場企業を、日本株・米国株それぞれから挙げてください。\n` +
    '出力形式: {"companies": [{"name": "正式社名", "country": "JP", "ticker": "", "relation": "事業上の関連の説明（40字以内）"}]}\n' +
    '規則:\n' +
    '・country は "JP"（日本上場）か "US"（米国上場）。米国株は ticker に正式ティッカー（例: NVDA）を書く。日本株の ticker は空文字。\n' +
    '・relation は事実の記述のみ。「〜を手掛ける」「〜を製造している」「〜と開示している」のような書き方。\n' +
    '・投資判断・推奨・予測の語（買い/売り/推奨/おすすめ/割安/割高/上がる/下がる/有望/期待/目標株価 等）は一切使わない。\n' +
    '・テーマとの関連が事業として確実な企業のみ。確信が持てない企業・関連が薄い企業は含めない。\n' +
    '・社名変更した企業は現在の社名を使う（例: 日本電産→ニデック、昭和電工→レゾナック）。\n' +
    '・ETF・投資信託・未上場企業は含めない。\n' +
    '・日本株は最大10社、米国株は最大6社。該当が無ければ {"companies": []}。\n'

  type LlmCompany = { name: string; country: 'JP' | 'US'; ticker: string; relation: string }
  let companies: LlmCompany[] = []
  try {
    const out = await geminiJson<{ companies?: unknown }>(prompt, { thinkingBudget: 512, maxOutputTokens: 2048, timeoutMs: 45000 })
    if (Array.isArray(out.companies)) {
      companies = out.companies
        .filter((c): c is { name?: string; country?: string; ticker?: string; relation?: string } => !!c && typeof c === 'object')
        .map(c => ({
          name: String(c.name ?? '').trim(),
          country: (c.country === 'US' ? 'US' : 'JP') as 'JP' | 'US',
          ticker: String(c.ticker ?? '').trim().toUpperCase(),
          relation: String(c.relation ?? '').trim(),
        }))
        .filter(c => c.name.length > 0)
        .slice(0, 16)
    }
  } catch (e) {
    console.error('[ai-theme] gemini error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'AIの呼び出しに失敗しました。少し待ってからもう一度お試しください' }, { status: 502 })
  }

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  const sb = url && anon ? createClient(url, anon, { auth: { persistSession: false } }) : null

  // ── 2) 実在照合（幻覚はここで落ちる）──
  const seen = new Set<string>()
  const matched: { code: string; name: string; market: string; country: 'JP' | 'US'; relation: string; sicLabel: string | null; mcap: number | null }[] = []
  const unmatched: string[] = []

  // 日本株: JPXマスタ照合
  const jpCompanies = companies.filter(c => c.country === 'JP')
  if (jpCompanies.length > 0) {
    let master: Record<string, { name: string; market: string }> = {}
    try { master = await getJpxMaster() } catch (e) {
      console.error('[ai-theme] jpx error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: '銘柄マスタの取得に失敗しました' }, { status: 502 })
    }
    for (const c of jpCompanies) {
      const hits = matchNameToCode(c.name, master)
      // 「LLMが挙げた1社=1銘柄」前提なので最有力1件のみ採用（曖昧一致の暴発防止）
      const hit = hits.find(h => h.exact) ?? (hits.length === 1 ? hits[0] : undefined)
      if (!hit) { unmatched.push(c.name); continue }
      if (seen.has(hit.code)) continue
      seen.add(hit.code)
      const relation = BANNED_RE.test(c.relation) ? '' : c.relation
      matched.push({ code: hit.code, name: hit.name, market: hit.market, country: 'JP', relation, sicLabel: null, mcap: null })
    }
  }

  // 米国株: us_master 照合（ティッカー検証）
  const usCompanies = companies.filter(c => c.country === 'US' && /^[A-Z.]{1,6}$/.test(c.ticker))
  if (usCompanies.length > 0 && sb) {
    try {
      const { data } = await sb.from('us_master')
        .select('ticker,name,exchange,mcap,sic_label')
        .in('ticker', usCompanies.map(c => c.ticker))
      const found = new Map(((data ?? []) as { ticker: string; name: string | null; exchange: string | null; mcap: number | null; sic_label: string | null }[])
        .map(r => [r.ticker, r]))
      for (const c of usCompanies) {
        const hit = found.get(c.ticker)
        if (!hit) { unmatched.push(c.name); continue }
        if (seen.has(hit.ticker)) continue
        seen.add(hit.ticker)
        const relation = BANNED_RE.test(c.relation) ? '' : c.relation
        matched.push({ code: hit.ticker, name: hit.name ?? c.name, market: hit.exchange ?? '', country: 'US', relation, sicLabel: hit.sic_label ?? null, mcap: hit.mcap ?? null })
      }
    } catch { for (const c of usCompanies) unmatched.push(c.name) }
  } else if (usCompanies.length > 0) {
    for (const c of usCompanies) unmatched.push(c.name)
  }

  // ── 3) 一次情報の根拠＋時価総額を添付 ──
  const factsheets: Record<string, { bizDesc: string; docUrl: string | null; docDate: string | null }> = {}
  const newsByCode: Record<string, { title: string; link: string; source: string; pubDate: string }[]> = {}
  const mcapByCode: Record<string, number> = {}
  const perByCode: Record<string, number> = {}
  const jpCodes = matched.filter(m => m.country === 'JP').map(m => m.code)
  if (sb && jpCodes.length > 0) {
    try {
      const { data } = await sb.from('company_factsheet')
        .select('code,biz_desc,doc_url,doc_date').in('code', jpCodes)
      for (const r of (data ?? []) as { code: string; biz_desc: string | null; doc_url: string | null; doc_date: string | null }[]) {
        if (r.biz_desc) factsheets[r.code] = { bizDesc: r.biz_desc, docUrl: r.doc_url, docDate: r.doc_date }
      }
    } catch { /* テーブル未作成等 → 根拠なしで返す（嘘をつかない） */ }
    try {
      const { data } = await sb.from('stock_news')
        .select('code,title,link,source,pub_date')
        .in('code', jpCodes)
        .order('pub_date', { ascending: false, nullsFirst: false })
        .limit(jpCodes.length * 6)
      for (const r of (data ?? []) as { code: string; title: string; link: string; source: string | null; pub_date: string | null }[]) {
        const list = (newsByCode[r.code] ??= [])
        if (list.length < 2) list.push({ title: r.title, link: r.link, source: r.source ?? '', pubDate: r.pub_date ?? '' })
      }
    } catch { /* 同上 */ }
    try {
      // 時価総額・PER: cron事前計算のスナップショット（mcapは price 列・fepsは fin 列）にあれば使う
      const { data } = await sb.from('stock_snapshot').select('code,price,fin').in('code', jpCodes)
      for (const r of (data ?? []) as { code: string; price: { close?: number; mcap?: number } | null; fin: { feps?: number | null } | null }[]) {
        if (r.price?.mcap) mcapByCode[r.code] = r.price.mcap
        const close = r.price?.close ?? 0; const feps = r.fin?.feps ?? 0
        if (close > 0 && feps > 0) perByCode[r.code] = Math.round((close / feps) * 10) / 10
      }
    } catch { /* 同上 */ }
    // スナップショット未収録の銘柄は J-Quants 直取得で補完（同時3並行・失敗はnullのまま）
    const missing = jpCodes.filter(c => !mcapByCode[c])
    for (let i = 0; i < missing.length; i += 3) {
      const batch = missing.slice(i, i + 3)
      const results = await Promise.all(batch.map(c => jqMcapPer(c)))
      batch.forEach((c, j) => {
        if (results[j].mcap) mcapByCode[c] = results[j].mcap as number
        if (results[j].per && !perByCode[c]) perByCode[c] = results[j].per as number
      })
    }
  }

  const items: ThemeItem[] = matched.map(m => ({
    ...m,
    mcap: m.country === 'JP' ? (mcapByCode[m.code] ?? null) : m.mcap,
    per: m.country === 'JP' ? (perByCode[m.code] ?? null) : null,
    factsheet: m.country === 'JP' ? (factsheets[m.code] ?? null) : null,
    news: m.country === 'JP' ? (newsByCode[m.code] ?? []) : [],
  }))
  // 時価総額の大きい順（不明は末尾）。表示時の最終並び（未登録↑/登録済み↓）はクライアントで行う
  items.sort((a, b) => (b.mcap ?? -1) - (a.mcap ?? -1))
  return NextResponse.json({ items, unmatched })
}
