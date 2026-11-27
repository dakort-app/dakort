import type { ReactNode } from 'react'
import { SettingsMenu } from './FolderBar'
import { ChangesIcon, FilesIcon, SettingsIcon, TerminalIcon } from './icons'
import { Mark } from './mark'
import { cn } from '@/lib/utils'

// The activity bar, as VS Code's (and Obsidian's ribbon): a narrow column
// at the window's left edge, laptop only. Dakort's mark on top, then one
// button per sidebar view, the one shown marked by a bar on its left edge
// and its icon at full strength; then the panels the editor can show
// (the terminal); the settings at its foot. A view's
// button again hides the sidebar, and the bar stays when it is hidden. On
// a phone the sidebar is a sheet and keeps its own Files / Changes row.

export type SideView = 'files' | 'changes'

type Props = {
  view: SideView | null // the view shown, null with the sidebar hidden
  onView: (v: SideView) => void
  changes: number // files not on the remote, as a badge on Changes
  terminal: boolean
  onTerminal: () => void
  onDevices: () => void
}

export function ActivityBar({ view, onView, changes, terminal, onTerminal, onDevices }: Props) {
  return (
    <nav className="activity-bar" aria-label="Views">
      <div className="activity-mark" aria-hidden="true">
        <Mark />
      </div>
      <Item tip="File explorer" on={view === 'files'} onClick={() => onView('files')} pressed={view === 'files'}>
        <FilesIcon />
      </Item>
      <Item tip="Changes" label={'Changes' + (changes ? `, ${changes} not pushed` : '')} on={view === 'changes'} onClick={() => onView('changes')} pressed={view === 'changes'}>
        <ChangesIcon />
        {/* The count drawn by the stylesheet, so the button still reads as
            an icon and keeps its tip (tips.ts: icon-only controls). */}
        {changes > 0 && <span className="activity-badge" data-count={changes > 99 ? '99+' : changes} aria-hidden="true" />}
      </Item>
      <Item tip="Terminal" keys="Ctrl+`" lit={terminal} pressed={terminal} onClick={onTerminal}>
        <TerminalIcon />
      </Item>
      <span className="grow" />
      <SettingsMenu onDevices={onDevices} side="right">
        <button type="button" className="activity-item" aria-label="Settings" title="Settings" data-tip-place="right">
          <SettingsIcon />
        </button>
      </SettingsMenu>
    </nav>
  )
}

// One button: on is the view shown (the edge bar), lit a panel that is
// open (the icon at full strength only).
function Item(p: { tip: string; keys?: string; label?: string; on?: boolean; lit?: boolean; pressed?: boolean; expanded?: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn('activity-item', p.on && 'on', p.lit && 'lit')}
      aria-label={p.label ?? p.tip}
      aria-pressed={p.pressed}
      aria-expanded={p.expanded}
      title={p.tip}
      data-tip-key={p.keys}
      aria-keyshortcuts={p.keys?.replace('Ctrl', 'Control')}
      data-tip-place="right"
      onClick={p.onClick}
    >
      {p.children}
    </button>
  )
}
