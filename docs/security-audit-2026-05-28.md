# kabu-dashboard セキュリティ監査（2026-05-28）

担当: kabu_守り（Claude）
スコープ: K3（判定エンジン自動テスト）／K4（J-Quants トークン秘匿・レート制限・依存脆弱性）
状態: 提案・修正の一次対応まで完了。要レビュー＋本人対応事項あり。

---

## 1. 発見・対応サマリ

| # | 重大度 | 項目 | 状態 |
|---|---|---|---|
| S1 | 🔴 HIGH | 旧ルート `app/app/api/jquants/route.ts` が `/app/api/jquants` として公開され、env 変数を読まない（誤ってブラウザの x-api-key を信頼） | 🟡 削除推奨（残課題） |
| S2 | 🟢 LOW | `/api/jquants` がパス検証なしで J-Quants 任意エンドポイントに中継可能（SSRF 系の最小リスク） | ✅ ホワイトリスト追加 |
| S3 | 🟢 LOW | レート制限なし。クライアントバグや誤ループで J-Quants 上限を消費し得る | ✅ IP単位 60req/60s の簡易制限を追加 |
| S4 | 🟡 MED | クライアント `localStorage` に J-Quants API キーを保存（XSS 経由で盗まれ得る） | 🟡 推奨：サーバー env 一本化（残課題） |
| S5 | 🟡 MED | `next@14.2.5` に Critical/High 複数の advisory（Cache Poisoning, Authorization Bypass, SSRF 系） | 🟡 14.2.35+ への bump 推奨（残課題） |
| S6 | 🟡 MED | `xlsx@*` に High（Prototype Pollution / ReDoS）。公式 fix なし | 🟡 SheetJS Pro へ移行 or 自社ホストへ差し替え検討（残課題） |
| S7 | 🟢 LOW | `.env.local.example` に必要キーは揃っている | ✅ 変更不要 |
| K3 | — | judgmentEngine / buildStockRow のユニットテスト | ✅ Vitest 28 ケース全 pass |

---

## 2. 詳細

### S1. 旧 jquants ルートの公開（最優先）

`npm run build` の出力に以下が含まれる:

```
ƒ /api/jquants          ← 現行（env 優先・rate limit あり）
ƒ /app/api/jquants      ← 旧版が露出している
```

`app/app/api/jquants/route.ts` は env を見ず、リクエストヘッダの `x-api-key` のみで J-Quants にフォワードする。攻撃者が直接叩けば、サーバー env キーは使わないがプロキシ経由で任意のキーを試行できる踏み台になり得る。

**推奨対応:**
- `app/app/` ディレクトリ一式（`api/`, `lib/`, `page.txt`, `globals.css`, `layout.tsx`, `page.module.css`）を削除する。中身は最新版 `app/` のサブセットの古いコピーで、ビルドに含まれている。
- 削除前に git で差分を確認し、未マージの変更がないか念のため目視。

このセッションでは「危険操作なし」のため**削除は実行していない**。次セッションで「`rm -rf app/app/` してよいか」確認→実行。

### S2. SSRF 系ガード（対応済み）

`/api/jquants?path=...` の `path` を以下のプレフィックスに限定:

```
/equities/ /fins/ /prices/ /markets/ /listed/ /derivatives/ /indices/
```

`..` や `//` を含むパスは弾く。J-Quants 以外への中継を構造的に不能にした。

### S3. レート制限（対応済み）

`app/api/jquants/route.ts` にメモリベースの IP 単位制限を追加（60req / 60s）。Vercel サーバーレスは関数インスタンス単位のメモリなので完全防御ではないが、暴走スクリプト・誤ループの一次抑止になる。

将来的に強化するなら:
- Upstash Redis などで分散カウンタ化
- ユーザー認証導入後はユーザー ID 単位に切替

### S4. localStorage に API キーを保存（残課題）

`app/page.tsx:260` で `apiKey` を `localStorage` に保存。XSS 一発で抜かれる。

**推奨対応:**
- `JQUANTS_API_KEY` をサーバー env で恒久運用する前提に切替
- クライアント側 API キー入力欄は撤去 or 「サーバー env 未設定時のみ表示」に絞る
- `/api/has-key` ですでに状態を返しているので、UI 切替の素材は揃っている

### S5. Next.js 脆弱性

`npm audit` 抜粋:

| Advisory | 重大度 |
|---|---|
| GHSA-gp8f-8m3g-qvj9 Cache Poisoning | High |
| GHSA-7gfc-8cq8-jh5f Authorization Bypass | High |
| GHSA-c4j6-fc7j-m34r SSRF (WebSocket upgrades) | — |
| GHSA-wfc6-r584-vfw7 RSC Cache Poisoning | — |
| GHSA-36qx-fr4f-26g5 Middleware bypass (i18n) | — |
| GHSA-g77x-44xx-532m Image Optimization DoS | Moderate |

**推奨対応:** `next` を `14.2.35` 以上に bump。

```bash
npm install next@^14.2.35
npm run build
npm test
```

Pages Router の i18n は使っていないので middleware bypass の影響は限定的、ただし Authorization Bypass / Cache Poisoning は本番影響あり。**最優先で bump 対応**。

### S6. xlsx の脆弱性

`xlsx@0.18.5`（npm 配布版）に Prototype Pollution / ReDoS。**fix リリースなし**。

用途は `app/api/listed-info/route.ts` で JPX の銘柄一覧 .xls を毎週パースするだけで、入力は信頼ソース。即時の悪用リスクは低いが、長期的には:

- 公式は SheetJS CDN（`https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz`）で fix 版配布、これに差し替える
- もしくは CSV 配布版があれば xlsx 依存自体を外す

優先度は S1/S4/S5 より下。

### S7. `.env.local.example`

```
JQUANTS_API_KEY
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
```

実コード参照と一致。漏れなし。

---

## 3. K3 自動テスト（実装済み）

`tests/judgmentEngine.test.ts`（17 ケース）
- evaluateRange: min/max境界、null/非数値、未知キー
- evaluateLogic: 全条件一致＝買い、1条件外＝null、ranges空＝null、PER変化率の境界（-5%）、PEG異常値、FEPS空欄

`tests/buildStockRow.test.ts`（11 ケース）
- FEPS=null/0 のときの perF/peg/epsCurGr の null 安全
- PEG: epsCurGr=0 ゼロ割回避、減益で負値、極小成長で極大値
- PER変化率: 据置=0、10%下落≈-10%、feps1m=null/prev1m=null で null
- 通常ケース・未登録銘柄

実行: `npm test`（28/28 pass、`npm run build` も pass）

---

## 4. 残課題（次セッション or たいし判断）

1. **[S1]** `app/app/` ディレクトリ削除（要承認）
2. **[S4]** クライアント localStorage 入力廃止 → サーバー env 一本化（UI 改修）
3. **[S5]** `next@^14.2.35` への bump（破壊変更なしのはず、要 build/test 確認）
4. **[S6]** `xlsx` の CDN 版 or 代替依存への差し替え（長期）
5. 夜間ジョブで `npm audit` を週次自動実行（ロードマップ N1 と統合）

---

## 5. 追記（2026-05-28 夕 CEO判断後の実施記録）

CEO（ジョブズ）判断により S1+S2 を同日中に実施・完了。

### S1（旧 `app/app/` 削除）— ✅完了
- `rm -rf app/app` 実施
- `npm run build` の出力から `ƒ /app/api/jquants` ルートが消えたことを確認
- 旧 `app/app/lib/api.ts` は J-Quants を直叩きする古い実装で、現行 `app/lib/api.ts`（プロキシ経由）と互換性なし→削除妥当

### S2（Next.js bump）— ✅完了
- `next` を `14.2.5` → **`14.2.35`**（14.x 最終）に更新
- `package.json` の依存範囲 `"next": "14.2.5"` → `"^14.2.35"` 相当
- `npm run build` ✅／`npm test` 28/28 ✅
- 解消：Cache Poisoning (High)、Authorization Bypass (High)、SSRF (WebSocket)、RSC Cache Poisoning、Middleware bypass (i18n)、Image Optimization DoS (Moderate) ほか
- **残るNext.js High**：`GHSA-9g9p-9gw9-jx7f`（self-hosted Image Optimizer DoS）→ 14.x に fix なし／kabu-dashboard は Vercel ホスト＋ Image 未使用のため**実質非該当**として受容

### S3（localStorage廃止）— Tier3 に降格
- CEO判断：K6（一般公開判断）と同時に対応。たいし1人運用の現状は実害低
- ロードマップ K4 から外し、K6 にぶら下げる扱い

### 残るnpm audit
- `xlsx@*` High（Prototype Pollution / ReDoS）— 公式 fix なし、JPX 信頼ソースのみで使用、優先度低（受容）
- `postcss <8.5.10` Moderate — next 依存。next 14.x の依存ロックで上がらず、影響軽微
