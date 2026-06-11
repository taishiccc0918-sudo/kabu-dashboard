import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { geminiJson, hasGeminiKey } from '../../lib/llm'
import { requireUserAndQuota } from '../../lib/api-guard'
import { getJpxMaster } from '../../lib/jpx'
import { matchNameToCode } from '../../lib/searchText'

// ── AIアシスト②: テーマ → 該当銘柄の「事実共有」───────────────────────
// 「レアアース関連は？」→ LLMが社名候補＋事業上の関連事実1行 → JPXマスタ照合で実在銘柄のみ
// → Supabase の一次情報（EDINET有報の事業内容 / 適時開示・ニュース見出し）を根拠として添付。
//
// コンプラ3層（金商法: 個別銘柄の断定的推奨は禁止）:
//   ①プロンプトで推奨語彙を禁止（事実記述のみ）
//   ②サーバー側ポストフィルタ（禁止語を含む文は破棄して社名のみ表示）
//   ③UI側で常設の免責文＋出典リンク（AiAssist.tsx）
// 根拠は一次情報のみ。AI生成の jp_company_desc は根拠表示に使わない。

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const DAILY_LIMIT = 10
const MAX_INPUT = 200

// ②ポストフィルタ: 投資判断・予測を示唆する語が混じった文は事実として出さない
const BANNED_RE = /買い|売り|推奨|おすすめ|オススメ|割安|割高|上昇|下落|上がる|下がる|有望|狙い目|妙味|期待でき|値上がり|値下がり|目標株価|チャンス|仕込み/

type ThemeItem = {
  code: string
  name: string
  market: string
  relation: string // LLMによる事業上の関連（事実記述・禁止語フィルタ済み）
  factsheet: { bizDesc: string; docUrl: string | null; docDate: string | null } | null
  news: { title: string; link: string; source: string; pubDate: string }[]
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

  // ── 1) LLM: テーマ関連の社名候補＋事実1行（社名のみ・コードは答えさせない）──
  const prompt =
    `テーマ「${theme}」に事業内容が関連する、日本の証券取引所に上場している企業を挙げてください。\n` +
    '出力形式: {"companies": [{"name": "正式社名", "relation": "事業上の関連の説明（40字以内）"}]}\n' +
    '規則:\n' +
    '・relation は事実の記述のみ。「〜を手掛ける」「〜を製造している」「〜と開示している」のような書き方。\n' +
    '・投資判断・推奨・予測の語（買い/売り/推奨/おすすめ/割安/割高/上がる/下がる/有望/期待/目標株価 等）は一切使わない。\n' +
    '・テーマとの関連が事業として確実な企業のみ。確信が持てない企業・関連が薄い企業は含めない。\n' +
    '・ETF・投資信託・米国株・未上場企業は含めない。\n' +
    '・最大10社。該当が無ければ {"companies": []}。\n'

  let companies: { name: string; relation: string }[] = []
  try {
    const out = await geminiJson<{ companies?: unknown }>(prompt, { thinkingBudget: 512, maxOutputTokens: 1536, timeoutMs: 45000 })
    if (Array.isArray(out.companies)) {
      companies = out.companies
        .filter((c): c is { name: string; relation?: string } => !!c && typeof (c as { name?: unknown }).name === 'string')
        .map(c => ({ name: c.name.trim(), relation: String(c.relation ?? '').trim() }))
        .filter(c => c.name.length > 0)
        .slice(0, 10)
    }
  } catch (e) {
    console.error('[ai-theme] gemini error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'AIの呼び出しに失敗しました。少し待ってからもう一度お試しください' }, { status: 502 })
  }

  // ── 2) JPXマスタ照合（実在する上場銘柄だけを通す＝幻覚はここで落ちる）──
  let master: Record<string, { name: string; market: string }> = {}
  try { master = await getJpxMaster() } catch (e) {
    console.error('[ai-theme] jpx error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: '銘柄マスタの取得に失敗しました' }, { status: 502 })
  }

  const seen = new Set<string>()
  const matched: { code: string; name: string; market: string; relation: string }[] = []
  const unmatched: string[] = []
  for (const c of companies) {
    const hits = matchNameToCode(c.name, master)
    // テーマ検索は「LLMが挙げた1社=1銘柄」が前提なので、最有力1件のみ採用（曖昧一致の暴発防止）
    const hit = hits.find(h => h.exact) ?? (hits.length === 1 ? hits[0] : undefined)
    if (!hit) { unmatched.push(c.name); continue }
    if (seen.has(hit.code)) continue
    seen.add(hit.code)
    // ②ポストフィルタ: 禁止語を含む relation は破棄（社名のみ表示）
    const relation = BANNED_RE.test(c.relation) ? '' : c.relation
    matched.push({ code: hit.code, name: hit.name, market: hit.market, relation })
  }

  // ── 3) 一次情報の根拠を添付（EDINET有報の事業内容＋直近ニュース見出し）──
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
  const factsheets: Record<string, { bizDesc: string; docUrl: string | null; docDate: string | null }> = {}
  const newsByCode: Record<string, { title: string; link: string; source: string; pubDate: string }[]> = {}
  if (url && anon && matched.length > 0) {
    const sb = createClient(url, anon, { auth: { persistSession: false } })
    const codes = matched.map(m => m.code)
    try {
      const { data } = await sb.from('company_factsheet')
        .select('code,biz_desc,doc_url,doc_date').in('code', codes)
      for (const r of (data ?? []) as { code: string; biz_desc: string | null; doc_url: string | null; doc_date: string | null }[]) {
        if (r.biz_desc) factsheets[r.code] = { bizDesc: r.biz_desc, docUrl: r.doc_url, docDate: r.doc_date }
      }
    } catch { /* テーブル未作成等 → 根拠なしで返す（嘘をつかない） */ }
    try {
      const { data } = await sb.from('stock_news')
        .select('code,title,link,source,pub_date')
        .in('code', codes)
        .order('pub_date', { ascending: false, nullsFirst: false })
        .limit(codes.length * 6)
      for (const r of (data ?? []) as { code: string; title: string; link: string; source: string | null; pub_date: string | null }[]) {
        const list = (newsByCode[r.code] ??= [])
        if (list.length < 2) list.push({ title: r.title, link: r.link, source: r.source ?? '', pubDate: r.pub_date ?? '' })
      }
    } catch { /* 同上 */ }
  }

  const items: ThemeItem[] = matched.map(m => ({
    ...m,
    factsheet: factsheets[m.code] ?? null,
    news: newsByCode[m.code] ?? [],
  }))
  return NextResponse.json({ items, unmatched })
}
