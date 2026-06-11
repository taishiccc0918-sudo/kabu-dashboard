import * as XLSX from 'xlsx'

// ── JPX 全上場銘柄マスタ（東証公式 Excel）────────────────────────────
// /api/listed-info と /api/ai-theme（サーバー側の社名照合）で共用。
// fetch の next.revalidate でサーバー側も7日キャッシュが効く。

const JPX_URL =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'

export type JpxRecord = { name: string; market: string }

function normalizeMarket(raw: string): string {
  if (raw.includes('プライム'))     return 'プライム市場'
  if (raw.includes('スタンダード')) return 'スタンダード市場'
  if (raw.includes('グロース'))     return 'グロース市場'
  return ''
}

export async function getJpxMaster(): Promise<Record<string, JpxRecord>> {
  const res = await fetch(JPX_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
    next: { revalidate: 604800 },
  })
  if (!res.ok) throw new Error(`JPX fetch failed: ${res.status}`)

  const buf = await res.arrayBuffer()
  const workbook = XLSX.read(Buffer.from(buf), { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 })

  const result: Record<string, JpxRecord> = {}
  for (const row of rows) {
    if (!row || row.length < 4) continue
    // col[1]=コード, col[2]=銘柄名, col[3]=市場・商品区分
    const rawCode = String(row[1] ?? '').trim()
    // 株式コード: 数字のみ3〜4桁 or 末尾アルファベット付き (例: 290A)
    if (!/^[0-9A-Z]{3,5}$/.test(rawCode)) continue

    const name      = String(row[2] ?? '').trim()
    const rawMarket = String(row[3] ?? '').trim()
    const market    = normalizeMarket(rawMarket)
    if (!name || !market) continue // ETF・REIT等はスキップ

    // 5桁末尾0 → 4桁に正規化 (J-Quants形式が混入した場合の保険)
    const code = rawCode.length === 5 && rawCode.endsWith('0')
      ? rawCode.slice(0, 4)
      : rawCode

    result[code] = { name, market }
  }
  return result
}
