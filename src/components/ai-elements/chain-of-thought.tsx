"use client"

import type { ComponentProps, ReactNode } from "react"
import { Check, ChevronDown, Circle, LoaderCircle } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

// Adapted from AI Elements' Chain of Thought component for Lane's Base UI layer.
function ChainOfThought({
  className,
  ...props
}: ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible
      className={cn("group/chain min-w-0", className)}
      defaultOpen
      {...props}
    />
  )
}

function ChainOfThoughtHeader({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronDown className="size-3.5 transition-transform group-data-panel-open/chain:rotate-180" />
    </CollapsibleTrigger>
  )
}

function ChainOfThoughtContent({
  className,
  ...props
}: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn(
        "relative mt-1 ml-2.5 border-l border-border/70 pl-4",
        className,
      )}
      {...props}
    />
  )
}

function ChainOfThoughtStep({
  children,
  className,
  defaultOpen = false,
  description,
  label,
  status = "complete",
}: {
  children?: ReactNode
  className?: string
  defaultOpen?: boolean
  description?: string
  label: string
  status?: "complete" | "error" | "running"
}) {
  const icon =
    status === "running" ? (
      <LoaderCircle className="size-3 animate-spin" />
    ) : status === "complete" ? (
      <Check className="size-3" />
    ) : (
      <Circle className="size-2.5 fill-destructive text-destructive" />
    )

  return (
    <Collapsible
      className={cn("group/step relative py-1.5", className)}
      defaultOpen={defaultOpen}
    >
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        disabled={!children}
      >
        <span className="absolute -left-[1.35rem] top-2.5 grid size-4 place-items-center rounded-full bg-background text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium leading-4 text-foreground">
            {label}
          </span>
          {description ? (
            <span className="mt-0.5 block truncate text-[0.6875rem] leading-4 text-muted-foreground">
              {description}
            </span>
          ) : null}
        </span>
        {children ? (
          <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open/step:rotate-180" />
        ) : null}
      </CollapsibleTrigger>
      {children ? (
        <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}

export {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
}
