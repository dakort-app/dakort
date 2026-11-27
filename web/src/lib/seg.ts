// shadcn's Tabs look (new-york TabsList and TabsTrigger)
// for the app's segmented controls: the agent switch and Effort in the
// model menu, Preview / Source, the files' Recent / A–Z, Browse's sort and
// the PDF and Word zoom groups. They keep their own buttons and state
// (aria-pressed, or aria-selected for the agent tabs); the step in use is
// shadcn's active trigger, raised on the background with shadow-sm.

// With a mouse a 28 px track and 24 px steps (SPEC.md). On touch each
// step is a 44 px target whose shape is drawn 4 px inside it (a transparent
// border), on a track drawn the same 4 px in (::before), so the step in
// use never overflows the track.
export const segList =
  "inline-flex h-7 w-fit items-center justify-center rounded-lg bg-muted p-[2px] text-muted-foreground pointer-coarse:relative pointer-coarse:h-auto pointer-coarse:bg-transparent pointer-coarse:p-0 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:inset-y-1 pointer-coarse:before:rounded-lg pointer-coarse:before:bg-muted pointer-coarse:before:pointer-events-none pointer-coarse:before:content-[''] pointer-coarse:*:relative"

export const segItem =
  "inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-[color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 pointer-coarse:relative pointer-coarse:min-h-11 pointer-coarse:border-4 pointer-coarse:border-x-0 pointer-coarse:bg-clip-padding hover:bg-transparent aria-pressed:bg-background aria-pressed:shadow-sm aria-selected:bg-background aria-selected:shadow-sm dark:aria-pressed:border-input dark:aria-pressed:bg-input/30 dark:aria-pressed:text-foreground dark:aria-selected:border-input dark:aria-selected:bg-input/30 dark:aria-selected:text-foreground pointer-coarse:dark:aria-pressed:border-transparent pointer-coarse:dark:aria-selected:border-transparent"
