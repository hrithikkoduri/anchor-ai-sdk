/**
 * Prompt blocks with an explicit cache contract.
 *
 * A request is cached by its prefix. Stable blocks must stay byte-identical
 * and come first; turn-scoped state is rendered separately at the tail, right
 * before the final message, so it cannot invalidate the stable prefix on every
 * tool result. Keep this deliberately small: one ordered list, one renderer.
 */
export type PromptStability = "stable" | "turn";

export interface PromptBlock {
  id: string;
  text: string | undefined;
  stability: PromptStability;
}

export function renderPromptBlocks(
  blocks: readonly PromptBlock[],
  stability: PromptStability,
): string {
  return blocks
    .filter((block) => block.stability === stability)
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n\n");
}
