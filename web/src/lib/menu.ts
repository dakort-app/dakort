// shadcn's DropdownMenu look (new-york DropdownMenu), as class
// names for the app's own menus: the model and mode menus, a tab's, a
// terminal's and a project's menu, the ⋯ and commit menus. Those keep
// their own keys and placement (PopMenu.tsx, menuKeys); only the look is
// shadcn's. Rows highlight under the pointer as well as on focus, since
// they are not focused as the pointer moves.

export const menuSurface =
  'rounded-md border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[side=above]:slide-in-from-bottom-2 data-[side=below]:slide-in-from-top-2'

export const menuItem =
  "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent aria-disabled:pointer-events-none aria-disabled:opacity-50 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"

export const menuItemDestructive = 'text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg:not([class*=text-])]:text-destructive'

export const menuLabel = 'truncate px-2 py-1.5 text-sm font-medium'

export const menuCaption = 'px-2 py-1.5 text-xs text-muted-foreground'

export const menuSeparator = '-mx-1 my-1 h-px bg-border'

export const menuShortcut = 'ml-auto text-xs tracking-widest text-muted-foreground'
