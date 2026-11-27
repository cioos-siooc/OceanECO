// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  rules: {
    // Mapbox and ECharts objects are typed loosely across the map code; type them as they're touched.
    '@typescript-eslint/no-explicit-any': 'warn',
  },
})
