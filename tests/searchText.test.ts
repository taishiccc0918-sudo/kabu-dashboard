import { describe, it, expect } from 'vitest'
import { matchNameToCode, stripCorpSuffix, loosen } from '../app/lib/searchText'

// AIアシストの心臓部: LLMが返した社名 → JPXマスタ照合。
// ここを通った銘柄だけが画面に出る（幻覚対策）ので、照合精度をテストで担保する。

const MASTER: Record<string, { name: string; market: string }> = {
  '7203': { name: 'トヨタ自動車', market: 'プライム市場' },
  '6758': { name: 'ソニーグループ', market: 'プライム市場' },
  '6861': { name: 'キーエンス', market: 'プライム市場' },
  '9983': { name: 'ファーストリテイリング', market: 'プライム市場' },
  '9434': { name: 'ソフトバンク', market: 'プライム市場' },
  '94345': { name: 'ソフトバンク第１回社債型種類株式', market: 'プライム市場' },
  '9984': { name: 'ソフトバンクグループ', market: 'プライム市場' },
  '8035': { name: '東京エレクトロン', market: 'プライム市場' },
  '5713': { name: '住友金属鉱山', market: 'プライム市場' },
  '6954': { name: 'ファナック', market: 'プライム市場' },
  '7974': { name: '任天堂', market: 'プライム市場' },
}

describe('stripCorpSuffix', () => {
  it('法人格・グループ表記を剥がす', () => {
    expect(stripCorpSuffix('ソニーグループ')).toBe('ソニー')
    expect(stripCorpSuffix('トヨタ自動車株式会社')).toBe('トヨタ自動車')
    expect(stripCorpSuffix('（株）任天堂')).toBe('任天堂')
  })
})

describe('matchNameToCode', () => {
  it('正式社名は完全一致する', () => {
    const hits = matchNameToCode('トヨタ自動車', MASTER)
    expect(hits[0]?.code).toBe('7203')
    expect(hits[0]?.exact).toBe(true)
  })
  it('グループ付き社名は通称でも一致する（ソニー→ソニーグループ）', () => {
    const hits = matchNameToCode('ソニー', MASTER)
    expect(hits.map(h => h.code)).toContain('6758')
  })
  it('ソフトバンクは通信(9434)と持株(9984)の両方が候補に出る', () => {
    const codes = matchNameToCode('ソフトバンク', MASTER).map(h => h.code)
    expect(codes).toContain('9434')
    expect(codes).toContain('9984')
  })
  it('5桁コード（社債型種類株式・優先株）は候補に出ない', () => {
    const codes = matchNameToCode('ソフトバンク', MASTER).map(h => h.code)
    expect(codes).not.toContain('94345')
  })
  it('ひらがな・表記ゆれでも一致する（loosen 経由）', () => {
    expect(matchNameToCode('きーえんす', MASTER)[0]?.code).toBe('6861')
    // 長音の有無ゆれ: ファーストリテーリング → ファーストリテイリング
    expect(matchNameToCode('ファーストリテーリング', MASTER)[0]?.code).toBe('9983')
  })
  it('存在しない社名は空配列（幻覚はここで落ちる）', () => {
    expect(matchNameToCode('タイムマシン製作所', MASTER)).toEqual([])
  })
  it('1〜2文字の一般語は部分一致で暴発しない', () => {
    expect(matchNameToCode('東', MASTER)).toEqual([])
  })
})

describe('loosen', () => {
  it('長音・空白を除去し連続文字を圧縮する', () => {
    expect(loosen('ファーストリテイリング')).toBe(loosen('ファストリテイリング'))
  })
})
