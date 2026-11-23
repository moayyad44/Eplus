/** EmergencyPlus design tokens — Baby Blue medical identity. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f1f9fe', 100: '#e2f2fc', 200: '#c5e6f9', 300: '#9dd6f4', 400: '#6cc0ec',
          500: '#3ea6de', 600: '#2389c2', 700: '#1d6e9d', 800: '#1d5d82', 900: '#1d4e6b', 950: '#133247',
        },
        ink: { DEFAULT: '#0f2537', soft: '#3d5468', muted: '#6b8093' },
        surface: { DEFAULT: '#ffffff', subtle: '#f6f9fb', sunken: '#eef3f7' },
        line: { DEFAULT: '#e1e8ee', strong: '#cbd6df' },
        success: { 50: '#ecfbf3', 100: '#d1f5e2', 600: '#15935b', 700: '#0f7a4a' },
        warning: { 50: '#fff8eb', 100: '#feecc7', 600: '#c77a05', 700: '#a35f04' },
        danger: { 50: '#fef1f1', 100: '#fde0e0', 600: '#d63b3b', 700: '#b42828' },
        violet: { 50: '#f4f2ff', 100: '#e9e5ff', 600: '#6b53d6', 700: '#5a3fc4' },
      },
      fontFamily: { sans: ['"IBM Plex Sans Arabic"', 'system-ui', 'Segoe UI', 'Tahoma', 'sans-serif'] },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        card: '0 1px 2px rgba(15,37,55,0.04), 0 1px 3px rgba(15,37,55,0.06)',
        pop: '0 12px 32px -8px rgba(15,37,55,0.18), 0 4px 8px -4px rgba(15,37,55,0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        'pop-in': { from: { opacity: 0, transform: 'translateY(6px) scale(.98)' }, to: { opacity: 1, transform: 'none' } },
      },
      animation: { 'fade-in': 'fade-in .15s ease-out', 'pop-in': 'pop-in .18s ease-out' },
    },
  },
  plugins: [],
};
