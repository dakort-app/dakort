import { cn } from '@/lib/utils'

// shadcn's Dialog look (new-york DialogOverlay and DialogContent) for the app's sheets:
// the dimmed overlay, and the panel with its border, shadow-lg, corners
// and fade and zoom in. A centred dialog from 900 px up, a bottom sheet
// below (rounded on top, sliding up). modal.ts keeps their focus, Tab and
// Escape as before; the markup stays the sheets' own (.sheet-back > .sheet
// with role="dialog", a .bar head, a .sheet-foot).

export const sheetBack = (popover?: boolean) =>
  cn(
    'sheet-back fixed inset-0 z-10',
    popover ? 'popover-back block' : 'flex items-end justify-center bg-black/50 animate-in fade-in-0 min-[900px]:items-center min-[900px]:py-[6vh]',
  )

export const sheetPanel = (o: { tall?: boolean; popover?: boolean; className?: string } = {}) =>
  cn(
    'sheet flex w-full flex-col overflow-hidden border bg-background text-foreground shadow-lg',
    '[&>.bar]:px-4 [&>.bar_b]:text-base [&>.bar_b]:font-semibold [&>.bar_b]:tracking-normal',
    o.popover
      ? 'popover fixed w-[400px] max-h-[60dvh] rounded-md shadow-md animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 [&>.bar]:min-h-9 [&>.bar]:px-3 [&>.bar_b]:text-sm'
      : 'max-h-[85dvh] max-w-[640px] rounded-t-xl border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] animate-in fade-in-0 slide-in-from-bottom-4 min-[900px]:max-h-full min-[900px]:max-w-lg min-[900px]:rounded-lg min-[900px]:border min-[900px]:pb-0 min-[900px]:zoom-in-95 min-[900px]:slide-in-from-bottom-0',
    o.tall && !o.popover && 'tall h-[85dvh] min-[900px]:h-auto',
    o.className,
  )
