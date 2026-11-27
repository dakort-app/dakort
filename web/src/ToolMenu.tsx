import type { ReactNode } from 'react'
import { MoreIcon } from './icons'
import { PopMenu } from './PopMenu'
import { toolClass } from '@/lib/tool'
import { cn } from '@/lib/utils'
import { menuItem, menuItemDestructive } from '@/lib/menu'

// A file's bar on a narrow screen: the least used buttons (Download, Open,
// Revert, a PDF's Source) leave the bar for this ⋯ menu, so the file's
// name keeps its room. styles in styles.css (.narrow-only, .tool-row).
// danger: a tool that loses work (Revert) stays a labelled row in the
// menu, never a lone icon button.
export type MenuTool = { label: string; icon: ReactNode; onPick?: () => void; href?: string; download?: string; danger?: boolean }

export function ToolMenu({ title, tools }: { title: string; tools: MenuTool[] }) {
  if (!tools.length) return null
  // One tool is a button, not a menu holding one row.
  if (tools.length === 1 && !tools[0].danger) {
    const t = tools[0]
    return t.href ? (
      <a className={toolClass({ className: 'narrow-only' })} href={t.href} download={t.download} aria-label={t.label} data-tip={t.label}>
        {t.icon}
      </a>
    ) : (
      <button type="button" className={toolClass({ className: 'narrow-only' })} aria-label={t.label} data-tip={t.label} onClick={t.onPick}>
        {t.icon}
      </button>
    )
  }
  return (
    <PopMenu className="tool-menu narrow-only" chipClass={toolClass()} label="More" title="More" sheetTitle={title} chip={<MoreIcon />}>
      {(close) => (
        <div role="menu" aria-label={title}>
          {tools.map((t) =>
            t.href ? (
              <a key={t.label} role="menuitem" data-item tabIndex={-1} className={cn('picker-row tool-row', menuItem)} href={t.href} download={t.download} onClick={close}>
                {t.icon}
                {t.label}
              </a>
            ) : (
              <div
                key={t.label}
                role="menuitem"
                data-item
                tabIndex={-1}
                className={cn('picker-row tool-row', menuItem, t.danger && cn('danger', menuItemDestructive))}
                onClick={() => {
                  close()
                  t.onPick?.()
                }}
              >
                {t.icon}
                {t.label}
              </div>
            ),
          )}
        </div>
      )}
    </PopMenu>
  )
}
