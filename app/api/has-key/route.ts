import { NextResponse } from 'next/server'

/**
 * クライアントに「サーバー側に JQUANTS_API_KEY が設定されているか」を安全に伝えるエンドポイント。
 * キー自体は返さない。
 */
export async function GET() {
  return NextResponse.json({ hasKey: !!process.env.JQUANTS_API_KEY })
}
