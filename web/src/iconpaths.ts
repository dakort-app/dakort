// Icons as markup, for views built outside React (the Markdown renderer's
// code blocks, CodeMirror's find panel): the same Lucide icons as
// icons.tsx, from the lucide package, at the same stroke. See icons.tsx
// for the sizes and why 1.75.

import { Check, ChevronDown, ChevronUp, Copy, X, type IconNode } from 'lucide'

export const ICON_STROKE = 1.75

const nodes = { check: Check, 'chevron-down': ChevronDown, 'chevron-up': ChevronUp, copy: Copy, x: X } satisfies Record<string, IconNode>

const esc = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const body = (node: IconNode) => node.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`).join('')

export const iconHTML = (name: keyof typeof nodes, sm?: boolean) =>
  `<svg class="i${sm ? ' i-sm' : ''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body(nodes[name])}</svg>`
