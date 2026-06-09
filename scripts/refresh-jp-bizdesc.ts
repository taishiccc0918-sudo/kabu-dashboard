/**
 * 日本株 事業内容（冒頭3行・本文）の生成。お気に入り∪ウォッチの銘柄について
 * JPX一覧の社名から Gemini で「何をしている会社か」を日本語で生成し jp_company_desc に保存。
 * 一度生成すれば保存データ（差分のみ・再実行で積み上げ）。
 *
 * 必要env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY（GEMINI_MODEL任意）
 */
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { TAISHI_WATCHLIST } from '../app/lib/types'

function normalizeUrl(raw: string): string {
  let u = (raw ?? '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/\s+/g, '').replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}
const SUPABASE_URL = normalizeUrl(process.env.SUPABASE_URL ?? '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY ?? '').trim()
const GEMINI_MODEL = (process.env.GEMINI_MODEL ?? 'gemini-2.0-flash').trim()
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SERVICE_ROLE_KEY 未設定'); process.exit(1) }
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY 未設定'); process.exit(1) }
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const CHUNK = 20

const JPX_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'
async function getNameMap(): Promise<Record<string, string>> {
  const res = await fetch(JPX_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' } })
  if (!res.ok) throw new Error(`JPX ${res.status}`)
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })
  const map: Record<string, string> = {}
  for (const row of rows) {
    if (!row || row.length < 3) continue
    let code = String(row[1] ?? '').trim(); const name = String(row[2] ?? '').trim()
    if (!/^[0-9A-Z]{3,5}$/.test(code) || !name) continue
    if (code.length === 5 && code.endsWith('0')) code = code.slice(0, 4)
    map[code] = name
  }
  return map
}

let RESOLVED_MODEL = ''
async function resolveModel(): Promise<string> {
  if (RESOLVED_MODEL) return RESOLVED_MODEL
  const candidates = [GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-1.5-flash', 'gemini-pro-latest']
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}&pageSize=100`)
    if (res.ok) {
      const j = await res.json() as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }
      const flash = (j.models ?? []).filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent')).map(m => (m.name ?? '').replace(/^models\//, '')).filter(Boolean)
      candidates.unshift(...flash.filter(n => /flash/i.test(n)), ...flash.filter(n => !/flash/i.test(n)))
    }
  } catch { /* noop */ }
  for (const m of Array.from(new Set(candidates)).filter(Boolean)) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5 } }) })
      if (res.ok) { RESOLVED_MODEL = m; console.log('採用モデル:', m); return m }
    } catch { /* next */ }
  }
  throw new Error('使えるGeminiモデルが見つかりません')
}

async function geminiDesc(batch: { code: string; name: string }[]): Promise<Record<string, string>> {
  const list = batch.map(b => `${b.code}\t${b.name}`).join('\n')
  const prompt =
    '次の日本の上場企業（証券コード[TAB]社名）について「何をしている会社か」を日本語で簡潔に説明してください。\n' +
    '制約:\n' +
    '・出力はJSONオブジェクトのみ（前置き・コードフェンス無し）。キー=証券コード, 値=説明文。\n' +
    '・各50〜100字。事実ベース（主力事業・製品/サービス・顧客）。\n' +
    '・「買い」「売り」「割安」等の投資判断・将来予測・宣伝表現は書かない。\n' +
    '・確実に分からない企業は値を「—」にする（推測で作文しない）。\n\n' + list
  const model = await resolveModel()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
  let res: Response | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 45000)
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 4096 } }) })
    } catch (e) { clearTimeout(to); if (attempt === 4) throw e; await sleep(3000 * (attempt + 1)); continue }
    clearTimeout(to)
    if (res.status === 429 || res.status === 503 || res.status === 500) { await sleep(8000 * (attempt + 1)); continue }
    break
  }
  if (!res || !res.ok) throw new Error(`gemini ${res?.status ?? 'no-res'}`)
  const json = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  let text = (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('').trim()
  text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  return JSON.parse(text) as Record<string, string>
}

async function main() {
  await resolveModel()
  const nameMap = await getNameMap()
  // 対象 = お気に入り ∪ TAISHIウォッチ（実際に見られる銘柄）
  const set = new Set<string>(TAISHI_WATCHLIST)
  try { const { data } = await sb.from('favorites').select('code'); for (const r of (data ?? []) as { code: string }[]) if (r.code && !r.code.startsWith('US:')) set.add(r.code) } catch { /* noop */ }
  // 既存生成は除外
  const have = new Set<string>()
  try { const { data } = await sb.from('jp_company_desc').select('code'); for (const r of (data ?? []) as { code: string }[]) have.add(r.code) } catch { /* noop */ }
  const pending = Array.from(set).filter(c => nameMap[c] && !have.has(c)).map(c => ({ code: c, name: nameMap[c] }))
  console.log(`日本株 事業内容 未生成: ${pending.length} 銘柄`)
  let updates: Record<string, unknown>[] = []
  let made = 0
  for (let i = 0; i < pending.length; i += CHUNK) {
    const batch = pending.slice(i, i + CHUNK)
    try {
      const map = await geminiDesc(batch)
      for (const b of batch) { const d = (map[b.code] ?? '').trim(); if (d && d !== '—' && d.length >= 6) { updates.push({ code: b.code, biz_desc: d, updated_at: new Date().toISOString() }); made++ } }
    } catch (e) { console.warn(`[chunk ${i}] ${(e as Error).message}`) }
    await sleep(4500)
    if (updates.length >= 100) { const { error } = await sb.from('jp_company_desc').upsert(updates, { onConflict: 'code' }); if (error) console.warn('upsert失敗:', error.message); updates = [] }
  }
  for (let i = 0; i < updates.length; i += 200) { const { error } = await sb.from('jp_company_desc').upsert(updates.slice(i, i + 200), { onConflict: 'code' }); if (error) { console.error('upsert失敗:', error.message); process.exit(1) } }
  console.log(`完了: 日本株 事業内容 ${made} 件を保存`)
}
main().catch(e => { console.error(e); process.exit(1) })
