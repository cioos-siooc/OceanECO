// Vercel Routing Middleware: site-wide maintenance switch.
//
// Turn on:  Vercel → Storage → Global Config (formerly Edge Config) → set item `maintenance` to true
// Turn off: set it to false (or delete it). Takes effect in seconds, no redeploy.
//
// While on, every page request gets a 503 maintenance page (with Retry-After so
// crawlers keep the old index). Visiting /?bypass=<MAINTENANCE_BYPASS_TOKEN>
// sets a cookie that lets you use the real site to check an update.
//
// No-op outside Vercel (Docker/dev): GLOBAL_CONFIG / EDGE_CONFIG are unset there.

export const config = {
  // Pages only — static assets don't need the check.
  matcher: '/((?!_nuxt/|fonts/|videos/|logos/|case-studies/|images/|.*\\.(?:png|jpe?g|webp|svg|ico|txt|mp4|woff2?)$).*)',
}

const BYPASS_COOKIE = 'oa_maintenance_bypass'

async function maintenanceOn(): Promise<boolean> {
  // Vercel renamed Edge Config → Global Config; newly connected stores set GLOBAL_CONFIG.
  const conn = process.env.GLOBAL_CONFIG ?? process.env.EDGE_CONFIG
  if (!conn) return false
  try {
    let base: string, token: string | null
    if (conn.startsWith('edge-config:')) {
      // Short form: edge-config:id=ecfg_…&token=…
      const params = new URLSearchParams(conn.slice('edge-config:'.length))
      base = `https://edge-config.vercel.com/${params.get('id')}`
      token = params.get('token')
    } else {
      // URL form: https://{edge,global}-config.vercel.com/ecfg_…?token=…
      const url = new URL(conn)
      base = `${url.origin}${url.pathname}`
      token = url.searchParams.get('token')
    }
    const res = await fetch(`${base}/item/maintenance?token=${token}`)
    if (!res.ok) return false // 404 = item not set
    return (await res.json()) === true
  } catch {
    return false // never take the site down because the flag couldn't be read
  }
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  if (!(await maintenanceOn())) return

  const bypass = process.env.MAINTENANCE_BYPASS_TOKEN
  if (bypass) {
    const url = new URL(request.url)
    if (url.searchParams.get('bypass') === bypass) {
      url.searchParams.delete('bypass')
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.toString(),
          'Set-Cookie': `${BYPASS_COOKIE}=${bypass}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
        },
      })
    }
    if (request.headers.get('cookie')?.includes(`${BYPASS_COOKIE}=${bypass}`)) return
  }

  return new Response(MAINTENANCE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '3600',
      'Cache-Control': 'no-store',
    },
  })
}

const MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>OceanECO — Down for maintenance</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0b1620; color: #dbe6ee; font: 16px/1.6 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #9fb3c2; }
</style>
</head>
<body>
<main>
  <h1>We'll be right back</h1>
  <p>The dashboard is down for scheduled maintenance. Please check back shortly.</p>
</main>
</body>
</html>`
