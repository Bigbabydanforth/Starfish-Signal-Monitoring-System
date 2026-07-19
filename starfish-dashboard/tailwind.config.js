/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Starfish Brand Palette
        'sf-teal': '#004b5c',        // Deep Teal — primary
        'sf-teal-light': '#6da3ab',  // Light Teal — secondary
        'sf-charcoal': '#2d2d2d',    // Charcoal — body text
        'sf-white': '#ffffff',        // Pure White — cards, modals
        'sf-offwhite': '#f5f7f8',    // Off-White — page background

        // Priority colors
        'sf-high': '#EF4444',        // HIGH priority — red
        'sf-medium': '#F59E0B',      // MEDIUM priority — amber
        'sf-low': '#9CA3AF',         // LOW priority — gray

        // Status colors
        'sf-status-new': '#004b5c',
        'sf-status-inprogress': '#F59E0B',
        'sf-status-contacted': '#16A34A',
        'sf-status-won': '#7C3AED',
        'sf-status-notafit': '#6B7280',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      transitionDuration: {
        'fast': '150ms',
      },
    },
  },
  plugins: [],
}
