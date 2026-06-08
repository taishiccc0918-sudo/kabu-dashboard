import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Supabase 未設定の場合はスキップ
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return NextResponse.next()
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // セッション更新（重要: getUser を必ず呼ぶ）
  await supabase.auth.getUser()
  return supabaseResponse
}

export const config = {
  // 静的ファイル・PWAアセット・listed-info（重いJPXフェッチ）は除外
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/listed-info|api/us-master|manifest.webmanifest|icon.svg|apple-icon|sw.js|icons.html).*)'],
}
