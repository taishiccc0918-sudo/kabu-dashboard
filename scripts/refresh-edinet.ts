/**
 * 企業ファクトシート蓄積エンジン（EDINET 有価証券報告書 → Supabase company_factsheet）。
 * GitHub Actions（月次cron＋手動）から実行。有報は年1回なので月次で十分。
 *
 * 【捏造ゼロ】格納する値は EDINET 一次情報からの機械抽出のみ（app/lib/edinet.ts の extractFactsheet）。
 *   判定不能な項目は null（=フロントで「データなし」）。値の生成・推測は一切しない。
 *
 * 必要な環境変数（GitHub Secrets / ローカル.env）:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … 書き込み（RLSバイパス）
 *   EDINET_API_KEY                          … EDINET API v2 の Subscription-Key（無料）
 *
 * 仕組み:
 *   ① お気に入り銘柄（favorites∪フォールバック）と証券コード→EDINETコード対応表を用意
 *   ② documents.json は「日付指定のみ」なので、今日から過去へ日付を走査し、
 *      docTypeCode=120(有報) かつ対象銘柄のものを見つける（新しい日から見るので最初の1件＝最新）
 *   ③ 見つかった書類の type=5 CSV を取得→extractFactsheet→company_factsheet に upsert
 */
import { createClient } from '@supabase/supabase-js'
import {
  fetchSecToEdinetMap, fetchDocList, fetchDocCsv, extractFactsheet,
  normSecCode, DOCTYPE_YUHO,
} from '../app/lib/edinet'

function normalizeUrl(raw: string): string {
  let u = (raw ?? '').trim().replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/\s+/g, '').replace(/\/+$/, '')
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}
const SUPABASE_URL = normalizeUrl(process.env.SUPABASE_URL ?? '')
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const API_KEY = (process.env.EDINET_API_KEY ?? '').trim()
const FALLBACK_WATCHLIST = ['7203', '8306', '8058']
const MAX_DAYS = Number(process.env.EDINET_MAX_DAYS ?? 400) // 有報1サイクル分を走査
const LIST_INTERVAL_MS = 3800 // EDINETレート制限（仕様3〜5秒間隔）
const DOC_INTERVAL_MS = 3800

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定'); process.exit(1) }
if (!API_KEY) { console.error('EDINET_API_KEY が未設定'); process.exit(1) }
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const fmtDate = (d: Date) => d.toISOString().slice(0, 10)

async function getUniverse(): Promise<string[]> {
  try {
    const { data, error } = await sb.from('favorites').select('code')
    if (error) throw error
    const set = new Set<string>(FALLBACK_WATCHLIST)
    for (const r of (data ?? []) as { code: string }[]) if (r.code) set.add(normSecCode(r.code))
    return Array.from(set)
  } catch (e) {
    console.warn('favorites取得失敗 → フォールバック:', (e as Error).message)
    return [...FALLBACK_WATCHLIST]
  }
}

type Found = { code: string; docID: string; date: string }

async function main() {
  const [universe, secToEdi] = await Promise.all([getUniverse(), fetchSecToEdinetMap()])
  console.log(`対象 ${universe.length} 銘柄 / EDINETコード対応表 ${Object.keys(secToEdi).length} 件`)
  if (Object.keys(secToEdi).length === 0) { console.error('EDINETコード対応表が取得できませんでした'); process.exit(1) }

  // 対象のEDINETコード集合（逆引きも用意）
  const wantEdi = new Map<string, string>() // edinetCode → secCode
  for (const code of universe) { const e = secToEdi[code]; if (e) wantEdi.set(e, code) }
  console.log(`EDINETコードが判明した銘柄: ${wantEdi.size}`)

  // ② 新しい日付から過去へ走査して最新の有報を1件ずつ確定
  const foundByCode = new Map<string, Found>()
  const today = new Date()
  for (let i = 0; i < MAX_DAYS && foundByCode.size < wantEdi.size; i++) {
    const date = fmtDate(new Date(today.getTime() - i * 86400000))
    const docs = await fetchDocList(date, API_KEY)
    for (const d of docs) {
      if (d.docTypeCode !== DOCTYPE_YUHO || !d.edinetCode) continue
      const code = wantEdi.get(d.edinetCode)
      if (!code || foundByCode.has(code)) continue
      foundByCode.set(code, { code, docID: d.docID, date: (d.submitDateTime ?? date).slice(0, 10) })
    }
    if (i % 20 === 0) console.log(`  走査 ${date}（${i}/${MAX_DAYS}日）／発見 ${foundByCode.size}/${wantEdi.size}`)
    await sleep(LIST_INTERVAL_MS)
  }
  console.log(`有報を発見: ${foundByCode.size} 銘柄。CSV取得＆抽出します`)

  // ③ CSV取得→抽出→upsert
  let ok = 0, fail = 0
  for (const f of foundByCode.values()) {
    try {
      const rows = await fetchDocCsv(f.docID, API_KEY)
      if (rows.length === 0) { fail++; await sleep(DOC_INTERVAL_MS); continue }
      const ex = extractFactsheet(rows)
      const { error } = await sb.from('company_factsheet').upsert({
        code: f.code,
        edinet_code: secToEdi[f.code] ?? null,
        biz_desc: ex.bizDesc,
        ceo: ex.ceo,
        founded: ex.founded,
        employees: ex.employees,
        employees_as_of: ex.employeesAsOf,
        segments: ex.segments,           // jsonb
        doc_url: null,                   // 出典はUIでEDINET検索＋提出日表記（キー露出回避）
        doc_date: f.date,
        doc_id: f.docID,
        fetched_at: new Date().toISOString(),
      }, { onConflict: 'code' })
      if (error) { console.warn(`  ${f.code} upsert失敗:`, error.message); fail++ }
      else { ok++; console.log(`  ${f.code} OK（従業員${ex.employees ?? '—'} / セグメント${ex.segments?.length ?? 0}）`) }
    } catch (e) {
      console.warn(`  ${f.code} 取得失敗:`, (e as Error).message); fail++
    }
    await sleep(DOC_INTERVAL_MS)
  }
  console.log(`完了: 成功 ${ok} / 失敗 ${fail}`)
}

main().catch(e => { console.error(e); process.exit(1) })
