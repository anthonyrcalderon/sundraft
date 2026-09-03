import { useEffect } from "react";

// Registers a single global keyboard shortcut (e.g. "Escape", "Delete").
// Ignored while the user is typing in a text input/textarea, so hotkeys
// don't fight with normal typing.
export function useHotkey(key: string, handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== key) return;
      const target = e.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (isTyping) return;
      handler();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, handler, enabled]);
}
