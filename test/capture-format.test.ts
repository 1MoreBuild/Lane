import { describe, expect, it } from "vitest";

import {
  formatJson,
  parseSse,
  protocolEvents,
} from "../src/renderer/capture-format.ts";

describe("capture formatting", () => {
  it("pretty prints JSON without changing its value", () => {
    expect(formatJson('{"model":"gpt-5.6-luna","stream":true}')).toBe(
      '{\n  "model": "gpt-5.6-luna",\n  "stream": true\n}',
    );
    expect(formatJson('{"truncated":')).toBeUndefined();
  });

  it("parses SSE fields, CRLF, and JSON event types", () => {
    const events = parseSse(
      'event: response.created\r\ndata: {"type":"response.created","sequence_number":0}\r\n\r\n' +
        'data: {"type":"response.completed","status":"completed"}\r\n\r\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("response.created");
    expect(events[1]?.event).toBe("response.completed");
  });

  it("groups consecutive text deltas into readable output", () => {
    const events = protocolEvents(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      label: "Generated text",
      count: 2,
      text: "Hello world",
    });
    expect(events[1]?.label).toBe("Response completed");
  });
});
