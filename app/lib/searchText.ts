// ── 検索用テキスト正規化（page.tsx から移出した共通関数群）──────────────
// AIアシスト（自然文→社名→コード照合）でも使うため lib 化。
// 重要: LLM にコードを答えさせず、ここでの JPX マスタ照合を通った銘柄だけを採用する（幻覚対策）。

// 検索正規化: ひらがな→カタカナ + NFKC全角→半角 + 小文字化
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .toLowerCase()
}

// 検索用: 全角英数字を半角化＋小文字化（「ＩＭＶ」「imv」どちらでもヒット）
export function normJa(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase()
}

// メディア名の表記ゆれ吸収（全角/半角括弧・空白の差）。「株探(かぶたん)」と「株探（かぶたん）」を同一視。
export function normSource(s: string): string {
  return (s || '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '').toLowerCase()
}

// カナ→ローマ字（簡易ヘボン式）。「ファナック」→"fanakku" 等。検索でローマ字/英語入力に対応するため。
const ROMAJI_2: Record<string, string> = {
  'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho','チャ':'cha','チュ':'chu','チョ':'cho',
  'ニャ':'nya','ニュ':'nyu','ニョ':'nyo','ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo','ジャ':'ja','ジュ':'ju','ジョ':'jo',
  'ビャ':'bya','ビュ':'byu','ビョ':'byo','ピャ':'pya','ピュ':'pyu','ピョ':'pyo',
  'ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo','ウィ':'wi','ウェ':'we','ウォ':'wo','ヴァ':'va','ヴィ':'vi','ヴェ':'ve','ヴォ':'vo',
  'ティ':'ti','ディ':'di','トゥ':'tu','ドゥ':'du','チェ':'che','シェ':'she','ジェ':'je',
}
const ROMAJI_1: Record<string, string> = {
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o','カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko','ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so','ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo','タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do','ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no','ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo','パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po','マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo',
  'ヤ':'ya','ユ':'yu','ヨ':'yo','ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro','ワ':'wa','ヲ':'wo','ン':'n','ヴ':'vu','ー':'','ッ':'','・':' ',
}
export function toRomaji(s: string): string {
  // ひらがな→カタカナに寄せる
  const kata = s.replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
  let out = ''
  for (let i = 0; i < kata.length;) {
    const two = kata.slice(i, i + 2)
    if (ROMAJI_2[two]) { out += ROMAJI_2[two]; i += 2; continue }
    const one = kata[i]
    out += ROMAJI_1[one] ?? one
    i++
  }
  return out
}
// あいまい一致用にゆるく正規化（c→k統一・連続文字を1つに・長音記号除去）
export function loosen(s: string): string {
  return normJa(s).replace(/[ー\s・,，、。]/g, '').replace(/c/g, 'k').replace(/l/g, 'r').replace(/(.)\1+/g, '$1')
}
// 銘柄1件の検索用テキスト（日本語名＋ローマ字＋コード）
export function stockHaystack(name: string, code: string): string {
  return loosen(name) + ' ' + loosen(toRomaji(name)) + ' ' + code.toLowerCase()
}

// ── 社名→コード照合（AIアシスト用）─────────────────────────────────

// 法人格・グループ表記を剥がす。「ソニーグループ」⇄「ソニー」、「（株）」等の揺れを吸収。
export function stripCorpSuffix(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/株式会社|\(株\)|（株）|ホールディングス|ホールディング|グループ|グループ本社|HD|G\b/gi, '')
    .trim()
}

export type NameMatch = { code: string; name: string; market: string; exact: boolean }

// 子音キー: ローマ字化して母音を除去。「リテーリング/リテイリング」のような母音・長音ゆれを吸収する
// 最終フォールバック用（等価比較のみ・部分一致には使わない＝過剰マッチ防止）。
function consonantKey(s: string): string {
  return loosen(toRomaji(stripCorpSuffix(s))).replace(/[aeiou]/g, '')
}

// 照合用キー: ひらがな→カタカナ（normalizeSearchText）まで揃えてから loosen。
// 「きーえんす」と「キーエンス」を同一視するため。
function matchKey(s: string): string {
  return loosen(normalizeSearchText(stripCorpSuffix(s)))
}

// 社名1件を JPX マスタ（code → {name, market}）に照合し、確からしい順に最大5件返す。
// 完全一致（法人格除去後）＞ 前方一致（2文字以上）＞ 部分一致（3文字以上）＞ 子音キー一致。
// 完全一致が複数あればそれを全部返す
// （例:「ソフトバンク」→ ソフトバンク(9434) と、グループ除去で一致する ソフトバンクグループ(9984)）。
export function matchNameToCode(
  rawName: string,
  masterDB: Record<string, { name: string; market: string }>,
): NameMatch[] {
  const q = matchKey(rawName)
  if (!q) return []
  const exact: NameMatch[] = []
  const prefix: NameMatch[] = []
  const partial: NameMatch[] = []
  for (const [code, rec] of Object.entries(masterDB)) {
    if (!rec?.name) continue
    // 5桁コード＝社債型種類株式・優先株等（例: 94345 ソフトバンク第１回社債型種類株式）は普通株でないため除外
    if (code.length > 4) continue
    const cand = matchKey(rec.name)
    if (!cand) continue
    if (cand === q) { exact.push({ code, name: rec.name, market: rec.market, exact: true }); continue }
    // 前方一致は2文字以上のときだけ（「東」1文字で東京◯◯が全部出る暴発防止）
    if (q.length >= 2 && cand.length >= 2 && (cand.startsWith(q) || q.startsWith(cand))) {
      prefix.push({ code, name: rec.name, market: rec.market, exact: false }); continue
    }
    // 部分一致は3文字以上のときだけ
    if (q.length >= 3 && cand.includes(q)) partial.push({ code, name: rec.name, market: rec.market, exact: false })
  }
  const byNameLen = (a: NameMatch, b: NameMatch) => a.name.length - b.name.length
  if (exact.length > 0) return [...exact.sort(byNameLen), ...prefix.sort(byNameLen)].slice(0, 5)
  if (prefix.length > 0) return prefix.sort(byNameLen).slice(0, 5)
  if (partial.length > 0) return partial.sort(byNameLen).slice(0, 5)
  // 最終フォールバック: 母音ゆれ吸収（ファーストリテーリング→ファーストリテイリング等）。
  // 短い名前は衝突しやすいのでキー5文字以上のみ・完全一致のみ。
  const qKey = consonantKey(rawName)
  if (qKey.length < 5) return []
  const fuzzy: NameMatch[] = []
  for (const [code, rec] of Object.entries(masterDB)) {
    if (!rec?.name) continue
    if (code.length > 4) continue
    if (consonantKey(rec.name) === qKey) fuzzy.push({ code, name: rec.name, market: rec.market, exact: false })
  }
  return fuzzy.sort(byNameLen).slice(0, 5)
}
