export type AppIconPreference =
  | "default"
  | "stable"
  | "anagram"
  | "dev"
  | "staging"
  | "journal"
  | "notepad"
  | "stone"
  | "typewriter-key"
  | "walnut";

export function normalizeAppIconPreference(
  value: string | null | undefined,
): AppIconPreference {
  switch (value) {
    case "stable":
    case "anagram":
    case "dev":
    case "staging":
    case "journal":
    case "notepad":
    case "stone":
    case "typewriter-key":
    case "walnut":
      return value;
    default:
      return "default";
  }
}

export function resolveAppIconName(
  icon: AppIconPreference,
  appIdentifier: string,
): Exclude<AppIconPreference, "default"> {
  if (icon !== "default") {
    return icon;
  }
  if (appIdentifier.endsWith(".dev")) {
    return "dev";
  }
  if (
    appIdentifier.endsWith(".staging") ||
    appIdentifier.endsWith(".nightly")
  ) {
    return "staging";
  }
  return "stable";
}

// An app icon is an identity, not a theme: switching the system between light
// and dark must leave it alone. Icons that ship two artworks pick one here and
// keep it, and `-dark` is only the file name of the artwork that was chosen.
const DARK_ARTWORK_ICONS = new Set<Exclude<AppIconPreference, "default">>([
  "stable",
]);

export function resolveDockIconName(
  icon: AppIconPreference,
  appIdentifier: string,
): string {
  const name = resolveAppIconName(icon, appIdentifier);
  return DARK_ARTWORK_ICONS.has(name) ? `${name}-dark` : name;
}

export function appIconAssetName(
  name: Exclude<AppIconPreference, "default">,
): string {
  if (DARK_ARTWORK_ICONS.has(name)) {
    return `${name}-dark`;
  }
  return HAS_LIGHT_ARTWORK_FILE.has(name) ? `${name}-light` : name;
}

// These ship their preview as `<name>-light.png`; the rest as `<name>.png`.
const HAS_LIGHT_ARTWORK_FILE = new Set<Exclude<AppIconPreference, "default">>([
  "anagram",
  "dev",
  "staging",
]);
