// ── Gemini 呼び出し（サーバー専用・raw fetch 版）────────────────────────
// scripts/refresh-jp-bizdesc.ts のパターンを踏襲（openai パッケージ追加なし）。
// reflect-web の知見: thinking 全開だと出力45tkに思考1400tk+で遅延・コスト増。
// 用途ごとに thinkingBudget を明示する（社名抽出=0 / テーマ検索=512）。
//
// 必要env: GEMINI_API_KEY（GEMINI_MODEL 任意・既定 gemini-2.5-flash）

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY ?? '').trim()
const GEMINI_MODEL = (process.env.GEMINI_MODEL ?? 'gemini-2.5-flash').trim()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export function hasGeminiKey(): boolean { return !!GEMINI_API_KEY }

export type GeminiJsonOpts = {
  thinkingBudget?: number   // 0=思考なし（抽出系）。512=軽い思考（テーマ検索）
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
}

// JSONを返すプロンプトを投げ、パース済みオブジェクトを返す。
// 429/503/500 は指数バックオフで3回までリトライ。失敗は throw（呼び出し側で500に変換）。
export async function geminiJson<T>(prompt: string, opts: GeminiJsonOpts = {}): Promise<T> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 未設定')
  const { thinkingBudget = 0, maxOutputTokens = 1024, temperature = 0.2, timeoutMs = 30000 } = opts
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget },
    },
  })
  let res: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal })
    } catch (e) {
      clearTimeout(to)
      if (attempt === 2) throw e
      await sleep(1500 * (attempt + 1)); continue
    }
    clearTimeout(to)
    if (res.status === 429 || res.status === 503 || res.status === 500) { await sleep(2500 * (attempt + 1)); continue }
    break
  }
  if (!res || !res.ok) throw new Error(`gemini ${res?.status ?? 'no-res'}`)
  const json = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  let text = (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('').trim()
  text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  return JSON.parse(text) as T
}
