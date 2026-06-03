/**
 * EDINET 有報の中身を「実物で確認する」検証ツール（捏造ゼロのための要）。
 *
 * 目的: 推測で抽出ロジックを書かない。実際の有価証券報告書1社分のXBRL→CSVをダンプし、
 *   従業員数・事業内容・代表者・沿革・セグメント別売上が「どの要素ID／コンテキスト」に
 *   入っているかを目視確認してから、収集スクリプト(refresh-edinet.ts)の抽出を確定する。
 *
 * 必要な環境変数:
 *   EDINET_API_KEY … EDINET API v2 の Subscription-Key（無料登録で発行）
 *
 * 使い方（WSLで実行）:
 *   EDINET_API_KEY=xxxx npx tsx scripts/edinet-probe.ts 7203          # 証券コードから最新の有報を探す
 *   EDINET_API_KEY=xxxx npx tsx scripts/edinet-probe.ts --doc S100XXXX # docIDを直接指定
 *   （任意）第2引数に走査開始日 YYYY-MM-DD。既定は今日から遡って最大420日。
 */
import {
  fetchSecToEdinetMap, fetchDocList, fetchDocCsv, normSecCode,
  stripHtml, extractFactsheet, DOCTYPE_YUHO, type CsvRow,
} from '../app/lib/edinet'

const API_KEY = (process.env.EDINET_API_KEY ?? '').trim()
if (!API_KEY) { console.error('環境変数 EDINET_API_KEY が未設定です'); process.exit(1) }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const fmtDate = (d: Date) => d.toISOString().slice(0, 10)

async function findLatestYuho(secCode: string, startDate?: string): Promise<string | null> {
  const map = await fetchSecToEdinetMap()
  const edi = map[normSecCode(secCode)]
  if (!edi) { console.error(`証券コード ${secCode} に対応するEDINETコードが見つかりません`); return null }
  console.log(`EDINETコード: ${edi}`)

  const start = startDate ? new Date(startDate) : new Date()
  const MAX_DAYS = 420
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date(start.getTime() - i * 86400000)
    const date = fmtDate(d)
    const docs = await fetchDocList(date, API_KEY)
    const hit = docs.find(x => x.edinetCode === edi && x.docTypeCode === DOCTYPE_YUHO)
    if (hit) {
      console.log(`有報を発見: ${date} docID=${hit.docID} 提出者=${hit.filerName}`)
      return hit.docID
    }
    if (i % 20 === 0) console.log(`  走査中… ${date}（${i}/${MAX_DAYS}日）`)
    await sleep(3500) // レート制限（仕様: 3〜5秒間隔）
  }
  console.error('過去420日に有価証券報告書が見つかりませんでした')
  return null
}

function dump(rows: CsvRow[]) {
  console.log(`\n=== CSV総行数: ${rows.length} ===`)

  const show = (label: string, pred: (r: CsvRow) => boolean, limit = 12, textPreview = false) => {
    const hits = rows.filter(pred)
    console.log(`\n--- ${label}（${hits.length}件）---`)
    for (const r of hits.slice(0, limit)) {
      const v = textPreview ? stripHtml(r.value).slice(0, 160).replace(/\n/g, ' ') : r.value
      console.log(`  [${r.elementId}] ctx=${r.contextRef} unit=${r.unit} 項目=${r.itemName}\n     値: ${v}`)
    }
  }

  show('従業員数 NumberOfEmployees', r => /NumberOfEmployees/i.test(r.elementId))
  show('事業の内容 DescriptionOfBusiness', r => /DescriptionOfBusiness/i.test(r.elementId), 4, true)
  show('沿革 History', r => /History|沿革/i.test(r.elementId) || /沿革/.test(r.itemName), 4, true)
  show('代表者・提出者(DEI)', r => /jpdei/i.test(r.elementId) || /代表者|氏名/.test(r.itemName), 20)
  show('セグメント売上候補', r =>
    /Segment/i.test(r.contextRef) && /(NetSales|Sales|Revenue)/i.test(r.elementId), 30)
  show('設立年月日 候補', r => /Establish|設立|創業/i.test(r.elementId) || /設立|創業/.test(r.itemName), 6, true)

  // セグメントのコンテキスト一覧（メンバー名＝事業区分名がコンテキストに埋まる）
  const segCtx = Array.from(new Set(rows.filter(r => /Segment/i.test(r.contextRef)).map(r => r.contextRef)))
  console.log(`\n--- セグメント系コンテキスト一覧（${segCtx.length}件）---`)
  segCtx.slice(0, 40).forEach(c => console.log(`  ${c}`))
}

async function main() {
  const args = process.argv.slice(2)
  let docID: string | null = null
  if (args[0] === '--doc' && args[1]) {
    docID = args[1]
  } else if (args[0]) {
    docID = await findLatestYuho(args[0], args[1])
  } else {
    console.error('使い方: tsx scripts/edinet-probe.ts <証券コード> [開始日YYYY-MM-DD]  /  --doc <docID>')
    process.exit(1)
  }
  if (!docID) process.exit(1)

  console.log(`\n書類CSV(type=5)を取得します: ${docID}`)
  const rows = await fetchDocCsv(docID, API_KEY)
  if (rows.length === 0) { console.error('CSVが取得できませんでした（キー/docID/仕様変更を確認）'); process.exit(1) }
  dump(rows)

  console.log('\n========== extractFactsheet() の抽出結果（実際にDBへ入る値）==========')
  console.log(JSON.stringify(extractFactsheet(rows), null, 2))
  console.log('\n完了。')
}

main().catch(e => { console.error(e); process.exit(1) })
