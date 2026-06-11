/**
 * AIアシストの一時検証プローブ（ローカル実行専用・本番では使わない）
 * ①/api/ai-add のプロンプトで Gemini が正しいJSONを返すか
 * ②返ってきた社名が実JPXマスタで何件照合できるか（照合率の実測）
 * ③/api/ai-theme のプロンプトで禁止語が出ないか
 * 実行: GEMINI_API_KEY=... npx tsx scripts/ai-assist-probe.ts
 */
import { geminiJson } from '../app/lib/llm'
import { getJpxMaster } from '../app/lib/jpx'
import { matchNameToCode } from '../app/lib/searchText'

const BANNED_RE = /買い|売り|推奨|おすすめ|オススメ|割安|割高|上昇|下落|上がる|下がる|有望|狙い目|妙味|期待でき|値上がり|値下がり|目標株価|チャンス|仕込み/

async function main() {
  const master = await getJpxMaster()
  console.log('JPXマスタ:', Object.keys(master).length, '銘柄')

  // ── ① 機能A: 自然文 → 社名抽出（本人の実音声誤変換＋カテゴリ展開ケース）──
  // 元発話:「デンソー、双日、豊田通商、トヨタの子会社、三菱重工、三菱商事とか総合商社とかみたいな」
  const text = 'デンソー掃除トヨタ通商 トヨタの子会社三菱中古三菱商事とか総合庁舎とかみたいな'
  const promptA =
    '次の文章から、上場企業の名前を抜き出し、日本株と米国株に分けてJSONで返してください。\n' +
    '出力形式: {"jp": ["トヨタ自動車"], "us": [{"name": "NVIDIA", "ticker": "NVDA"}]}\n' +
    '規則:\n' +
    '・文章は音声認識の文字起こしの場合があり、同音異字の誤変換を含みうる。読み（発音）が同じ・近い上場企業名に解釈して正式社名に直す（例:「早実」「デンソー掃除」の掃除→読み「そうじ(つ)」→「双日」、「トヨタ通商」→「豊田通商」、「総合庁舎」→「総合商社」、「NVディア」→「NVIDIA」、「アーム」→「Arm Holdings」）。\n' +
    '・日本の通称は正式社名に直す（例:「トヨタ」→「トヨタ自動車」）。\n' +
    '・「〜の子会社」「〜グループ」「三菱商事とか総合商社みたいな」のようなカテゴリ・グループ表現は、該当する代表的な上場企業を5〜6社に展開して含める（例:「トヨタの子会社」→豊田自動織機・デンソー・アイシン・豊田通商・トヨタ紡織、「総合商社」→三菱商事・三井物産・伊藤忠商事・住友商事・丸紅）。\n' +
    '・「ソフトバンク」のように通信子会社と持株会社のどちらか文脈で判別できない場合は両方の社名を含める。\n' +
    '・米国上場企業は us に入れ、ticker は米国市場の正式ティッカーを書く（例: Arm Holdings→ARM）。\n' +
    '・株価指数・投資信託・ETF・一般名詞は含めない。\n' +
    '・社名と思われる語は、知らない会社・上場しているか確信がない会社でも「そのままの表記」で jp に含めてよい（実在確認は後段のマスタ照合で行う。例: IMV、中小型株）。\n' +
    '・ただし読みの補正で「別の社名」に置き換えるのは確信がある場合のみ（無理に近い社名をあてない・推測で別会社を作らない）。\n' +
    '・合計最大30社。該当なしは {"jp": [], "us": []}。\n\n' +
    `文章: ${text}`
  const a = await geminiJson<{ jp: string[]; us: { name: string; ticker: string }[] }>(promptA, { thinkingBudget: 0, maxOutputTokens: 1024 })
  console.log('\n[機能A] JP:', JSON.stringify(a.jp), '\n        US:', JSON.stringify(a.us))
  for (const n of a.jp ?? []) {
    const hits = matchNameToCode(n, master)
    console.log(`  ${n} → ${hits.length === 0 ? '照合不可✗' : hits.map(h => `${h.code} ${h.name}${h.exact ? '(完全)' : ''}`).join(' / ')}`)
  }

  // ── ③ 機能B: テーマ → 社名＋事実 ──
  const theme = 'レアアース'
  const promptB =
    `テーマ「${theme}」に事業内容が関連する、日本の証券取引所に上場している企業を挙げてください。\n` +
    '出力形式: {"companies": [{"name": "正式社名", "relation": "事業上の関連の説明(40字以内)"}]}\n' +
    '規則:\n' +
    '・relation は事実の記述のみ。「〜を手掛ける」「〜を製造している」「〜と開示している」のような書き方。\n' +
    '・投資判断・推奨・予測の語(買い/売り/推奨/おすすめ/割安/割高/上がる/下がる/有望/期待/目標株価 等)は一切使わない。\n' +
    '・テーマとの関連が事業として確実な企業のみ。確信が持てない企業・関連が薄い企業は含めない。\n' +
    '・ETF・投資信託・米国株・未上場企業は含めない。\n' +
    '・最大10社。該当が無ければ {"companies": []}。\n'
  const b = await geminiJson<{ companies: { name: string; relation: string }[] }>(promptB, { thinkingBudget: 512, maxOutputTokens: 1536, timeoutMs: 45000 })
  console.log(`\n[機能B] テーマ「${theme}」候補: ${b.companies.length}社`)
  for (const c of b.companies) {
    const hits = matchNameToCode(c.name, master)
    const hit = hits.find(h => h.exact) ?? (hits.length === 1 ? hits[0] : undefined)
    const banned = BANNED_RE.test(c.relation) ? ' ⚠️禁止語!' : ''
    console.log(`  ${c.name} → ${hit ? `${hit.code} ${hit.name}` : '照合不可✗'} | ${c.relation}${banned}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
