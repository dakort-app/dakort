// Sonner's look, as shadcn's Toaster (sonner) draws it:
// the popover's colours with its border, the radius, a soft shadow, 13 px
// text, rising in at the bottom centre. The app's toasts keep their own
// state and timers (an Undo, a failed rename); only the look is Sonner's.
export const toastClass =
  'toast fixed inset-x-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-3 rounded-md border bg-popover py-2 pr-2 pl-4 text-[13px] text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 [&:not(:has(>button))]:pr-4'
