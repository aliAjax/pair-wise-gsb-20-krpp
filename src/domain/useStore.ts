import { useSyncExternalStore } from "react";
import { store } from "./store";
import type { Command } from "./types";

export function useLab() {
  const state = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.state,
  );
  return { state, dispatch: (cmd: Command) => store.dispatch(cmd) };
}

export { store };
