import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";

import { useMountEffect } from "@anlg/ui/hooks/use-mount-effect";

// The native macOS traffic lights live in window points, but the webview
// content scales with the zoom factor (--anlg-zoom). These classes divide the
// gutter by that factor so chrome stays aligned with the buttons at any zoom.
export const WINDOW_CONTROLS_GUTTER_CLASS =
  "pl-[calc(76px_/_var(--anlg-zoom,1))]";
export const WINDOW_CONTROLS_GUTTER_PLUS_28_CLASS =
  "left-[calc(76px_/_var(--anlg-zoom,1)_+_28px)]";
export const WINDOW_CONTROLS_GUTTER_PLUS_32_CLASS =
  "pl-[calc(76px_/_var(--anlg-zoom,1)_+_32px)]";
export const WINDOW_CONTROLS_GUTTER_PLUS_80_CLASS =
  "pl-[calc(76px_/_var(--anlg-zoom,1)_+_80px)]";
export const WINDOW_CONTROLS_SIDEBAR_MIN_WIDTH =
  "max(200px, calc(76px / var(--anlg-zoom, 1) + 124px))";
// Centers 28px (size-7) controls on the 23px baseline the traffic lights use.
export const WINDOW_CONTROLS_ROW_PADDING_TOP_CLASS =
  "pt-[max(0px,calc(23px_/_var(--anlg-zoom,1)_-_14px))]";

export function useWindowControlsGutter() {
  const [visible, setVisible] = useState(true);

  useMountEffect(() => {
    if (!isTauri()) {
      return;
    }

    let cancelled = false;
    let unlistenResize: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    const sync = async () => {
      const isFullscreen = await appWindow.isFullscreen().catch(() => false);

      if (!cancelled) {
        setVisible(!isFullscreen);
      }
    };

    void sync();
    void appWindow
      .onResized(() => {
        void sync();
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }

        unlistenResize = unlisten;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlistenResize?.();
    };
  });

  return visible;
}
