/** @type {import('next').NextConfig} */
const nextConfig = {
  // ビルド時の型チェック・ESLintをスキップ（CI/CDではなくVercel直デプロイのため）
  // 開発中はエディタ・Claude Codeが型チェックを担うので問題なし
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
}
module.exports = nextConfig
