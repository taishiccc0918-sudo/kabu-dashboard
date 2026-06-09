/**
 * 米国株 事業内容（本文）の生成。us_master の「業種(SIC)/mcapがある実事業会社」について
 * Gemini で「何をしている会社か」を日本語1〜2文で生成し biz_desc に保存。
 * EDINETのような開示が米国に無いため、社名+業種から事実ベースで要約（投資判断は書かない）。
 * 一度生成すれば保存データ（差分のみ処理・再実行で積み上げ）。
 *
 * 必要env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY（GEMINI_MODEL任意）
 *   US_BIZ_MAX（任意・1回の最大件数）
 */
import { createClient } from '@supabase/supabase-js'

function normalizeUrl(raw: string): string {
  let u = (raw ?? '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/\s+/g, '').replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}
const SUPABASE_URL = normalizeUrl(process.env.SUPABASE_URL ?? '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY ?? '').trim()
const GEMINI_MODEL = (process.env.GEMINI_MODEL ?? 'gemini-2.0-flash').trim()
const MAX = Number(process.env.US_BIZ_MAX ?? '0') || 0
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定'); process.exit(1) }
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY 未設定'); process.exit(1) }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const CHUNK = 20

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

type Row = { ticker: string; name: string; sic_label: string | null; biz_desc: string | null; mcap: number | null }
async function getPending(): Promise<{ ticker: string; name: string; sic: string }[]> {
  const out: { ticker: string; name: string; sic: string }[] = []
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from('us_master').select('ticker, name, sic_label, biz_desc, mcap').range(p * 1000, p * 1000 + 999)
    if (error) { console.warn('読込失敗:', error.message); break }
    const chunk = (data ?? []) as Row[]
    for (const r of chunk) {
      // 実事業会社（業種 or 時価総額あり）かつ未生成のみ対象＝obscure銘柄の作文を避ける
      if (r.ticker && r.name && !r.biz_desc && (r.sic_label || r.mcap)) out.push({ ticker: r.ticker, name: r.name, sic: r.sic_label ?? '' })
    }
    if (chunk.length < 1000) break
  }
  return out
}

async function geminiDesc(batch: { ticker: string; name: string; sic: string }[]): Promise<Record<string, string>> {
  const list = batch.map(b => `${b.ticker}\t${b.name}\t${b.sic}`).join('\n')
  const prompt =
    '次の米国上場企業（ティッカー[TAB]英語社名[TAB]SEC業種）について、「何をしている会社か」を日本語で簡潔に説明してください。\n' +
    '制約:\n' +
    '・出力はJSONオブジェクトのみ（前置き・コードフェンス無し）。キー=ティッカー, 値=説明文。\n' +
    '・各40〜90字。事実ベース（主力事業・製品/サービス・顧客）。\n' +
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
  try { await resolveModel() } catch (e) { console.error((e as Error).message); process.exit(1) }
  let pending = await getPending()
  if (MAX > 0) pending = pending.slice(0, MAX)
  console.log(`事業内容 未生成: ${pending.length} 銘柄`)
  let updates: Record<string, unknown>[] = []
  let done = 0, made = 0
  for (let i = 0; i < pending.length; i += CHUNK) {
    const batch = pending.slice(i, i + CHUNK)
    try {
      const map = await geminiDesc(batch)
      for (const b of batch) {
        const d = (map[b.ticker] ?? '').trim()
        if (d && d !== '—' && d.length >= 6) { updates.push({ ticker: b.ticker, biz_desc: d, updated_at: new Date().toISOString() }); made++ }
      }
    } catch (e) { console.warn(`[chunk ${i}] ${(e as Error).message}`) }
    done += batch.length
    if (done % 200 === 0 || done >= pending.length) console.log(`  ${Math.min(done, pending.length)}/${pending.length}（生成 ${made}）`)
    await sleep(4500)
    if (updates.length >= 200) { const { error } = await sb.from('us_master').upsert(updates, { onConflict: 'ticker' }); if (error) console.warn('upsert失敗:', error.message); updates = [] }
  }
  for (let i = 0; i < updates.length; i += 200) {
    const { error } = await sb.from('us_master').upsert(updates.slice(i, i + 200), { onConflict: 'ticker' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
  }
  console.log(`完了: 事業内容 ${made} 件を保存`)
}
main().catch(e => { console.error(e); process.exit(1) })
