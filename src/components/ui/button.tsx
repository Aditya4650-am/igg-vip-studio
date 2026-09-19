import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "premium-button btn-motion inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold outline-none disabled:pointer-events-none disabled:opacity-45 transition-[scale,background-color,color,box-shadow,transform] duration-150 ease-smooth active:not-disabled:scale-press focus-visible:ring-2 focus-visible:ring-primary/50",
  {
    variants: {
      variant: {
        primary: "button-primary bg-primary text-primary-fg hover:bg-primary/90",
        outline: "button-outline bg-transparent text-primary shadow-outline hover:bg-primary/10",
        ghost: "button-ghost bg-input text-muted hover:text-fg hover:bg-card",
        tool: "button-tool bg-transparent text-fg shadow-hairline hover:shadow-lift hover:text-primary",
        purple: "button-ice bg-transparent text-purple shadow-purple hover:bg-purple/15",
        amber: "button-premium bg-transparent text-amber shadow-amber-ring hover:bg-amber/15",
        success: "button-success bg-ok-deep text-ok-fg hover:brightness-110",
        warn: "button-warn bg-amber-deep text-amber-fg hover:brightness-110",
        danger: "button-danger bg-danger-deep text-danger hover:brightness-110",
        secondary: "button-secondary bg-secondary text-secondary-fg hover:brightness-110",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-9 px-3 text-xs",
        lg: "h-12 px-5",
        icon: "size-11 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
