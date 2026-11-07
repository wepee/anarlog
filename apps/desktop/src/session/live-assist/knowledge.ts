import { commands as fs2Commands, type MarkdownFile } from "@anlg/plugin-fs2";
import { commands as tantivy } from "@anlg/plugin-tantivy";

export type KnowledgeSnippet = {
  tag: string;
  kind: "note" | "obsidian";
  title: string;
  excerpt: string;
};

const EXCERPT_CHARS = 600;
const MAX_KEYWORDS = 8;
const OBSIDIAN_MAX_FILES = 3_000;
const OBSIDIAN_MAX_FILE_BYTES = 40_000;
const OBSIDIAN_CACHE_MS = 10 * 60_000;

const STOPWORDS = new Set([
  "about",
  "avez",
  "avoir",
  "being",
  "cela",
  "cette",
  "comment",
  "dans",
  "does",
  "elle",
  "est-ce",
  "était",
  "être",
  "faire",
  "have",
  "leur",
  "mais",
  "nous",
  "pour",
  "pourquoi",
  "quand",
  "quel",
  "quelle",
  "quels",
  "quoi",
  "sont",
  "that",
  "their",
  "there",
  "they",
  "this",
  "votre",
  "vous",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of fold(text).split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 4 || STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= MAX_KEYWORDS) {
      break;
    }
  }
  return keywords;
}

function excerptAround(content: string, keywords: string[]): string {
  const folded = fold(content);
  const hit = keywords
    .map((keyword) => folded.indexOf(keyword))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (hit ?? 0) - EXCERPT_CHARS / 3);
  const slice = content.slice(start, start + EXCERPT_CHARS);
  return `${start > 0 ? "…" : ""}${slice.replace(/\s+/g, " ").trim()}${
    start + EXCERPT_CHARS < content.length ? "…" : ""
  }`;
}

// Notes from earlier meetings, through the app's own search index.
export async function searchPastNotes(
  question: string,
  excludeSessionId: string,
  limit = 4,
): Promise<KnowledgeSnippet[]> {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) {
    return [];
  }
  const result = await tantivy.search({
    query: keywords.join(" "),
    filters: { created_at: null, doc_type: "session", facet: null },
    limit: limit + 1,
    options: {
      fuzzy: true,
      distance: 1,
      snippets: true,
      snippet_max_chars: EXCERPT_CHARS,
      phrase_slop: null,
    },
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data.hits
    .filter((hit) => hit.document.id !== excludeSessionId)
    .slice(0, limit)
    .map((hit, index) => ({
      tag: `N${index + 1}`,
      kind: "note" as const,
      title: hit.document.title || "Untitled",
      excerpt:
        hit.content_snippet?.fragment?.trim() ||
        excerptAround(hit.document.content, keywords),
    }));
}

let vaultCache: {
  path: string;
  files: MarkdownFile[];
  loadedAtMs: number;
} | null = null;

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

// A small keyword ranking over the vault: matches in the file name weigh
// more, repeated matches in the body are capped so one long note does not
// win on its own.
export function searchMarkdownFiles(
  files: MarkdownFile[],
  question: string,
  limit = 4,
): KnowledgeSnippet[] {
  const keywords = extractKeywords(question);
  if (keywords.length === 0) {
    return [];
  }
  const minMatches = keywords.length === 1 ? 1 : 2;

  return files
    .map((file) => {
      const title = fold(file.path);
      const body = fold(file.content);
      let score = 0;
      let matched = 0;
      for (const keyword of keywords) {
        const inTitle = title.includes(keyword);
        const inBody = body.split(keyword).length - 1;
        if (inTitle || inBody > 0) {
          matched += 1;
        }
        score += (inTitle ? 3 : 0) + Math.min(inBody, 5);
      }
      return { file, score, matched };
    })
    .filter((entry) => entry.matched >= minMatches)
    .sort((a, b) => b.score - a.score || b.file.modifiedMs - a.file.modifiedMs)
    .slice(0, limit)
    .map((entry, index) => ({
      tag: `O${index + 1}`,
      kind: "obsidian" as const,
      title: entry.file.path.replace(/\.md$/i, ""),
      excerpt: excerptAround(entry.file.content, keywords),
    }));
}
