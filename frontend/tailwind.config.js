/** @type {import('tailwindcss').Config} */
const c = (name) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: c('background'),
        foreground: c('foreground'),
        card: c('card'),
        muted: c('muted'),
        'muted-foreground': c('muted-foreground'),
        border: c('border'),
        accent: c('accent'),
        'accent-foreground': c('accent-foreground'),
        'accent-soft': c('accent-soft'),
        ok: c('ok'),
        warn: c('warn'),
        danger: c('danger'),
      },
      borderRadius: { '2xl': '1rem' },
      boxShadow: { soft: '0 1px 2px rgb(0 0 0 / 0.04), 0 4px 16px rgb(0 0 0 / 0.06)' },
    },
  },
  plugins: [],
};
