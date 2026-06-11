import { NextResponse } from 'next/server'
import { getJpxMaster } from '../../lib/jpx'

export const revalidate = 604800 // 7日間キャッシュ

export async function GET() {
  try {
    const result = await getJpxMaster()
    console.log(`[listed-info] parsed ${Object.keys(result).length} stocks from JPX`)
    return NextResponse.json(result)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[listed-info] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
