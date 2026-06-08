import { NextRequest, NextResponse } from 'next/server'
import { fetchYahooDaily } from '../../lib/usApi'

// 米国株の日足チャートデータ。Yahoo Finance から取得し、J-Quants互換の形（{data:[{Date,AdjC}]}）で返す。
// これにより既存の MiniChart(parseStock) がそのまま描画できる。無料・キー不要。
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const ticker = (sp.get('ticker') ?? '').trim()
  const from = (sp.get('from') ?? '').replace(/\D/g, '')  // YYYYMMDD
  const to = (sp.get('to') ?? '').replace(/\D/g, '')
  if (!ticker || from.length !== 8 || to.length !== 8) return NextResponse.json({ data: [] })
  const fromISO = `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`
  const toISO = `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}`
  try {
    const daily = await fetchYahooDaily(ticker, fromISO, toISO)
    return NextResponse.json({ data: daily.map(d => ({ Date: d.date, AdjC: d.price })) })
  } catch (e) {
    console.error('[us-chart] error:', e instanceof Error ? e.message : String(e))
    return NextResponse.json({ data: [] })
  }
}
