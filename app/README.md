# 株式ダッシュボード

J-Quants API を使った日本株投資判断ダッシュボードです。

## Vercelへのデプロイ手順

### 1. GitHubリポジトリを作成

```bash
cd kabu-app
git init
git add .
git commit -m "initial commit"
```

GitHubで新しいリポジトリを作成し、pushします：

```bash
git remote add origin https://github.com/あなたのID/kabu-dashboard.git
git branch -M main
git push -u origin main
```

### 2. Vercelにデプロイ

1. https://vercel.com にアクセス → GitHubでログイン
2. 「New Project」→ 作成したリポジトリを選択
3. 設定はデフォルトのままで「Deploy」を押す
4. 1〜2分でURLが発行されます（例: `https://kabu-dashboard-xxx.vercel.app`）

### 3. 使い方

1. 発行されたURLをブラウザで開く
2. J-Quants APIキーを右上の入力欄に入力
3. 「全更新」ボタンを押す

### APIキーの取得方法

1. https://jquants.com/ にアクセス
2. 無料登録（メールアドレスのみ）
3. ダッシュボード → APIキーを発行

### 機能

- ダッシュボード表示（株価・変化率・PER/PBR/ROE・配当利回り・EPS・PEG等）
- カードビュー（スマホ対応）
- 銘柄管理（追加・削除・エクスポート・インポート）
- 詳細パネル（クリックで展開、メモ保存）
- フィルター・ソート
- 四季報・IRBankリンク
- APIキー・銘柄リスト・メモをブラウザに自動保存

### ローカルで動かす場合

```bash
npm install
npm run dev
```

→ http://localhost:3000 で起動
