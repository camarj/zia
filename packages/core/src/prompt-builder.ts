import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function buildPromptFromFicha(fichaDir: string): Promise<string> {
  const soulPath = join(fichaDir, "SOUL.md");
  try {
    return await readFile(soulPath, "utf8");
  } catch (cause) {
    throw new Error(`zia: cannot read system prompt — ${soulPath} is missing or unreadable`, {
      cause,
    });
  }
}
