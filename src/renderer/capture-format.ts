interface ParsedSseEvent {
  data: string;
  event: string;
  id?: string;
  json?: unknown;
}

interface ProtocolEvent {
  count: number;
  data: string;
  event: string;
  json?: unknown;
  label: string;
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function formatJson(value: string): string | undefined {
  const parsed = tryParseJson(value);
  return parsed === undefined ? undefined : JSON.stringify(parsed, null, 2);
}

function parseSse(value: string): ParsedSseEvent[] {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const events: ParsedSseEvent[] = [];

  for (const block of normalized.split(/\n{2,}/u)) {
    if (!block.trim()) continue;
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let fieldValue = separator === -1 ? "" : line.slice(separator + 1);
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "event") event = fieldValue || "message";
      if (field === "id") id = fieldValue;
      if (field === "data") data.push(fieldValue);
    }

    const joinedData = data.join("\n");
    const json = tryParseJson(joinedData);
    if (event === "message" && isRecord(json) && typeof json.type === "string") {
      event = json.type;
    }
    events.push({
      event,
      data: joinedData,
      ...(id === undefined ? {} : { id }),
      ...(json === undefined ? {} : { json }),
    });
  }

  return events;
}

const EVENT_LABELS: Record<string, string> = {
  "response.created": "Response created",
  "response.in_progress": "Response started",
  "response.output_item.added": "Output item added",
  "response.content_part.added": "Content started",
  "response.output_text.delta": "Generated text",
  "response.output_text.done": "Text completed",
  "response.content_part.done": "Content completed",
  "response.output_item.done": "Output item completed",
  "response.completed": "Response completed",
  "response.failed": "Response failed",
  "response.incomplete": "Response incomplete",
  error: "Error",
  "[DONE]": "Stream finished",
};

function eventLabel(event: string): string {
  const known = EVENT_LABELS[event];
  if (known) return known;
  return event
    .replace(/^response\./u, "")
    .split(/[._]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function deltaText(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  return typeof json.delta === "string" ? json.delta : undefined;
}

function protocolEvents(value: string): ProtocolEvent[] {
  const result: ProtocolEvent[] = [];
  for (const parsed of parseSse(value)) {
    const event = parsed.data === "[DONE]" ? "[DONE]" : parsed.event;
    const text = deltaText(parsed.json);
    const previous = result.at(-1);
    if (text !== undefined && previous?.event === event && previous.text !== undefined) {
      previous.count += 1;
      previous.text += text;
      continue;
    }
    result.push({
      event,
      label: eventLabel(event),
      count: 1,
      data: parsed.data,
      ...(parsed.json === undefined ? {} : { json: parsed.json }),
      ...(text === undefined ? {} : { text }),
    });
  }
  return result;
}

export {
  eventLabel,
  formatJson,
  parseSse,
  protocolEvents,
  tryParseJson,
  type ParsedSseEvent,
  type ProtocolEvent,
};
