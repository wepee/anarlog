import type { ReactNode } from "react";

export type CalendarProvider = {
  disabled: boolean;
  id: string;
  displayName: string;
  icon: ReactNode;
  badge?: string | null;
  docsPath: string;
};

const _PROVIDERS = [
  {
    disabled: false,
    id: "apple",
    displayName: "Apple Calendar",
    badge: "",
    icon: (
      <img
        src="/assets/apple-calendar.png"
        alt="Apple Calendar"
        className="size-5 rounded-[4px] object-cover"
      />
    ),
    docsPath: "https://docs.anarlog.so/calendar#apple-calendar",
  },
] as const satisfies readonly CalendarProvider[];

export const PROVIDERS = [..._PROVIDERS];
