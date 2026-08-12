## Design System: 考公刷题App

### Pattern
- **Name:** App Store Style Landing
- **Conversion Focus:** Show real screenshots. Include ratings (4.5+ stars). QR code for mobile. Platform-specific CTAs.
- **CTA Placement:** Download buttons prominent (App Store + Play Store) throughout
- **Color Strategy:** Dark/light matching app store feel. Star ratings in gold. Screenshots with device frames.
- **Sections:** 1. Hero with device mockup, 2. Screenshots carousel, 3. Features with icons, 4. Reviews/ratings, 5. Download CTAs

### Style
- **Name:** Soft UI Evolution
- **Mode Support:** Light ✓ Full | Dark ✓ Full
- **Keywords:** Evolved soft UI, better contrast, modern aesthetics, subtle depth, accessibility-focused, improved shadows, hybrid
- **Best For:** Modern enterprise apps, SaaS platforms, health/wellness, modern business tools, professional, hybrid
- **Performance:** ⚡ Excellent | **Accessibility:** ✓ WCAG AA+

### Colors
| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#8B5CF6` | `--color-primary` |
| On Primary | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#C4B5FD` | `--color-secondary` |
| Accent/CTA | `#059669` | `--color-accent` |
| Background | `#FAF5FF` | `--color-background` |
| Foreground | `#4C1D95` | `--color-foreground` |
| Muted | `#EDEFF9` | `--color-muted` |
| Border | `#EDE9FE` | `--color-border` |
| Destructive | `#DC2626` | `--color-destructive` |
| Ring | `#8B5CF6` | `--color-ring` |

*Notes: Calming lavender + wellness green [Accent adjusted from #10B981 for WCAG 3:1]*

### Typography
- **Heading:** Varela Round
- **Body:** Nunito Sans
- **Mood:** soft, rounded, friendly, approachable, warm, gentle
- **Best For:** Children's products, pet apps, friendly brands, wellness, soft UI
- **Google Fonts:** https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;500;600;700&family=Varela+Round&display=swap
- **CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;500;600;700&family=Varela+Round&display=swap');
```

### Key Effects
Improved shadows (softer than flat, clearer than neumorphism), modern (200-300ms), focus visible, WCAG AA/AAA

### Avoid (Anti-patterns)
- Poor imagery
- No testimonials

### Pre-Delivery Checklist
- [ ] No emojis as icons (use SVG: Heroicons/Lucide)
- [ ] cursor-pointer on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard nav
- [ ] prefers-reduced-motion respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px


