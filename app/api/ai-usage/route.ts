import { NextResponse } from 'next/server'
import { readUsage } from '../../lib/api-guard'

// 本日のAI利用状況（回数は消費しない・本人分のみ）。AIアシストの残り回数表示用。
// 上限値は ai-add / ai-theme の DAILY_LIMIT と揃えること。
export const dynamic = 'force-dynamic'

export async function GET() {
  const res = await readUsage({ add: 20, theme: 10 })
  if (!res.ok) return NextResponse.json({ error: 'unauthorized' }, { status: res.status })
  return NextResponse.json(res.usage)
}
