"use client"

import { Fragment, useEffect, useMemo, useState } from "react"
import { useTheme } from "next-themes"
import { createHighlighterCore, type ThemedToken } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { formatJson, protocolEvents } from "@/renderer/capture-format"
import type { GatewayCapturedBody } from "@/shared/contracts"

const MAX_HIGHLIGHT_BYTES = 128 * 1024

const highlighterPromise = createHighlighterCore({
  themes: [
    import("@shikijs/themes/github-light"),
    import("@shikijs/themes/github-dark"),
  ],
  langs: [import("@shikijs/langs/json")],
  engine: createJavaScriptRegexEngine(),
})

function byteCount(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function HighlightedCode({
  code,
  json = false,
  maxHeight = "max-h-72",
}: {
  code: string
  json?: boolean
  maxHeight?: string
}) {
  const { resolvedTheme } = useTheme()
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const shouldHighlight = json && new TextEncoder().encode(code).byteLength <= MAX_HIGHLIGHT_BYTES

  useEffect(() => {
    let active = true
    setTokens(null)
    if (!shouldHighlight) return () => { active = false }

    void highlighterPromise
      .then((highlighter) => {
        if (!active) return
        const result = highlighter.codeToTokens(code, {
          lang: "json",
          theme: resolvedTheme === "dark" ? "github-dark" : "github-light",
        })
        if (active) setTokens(result.tokens)
      })
      .catch(() => {
        if (active) setTokens(null)
      })

    return () => { active = false }
  }, [code, resolvedTheme, shouldHighlight])

  return (
    <div className="lane-code-viewer overflow-hidden rounded-lg border bg-background/55">
      <ScrollArea aria-label="Captured body" role="region" viewportClassName={maxHeight}>
        <pre>
          <code>
            {tokens
              ? tokens.map((line, lineIndex) => (
                  <Fragment key={lineIndex}>
                    {line.map((token, tokenIndex) => (
                      <span
                        key={`${token.offset}-${tokenIndex}`}
                        style={{ color: token.color }}
                      >
                        {token.content}
                      </span>
                    ))}
                    {lineIndex < tokens.length - 1 ? "\n" : null}
                  </Fragment>
                ))
              : code}
          </code>
        </pre>
      </ScrollArea>
    </div>
  )
}

function protocolDescription(event: ReturnType<typeof protocolEvents>[number]): string | undefined {
  if (event.text !== undefined) {
    return `${event.count} ${event.count === 1 ? "chunk" : "chunks"}`
  }
  if (typeof event.json !== "object" || event.json === null || Array.isArray(event.json)) {
    return undefined
  }
  const record = event.json as Record<string, unknown>
  const sequence = typeof record.sequence_number === "number"
    ? `Event ${record.sequence_number + 1}`
    : undefined
  const response = typeof record.response === "object" && record.response !== null
    ? record.response as Record<string, unknown>
    : undefined
  const status = typeof response?.status === "string"
    ? response.status.replaceAll("_", " ")
    : typeof record.status === "string"
      ? record.status.replaceAll("_", " ")
      : undefined
  return [sequence, status].filter(Boolean).join(" · ") || undefined
}

function SseEventView({ body }: { body: string }) {
  const events = useMemo(() => protocolEvents(body), [body])
  if (events.length === 0) {
    return <HighlightedCode code={body} />
  }

  return (
    <div className="rounded-lg border bg-background/35 px-3 py-2">
      <ChainOfThought>
        <ChainOfThoughtHeader>
          {events.length} response {events.length === 1 ? "event" : "events"}
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {events.map((event, index) => {
            const failed = event.event.includes("failed") || event.event === "error"
            const description = protocolDescription(event)
            const payload = event.text !== undefined
              ? event.text
              : event.json === undefined
                ? event.data
                : JSON.stringify(event.json, null, 2)
            return (
              <ChainOfThoughtStep
                defaultOpen={event.text !== undefined || failed}
                key={`${event.event}-${index}`}
                label={event.label}
                status={failed ? "error" : "complete"}
                {...(description === undefined ? {} : { description })}
              >
                {payload ? (
                  <HighlightedCode
                    code={payload}
                    json={event.text === undefined && event.json !== undefined}
                    maxHeight="max-h-64"
                  />
                ) : null}
              </ChainOfThoughtStep>
            )
          })}
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  )
}

function CodeViewer({ capture }: { capture: GatewayCapturedBody }) {
  const contentType = capture.contentType?.toLowerCase() ?? ""
  const formattedJson = useMemo(
    () => contentType.includes("json") ? formatJson(capture.body) : undefined,
    [capture.body, contentType],
  )
  const isSse = contentType.includes("text/event-stream") || /^event:\s|^data:\s/mu.test(capture.body)
  const canFormat = formattedJson !== undefined || isSse
  const [mode, setMode] = useState<"pretty" | "raw">(canFormat ? "pretty" : "raw")

  useEffect(() => {
    setMode(canFormat ? "pretty" : "raw")
  }, [capture.body, canFormat])

  return (
    <div className="min-w-0">
      {canFormat ? (
        <div className="mb-1.5 flex items-center justify-end gap-0.5">
          <Button
            aria-pressed={mode === "pretty"}
            className={cn(mode === "pretty" && "bg-muted text-foreground")}
            onClick={() => setMode("pretty")}
            size="xs"
            variant="ghost"
          >
            {isSse ? "Events" : "Pretty"}
          </Button>
          <Button
            aria-pressed={mode === "raw"}
            className={cn(mode === "raw" && "bg-muted text-foreground")}
            onClick={() => setMode("raw")}
            size="xs"
            variant="ghost"
          >
            Raw
          </Button>
        </div>
      ) : null}

      {mode === "pretty" && isSse ? (
        <SseEventView body={capture.body} />
      ) : (
        <HighlightedCode
          code={mode === "pretty" && formattedJson !== undefined ? formattedJson : capture.body}
          json={formattedJson !== undefined}
        />
      )}

      {capture.truncated && (
        <p className="lane-label mt-1.5 text-muted-foreground">
          Captured {byteCount(capture.capturedBytes)} of {byteCount(capture.totalBytes)}
        </p>
      )}
    </div>
  )
}

export { CodeViewer, HighlightedCode }
