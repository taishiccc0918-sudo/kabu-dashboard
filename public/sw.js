// 最小サービスワーカー（キャッシュしない＝古い表示を出さない）。
// Chrome/Android が PWA を「インストール可能」と判定するために fetch ハンドラを持つだけ。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
// respondWith を呼ばない＝ブラウザ既定の取得に委ねる（オフラインキャッシュなし・常に最新）
self.addEventListener('fetch', () => {})
