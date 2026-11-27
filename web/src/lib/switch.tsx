import { cn } from '@/lib/utils'

// shadcn's Switch (components/ui/switch.tsx) drawn without its button, for
// a row that is itself the switch (the sidebar's Dark mode: a button with
// role="switch" can hold no second button). Same track and thumb.
export function SwitchLook({ on, className }: { on: boolean; className?: string }) {
  const state = on ? 'checked' : 'unchecked'
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn(
        'switch inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80',
        className,
      )}
    >
      <span
        data-state={state}
        className="pointer-events-none block size-4 rounded-full bg-background ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-muted-foreground"
      />
    </span>
  )
}
