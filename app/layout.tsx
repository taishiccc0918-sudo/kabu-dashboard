import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'かぶノート',
  description: 'J-Quants API 日本株投資判断ダッシュボード。お気に入り銘柄のPER位置・決算・ニュースをスマホでサッと確認。',
  manifest: '/manifest.webmanifest',
  // iOS: ホーム画面に追加したとき全画面のアプリのように起動する
  appleWebApp: {
    capable: true,
    title: 'かぶノート',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
}

export const viewport: Viewport = {
  themeColor: '#0f766e',
  width: 'device-width',
  initialScale: 1,
  // ノッチ/ホームインジケータの safe-area を使えるように
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
