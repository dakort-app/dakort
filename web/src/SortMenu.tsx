import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { SortIcon } from './icons'
import { cn } from '@/lib/utils'

// SortMenu is the one way a list of files or folders is sorted: a small
// sort icon and a compact menu (small text, tight rows, its content's
// width) with Recent and Name. The file explorer's header and Browse use it.
export function SortMenu({ byName, onChange, size = 'icon-xs', className }: { byName: boolean; onChange: (byName: boolean) => void; size?: 'icon-xs' | 'icon-sm'; className?: string }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={size} className={cn('text-muted-foreground hover:text-foreground', className)} aria-label="Sort" title="Sort">
          <SortIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="sort-menu min-w-0 p-1">
        <DropdownMenuLabel className="px-2 pt-1 pb-0.5 text-xs font-normal text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={byName ? 'name' : 'recent'} onValueChange={(v) => onChange(v === 'name')}>
          <DropdownMenuRadioItem value="recent" className="py-1 pr-3 pl-6 text-xs [&>span:first-child]:left-1.5">
            Recent
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name" className="py-1 pr-3 pl-6 text-xs [&>span:first-child]:left-1.5">
            Name
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
