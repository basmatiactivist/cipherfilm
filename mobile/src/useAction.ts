import { useCallback, useRef, useState } from "react";
import { t } from "./i18n";

/** Runs one async action at a time and keeps its error message for the screen. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const running = useRef(false);
  const run = useCallback(async (f: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Something went wrong."));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}
