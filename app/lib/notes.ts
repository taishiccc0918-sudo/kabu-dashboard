// ── 銘柄ノート（タイムライン型・追記式）─────────────────────────────
// 「上書きメモ」とは別の、日付つき記録の積み重ね。ロックインの本体。
// ローカル（localStorage）が正・即時反映、ログイン時は Supabase stock_notes に
// fire-and-forget で同期する（クラウド失敗してもローカルは常に動く）。

import { createClient } from './supabase/client'
import { StockRow, StockMeta } from './types'

export type NoteKind = 'note' | 'status_change' | 'target' | 'trade' | 'review'

export interface NoteSnapshot {
  price?: number | null
  per?: number | null
  pbr?: number | null
  divY?: number | null
  mcap?: number | null
}

export interface StockNote {
  id: string
  code: string
  market: 'jp' | 'us'
  kind: NoteKind
  body: string
  snapshot: NoteSnapshot
  meta: Record<string, unknown>
  createdAt: string   // ISO8601
}

const LS_KEY = 'stockNotes:v1'

// ── Supabase シングルトン（page.tsx の getSb と同じガード）──────────
let _sb: ReturnType<typeof createClient> | null = null
function getSb() {
  if (typeof window === 'undefined') return null
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null
  if (!_sb) _sb = createClient()
  return _sb
}
let _userId: string | null = null
/** ログイン状態を notes モジュールに伝える（page.tsx の認証リスナーから呼ぶ） */
export function setNotesUser(userId: string | null) { _userId = userId }

// ── ローカルストア（メモリキャッシュつき）──────────────────────────
let _cache: Record<string, StockNote[]> | null = null

function readAll(): Record<string, StockNote[]> {
  if (_cache) return _cache
  if (typeof window === 'undefined') return {}
  try {
    const v = localStorage.getItem(LS_KEY)
    _cache = v ? JSON.parse(v) : {}
  } catch { _cache = {} }
  return _cache!
}
function writeAll(all: Record<string, StockNote[]>) {
  _cache = all
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)) } catch { /* quota */ }
}

/** 新しい順（createdAt desc）で返す */
export function getNotes(code: string): StockNote[] {
  return readAll()[code] ?? []
}

export function getNoteCount(code: string): number {
  return getNotes(code).length
}

/** ノートを持つ全コード（検索の走査対象用） */
export function notesCodes(): string[] {
  return Object.keys(readAll()).filter(c => (readAll()[c] ?? []).length > 0)
}

/** 検索用：その銘柄の全ノート本文を連結して返す */
export function notesText(code: string): string {
  return getNotes(code).map(n => n.body).join('\n')
}

// ── 純粋ヘルパー（テスト対象・window 非依存）────────────────────────
export function sortNotesDesc(notes: StockNote[]): StockNote[] {
  return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** ローカルとクラウドを id で重複排除マージ（ローカル優先・新しい順） */
export function mergeNotes(local: StockNote[], cloud: StockNote[]): StockNote[] {
  const seen = new Set(local.map(n => n.id))
  return sortNotesDesc([...local, ...cloud.filter(n => !seen.has(n.id))])
}

/** 旧・上書きメモ → 最初のノートへの変換。id を legacy-<code> に固定し
 *  端末をまたいでも二重シードしない（クラウド upsert が同一行に収束する）。 */
export function legacyMemoToNote(code: string, memo: string, updatedAt?: string): StockNote {
  return {
    id: `legacy-${code}`,
    code,
    market: /^[A-Za-z]/.test(code) ? 'us' : 'jp',
    kind: 'note',
    body: memo,
    snapshot: {},
    meta: { source: 'legacy_memo' },
    createdAt: updatedAt ?? new Date().toISOString(),
  }
}

/** StockRow から保存時スナップショットを作る（null/0 は省く） */
export function buildSnapshot(row: StockRow | null | undefined): NoteSnapshot {
  if (!row) return {}
  const s: NoteSnapshot = {}
  if (row.close) s.price = row.close
  if (row.perF != null) s.per = row.perF
  if (row.pbr != null) s.pbr = row.pbr
  if (row.divY != null) s.divY = row.divY
  if (row.mcap) s.mcap = row.mcap
  return s
}

// ── クラウド同期（fire-and-forget。失敗してもローカルは生きる）────────
function noteToRow(n: StockNote, userId: string) {
  return {
    id: n.id, user_id: userId, code: n.code, market: n.market, kind: n.kind,
    body: n.body, snapshot: n.snapshot, meta: n.meta, created_at: n.createdAt,
  }
}
function rowToNote(r: Record<string, unknown>): StockNote {
  return {
    id: String(r.id),
    code: String(r.code),
    market: (r.market === 'us' ? 'us' : 'jp'),
    kind: (r.kind as NoteKind) ?? 'note',
    body: String(r.body ?? ''),
    snapshot: (r.snapshot as NoteSnapshot) ?? {},
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  }
}

function cloudUpsert(notes: StockNote[]) {
  const sb = getSb()
  if (!sb || !_userId || notes.length === 0) return
  const uid = _userId
  sb.from('stock_notes').upsert(notes.map(n => noteToRow(n, uid))).then(
    ({ error }) => { if (error) console.warn('[notes] クラウド保存に失敗（ローカルには保存済み）:', error.message) },
  )
}

// ── 操作 ─────────────────────────────────────────────────────────────
export function addNote(input: {
  code: string
  body: string
  kind?: NoteKind
  snapshot?: NoteSnapshot
  meta?: Record<string, unknown>
}): StockNote {
  const note: StockNote = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `n-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    code: input.code,
    market: /^[A-Za-z]/.test(input.code) ? 'us' : 'jp',
    kind: input.kind ?? 'note',
    body: input.body,
    snapshot: input.snapshot ?? {},
    meta: input.meta ?? {},
    createdAt: new Date().toISOString(),
  }
  const all = readAll()
  writeAll({ ...all, [note.code]: sortNotesDesc([note, ...(all[note.code] ?? [])]) })
  cloudUpsert([note])
  return note
}

export function deleteNote(code: string, id: string) {
  const all = readAll()
  writeAll({ ...all, [code]: (all[code] ?? []).filter(n => n.id !== id) })
  const sb = getSb()
  if (sb && _userId) {
    sb.from('stock_notes').delete().eq('user_id', _userId).eq('id', id).then(
      ({ error }) => { if (error) console.warn('[notes] クラウド削除に失敗:', error.message) },
    )
  }
}

/** その銘柄にノートが1件もなく旧メモがあるとき、旧メモを最初のノートとして取り込む。
 *  冪等（ノートが既にあれば何もしない）。タイムライン表示時に呼ぶ。 */
export function ensureLegacySeed(code: string): void {
  if (getNotes(code).length > 0) return
  if (typeof window === 'undefined') return
  let meta: StockMeta | undefined
  try {
    const v = localStorage.getItem('stockMetadata')
    meta = v ? (JSON.parse(v) as Record<string, StockMeta>)[code] : undefined
  } catch { return }
  if (!meta?.memo || !meta.memo.trim()) return
  const note = legacyMemoToNote(code, meta.memo, meta.memoUpdatedAt)
  const all = readAll()
  writeAll({ ...all, [code]: [note] })
  cloudUpsert([note])
}

/** ログイン時：クラウドの全ノートを取得してローカルとマージ、
 *  ローカルにしかない分はクラウドへ送る。 */
export async function syncNotesWithCloud(userId: string): Promise<void> {
  const sb = getSb()
  if (!sb) return
  setNotesUser(userId)
  const { data, error } = await sb.from('stock_notes').select('*').eq('user_id', userId)
  if (error) { console.warn('[notes] クラウド読込に失敗（ローカルで継続）:', error.message); return }
  const cloud = (data ?? []).map(rowToNote)
  const cloudIds = new Set(cloud.map(n => n.id))
  const all = readAll()
  const merged: Record<string, StockNote[]> = { ...all }
  for (const n of cloud) {
    merged[n.code] = mergeNotes(merged[n.code] ?? [], [n])
  }
  writeAll(merged)
  // ローカルにしかないノートをクラウドへ
  const localOnly = Object.values(all).flat().filter(n => !cloudIds.has(n.id))
  if (localOnly.length > 0) cloudUpsert(localOnly)
}
