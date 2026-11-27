import { describe, expect, it } from 'vitest'
import { codeLangs, isRelative, join, loadLangs, loadMath, mathReady, render } from './mdrender'

const resolve = (href: string, kind: 'image' | 'link') => (kind === 'image' ? '/raw?p=' + href : '#')

describe('markdown files', () => {
  it('resolves links against the file they are in', () => {
    expect(join('notes/a.md', 'b.md')).toBe('notes/b.md')
    expect(join('notes/a.md', '../fig/x.png')).toBe('fig/x.png')
    expect(join('a.md', './sub/c.md#part')).toBe('sub/c.md')
    expect(join('a.md', 'my%20file.md')).toBe('my file.md')
  })

  it('knows relative targets from the rest', () => {
    for (const h of ['b.md', '../x.png', 'sub/c']) expect(isRelative(h)).toBe(true)
    for (const h of ['https://x.org', 'mailto:a@b', '/abs', '#top', 'javascript:alert(1)', '']) expect(isRelative(h)).toBe(false)
  })

  it('rewrites relative images and links, and opens web links outside', () => {
    const html = render('![p](fig/p.png) [b](b.md) [w](https://example.org)', { resolve })
    expect(html).toContain('src="/raw?p=fig/p.png"')
    expect(html).toContain('data-rel="b.md"')
    expect(html).toMatch(/href="https:\/\/example.org" target="_blank" rel="noopener noreferrer"/)
  })

  it('shows a plain <img> tag as the image it names, sized as asked', () => {
    const html = render('<img src="docs/a.gif" width="800" alt="the page">\n\nand <img src="https://x.org/p.png" height="20"/> inline', {
      resolve,
    })
    expect(html).toContain('<img src="/raw?p=docs/a.gif" alt="the page" width="800" loading="lazy">')
    expect(html).toContain('<img src="https://x.org/p.png" alt="" height="20" loading="lazy"> inline')
    expect(html).not.toContain('&lt;img')
    // Anything beyond src, alt, width and height stays text.
    for (const tag of ['<img src="a.png" onerror="alert(1)">', '<img src="a.png" style="x">', '<img src=a.png>', "<img src='a.png'>"]) {
      expect(render(tag)).not.toContain('<img')
    }
  })

  it('keeps raw HTML escaped', () => {
    const html = render('<script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
  })

  it('gives each code block a header with its language and a Copy button, over its pre, code still escaped', () => {
    for (const [src, lang] of [['```sh\necho <b>\n```', 'sh'], ['    indented <b>', '']]) {
      const html = render(src)
      expect(html).toMatch(
        new RegExp(`^<div class="code-block"><div class="code-head"><span class="code-lang">${lang}</span><button type="button" class="code-copy"[\\s\\S]*?</button></div><pre[^>]*><code[^>]*>[^<]*&lt;b&gt;\\n</code></pre>`),
      )
      expect(html.match(/<button/g)).toHaveLength(1)
    }
    expect(render('inline `code` only')).not.toContain('code-copy')
    expect(render('```<img src=x>\nx\n```')).not.toContain('<img')
  })

  it('shows YAML front matter as names and values, keeping source lines', () => {
    const html = render('---\nname: release\ndescription: "Tag <it>"\n  and publish\n---\n\n# Title\n')
    expect(html).toMatch(/^<dl class="front-matter" data-line="1"><div><dt>name<\/dt><dd>release<\/dd><\/div><div><dt>description<\/dt><dd>Tag &lt;it&gt; and publish<\/dd><\/div><\/dl>/)
    expect(html).toContain('<h1 data-line="7" dir="auto">Title</h1>')
    expect(html).not.toContain('<hr')
    expect(render('text\n\n---\n\nmore')).toContain('<hr')
  })

  it('right-aligns columns of numbers and keeps short inline code whole', () => {
    const html = render('| a | n |\n|---|---|\n| x | 12 |\n| y | 3.5% |\n')
    expect(html).toContain('<td class="short num"')
    expect(html).toContain('<td class="short">x')
    expect(render('`data-theme`')).toContain('<code class="nb">data-theme</code>')
    expect(render('`' + 'a'.repeat(30) + '`')).not.toContain('nb')
  })

  it('colours code once its language is in, and names only the languages it knows', async () => {
    const src = '```ts\nconst a: number = 1 // one\n```\n\n```weird\nx\n```'
    expect(codeLangs(src)).toEqual(['ts'])
    expect(render(src)).not.toContain('s-kw')
    await new Promise<void>((done) => loadLangs(codeLangs(src), done))
    const html = render(src)
    expect(html).toContain('<span class="s-kw">const</span>')
    expect(html).toContain('<span class="s-type">number</span>')
    expect(html).toContain('<span class="s-num">1</span>')
    expect(html).toContain('<span class="s-com">// one</span>')
    expect(codeLangs(src)).toEqual([])
  })

  it('renders math once KaTeX is in, and leaves prices alone', async () => {
    await new Promise<void>((done) => {
      loadMath(done)
      if (mathReady()) done()
    })
    const html = render('Euler: $e^{i\\pi} + 1 = 0$ and $$a_1 + b_1$$')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('<em>') // a_1 ... b_1 is not italics
    const prices = render('It costs $5 and $10 today.')
    expect(prices).not.toContain('katex')
    expect(prices).toContain('$5 and $10')
  })
})

describe('tables', () => {
  it('marks short columns whole and long ones wrapping, by their longest cell', () => {
    const long = 'No good in-browser viewer exists, so the server converts the file to PDF first.'
    const html = render(
      ['| Format | Approach | Effort |', '|---|---|---|', `| **ODT, ODS, ODP, PowerPoint** | ${long} | Moderate, needs LibreOffice |`, '| CSV | short | Easy |', '', 'after'].join('\n'),
    )
    const classes = [...html.matchAll(/<t[hd] class="(\w+)"/g)].map((m) => m[1])
    expect(classes).toEqual(['short', 'long', 'short', 'short', 'long', 'short', 'short', 'long', 'short'])
    expect(html).toContain('<p data-line="6" dir="auto">after</p>')
  })
})

describe('source lines', () => {
  it('stamps each block, items included, with the line it starts at', () => {
    const html = render(['# Title', '', 'one', 'two', '', '- a', '- b', '', '```', 'x', '```', '', '> q'].join('\n'))
    expect(html).toContain('<h1 data-line="1" dir="auto">')
    expect(html).toContain('<p data-line="3" dir="auto">one')
    expect(html).toContain('<ul data-line="6" dir="auto">')
    expect(html).toContain('<li data-line="7">b')
    expect(html).toContain('<code data-line="9">')
    expect(html).toContain('<blockquote data-line="13" dir="auto">')
    expect(html).not.toMatch(/<p data-line="6"[ >]/) // a tight item's paragraph renders nothing
  })
})
