// ============================================================
// EDINET（金融庁の電子開示システム）API v2 共有プリミティブ
//   - 有価証券報告書から会社概要（事業内容/従業員数/セグメント等）を取得するための土台。
//   - ここは「取得・展開・解析」のみ。値の意味づけ（どの要素IDを採用するか）は
//     実物の有報をプローブ（scripts/edinet-probe.ts）で確認してから確定する。
//
// 【捏造ゼロの原則】このモジュールは一次情報（EDINETが配信するXBRL→CSV）を
//   機械的に展開・抽出するだけ。値を生成・推測しない。取れない項目は null を返す。
//
// API仕様: EDINET API 仕様書 Version 2（金融庁）。無料・要 Subscription-Key（無料登録）。
// ============================================================
import { unzipSync } from 'fflate'

export const EDINET_API_BASE = 'https://api.edinet-fsa.go.jp/api/v2'
// EDINETコード一覧（証券コード↔EDINETコードの対応表）。ZIP内に EdinetcodeDlInfo.csv（Shift_JIS）。
export const EDINET_CODELIST_URL =
  'https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip'

// 書類種別コード: 120 = 有価証券報告書
export const DOCTYPE_YUHO = '120'

// documents.json の1件（必要なフィールドのみ）
export type EdinetDoc = {
  docID: string
  secCode: string | null        // 証券コード（5桁。末尾0を落として4桁化する）
  edinetCode: string | null
  docTypeCode: string | null
  filerName: string | null
  submitDateTime: string | null // "YYYY-MM-DD HH:mm"
}

// type=5 CSV の1行（XBRL→CSV変換済み）
export type CsvRow = {
  elementId: string   // 要素ID 例 jpcrp_cor:NumberOfEmployees
  itemName: string    // 項目名（標準ラベル）
  contextRef: string  // コンテキストID 例 CurrentYearInstant / Prior1YearDuration_xxxSegmentMember
  unitId: string
  unit: string
  value: string       // 値（数値 or テキスト or HTMLブロック）
}

const ua = { 'User-Agent': 'Mozilla/5.0 (compatible; kabu-dashboard/1.0)' }

// 5桁証券コード（末尾0）→4桁に正規化。すでに4桁ならそのまま。
export function normSecCode(code: string): string {
  const c = (code ?? '').trim()
  if (/^[0-9A-Za-z]{5}$/.test(c) && c.endsWith('0')) return c.slice(0, 4)
  return c
}

// 指定日に提出された全書類の一覧を取得（type=2: 提出書類を取得）。失敗時は空配列（呼び出し側を止めない）。
export async function fetchDocList(date: string, apiKey: string): Promise<EdinetDoc[]> {
  const url = `${EDINET_API_BASE}/documents.json?date=${date}&type=2&Subscription-Key=${encodeURIComponent(apiKey)}`
  try {
    const res = await fetch(url, { headers: ua, cache: 'no-store' })
    if (!res.ok) return []
    const json = await res.json() as { results?: Array<Record<string, unknown>> }
    const results = json.results ?? []
    return results.map(r => ({
      docID: String(r.docID ?? ''),
      secCode: r.secCode != null ? String(r.secCode) : null,
      edinetCode: r.edinetCode != null ? String(r.edinetCode) : null,
      docTypeCode: r.docTypeCode != null ? String(r.docTypeCode) : null,
      filerName: r.filerName != null ? String(r.filerName) : null,
      submitDateTime: r.submitDateTime != null ? String(r.submitDateTime) : null,
    })).filter(d => d.docID)
  } catch {
    return []
  }
}

// 書類のXBRL→CSV（type=5）を取得し、ZIPを展開して CsvRow[] にして返す。
// CSVは UTF-16LE・タブ区切り（EDINET仕様）。取得/展開失敗時は空配列。
export async function fetchDocCsv(docID: string, apiKey: string): Promise<CsvRow[]> {
  const url = `${EDINET_API_BASE}/documents/${encodeURIComponent(docID)}?type=5&Subscription-Key=${encodeURIComponent(apiKey)}`
  try {
    const res = await fetch(url, { headers: ua, cache: 'no-store' })
    if (!res.ok) return []
    const buf = new Uint8Array(await res.arrayBuffer())
    const files = unzipSync(buf)
    const rows: CsvRow[] = []
    for (const [name, data] of Object.entries(files)) {
      if (!/\.csv$/i.test(name)) continue
      // 監査報告書(jpaud)系は除外し、本体(jpcrp)を優先採用（両方読んでも害はないが本体に絞る）
      const text = decodeUtf16le(data)
      rows.push(...parseEdinetCsv(text))
    }
    return rows
  } catch {
    return []
  }
}

// UTF-16LE（先頭BOM可）を文字列化。Node18+ / モダンブラウザの TextDecoder は utf-16le 対応。
export function decodeUtf16le(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-16le').decode(data)
  } catch {
    return new TextDecoder().decode(data)
  }
}

// Shift_JIS を文字列化（EDINETコード一覧CSV用）。Node18+はfull-ICUでshift_jis対応。
export function decodeShiftJis(data: Uint8Array): string {
  try {
    return new TextDecoder('shift_jis').decode(data)
  } catch {
    return new TextDecoder().decode(data)
  }
}

// EDINETのtype=5 CSV（タブ区切り・ヘッダ行あり）を CsvRow[] に。
// 列: 要素ID / 項目名 / コンテキストID / 相対年度 / 連結・個別 / 期間・時点 / ユニットID / 単位 / 値
// ※実際の列順はプローブで確認のうえ確定する。ヘッダ名でインデックスを引いて順序変更に耐える作り。
export function parseEdinetCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0)
  if (lines.length < 2) return []
  const header = lines[0].split('\t')
  const idx = (name: string) => header.findIndex(h => h.replace(/^﻿/, '').includes(name))
  const iEl = idx('要素ID'), iItem = idx('項目名'), iCtx = idx('コンテキスト'),
        iUnitId = idx('ユニットID'), iUnit = idx('単位'), iVal = idx('値')
  // ヘッダが想定と違う（仕様変更）場合は空を返し、推測抽出をしない（捏造防止）
  if (iEl < 0 || iVal < 0) return []
  const rows: CsvRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t')
    rows.push({
      elementId: (c[iEl] ?? '').trim(),
      itemName: iItem >= 0 ? (c[iItem] ?? '').trim() : '',
      contextRef: iCtx >= 0 ? (c[iCtx] ?? '').trim() : '',
      unitId: iUnitId >= 0 ? (c[iUnitId] ?? '').trim() : '',
      unit: iUnit >= 0 ? (c[iUnit] ?? '').trim() : '',
      value: (c[iVal] ?? '').trim(),
    })
  }
  return rows
}

// EDINETコード一覧ZIPを取得し、証券コード(4桁)→EDINETコード のマップを作る。失敗時は空。
export async function fetchSecToEdinetMap(): Promise<Record<string, string>> {
  try {
    const res = await fetch(EDINET_CODELIST_URL, { headers: ua, cache: 'no-store' })
    if (!res.ok) return {}
    const buf = new Uint8Array(await res.arrayBuffer())
    const files = unzipSync(buf)
    const csvEntry = Object.entries(files).find(([n]) => /\.csv$/i.test(n))
    if (!csvEntry) return {}
    const text = decodeShiftJis(csvEntry[1])
    const lines = text.split(/\r?\n/).filter(l => l.length > 0)
    // 1行目=ダウンロード日時、2行目=ヘッダ、3行目以降=データ（EDINET仕様）
    if (lines.length < 3) return {}
    const header = lines[1].split(',').map(h => h.replace(/^"|"$/g, ''))
    const iEdi = header.findIndex(h => h.includes('ＥＤＩＮＥＴコード') || h.includes('EDINETコード'))
    const iSec = header.findIndex(h => h.includes('証券コード'))
    if (iEdi < 0 || iSec < 0) return {}
    const map: Record<string, string> = {}
    for (let i = 2; i < lines.length; i++) {
      const cols = splitCsvLine(lines[i])
      const edi = (cols[iEdi] ?? '').trim()
      const sec = normSecCode((cols[iSec] ?? '').trim())
      if (edi && /^[0-9]{4}$/.test(sec)) map[sec] = edi
    }
    return map
  } catch {
    return {}
  }
}

// ダブルクオート対応の簡易CSV分割（EDINETコード一覧はカンマ区切り＋クオート）
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { inQ = !inQ; continue }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

// HTMLブロック（事業内容など）からタグを除去して素のテキストにする（原文抜粋用・生成はしない）。
export function stripHtml(s: string): string {
  return (s ?? '')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
