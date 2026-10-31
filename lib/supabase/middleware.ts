import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * ARK (Onda 0 / 0.8) — o proxy rodava, em TODA navegação (inclusive prefetch de link):
 *   1. `auth.getUser()`  → uma ida ao servidor de auth do Supabase;
 *   2. `rpc('is_instance_initialized')` → outra ida ao banco.
 * Medido em 31/10: TTFB de 1–3 s nas telas logadas, com login em 70 ms.
 *
 * Agora:
 *   - `auth.getClaims()` valida o JWT LOCALMENTE (o projeto usa chave ES256 — conferido
 *     na Management API em 31/10) e só vai à rede para renovar token vencido. O JWKS é
 *     mantido em cache no módulo (vive enquanto a instância edge estiver quente) e
 *     repassado ao cliente para não ser baixado a cada request.
 *   - `is_instance_initialized` só é consultada uma vez por navegador: o resultado
 *     positivo vira um cookie (`ncrm_init=1`, 30 dias) e também um cache em memória
 *     do módulo. Instância inicializada não volta a ser "não inicializada".
 */

const INIT_COOKIE = 'ncrm_init'
const INIT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 dias
const INIT_MEMO_TTL_MS = 10 * 60 * 1000 // 10 min (só vale para o caso "não inicializada")

type Jwks = { keys: unknown[] }

// Caches de módulo: sobrevivem entre requests na mesma instância edge.
let jwksCache: Jwks | null = null
let initializedMemo: { value: boolean; at: number } | null = null

/**
 * Função pública `updateSession` do projeto.
 *
 * @param {NextRequest} request - Objeto da requisição.
 * @returns {Promise<NextResponse<unknown>>} Retorna um valor do tipo `Promise<NextResponse<unknown>>`.
 */
export async function updateSession(request: NextRequest) {
    // NOTE: Apesar do nome do arquivo, esta função é consumida pelo `proxy.ts` (Next 16+).
    // O Next renomeou a convenção de `middleware.ts` -> `proxy.ts`.
    // Doc: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
    //
    // Importante: o Proxy NÃO deve interferir em `/api/*`.
    // Route Handlers devem responder com 401/403 quando necessário.
    // Se redirecionarmos `/api/*` para `/login`, quebramos `fetch`/SDKs.
    if (request.nextUrl.pathname.startsWith('/api')) {
        return NextResponse.next({ request })
    }

    // Check if Supabase is properly configured
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    // Prefer new publishable key format, fallback to legacy anon key
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
        || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    // Skip auth if not configured or using placeholder values
    const isConfigured = supabaseUrl &&
        supabaseAnonKey &&
        !supabaseUrl.includes('your_') &&
        supabaseUrl.startsWith('http')

    if (!isConfigured) {
        console.warn('[proxy] Supabase not configured - skipping auth check')
        return NextResponse.next({ request })
    }

    let supabaseResponse = NextResponse.next({
        request,
    })

    const supabase = createServerClient(
        supabaseUrl,
        supabaseAnonKey,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll()
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
                    supabaseResponse = NextResponse.next({
                        request,
                    })
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options)
                    )
                },
            },
        }
    )

    // Sessão: valida o JWT localmente (ES256 + JWKS em cache). Renova se vencido.
    // Sem cookie de sessão nenhum, nem chega a tentar (visitante anônimo).
    type ClaimsOptions = NonNullable<Parameters<typeof supabase.auth.getClaims>[1]>
    let hasUser = false
    const hasAuthCookie = request.cookies
        .getAll()
        .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'))
    if (hasAuthCookie) {
        try {
            const options: ClaimsOptions | undefined = jwksCache
                ? { jwks: jwksCache as unknown as ClaimsOptions['jwks'] }
                : undefined
            const { data, error } = await supabase.auth.getClaims(undefined, options)
            hasUser = !error && !!data?.claims?.sub
            // Seguro contra lockout: se a validacao local falhar por qualquer motivo (JWKS fora
            // do ar, chave desconhecida), cai no caminho antigo (getUser na rede) em vez de
            // mandar usuario logado para /login.
            if (!hasUser && error) {
                const { data: u } = await supabase.auth.getUser()
                hasUser = !!u?.user
            }
            // Guarda o JWKS que o cliente acabou de usar/baixar para os próximos requests.
            const used = (supabase.auth as unknown as { jwks?: Jwks }).jwks
            if (used && Array.isArray(used.keys) && used.keys.length > 0) {
                jwksCache = used
            }
        } catch {
            hasUser = false
        }
    }

    // ---------------------------------------------------------------------
    // Setup guard: se a instância não foi inicializada, forçar /setup
    // ---------------------------------------------------------------------
    // Observação: is_instance_initialized() está com GRANT para anon/authenticated.
    // Se der erro, falhamos "aberto" (não bloqueia navegação) para evitar lockout.
    const pathname = request.nextUrl.pathname
    const isSetupRoute = pathname === '/setup' || pathname.startsWith('/setup/')
    const isInstallRoute = pathname === '/install' || pathname.startsWith('/install/')

    const initCookie = request.cookies.get(INIT_COOKIE)?.value === '1'
    const memoUsable = initializedMemo !== null
        && (initializedMemo.value || Date.now() - initializedMemo.at < INIT_MEMO_TTL_MS)
    let shouldSetInitCookie = false

    if (!initCookie && !(memoUsable && initializedMemo?.value)) {
        try {
            let initialized: boolean | null = memoUsable && initializedMemo ? initializedMemo.value : null
            if (initialized === null) {
                const { data: initData, error: initError } = await supabase.rpc('is_instance_initialized')
                if (!initError && typeof initData === 'boolean') {
                    initialized = initData
                    initializedMemo = { value: initData, at: Date.now() }
                }
            }
            if (initialized === false && !isSetupRoute && !isInstallRoute) {
                const url = request.nextUrl.clone()
                url.pathname = '/setup'
                return NextResponse.redirect(url)
            }
            if (initialized === true) shouldSetInitCookie = true
        } catch {
            // ignore
        }
    }

    // Protected routes - redirect to login if not authenticated
    const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/auth')
    const isPublicRoute = pathname === '/' || pathname.startsWith('/join') || isSetupRoute || isInstallRoute

    if (!hasUser && !isAuthRoute && !isPublicRoute) {
        const url = request.nextUrl.clone()
        url.pathname = '/login'
        const res = NextResponse.redirect(url)
        if (shouldSetInitCookie) setInitCookie(res)
        return res
    }

    // Redirect authenticated users away from login
    if (hasUser && isAuthRoute) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        const res = NextResponse.redirect(url)
        if (shouldSetInitCookie) setInitCookie(res)
        return res
    }

    if (shouldSetInitCookie) setInitCookie(supabaseResponse)
    return supabaseResponse
}

function setInitCookie(res: NextResponse) {
    res.cookies.set(INIT_COOKIE, '1', {
        maxAge: INIT_COOKIE_MAX_AGE,
        path: '/',
        sameSite: 'lax',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
    })
}
