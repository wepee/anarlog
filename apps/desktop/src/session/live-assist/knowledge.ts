import { commands as fs2Commands, type MarkdownFile } from "@anlg/plugin-fs2";

const OBSIDIAN_MAX_FILES = 3_000;
const OBSIDIAN_MAX_FILE_BYTES = 40_000;
const OBSIDIAN_CACHE_MS = 10 * 60_000;

let vaultCache: {
  path: string;
  files: MarkdownFile[];
  loadedAtMs: number;
} | null = null;

// The Markdown notes of the user's Obsidian vault, read on this computer and
// kept for ten minutes so a new call does not read the whole vault again.
export async function loadObsidianVault(path: string): Promise<MarkdownFile[]> {
  if (
    vaultCache &&
    vaultCache.path === path &&
    Date.now() - vaultCache.loadedAtMs < OBSIDIAN_CACHE_MS
  ) {
    return vaultCache.files;
  }
  const result = await fs2Commands.readMarkdownTree(
    path,
    OBSIDIAN_MAX_FILES,
    OBSIDIAN_MAX_FILE_BYTES,
  );
  if (result.status === "error") {
    throw new Error(result.error);
  }
  vaultCache = { path, files: result.data, loadedAtMs: Date.now() };
  return result.data;
}
