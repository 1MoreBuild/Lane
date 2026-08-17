// Contract for the test-only main-process control channel. Kept free of any
// electron import so the CLI protocol (and the test harness) can validate
// actions from plain Node.

export type E2eControlAction =
  | "window-state"
  | "set-window-size"
  | "clipboard-text"
  | "menu-labels"
  | "menu-click"
  | "push-update-state"
  | "stub-dialogs"
  | "dialog-message";

export interface E2eControlParams {
  action?: E2eControlAction;
  width?: number;
  height?: number;
  label?: string;
  channel?: string;
  payload?: unknown;
}

const E2E_ACTIONS: readonly E2eControlAction[] = [
  "window-state",
  "set-window-size",
  "clipboard-text",
  "menu-labels",
  "menu-click",
  "push-update-state",
  "stub-dialogs",
  "dialog-message",
];

export function isE2eControlAction(value: unknown): value is E2eControlAction {
  return E2E_ACTIONS.includes(value as E2eControlAction);
}
