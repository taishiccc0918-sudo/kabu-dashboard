// 米国主要銘柄の社名カタカナ表記（手作り辞書・固定データ）。
// 読み仮名の無料データ源が無いため、主要銘柄のみ。辞書に無い銘柄は英語名のまま表示する。
// 使い方: カナ表示トグルがONのとき usName() がカタカナを返す（モジュール変数で全表示に反映）。

export const US_KATAKANA: Record<string, string> = {
  AAPL: 'アップル', MSFT: 'マイクロソフト', GOOGL: 'アルファベット（グーグル）', GOOG: 'アルファベット（グーグル）',
  AMZN: 'アマゾン', NVDA: 'エヌビディア', META: 'メタ（旧フェイスブック）', TSLA: 'テスラ',
  'BRK-B': 'バークシャー・ハサウェイ', AVGO: 'ブロードコム', LLY: 'イーライリリー', JPM: 'JPモルガン・チェース',
  V: 'ビザ', UNH: 'ユナイテッドヘルス', XOM: 'エクソンモービル', MA: 'マスターカード',
  JNJ: 'ジョンソン・エンド・ジョンソン', PG: 'プロクター・アンド・ギャンブル', HD: 'ホーム・デポ', COST: 'コストコ',
  ORCL: 'オラクル', MRK: 'メルク', ABBV: 'アッヴィ', CVX: 'シェブロン', KO: 'コカ・コーラ',
  PEP: 'ペプシコ', ADBE: 'アドビ', BAC: 'バンク・オブ・アメリカ', CRM: 'セールスフォース', AMD: 'AMD（アドバンスト・マイクロ・デバイセズ）',
  NFLX: 'ネットフリックス', TMO: 'サーモフィッシャー', ACN: 'アクセンチュア', LIN: 'リンデ', MCD: 'マクドナルド',
  CSCO: 'シスコシステムズ', ABT: 'アボット・ラボラトリーズ', WMT: 'ウォルマート', DHR: 'ダナハー', INTC: 'インテル',
  WFC: 'ウェルズ・ファーゴ', TXN: 'テキサス・インスツルメンツ', QCOM: 'クアルコム', PM: 'フィリップ・モリス', DIS: 'ウォルト・ディズニー',
  VZ: 'ベライゾン', INTU: 'インテュイット', CAT: 'キャタピラー', IBM: 'IBM', AMGN: 'アムジェン',
  NOW: 'サービスナウ', UNP: 'ユニオン・パシフィック', GE: 'ゼネラル・エレクトリック', SPGI: 'S&Pグローバル', HON: 'ハネウェル',
  LOW: 'ロウズ', ISRG: 'インテュイティブ・サージカル', GS: 'ゴールドマン・サックス', BKNG: 'ブッキング・ホールディングス', AXP: 'アメリカン・エキスプレス',
  PFE: 'ファイザー', SYK: 'ストライカー', BLK: 'ブラックロック', ELV: 'エレバンス・ヘルス', T: 'AT&T',
  VRTX: 'バーテックス', C: 'シティグループ', MS: 'モルガン・スタンレー', GILD: 'ギリアド・サイエンシズ', MDT: 'メドトロニック',
  TJX: 'TJX', REGN: 'リジェネロン', ADP: 'ADP', LRCX: 'ラムリサーチ', CB: 'チャブ', MU: 'マイクロン・テクノロジー',
  PLD: 'プロロジス', SBUX: 'スターバックス', BMY: 'ブリストル・マイヤーズ・スクイブ', SCHW: 'チャールズ・シュワブ', MMC: 'マーシュ・マクレナン',
  DE: 'ディア（ジョンディア）', BSX: 'ボストン・サイエンティフィック', ADI: 'アナログ・デバイセズ', ETN: 'イートン', KLAC: 'KLA',
  PANW: 'パロアルトネットワークス', SO: 'サザン・カンパニー', CI: 'シグナ', ZTS: 'ゾエティス', DUK: 'デューク・エナジー',
  FI: 'ファイサーブ', MO: 'アルトリア', BX: 'ブラックストーン', SNPS: 'シノプシス', APH: 'アンフェノール',
  CDNS: 'ケイデンス', ICE: 'インターコンチネンタル取引所', SHW: 'シャーウィン・ウィリアムズ', PGR: 'プログレッシブ', CMG: 'チポトレ',
  EQIX: 'エクイニクス', PYPL: 'ペイパル', TT: 'トレーン・テクノロジーズ', CME: 'CMEグループ', PNC: 'PNCファイナンシャル',
  USB: 'USバンコープ', AON: 'エーオン', ITW: 'イリノイ・ツール・ワークス', CL: 'コルゲート・パルモリーブ', MSI: 'モトローラ・ソリューションズ',
  GD: 'ゼネラル・ダイナミクス', MCK: 'マッケソン', EOG: 'EOGリソーシズ', NKE: 'ナイキ', WM: 'ウェイスト・マネジメント',
  EMR: 'エマソン・エレクトリック', MMM: 'スリーエム', FCX: 'フリーポート・マクモラン', CSX: 'CSX', PH: 'パーカー・ハネフィン',
  MAR: 'マリオット', APD: 'エア・プロダクツ', ORLY: 'オライリー・オートモーティブ', NOC: 'ノースロップ・グラマン', PCAR: 'パッカー',
  HCA: 'HCAヘルスケア', COF: 'キャピタル・ワン', ROP: 'ローパー・テクノロジーズ', TGT: 'ターゲット', MPC: 'マラソン・ペトロリアム',
  NXPI: 'NXPセミコンダクターズ', AJG: 'アーサー・J・ギャラガー', CARR: 'キヤリア', SLB: 'シュルンベルジェ', FDX: 'フェデックス',
  PSX: 'フィリップス66', ABNB: 'エアビーアンドビー', OXY: 'オキシデンタル・ペトロリアム', TFC: 'トゥルーイスト', DELL: 'デル・テクノロジーズ',
  CRWD: 'クラウドストライク', UBER: 'ウーバー', PLTR: 'パランティア', SMCI: 'スーパー・マイクロ・コンピューター', COIN: 'コインベース',
  SHOP: 'ショッピファイ', MRNA: 'モデルナ', F: 'フォード', GM: 'ゼネラル・モーターズ', DAL: 'デルタ航空',
  UAL: 'ユナイテッド航空', RIVN: 'リヴィアン', LCID: 'ルーシッド', SOFI: 'ソーファイ', HOOD: 'ロビンフッド',
  RBLX: 'ロブロックス', SNAP: 'スナップ', PINS: 'ピンタレスト', NFE: 'ニューフォートレス', ASML: 'ASML',
  TMUS: 'Tモバイル', AMAT: 'アプライド・マテリアルズ', MELI: 'メルカドリブレ', PDD: 'PDDホールディングス（拼多多）', ARM: 'アーム',
  MSTR: 'マイクロストラテジー（ストラテジー）', AXON: 'アクソン', DDOG: 'データドッグ', ZS: 'ゼットスケーラー', TEAM: 'アトラシアン',
  TTD: 'ザ・トレード・デスク', APP: 'アップラビン', MRVL: 'マーベル・テクノロジー', WDAY: 'ワークデイ', FTNT: 'フォーティネット',
  DASH: 'ドアダッシュ', LULU: 'ルルレモン', WBD: 'ワーナー・ブラザース・ディスカバリー',
}

let _kana = false
let _listener: ((on: boolean) => void) | null = null
export function setKanaMode(on: boolean) { _kana = on }
export function getKanaMode(): boolean { return _kana }
// Page側で再描画用の setState を登録（銘柄名クリックから全表示を切替えるため）。
export function registerKanaListener(fn: ((on: boolean) => void) | null) { _listener = fn }
// どのコンポーネントからでも呼べるグローバル切替（同期で _kana を更新＋再描画通知）。
export function toggleKanaGlobal() { _kana = !_kana; _listener?.(_kana) }
// カナ表示ONかつ辞書にあればカタカナ、無ければ英語名のまま。
export function usName(code: string, name: string): string {
  if (_kana) { const k = US_KATAKANA[code.toUpperCase()]; if (k) return k }
  return name
}
export function hasKatakana(code: string): boolean { return !!US_KATAKANA[code.toUpperCase()] }
