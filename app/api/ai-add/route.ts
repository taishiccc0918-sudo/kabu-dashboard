import { NextRequest, NextResponse } from 'next/server'
import { geminiJson, hasGeminiKey } from '../../lib/llm'
import { requireUserAndQuota } from '../../lib/api-guard'

// ── AIアシスト①: 自然文 → 社名リスト抽出 ─────────────────────────────
// 「トヨタとソニーとキーエンス追加して」→ {"names":["トヨタ自動車","ソニーグループ","キーエンス"]}
// LLM の仕事は社名抽出のみ。コード解決はクライアントが JPX マスタ（masterDB）照合で行い、
// 照合できた銘柄だけ表示する＝幻覚が登録に直結しない設計。
// ログイン必須・1ユーザー20回/日・thinking 0 でコスト最小。

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const DAILY_LIMIT = 20
const MAX_INPUT = 500

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
    '次の文章から、日本の証券取引所に上場している企業の名前だけを抜き出し、JSONで返してください。\n' +
    '出力形式: {"names": ["トヨタ自動車", "ソニーグループ"]}\n' +
    '規則:\n' +
    '・文章は音声認識の文字起こしの場合があり、同音異字の誤変換を含みうる。読み（発音）が同じ・近い上場企業名に解釈して正式社名に直す（例:「早実」→読み「そうじつ」→「双日」、「村田製作所」が「むら田製作所」等）。\n' +
    '・通称は正式社名に直す（例:「トヨタ」→「トヨタ自動車」）。\n' +
    '・「ソフトバンク」のように通信子会社と持株会社のどちらか文脈で判別できない場合は両方の社名を含める。\n' +
    '・株価指数・投資信託・ETF・米国株・上場していない企業・一般名詞は含めない。\n' +
    '・読み補正してもどの上場企業か確信が持てない語は含めない（無理に近い社名をあてない。推測で作らない）。\n' +
    '・最大20社。該当なしは {"names": []}。\n\n' +
    `文章: ${text}`

  try {
    const out = await geminiJson<{ names?: unknown }>(prompt, { thinkingBudget: 0, maxOutputTokens: 512 })
    const names = Array.isArray(out.names)
      ? out.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map(n => n.trim()).slice(0, 20)
      : []
    return NextResponse.json({ names })
  } catch (e) {
    console.error('[ai-add] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'AIの呼び出しに失敗しました。少し待ってからもう一度お試しください' }, { status: 502 })
  }
}
