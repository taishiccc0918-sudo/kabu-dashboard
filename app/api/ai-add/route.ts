import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { geminiJson, hasGeminiKey } from '../../lib/llm'
import { requireUserAndQuota } from '../../lib/api-guard'

// ── AIアシスト①: 自然文 → 社名リスト抽出（日本株＋米国株）─────────────
// 「トヨタとNVIDIA追加して」→ {"jp":["トヨタ自動車"],"us":[{"name":"NVIDIA","ticker":"NVDA"}]}
// 日本株: LLMは社名のみ→クライアントが JPX マスタ照合（コードを答えさせない＝幻覚対策）。
// 米国株: LLMのティッカーは Supabase us_master 照合を通ったものだけ返す（同上）。
// ログイン必須・1ユーザー20回/日・thinking 0 でコスト最小。

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const DAILY_LIMIT = 20
const MAX_INPUT = 800

export type UsHit = { ticker: string; name: string; market: string; mcap: number | null }

export async function POST(req: NextRequest) {
  if (!hasGeminiKey()) {
    return NextResponse.json({ error: 'AI機能は準備中です（GEMINI_API_KEY 未設定）' }, { status: 503 })
  }
  let text = ''
  try { text = String(((await req.json()) as { text?: unknown }).text ?? '').trim() } catch { /* fallthrough */ }
  if (!text) return NextResponse.json({ error: '文章を入力してください' }, { status: 400 })
  if (text.length > MAX_INPUT) text = text.slice(0, MAX_INPUT)

  const guard = await requireUserAndQuota('add', DAILY_LIMIT)
  if (!guard.ok) return NextResponse.json({ error: guard.message }, { status: guard.status })

  const prompt =
    '次の文章から、上場企業の名前を抜き出し、日本株と米国株に分けてJSONで返してください。\n' +
    '出力形式: {"jp": ["トヨタ自動車"], "us": [{"name": "NVIDIA", "ticker": "NVDA"}]}\n' +
    '規則:\n' +
    '・文章は音声認識の文字起こしの場合があり、同音異字の誤変換を含みうる。読み（発音）が同じ・近い上場企業名に解釈して正式社名に直す（例:「早実」→読み「そうじつ」→「双日」、「NVディア」→「NVIDIA」、「アーム」→「Arm Holdings」）。\n' +
    '・日本の通称は正式社名に直す（例:「トヨタ」→「トヨタ自動車」）。\n' +
    '・「ソフトバンク」のように通信子会社と持株会社のどちらか文脈で判別できない場合は両方の社名を含める。\n' +
    '・米国上場企業は us に入れ、ticker は米国市場の正式ティッカーを書く（例: Arm Holdings→ARM）。\n' +
    '・株価指数・投資信託・ETF・一般名詞は含めない。\n' +
    '・社名と思われる語は、知らない会社・上場しているか確信がない会社でも「そのままの表記」で jp に含めてよい（実在確認は後段のマスタ照合で行う。例: IMV、中小型株）。\n' +
    '・ただし読みの補正で「別の社名」に置き換えるのは確信がある場合のみ（無理に近い社名をあてない・推測で別会社を作らない）。\n' +
    '・合計最大30社。該当なしは {"jp": [], "us": []}。\n\n' +
    `文章: ${text}`

  try {
    const out = await geminiJson<{ jp?: unknown; us?: unknown }>(prompt, { thinkingBudget: 0, maxOutputTokens: 1024 })
    const names = Array.isArray(out.jp)
      ? out.jp.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map(n => n.trim()).slice(0, 30)
      : []
    const usRaw = Array.isArray(out.us)
      ? out.us.filter((u): u is { name?: string; ticker?: string } => !!u && typeof u === 'object')
          .map(u => ({ name: String(u.name ?? '').trim(), ticker: String(u.ticker ?? '').trim().toUpperCase() }))
          .filter(u => u.ticker.length > 0 && /^[A-Z.]{1,6}$/.test(u.ticker))
          .slice(0, 30)
      : []

    // 米国株は us_master 照合を通ったものだけ返す（LLMのティッカー幻覚はここで落ちる）
    let us: UsHit[] = []
    let usUnmatched: string[] = []
    if (usRaw.length > 0) {
      const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
      const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
      if (url && anon) {
        try {
          const sb = createClient(url, anon, { auth: { persistSession: false } })
          const { data } = await sb.from('us_master')
            .select('ticker,name,exchange,mcap')
            .in('ticker', usRaw.map(u => u.ticker))
          const found = new Map(((data ?? []) as { ticker: string; name: string | null; exchange: string | null; mcap: number | null }[])
            .map(r => [r.ticker, r]))
          for (const u of usRaw) {
            const hit = found.get(u.ticker)
            if (hit) us.push({ ticker: hit.ticker, name: hit.name ?? u.name ?? hit.ticker, market: hit.exchange ?? '', mcap: hit.mcap ?? null })
            else usUnmatched.push(u.name || u.ticker)
          }
        } catch { usUnmatched = usRaw.map(u => u.name || u.ticker); us = [] }
      }
    }
    return NextResponse.json({ names, us, usUnmatched })
  } catch (e) {
    console.error('[ai-add] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'AIの呼び出しに失敗しました。少し待ってからもう一度お試しください' }, { status: 502 })
  }
}
