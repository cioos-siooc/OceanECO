
// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/png', href: '/OA_logo.png' }
      ]
    }
  },
  css: ['~/assets/css/main.css'],
  // Self-hosted by @nuxt/fonts (registered by @nuxt/ui) instead of
  // render-blocking on fonts.googleapis.com. Plex Sans is the UI face, Plex
  // Mono is for every number (see the tokens in assets/css/main.css).
  fonts: {
    families: [
      { name: 'IBM Plex Sans', provider: 'google', weights: [400, 500, 600] },
      { name: 'IBM Plex Mono', provider: 'google', weights: [400, 500] },
    ],
  },
  vite: {
    resolve: {
      alias: {
        // The default entry bundles every zone's full history (~700 KB); the app only needs America/Vancouver and UTC.
        // shortcut: no DST data after 2030 (times then show the last offset), move to a later build or Intl before then.
        'moment-timezone': 'moment-timezone/builds/moment-timezone-with-data-1970-2030.js',
      },
    },
  },
  nitro: {
    externals: {
      inline: ['pinia'],
    },
  },
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    ['@pinia/nuxt'],
  ],
  // The app has always been dark-only; @nuxt/ui pulls in @nuxtjs/color-mode,
  // which follows the system preference unless pinned. Flip this to 'system'
  // (and verify both themes) if light mode is ever wanted.
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },
  runtimeConfig: {
    public: {
      mapboxToken: process.env.NUXT_PUBLIC_MAPBOX_TOKEN || '',
      apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL || '',
      version: process.env.NUXT_PUBLIC_VERSION || '',
      umamiWebsiteId: process.env.NUXT_PUBLIC_UMAMI_WEBSITE_ID || '',
      umamiHost: process.env.NUXT_PUBLIC_UMAMI_HOST || 'https://analytics.cioospacific.ca',
    },
  },
})