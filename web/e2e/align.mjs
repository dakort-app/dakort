// align.mjs: measures alignment on the screen as it is, so a misfit is a
// number and not a judgement. Use it as
//
//   const report = await page.evaluate(alignAudit, opts)
//
// alignAudit runs in the page and closes over nothing in this module (page
// .evaluate sends its source text alone), so every helper lives inside it.
//
// What it reports, each finding with the elements' short CSS paths, the
// measured numbers and the delta (all in CSS px):
//   column-left    siblings stacked in a column whose content starts 1 to 3
//                  px apart (content: the first row of text, icons and
//                  painted boxes inside each, not the bare box, which is
//                  usually the parent's full width). Rows that both lead
//                  with an icon compare the icons' centres; an icon
//                  against text is not compared. column-centre and
//                  column-right for centred and right-aligned columns.
//   column-text    rows of one kind (tag and class) whose text starts 1 to
//                  3 px apart, measured apart from any icons before it.
//   row-baseline   plain text side by side whose first lines sit on
//                  baselines 1 to 3 px apart.
//   row-centre     siblings side by side, at least one a box (painted,
//                  an icon, a field), whose centres differ: box against
//                  box, or box against the other's line of text.
//   control-height controls in one visual row (same parent, a flex row a
//                  few levels up, or one toolbar) whose heights differ.
//   icon-centre    an icon (svg or img up to 24 px) off the centre of its
//                  control or box (icon alone), or of its text line (icon
//                  beside text), by more than 1 px.
//   list-gap       a run of three or more siblings of one kind (tag and
//                  class) whose gaps differ.
//   list-height    siblings of one kind in a column whose heights differ.
//
// Baselines: the first line box of the first text node (Range
// .getClientRects()[0]) plus the font's ascent from a canvas
// (fontBoundingBoxAscent), corrected for half-leading. Not the CSS
// baseline of the box, which a flex item's padding moves.
//
// Deltas under 1 px are dropped: a finding is 1 to 3 px off. Half a CSS
// pixel is one device pixel on a 2x screen, the engine's rounding of a
// centred box (WebKit and Chromium round it differently), not a misfit. Deltas over 3 px are
// taken as intended and only counted, by kind, under `large`. Skipped:
// hidden, zero-size and off-screen elements (scrolled out of an overflow
// box counts as off-screen), inert backgrounds behind a dialog,
// aria-hidden decoration (except icons, for the icon check), prose (the
// transcript's markdown, prompts, tool output, file contents), and
// anything inside [data-align-ignore]. An icon, a control or a run of
// text (row-baseline) marked data-align-ok="<reason>", on itself or an
// ancestor, is excused and listed under `excused`.

export function alignAudit(opts = {}) {
  const MIN = opts.min ?? 1
  const MAX = opts.max ?? 3
  const ICON_MAX = opts.iconMax ?? 24
  const ICON_TOL = opts.iconTol ?? 1
  const ROW_MAX_H = opts.rowMaxHeight ?? 64
  // Where a text line's place comes from font metrics, a browser rounds
  // its ascent and descent to whole pixels, so up to a pixel of offset is
  // the font's and not the layout's: text against text, or a box against a
  // line of text, is a finding from 1 px.
  const TEXT_MIN = opts.textMin ?? 1
  const PROSE =
    opts.prose ??
    '.md, .prompt-text, .thinking-body, .thinking-preview, .tool-body, .cm-editor, .file-md, .file-view pre, .raw, .page-card, .card-page, .pdf-page, .docx, .sheet-grid, table, pre, .queued-text, .run-text, .leftover-cmd'
  const IGNORE = '[data-align-ignore]' + (opts.ignore ? ', ' + opts.ignore : '')
  const CONTROL =
    'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=option], [role=switch], [role=checkbox], .chip, .chip-btn, .mode-chip, .btn, .tab'
  const root = opts.root ? document.querySelector(opts.root) : document.body
  const vw = innerWidth
  const vh = innerHeight
  const r2 = (n) => Math.round(n * 100) / 100

  const findings = []
  const large = {}
  const excused = []
  const seen = new Set()
  const largeList = []
  const tooLarge = (kind, d, f) => {
    large[kind] = (large[kind] || 0) + 1
    if (opts.keepLarge && largeList.length < 300) largeList.push({ kind, ...f, delta: r2(d) })
  }
  // report files a delta: a finding from MIN to MAX, a count above MAX.
  const report = (kind, delta, f, min = MIN) => {
    const d = Math.abs(delta)
    if (d < min) return
    if (d > MAX) return tooLarge(kind, d, f)
    const key = kind + '|' + f.a + '|' + (f.b || '') + '|' + r2(d)
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ kind, ...f, delta: r2(d) })
  }

  // ------------------------------------------------------------ geometry
  const css = new Map()
  const style = (el) => {
    let s = css.get(el)
    if (!s) css.set(el, (s = getComputedStyle(el)))
    return s
  }
  const box = (r) => ({ x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) })
  const union = (a, b) => {
    if (!a) return b
    const left = Math.min(a.left, b.left)
    const top = Math.min(a.top, b.top)
    const right = Math.max(a.right, b.right)
    const bottom = Math.max(a.bottom, b.bottom)
    return { left, top, right, bottom, width: right - left, height: bottom - top }
  }
  const midY = (r) => r.top + r.height / 2
  const midX = (r) => r.left + r.width / 2
  // The padding box: the visible box of a control whose border is on one
  // side only (a tab's underline) would move a border-box centre.
  const paddingBox = (el) => {
    const r = el.getBoundingClientRect()
    const s = style(el)
    const bl = parseFloat(s.borderLeftWidth) || 0
    const br = parseFloat(s.borderRightWidth) || 0
    const bt = parseFloat(s.borderTopWidth) || 0
    const bb = parseFloat(s.borderBottomWidth) || 0
    const left = r.left + bl
    const top = r.top + bt
    const right = r.right - br
    const bottom = r.bottom - bb
    return { left, top, right, bottom, width: right - left, height: bottom - top }
  }

  // The part of the screen an element can show in: the viewport cut by
  // every scrolling or clipping box above it.
  const clips = new Map()
  const clipOf = (el) => {
    if (!el || el === document.documentElement) return { left: 0, top: 0, right: vw, bottom: vh }
    if (clips.has(el)) return clips.get(el)
    const s = style(el)
    let c = s.position === 'fixed' ? { left: 0, top: 0, right: vw, bottom: vh } : clipOf(el.parentElement)
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const r = el.getBoundingClientRect()
      c = { left: Math.max(c.left, r.left), top: Math.max(c.top, r.top), right: Math.min(c.right, r.right), bottom: Math.min(c.bottom, r.bottom) }
    }
    clips.set(el, c)
    return c
  }

  const vis = new Map()
  const visible = (el) => {
    if (vis.has(el)) return vis.get(el)
    let ok = true
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) ok = false
    else if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) ok = false
    else {
      const s = style(el)
      if (s.visibility !== 'visible' || Number(s.opacity) === 0) ok = false
      else {
        const c = clipOf(el.parentElement)
        if (Math.min(r.right, c.right) - Math.max(r.left, c.left) < 1 || Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) < 1) ok = false
      }
    }
    vis.set(el, ok)
    return ok
  }
  const skipped = (el) => !!el.closest(IGNORE) || !!el.closest(PROSE) || !!el.closest('[inert]')
  const decoration = (el) => !!el.closest('[aria-hidden="true"]')
  const isIcon = (el) => /^(svg|img|canvas|video)$/i.test(el.tagName)
  const isField = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0
    const m = c.match(/rgba?\(([^)]+)\)/) || c.match(/color\([a-z0-9-]+ ([^)]+)\)/)
    if (!m) return 1
    const p = m[1].split(/[ ,/]+/).filter(Boolean)
    return p.length > 3 ? parseFloat(p[3]) : 1
  }
  // painted: a box the eye sees as a box (a fill, a border, a shadow).
  const painted = (el) => {
    const s = style(el)
    if (alpha(s.backgroundColor) > 0.02) return true
    // An image is a fill; a gradient with clear stops is a guide line or a
    // fade (the tree's indent guides), not a box.
    const bg = s.backgroundImage
    if (bg !== 'none' && (/url\(/.test(bg) || !/rgba\([^)]*,\s*0\)|transparent/.test(bg))) return true
    if (s.boxShadow && s.boxShadow !== 'none') return true
    for (const side of ['Top', 'Right', 'Bottom', 'Left'])
      if (parseFloat(s['border' + side + 'Width']) > 0 && s['border' + side + 'Style'] !== 'none' && alpha(s['border' + side + 'Color']) > 0.02) return true
    return false
  }

  // ---------------------------------------------------------------- text
  const metrics = new Map()
  const canvas = document.createElement('canvas').getContext('2d')
  const fontOf = (el) => {
    const s = style(el)
    const f = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
    let m = metrics.get(f)
    if (!m) {
      canvas.font = f
      const t = canvas.measureText('Hg')
      const size = parseFloat(s.fontSize)
      m = { asc: t.fontBoundingBoxAscent ?? size * 0.8, desc: t.fontBoundingBoxDescent ?? size * 0.2 }
      metrics.set(f, m)
    }
    return m
  }
  // A text node's first line box: its rect and baseline.
  const lineOf = (node) => {
    const t = node.textContent
    const start = t.search(/\S/)
    if (start < 0) return null
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, t.length - (t.length - t.trimEnd().length))
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
    if (!rects.length) return null
    const r = rects[0]
    const m = fontOf(node.parentElement)
    const baseline = r.top + (r.height - (m.asc + m.desc)) / 2 + m.asc
    return { rect: r, baseline }
  }

  // leaves: what an element shows, as boxes: first lines of text, icons,
  // form fields and painted boxes (not looked inside). Capped, so a big
  // container costs little; the checks only use the first row of it.
  const leafCache = new Map()
  const leaves = (el, cap = 60) => {
    if (leafCache.has(el)) return leafCache.get(el)
    const out = []
    const walk = (n, top) => {
      if (out.length >= cap) return
      if (n.nodeType === 3) {
        const l = lineOf(n)
        if (l) out.push({ kind: 'text', rect: l.rect, baseline: l.baseline, el: n.parentElement })
        return
      }
      if (n.nodeType !== 1) return
      const s = style(n)
      if (s.display === 'none') return
      if (s.display !== 'contents') {
        if (!visible(n)) return
        if (n.matches(IGNORE)) return
        if (!top && (s.position === 'absolute' || s.position === 'fixed') && !isIcon(n)) return
        if (isIcon(n)) return void out.push({ kind: 'icon', rect: upright(n), el: n })
        if (isField(n)) return void out.push({ kind: 'field', rect: n.getBoundingClientRect(), el: n })
        if (painted(n) && !top) return void out.push({ kind: 'box', rect: n.getBoundingClientRect(), el: n })
      }
      for (const c of n.childNodes) walk(c, false)
    }
    walk(el, true)
    leafCache.set(el, out)
    return out
  }
  // An icon's box as laid out, before a transform turns it (an open
  // folder's caret is the closed one turned 90 degrees; a box that is not
  // square moves its edges when turned, its centre stays).
  const upright = (el) => {
    const r = el.getBoundingClientRect()
    const turned = (e) => e && style(e).transform !== 'none'
    if (!turned(el) && !turned(el.parentElement)) return r
    const w = el.width?.baseVal?.value || el.offsetWidth || r.width
    const h = el.height?.baseVal?.value || el.offsetHeight || r.height
    const x = midX(r) - w / 2
    const y = midY(r) - h / 2
    return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }
  }
  // The first row of an element's leaves: those level with the topmost.
  const firstRow = (ls) => {
    if (!ls.length) return []
    const top = ls.reduce((a, b) => (b.rect.top < a.rect.top ? b : a))
    return ls.filter((l) => l.rect.top < top.rect.bottom - 1 && l.rect.bottom > top.rect.top + 1)
  }
  // ink: the box the eye reads for an element (its painted box, else what
  // it shows).
  const ink = (el) => {
    if (painted(el) || isIcon(el) || isField(el)) return el.getBoundingClientRect()
    let u = null
    for (const l of leaves(el)) u = union(u, l.rect)
    return u || el.getBoundingClientRect()
  }
  const firstText = (el) => {
    if (isField(el)) return null
    return leaves(el).find((l) => l.kind === 'text') || null
  }

  // --------------------------------------------------------------- names
  const part = (el) => {
    let s = el.tagName.toLowerCase()
    if (el.id) return s + '#' + el.id
    const cls = [...el.classList].filter((c) => !/^(cm-|ͼ)/.test(c)).slice(0, 2)
    if (cls.length) s += '.' + cls.join('.')
    const label = el.getAttribute('aria-label')
    if (label && label.length <= 32) s += `[aria-label="${label}"]`
    else if (!cls.length && el.parentElement) {
      const same = [...el.parentElement.children].filter((c) => c.tagName === el.tagName)
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`
    }
    return s
  }
  // A short CSS path: the element and enough of its ancestors to place it
  // (three steps, or fewer when one has an id).
  const pathOf = (el) => {
    const parts = []
    for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) {
      parts.unshift(part(e))
      if (e.id) break
    }
    return parts.join(' > ')
  }
  const textOf = (el) => ((el.getAttribute && el.getAttribute('aria-label')) || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)

  // ---------------------------------------------------- elements to check
  const all = [...root.querySelectorAll('*')].filter((el) => visible(el) && !skipped(el))
  const inSet = new Set(all)
  // The children a layout places, display: contents opened up.
  const kids = (el) => {
    const out = []
    for (const c of el.children) {
      const s = style(c)
      if (s.display === 'contents') out.push(...kids(c))
      else if (inSet.has(c)) out.push(c)
    }
    return out
  }
  const placed = (el) => {
    const s = style(el)
    return s.position !== 'absolute' && s.position !== 'fixed' && !decoration(el) && !/^(BR|WBR)$/.test(el.tagName)
  }
  const flowBlock = (el, parent) => {
    const pd = style(parent).display
    if (/flex|grid/.test(pd)) return true
    return !/^inline/.test(style(el).display)
  }
  const STATE = /^(active|selected|open|current|focused|focus|hover|expanded|collapsed|folded|on|off|failed|error|done|running|dirty|pinned|disabled|new|unread|needs|ok|warn|busy|live|empty|first|last)$/
  const kindOf = (el) => el.tagName + '.' + [...el.classList].filter((c) => !STATE.test(c)).sort().join('.')

  // Which edge a column lines its children up on.
  const columnEdge = (el, parent) => {
    const ps = style(parent)
    const s = style(el)
    if (/flex/.test(ps.display) && /column/.test(ps.flexDirection)) {
      const a = s.alignSelf !== 'auto' ? s.alignSelf : ps.alignItems
      if (/center/.test(a)) return 'centre'
      if (/end|right/.test(a)) return 'right'
    }
    if (/grid/.test(ps.display)) {
      const a = s.justifySelf !== 'auto' ? s.justifySelf : ps.justifyItems
      if (/center/.test(a)) return 'centre'
      if (/end|right/.test(a)) return 'right'
    }
    if (s.textAlign === 'center') return 'centre'
    if (s.textAlign === 'right' || s.textAlign === 'end') return 'right'
    return 'left'
  }

  let pairs = 0
  // ------------------------------------------------ siblings: rows, columns
  for (const parent of [root, ...all]) {
    const cs = kids(parent).filter((c) => placed(c) && flowBlock(c, parent))
    if (cs.length < 2) continue
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i]
      const b = cs[i + 1]
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const stacked = rb.top >= ra.bottom - 1 || ra.top >= rb.bottom - 1
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      const sideBySide = (rb.left >= ra.right - 1 || ra.left >= rb.right - 1) && overlapY > 0.5 * Math.min(ra.height, rb.height)
      pairs++
      if (stacked && Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 0) {
        // A column: where each one's content starts.
        const ea = columnEdge(a, parent)
        const eb = columnEdge(b, parent)
        if (ea !== eb) continue
        // Two painted boxes line up by their boxes. Otherwise by what they
        // show: an active row's fill against a plain row's text says
        // nothing, the text inside both does.
        const boxes = painted(a) && painted(b)
        const fa = firstRow(boxes ? [{ rect: ra }] : leaves(a))
        const fb = firstRow(boxes ? [{ rect: rb }] : leaves(b))
        if (!fa.length || !fb.length) continue
        const edge = (f) => {
          let u = null
          for (const l of f) u = union(u, l.rect)
          return ea === 'left' ? u.left : ea === 'right' ? u.right : midX(u)
        }
        const where = { a: pathOf(a), b: pathOf(b), text: [textOf(a), textOf(b)] }
        // Rows that lead with an icon line up on the icons' centres (icons
        // of different sizes sit in one slot). An icon against text or a
        // box says little: an icon's drawing does not fill its box.
        const lead = (f) => f.reduce((p, q) => (q.rect.left < p.rect.left ? q : p))
        const ia = ea === 'left' && !boxes && lead(fa).kind === 'icon'
        const ib = ea === 'left' && !boxes && lead(fb).kind === 'icon'
        let xa = 0
        let xb = 0
        if (ia && ib) {
          xa = midX(lead(fa).rect)
          xb = midX(lead(fb).rect)
          report('column-left', xa - xb, { ...where, values: { a: r2(xa), b: r2(xb), by: 'icon centres' } })
        } else if (!ia && !ib) {
          xa = edge(fa)
          xb = edge(fb)
          report('column-' + ea, xa - xb, { ...where, values: { a: r2(xa), b: r2(xb) } })
        }
        // Where the words start, which the eye follows down a list even when
        // one row has a caret or an icon the next lacks: rows of one kind.
        if (ea === 'left' && !boxes && kindOf(a) === kindOf(b)) {
          const ta = fa.find((l) => l.kind === 'text')
          const tb = fb.find((l) => l.kind === 'text')
          if (ta && tb && Math.abs(ta.rect.left - tb.rect.left - (xa - xb)) > 0.1)
            report('column-text', ta.rect.left - tb.rect.left, { ...where, values: { a: r2(ta.rect.left), b: r2(tb.rect.left) } })
        }
      } else if (sideBySide) {
        if (ra.height > ROW_MAX_H || rb.height > ROW_MAX_H) continue
        const ta = firstText(a)
        const tb = firstText(b)
        // Runs of text line up on their baselines. A box (a pill, a
        // button, a field) lines up on its centre, against the other's
        // box or, for plain text, against its line.
        const pa = painted(a) || isField(a)
        const pb = painted(b) || isField(b)
        if (ta && tb && !pa && !pb) {
          const ok = a.closest('[data-align-ok]') || b.closest('[data-align-ok]')
          if (ok) {
            excused.push({ kind: 'row-baseline', a: pathOf(a), b: pathOf(b), reason: ok.getAttribute('data-align-ok') })
            continue
          }
          report('row-baseline', ta.baseline - tb.baseline, { a: pathOf(a), b: pathOf(b), text: [textOf(a), textOf(b)], values: { a: r2(ta.baseline), b: r2(tb.baseline) } }, TEXT_MIN)
        } else {
          // Plain text is read by its line, when it is one line (a title
          // over a subtitle is centred as a block).
          const oneLine = (el, t, p) => t && !p && leaves(el).every((l) => l.rect.top < t.rect.bottom - 1 && l.rect.bottom > t.rect.top + 1)
          const ia = oneLine(a, ta, pa) ? ta.rect : ink(a)
          const ib = oneLine(b, tb, pb) ? tb.rect : ink(b)
          const byText = (ta && !pa) || (tb && !pb)
          report('row-centre', midY(ia) - midY(ib), { a: pathOf(a), b: pathOf(b), text: [textOf(a), textOf(b)], values: { a: r2(midY(ia)), b: r2(midY(ib)), by: byText ? 'text line' : 'boxes' } }, byText ? TEXT_MIN : MIN)
        }
      }
    }

    // A list: three or more of one kind in a run, column or row.
    let run = [cs[0]]
    const flush = () => {
      if (run.length >= 2) list(run)
      run = []
    }
    for (let i = 1; i < cs.length; i++) {
      if (kindOf(cs[i]) === kindOf(run[0])) run.push(cs[i])
      else {
        flush()
        run = [cs[i]]
      }
    }
    flush()
  }

  function list(run) {
    const rs = run.map((e) => e.getBoundingClientRect())
    const column = rs.every((r, i) => i === 0 || r.top >= rs[i - 1].bottom - 1)
    const row = !column && rs.every((r, i) => i === 0 || (r.left >= rs[i - 1].right - 1 && Math.abs(r.top - rs[i - 1].top) < r.height))
    if (!column && !row) return
    const mode = (xs) => {
      const n = new Map()
      for (const x of xs) n.set(Math.round(x * 2) / 2, (n.get(Math.round(x * 2) / 2) || 0) + 1)
      return [...n.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0]
    }
    if (run.length >= 3) {
      const gaps = rs.slice(1).map((r, i) => (column ? r.top - rs[i].bottom : r.left - rs[i].right))
      const m = mode(gaps)
      gaps.forEach((g, i) =>
        report('list-gap', g - m, { a: pathOf(run[i]), b: pathOf(run[i + 1]), text: [textOf(run[i]), textOf(run[i + 1])], values: { gap: r2(g), usual: m, axis: column ? 'y' : 'x' } }),
      )
    }
    if (column) {
      const hs = rs.map((r) => r.height)
      const m = mode(hs)
      hs.forEach((h, i) => report('list-height', h - m, { a: pathOf(run[i]), text: [textOf(run[i])], values: { height: r2(h), usual: m, of: run.length } }))
    }
  }

  // ------------------------------------------------- controls in one row
  const controls = all.filter((el) => el.matches(CONTROL) && !decoration(el) && !/^inline$/.test(style(el).display) && !el.parentElement.closest(CONTROL))
  const commonAncestor = (a, b) => {
    const up = new Set()
    for (let e = a; e; e = e.parentElement) up.add(e)
    for (let e = b; e; e = e.parentElement) if (up.has(e)) return e
    return null
  }
  const depth = (el, anc) => {
    let d = 0
    for (let e = el; e && e !== anc; e = e.parentElement) d++
    return d
  }
  const sameRow = (a, b) => {
    if (a.parentElement === b.parentElement) return true
    const tb = a.closest('[role=toolbar]')
    if (tb && tb === b.closest('[role=toolbar]')) return true
    const c = commonAncestor(a, b)
    if (!c) return false
    const s = style(c)
    return /flex/.test(s.display) && !/column/.test(s.flexDirection) && depth(a, c) <= 3 && depth(b, c) <= 3
  }
  for (const a of controls) {
    const ra = a.getBoundingClientRect()
    let next = null
    let nr = null
    for (const b of controls) {
      if (b === a) continue
      const rb = b.getBoundingClientRect()
      if (rb.left < ra.right - 0.5) continue
      const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (overlapY < 0.5 * Math.min(ra.height, rb.height)) continue
      if (nr && rb.left >= nr.left) continue
      if (!sameRow(a, b)) continue
      next = b
      nr = rb
    }
    if (!next) continue
    if (a.closest('[data-align-ok]') || next.closest('[data-align-ok]')) {
      excused.push({ kind: 'control-height', a: pathOf(a), b: pathOf(next), reason: (a.closest('[data-align-ok]') || next.closest('[data-align-ok]')).getAttribute('data-align-ok') })
      continue
    }
    report('control-height', ra.height - nr.height, {
      a: pathOf(a),
      b: pathOf(next),
      text: [textOf(a), textOf(next)],
      values: { a: r2(ra.height), b: r2(nr.height), centreDelta: r2(midY(ra) - midY(nr)) },
    })
  }

  // ------------------------------------------------------------- icons
  const icons = [...root.querySelectorAll('svg, img')].filter((el) => {
    if (!visible(el) || el.closest(IGNORE) || el.closest(PROSE) || el.closest('[inert]')) return false
    if (el.parentElement && el.parentElement.closest('svg')) return false
    const r = el.getBoundingClientRect()
    return r.width <= ICON_MAX && r.height <= ICON_MAX && r.width >= 4 && r.height >= 4
  })
  for (const icon of icons) {
    const ri = icon.getBoundingClientRect()
    // Its holder: the nearest control or painted box, three levels up at most.
    let holder = null
    let e = icon.parentElement
    for (let i = 0; e && e !== document.body && i < 3; i++, e = e.parentElement) {
      if (e.matches(CONTROL) || painted(e)) {
        holder = e
        break
      }
    }
    const ok = icon.closest('[data-align-ok]')
    if (ok && (!holder || holder.contains(ok) || ok === holder)) {
      excused.push({ kind: 'icon-centre', a: pathOf(icon), reason: ok.getAttribute('data-align-ok') })
      continue
    }
    const scope = holder || icon.parentElement
    if (!scope || skipped(scope)) continue
    // Everything else it shows (the text beside it, not a box around it).
    const rest = leaves(scope).filter((l) => l.el !== icon && !icon.contains(l.el) && !(l.kind !== 'text' && l.el.contains(icon)))
    const level = rest.filter((l) => l.rect.top < ri.bottom && l.rect.bottom > ri.top)
    const where = { a: pathOf(icon), b: pathOf(scope), text: [textOf(scope)] }
    if (holder && !rest.length) {
      // Alone in its control or box: centred both ways in the padding box.
      const p = paddingBox(holder)
      if (p.height > 64 || p.width > 120) continue
      const dx = midX(ri) - midX(p)
      const dy = midY(ri) - midY(p)
      const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy
      report('icon-centre', d, { ...where, values: { dx: r2(dx), dy: r2(dy), icon: box(ri), box: box(p) } }, ICON_TOL + 0.01)
      continue
    }
    // Beside text: level with the line it sits on.
    const text = level.find((l) => l.kind === 'text')
    if (text) {
      const dy = midY(ri) - midY(text.rect)
      report('icon-centre', dy, { ...where, values: { dy: r2(dy), icon: box(ri), line: box(text.rect) } }, ICON_TOL + 0.01)
    }
  }

  const counts = {}
  for (const f of findings) counts[f.kind] = (counts[f.kind] || 0) + 1
  findings.sort((p, q) => q.delta - p.delta)
  return {
    viewport: { w: vw, h: vh },
    baseline: 'first line box (Range.getClientRects) plus canvas fontBoundingBoxAscent',
    total: findings.length,
    counts,
    large: { total: Object.values(large).reduce((s, n) => s + n, 0), byKind: large, ...(opts.keepLarge ? { list: largeList } : {}) },
    excused,
    checked: { elements: all.length, siblingPairs: pairs, controls: controls.length, icons: icons.length },
    findings,
  }
}
