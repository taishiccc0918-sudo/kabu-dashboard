import { NextRequest, NextResponse } from 'next/server'

const JQ_BASE = 'https://api.jquants.com/v2'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const path = searchParams.get('path')
  const apiKey = req.headers.get('x-api-key')

  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 })
  if (!apiKey) return NextResponse.json({ error: 'api key required' }, { status: 401 })

  try {
    const url = `${JQ_BASE}${path}`
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      next: { revalidate: 0 },
    })
    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ error: text }, { status: res.status })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
