import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// A toolbar button (.tbtn): shadcn's ghost button at the toolbar's 28 px
// with a mouse (44 on touch), the icon alone until its pane is 600 px wide,
// where its name shows beside it (styles.css, .tbtn .lbl). primary and
// secondary are the filled and outlined ones (Save, Revert); on is a
// switch that is on (Find open, the view shown).
export function toolClass(o: { primary?: boolean; secondary?: boolean; on?: boolean; text?: boolean; className?: string } = {}) {
  return cn(
    buttonVariants({ variant: o.primary ? 'default' : o.secondary ? 'outline' : 'ghost', size: 'sm' }),
    'tbtn h-7 min-w-7 gap-2 px-1.5 has-[>svg]:px-1.5 font-normal pointer-coarse:min-w-11 pointer-coarse:px-2.5',
    !o.primary && !o.secondary && 'text-muted-foreground hover:text-foreground aria-pressed:text-foreground',
    o.text && 'px-2.5',
    o.on && 'on',
    o.text && 'text',
    o.className,
  )
}
