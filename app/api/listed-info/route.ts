import { NextResponse } from 'next/server'
import * as XLSX from 'xlsx'

export const revalidate = 604800 // 7日間キャッシュ

const JPX_URL =
  'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls'

function normalizeMarket(raw: string): string {
  if (raw.includes('プライム'))     return 'プライム市場'
  if (raw.includes('スタンダード')) return 'スタンダード市場'
  if (raw.includes('グロース'))     return 'グロース市場'
  return ''
}

export async function GET() {
  try {
    const res = await fetch(JPX_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' },
      next: { revalidate: 604800 },
    })
    if (!res.ok) {
      return NextResponse.json(
        { error: `JPX fetch failed: ${res.status}` },
        { status: 502 }
      )
    }

    const buf = await res.arrayBuffer()
    const workbook = XLSX.read(Buffer.from(buf), { type: 'buffer' })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 })

    const result: Record<string, { name: string; market: string }> = {}

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

    console.log(`[listed-info] parsed ${Object.keys(result).length} stocks from JPX`)
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[listed-info] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
