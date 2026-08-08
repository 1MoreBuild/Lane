import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LoaderCircle } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import type { LaneState } from "../shared/contracts.ts";
import "./menubar.css";

function App(): ReactNode {
  const [state, setState] = useState<LaneState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const unsubscribe = window.lane.onStateChanged(setState);
    window.lane.getState().then(setState).catch((value: unknown) => {
      setError(value instanceof Error ? value.message : String(value));
    });
    return unsubscribe;
  }, []);

  async function toggleGateway(enabled: boolean): Promise<void> {
    setBusy(true);
    setError("");
    try {
      setState(enabled ? await window.lane.startGateway() : await window.lane.stopGateway());
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <main className="menubar-shell menubar-loading">
        <LoaderCircle aria-hidden="true" />
        <span>{error || "Opening Lane…"}</span>
      </main>
    );
  }

  return (
    <main className="menubar-shell">
      <header className="menubar-header">
        <strong className={error ? "is-error" : undefined}>Gateway</strong>
        <Switch
          aria-label={state.gateway.running ? "Stop gateway" : "Start gateway"}
          checked={state.gateway.running}
          disabled={busy}
          size="sm"
          title={error || undefined}
          onCheckedChange={(checked) => void toggleGateway(checked)}
        />
      </header>

      <footer className="menubar-footer">
        <button onClick={() => void window.lane.openMainWindow()} type="button">
          <span>Open Lane</span>
        </button>
        <div aria-hidden="true" className="menubar-divider" />
        <button onClick={() => void window.lane.quitApp()} type="button">
          <span>Quit Lane</span>
        </button>
      </footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
