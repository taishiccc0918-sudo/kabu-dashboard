// ── 銘柄ステータス（気になる→ウォッチ中→買いたい→保有→売却済み）────
// 銘柄ごとの「いまの状態」＋目標価格＋買いたい理由。1銘柄1行。
// ローカル（localStorage）が正・即時反映、ログイン時は Supabase stock_states に
// fire-and-forget で同期（notes.ts と同じ作法）。
// ステータス変更の履歴は stock_notes（kind='status_change'）に自動で積む。

import { createClient } from './supabase/client'
import { addNote, NoteSnapshot } from './notes'

export type StockStatus = 'interested' | 'watching' | 'want_to_buy' | 'holding' | 'sold' | 'archived'

export const STATUS_LABEL: Record<StockStatus, string> = {
  interested: '気になる',
  watching: 'ウォッチ中',
  want_to_buy: '買いたい',
  holding: '保有',
  sold: '売却済み',
  archived: 'アーカイブ',
}

/** UIで選べるステータス（archived は当面UI非表示） */
export const STATUS_OPTIONS: StockStatus[] = ['interested', 'watching', 'want_to_buy', 'holding', 'sold']

export interface StockState {
  code: string
  status: StockStatus
  targetPrice: number | null
  buyReason: string
  statusChangedAt: string  // ISO8601
  updatedAt: string        // ISO8601
}

const LS_KEY = 'stockStates:v1'

// ── Supabase シングルトン（notes.ts と同じガード）────────────────────
let _sb: ReturnType<typeof createClient> | null = null
function getSb() {
  if (typeof window === 'undefined') return null
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null
  if (!_sb) _sb = createClient()
  return _sb
}
let _userId: string | null = null
export function setStatesUser(userId: string | null) { _userId = userId }

// ── ローカルストア（メモリキャッシュつき）──────────────────────────
let _cache: Record<string, StockState> | null = null

function readAll(): Record<string, StockState> {
  if (_cache) return _cache
  if (typeof window === 'undefined') return {}
  try {
    const v = localStorage.getItem(LS_KEY)
    _cache = v ? JSON.parse(v) : {}
  } catch { _cache = {} }
  return _cache!
}
function writeAll(all: Record<string, StockState>) {
  _cache = all
  if (typeof window === 'undefined') return
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)) } catch { /* quota */ }
}

export function getState(code: string): StockState | null {
  return readAll()[code] ?? null
}

export function getAllStates(): Record<string, StockState> {
  return readAll()
}

// ── 純粋ヘルパー（テスト対象・window 非依存）────────────────────────
/** 明示設定がない銘柄の表示用デフォルト：♥=買いたい／★=ウォッチ中 */
export function defaultStatus(isHeart: boolean): StockStatus {
  return isHeart ? 'want_to_buy' : 'watching'
}

/** 表示用の実効ステータス（明示設定 > ♥/★ デフォルト） */
export function effectiveStatus(state: StockState | null, isHeart: boolean): StockStatus {
  return state?.status ?? defaultStatus(isHeart)
}

/** updated_at の新しい方を採用してマージ（ローカル vs クラウド） */
export function mergeStates(
  local: Record<string, StockState>,
  cloud: Record<string, StockState>,
): Record<string, StockState> {
  const merged: Record<string, StockState> = { ...cloud }
  for (const [code, s] of Object.entries(local)) {
    const c = merged[code]
    if (!c || s.updatedAt.localeCompare(c.updatedAt) >= 0) merged[code] = s
  }
  return merged
}

// ── クラウド同期 ─────────────────────────────────────────────────────
function stateToRow(s: StockState, userId: string) {
  return {
    user_id: userId, code: s.code, status: s.status,
    target_price: s.targetPrice, buy_reason: s.buyReason,
    status_changed_at: s.statusChangedAt, updated_at: s.updatedAt,
  }
}
function rowToState(r: Record<string, unknown>): StockState {
  return {
    code: String(r.code),
    status: (r.status as StockStatus) ?? 'watching',
    targetPrice: r.target_price == null ? null : Number(r.target_price),
    buyReason: String(r.buy_reason ?? ''),
    statusChangedAt: String(r.status_changed_at ?? r.updated_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }
}

function cloudUpsert(states: StockState[]) {
  const sb = getSb()
  if (!sb || !_userId || states.length === 0) return
  const uid = _userId
  sb.from('stock_states').upsert(states.map(s => stateToRow(s, uid))).then(
    ({ error }) => { if (error) console.warn('[states] クラウド保存に失敗（ローカルには保存済み）:', error.message) },
  )
}

// ── 操作 ─────────────────────────────────────────────────────────────
/** ステータスを変更。変更があればタイムライン（stock_notes）にも自動記録。 */
export function setStatus(code: string, status: StockStatus, opts?: {
  prevEffective?: StockStatus       // 変更前の実効ステータス（ノート記録用）
  snapshot?: NoteSnapshot           // 当時の株価等（notes.buildSnapshot で作る）
}): StockState {
  const now = new Date().toISOString()
  const prev = getState(code)
  const next: StockState = {
    code,
    status,
    targetPrice: prev?.targetPrice ?? null,
    buyReason: prev?.buyReason ?? '',
    statusChangedAt: now,
    updatedAt: now,
  }
  writeAll({ ...readAll(), [code]: next })
  cloudUpsert([next])
  const from = opts?.prevEffective ?? prev?.status
  if (from !== status) {
    addNote({
      code,
      kind: 'status_change',
      body: `${from ? STATUS_LABEL[from] : '未設定'} → ${STATUS_LABEL[status]}`,
      snapshot: opts?.snapshot ?? {},
      meta: { from: from ?? null, to: status },
    })
  }
  return next
}

/** 目標価格・買いたい理由の更新（ステータスは変えない） */
export function setStateFields(code: string, fields: { targetPrice?: number | null; buyReason?: string }, opts?: {
  fallbackStatus?: StockStatus      // 行が無いときの初期ステータス（実効値）
  snapshot?: NoteSnapshot
}): StockState {
  const now = new Date().toISOString()
  const prev = getState(code)
  const next: StockState = {
    code,
    status: prev?.status ?? opts?.fallbackStatus ?? 'watching',
    targetPrice: fields.targetPrice !== undefined ? fields.targetPrice : (prev?.targetPrice ?? null),
    buyReason: fields.buyReason !== undefined ? fields.buyReason : (prev?.buyReason ?? ''),
    statusChangedAt: prev?.statusChangedAt ?? now,
    updatedAt: now,
  }
  writeAll({ ...readAll(), [code]: next })
  cloudUpsert([next])
  // 目標価格を新規設定/変更したらタイムラインにも残す（事実の記録）
  if (fields.targetPrice !== undefined && fields.targetPrice !== (prev?.targetPrice ?? null) && fields.targetPrice != null) {
    addNote({
      code,
      kind: 'target',
      body: `目標価格を ${fields.targetPrice.toLocaleString()} に設定`,
      snapshot: opts?.snapshot ?? {},
      meta: { target_price: fields.targetPrice },
    })
  }
  return next
}

/** ログイン時：クラウドの全ステータスとマージ（updated_at 新しい方優先）。 */
export async function syncStatesWithCloud(userId: string): Promise<void> {
  const sb = getSb()
  if (!sb) return
  setStatesUser(userId)
  const { data, error } = await sb.from('stock_states').select('*').eq('user_id', userId)
  if (error) { console.warn('[states] クラウド読込に失敗（ローカルで継続）:', error.message); return }
  const cloud: Record<string, StockState> = {}
  for (const r of data ?? []) { const s = rowToState(r); cloud[s.code] = s }
  const local = readAll()
  const merged = mergeStates(local, cloud)
  writeAll(merged)
  // ローカルが勝った行（クラウドに無い/古い）をクラウドへ
  const toPush = Object.values(merged).filter(s => {
    const c = cloud[s.code]
    return !c || s.updatedAt.localeCompare(c.updatedAt) > 0
  })
  if (toPush.length > 0) cloudUpsert(toPush)
}
