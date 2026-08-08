import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-max max-w-[calc(100vw-2rem)] origin-(--transform-origin) items-center gap-1.5 rounded-lg border border-white/10 bg-[var(--tooltip)] px-2.5 py-1.5 text-xs font-medium leading-4 text-[var(--tooltip-foreground)] shadow-lg transition-[transform,opacity] duration-[125ms] ease-[cubic-bezier(0.23,1,0.32,1)] has-data-[slot=kbd]:pr-1.5 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-[0.98] data-starting-style:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-lg",
            className
          )}
          {...props}
        >
          <TooltipPrimitive.Arrow className="relative block h-1.5 w-3 overflow-clip data-[side=bottom]:-top-1.5 data-[side=inline-end]:-left-[9px] data-[side=inline-end]:-rotate-90 data-[side=inline-start]:-right-[9px] data-[side=inline-start]:rotate-90 data-[side=left]:-right-[9px] data-[side=left]:rotate-90 data-[side=right]:-left-[9px] data-[side=right]:-rotate-90 data-[side=top]:-bottom-1.5 data-[side=top]:rotate-180 before:absolute before:bottom-0 before:left-1/2 before:size-[calc(6px*1.414)] before:-translate-x-1/2 before:translate-y-1/2 before:rotate-45 before:rounded-[1px] before:border before:border-white/10 before:bg-[var(--tooltip)] before:content-['']" />
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
