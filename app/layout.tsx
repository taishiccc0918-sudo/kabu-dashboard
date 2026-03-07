import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '株式ダッシュボード',
  description: 'J-Quants API 日本株投資判断ダッシュボード',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  )
}
