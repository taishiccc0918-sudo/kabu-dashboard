import type { MetadataRoute } from 'next'

// PWA マニフェスト。「ホーム画面に追加」で全画面アプリのように起動できる。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'かぶノート',
    short_name: 'かぶノート',
    description: 'お気に入り銘柄のPER位置・決算・ニュースをスマホでサッと確認',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0f17',
    theme_color: '#0f766e',
    lang: 'ja',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }
}
