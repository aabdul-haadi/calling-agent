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
        elevated: c('elevated'),
        muted: c('muted'),
        'muted-foreground': c('muted-foreground'),
        border: c('border'),
        accent: c('accent'),
        'accent-2': c('accent-2'),
        'accent-foreground': c('accent-foreground'),
        'accent-soft': c('accent-soft'),
        ok: c('ok'),
        warn: c('warn'),
        danger: c('danger'),
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
        '2xl': '1rem',
      },
      boxShadow: {
        soft: '0 1px 0 hsl(0 0% 100% / 0.03) inset, 0 1px 2px rgb(0 0 0 / 0.25), 0 8px 24px rgb(0 0 0 / 0.18)',
        raised: '0 1px 0 hsl(0 0% 100% / 0.05) inset, 0 12px 40px rgb(0 0 0 / 0.35)',
        glow: '0 0 0 1px hsl(var(--accent) / 0.35), 0 0 32px hsl(var(--glow) / 0.18)',
      },
      transitionTimingFunction: { out: 'var(--ease-out)' },
      keyframes: {
        rise: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: { rise: 'rise 420ms var(--ease-out) both' },
    },
  },
  plugins: [],
};
