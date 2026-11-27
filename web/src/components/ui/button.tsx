import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground not-disabled:hover:bg-primary/90",
        destructive:
          "bg-destructive text-white not-disabled:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:not-disabled:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground not-disabled:hover:bg-secondary/80",
        ghost:
          "not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground [&.on]:bg-accent [&.on]:text-accent-foreground [&.open]:bg-accent [&.open]:text-accent-foreground",
        link: "text-primary underline-offset-4 not-disabled:hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3 pointer-coarse:h-11 pointer-coarse:px-4 pointer-coarse:text-sm",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5 pointer-coarse:h-11 pointer-coarse:px-4",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5 pointer-coarse:size-11",
        "icon-sm": "size-7 pointer-coarse:size-11 pointer-coarse:[&_svg:not([class*='size-'])]:size-5",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
