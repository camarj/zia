import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILE_CHARS = 100_000;

interface FichaSection {
  readonly file: string;
  readonly header: string;
  readonly required: boolean;
}

const FICHA_SECTIONS: readonly FichaSection[] = [
  { file: "SOUL.md", header: "# IDENTITY (SOUL)", required: true },
  { file: "POLICIES.md", header: "# GOVERNANCE POLICIES", required: false },
  { file: "KNOWLEDGE.md", header: "# KNOWLEDGE", required: false },
  { file: "MEMORY.md", header: "# MEMORY (snapshot)", required: false },
];

async function readFichaFile(
  path: string,
  required: boolean
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (required) {
      throw new Error(
        `zia: cannot read system prompt — ${path} is missing or unreadable`,
        { cause }
      );
    }
    return undefined;
  }
  if (raw.length > MAX_FILE_CHARS) {
    return raw.slice(0, MAX_FILE_CHARS) + "\n [TRUNCATED]";
  }
  return raw;
}

export async function buildPromptFromFicha(fichaDir: string): Promise<string> {
  const blocks: string[] = [];

  for (const section of FICHA_SECTIONS) {
    const content = await readFichaFile(
      join(fichaDir, section.file),
      section.required
    );
    if (content === undefined) continue;

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      if (section.required) {
        throw new Error(
          `zia: SOUL.md is present but empty — ${join(fichaDir, section.file)}`
        );
      }
      continue;
    }

    blocks.push(`${section.header}\n\n${trimmed}`);
  }

  return blocks.join("\n\n");
}
