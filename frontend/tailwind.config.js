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
        xl: '0.875rem',
      },
      boxShadow: {
        soft: '0 1px 2px hsl(216 40% 20% / 0.05)',
        raised: '0 1px 2px hsl(216 40% 15% / 0.08), 0 16px 40px -12px hsl(216 40% 15% / 0.28)',
        glow: '0 1px 2px hsl(216 40% 20% / 0.12)',
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
