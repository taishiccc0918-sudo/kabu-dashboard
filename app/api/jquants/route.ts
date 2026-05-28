import { NextRequest, NextResponse } from 'next/server'

const JQ_BASE = 'https://api.jquants.com/v2'

// ── 簡易レート制限（同一IPから 60秒で 60リクエストまで） ─────────────
// Vercelサーバーレス環境では関数インスタンス単位のメモリなので完全防御ではないが、
// 暴走スクリプトや誤ループ呼び出しの一次抑止として機能する。
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60
const ipHits = new Map<string, { count: number; resetAt: number }>()

function getClientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') || 'unknown'
}

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = ipHits.get(ip)
  if (!entry || entry.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  entry.count += 1
  if (entry.count > RATE_LIMIT_MAX) return true
  return false
}

// J-Quants の有効パス（プレフィックスホワイトリスト）。
// SSRF 防止と意図しないエンドポイント叩きの抑止。
const ALLOWED_PATH_PREFIXES = [
  '/equities/',
  '/fins/',
  '/prices/',
  '/markets/',
  '/listed/',
  '/derivatives/',
  '/indices/',
]

function isAllowedPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  if (path.includes('..') || path.includes('//')) return false
  return ALLOWED_PATH_PREFIXES.some(p => path.startsWith(p))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const path = searchParams.get('path')

  // サーバー環境変数キーを優先（設定されていればクライアントキーは無視）
  const apiKey = process.env.JQUANTS_API_KEY || req.headers.get('x-api-key') || ''

  if (!path) return NextResponse.json({ error: 'path required' }, { status: 400 })
  if (!isAllowedPath(path)) return NextResponse.json({ error: 'path not allowed' }, { status: 400 })
  if (!apiKey) return NextResponse.json({ error: 'api key required' }, { status: 401 })

  const ip = getClientIp(req)
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: 'rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

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
