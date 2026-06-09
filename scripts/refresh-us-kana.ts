/**
 * 米国株 社名カタカナの一括生成（全銘柄統一）。
 * us_master の英語社名を Gemini で日本語カタカナに変換し name_kana に保存。
 * 「主要150社だけカタカナ」では統一感が無いので、全銘柄に一度だけ付与する。
 * 一度生成すれば保存データとして使い回す（以後はAI不要）。差分のみ処理。
 *
 * 必要な環境変数: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GEMINI_API_KEY
 *   GEMINI_MODEL (任意・既定 gemini-2.0-flash)
 *   US_KANA_MAX (任意・1回の最大処理件数。未設定=全件)
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
const MAX = Number(process.env.US_KANA_MAX ?? '0') || 0
if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定'); process.exit(1) }
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY が未設定（カタカナ生成にはGeminiが必要）'); process.exit(1) }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const CHUNK = 60

// 利用可能なモデルを実際に問い合わせて、generateContent対応のflash系を選ぶ（モデル名の404を回避）。
let RESOLVED_MODEL = ''
async function resolveModel(): Promise<string> {
  if (RESOLVED_MODEL) return RESOLVED_MODEL
  // まず設定モデル＋候補を直接試す
  const candidates = [GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-1.5-flash', 'gemini-pro-latest']
  // ListModels で実在モデルを取得して候補を補強
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(GEMINI_API_KEY)}&pageSize=100`)
    if (res.ok) {
      const j = await res.json() as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }
      const flash = (j.models ?? [])
        .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map(m => (m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean)
      // flash優先で候補先頭に
      const flashFirst = flash.filter(n => /flash/i.test(n)).concat(flash.filter(n => !/flash/i.test(n)))
      candidates.unshift(...flashFirst)
      console.log('利用可能モデル(先頭5):', flashFirst.slice(0, 5).join(', '))
    } else {
      console.warn('ListModels失敗:', res.status, '→ 候補を直接試行')
    }
  } catch (e) { console.warn('ListModels例外:', (e as Error).message) }
  // 候補を1つずつ軽く叩いて200になるものを採用
  for (const m of Array.from(new Set(candidates)).filter(Boolean)) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5 } }) })
      if (res.ok) { RESOLVED_MODEL = m; console.log('採用モデル:', m); return m }
    } catch { /* next */ }
  }
  throw new Error('使えるGeminiモデルが見つかりません（APIキー/Generative Language API有効化を確認）')
}

// name_kana が未設定の銘柄を集める
async function getPending(): Promise<{ ticker: string; name: string }[]> {
  const out: { ticker: string; name: string }[] = []
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from('us_master').select('ticker, name, name_kana').range(p * 1000, p * 1000 + 999)
    if (error) { console.warn('us_master読込失敗:', error.message); break }
    const chunk = (data ?? []) as { ticker: string; name: string; name_kana: string | null }[]
    for (const r of chunk) if (r.ticker && r.name && !r.name_kana) out.push({ ticker: r.ticker, name: r.name })
    if (chunk.length < 1000) break
  }
  return out
}

// Gemini に「ticker→カタカナ」のJSONを作らせる
async function geminiKana(batch: { ticker: string; name: string }[]): Promise<Record<string, string>> {
  const list = batch.map(b => `${b.ticker}\t${b.name}`).join('\n')
  const prompt =
    '次の米国上場企業（ティッカー[TAB]英語社名）を、日本語の一般的なカタカナ社名に変換してください。\n' +
    '制約:\n' +
    '・出力はJSONオブジェクトのみ（前置き・コードフェンス無し）。キー=ティッカー, 値=カタカナ社名。\n' +
    '・一般に通用する読み（例: Apple Inc.→アップル, NVIDIA→エヌビディア, Berkshire Hathaway→バークシャー・ハサウェイ）。\n' +
    '・社名種別(Inc./Corp./Ltd.等)や末尾の法人格は省く。不明なものは英語発音に忠実なカタカナで。\n' +
    '・余計な注釈は付けない。\n\n' + list
  const model = await resolveModel()
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
  // タイムアウト(ハング防止)＋429/503はバックオフ再試行（レート制限対策）
  let res: Response | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), 45000)
    try {
      res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 4096 } }),
      })
    } catch (e) { clearTimeout(to); if (attempt === 4) throw e; await sleep(3000 * (attempt + 1)); continue }
    clearTimeout(to)
    if (res.status === 429 || res.status === 503 || res.status === 500) { await sleep(8000 * (attempt + 1)); continue }
    break
  }
  if (!res || !res.ok) throw new Error(`gemini ${res?.status ?? 'no-res'}`)
  const json = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  let text = (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('').trim()
  text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  const obj = JSON.parse(text) as Record<string, string>
  return obj
}

async function main() {
  try { await resolveModel() } catch (e) { console.error((e as Error).message); process.exit(1) }
  let pending = await getPending()
  if (MAX > 0) pending = pending.slice(0, MAX)
  console.log(`カタカナ未生成: ${pending.length} 銘柄を処理します`)
  const updates: Record<string, unknown>[] = []
  let done = 0
  for (let i = 0; i < pending.length; i += CHUNK) {
    const batch = pending.slice(i, i + CHUNK)
    try {
      const map = await geminiKana(batch)
      for (const b of batch) {
        const kana = (map[b.ticker] ?? '').trim()
        if (kana) updates.push({ ticker: b.ticker, name_kana: kana, updated_at: new Date().toISOString() })
      }
    } catch (e) { console.warn(`[chunk ${i}] ${(e as Error).message}`) }
    done += batch.length
    if (done % 600 === 0 || done >= pending.length) console.log(`  ${Math.min(done, pending.length)}/${pending.length}（生成 ${updates.length}）`)
    await sleep(4500) // Gemini 無料枠のRPM制限に配慮（約13req/分）
    // 逐次保存（途中失敗しても進捗を残す）
    if (updates.length >= 300) {
      const { error } = await sb.from('us_master').upsert(updates.splice(0, updates.length), { onConflict: 'ticker' })
      if (error) console.warn('upsert失敗:', error.message)
    }
  }
  for (let i = 0; i < updates.length; i += 200) {
    const { error } = await sb.from('us_master').upsert(updates.slice(i, i + 200), { onConflict: 'ticker' })
    if (error) { console.error('upsert失敗:', error.message); process.exit(1) }
  }
  console.log('完了: カタカナ社名を保存')
}

main().catch(e => { console.error(e); process.exit(1) })
