import { Fragment, type ReactNode } from "react";

/**
 * Same «…» rule as WhatsApp `toWhatsAppFormatting`: the quoted span (plus
 * letters glued to the marks) is bold, and the guillemets themselves are not shown.
 */
const QUOTE_TO_BOLD =
  /([\p{L}\p{M}\p{N}]*)«[^\S\n]*([^«»\n]*?[^\s«»])[^\S\n]*»([\p{L}\p{M}\p{N}]*)/gu;

export function renderChatText(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(QUOTE_TO_BOLD)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push(<Fragment key={key++}>{text.slice(last, index)}</Fragment>);
    }
    nodes.push(
      <strong key={key++}>{`${match[1] ?? ""}${match[2] ?? ""}${match[3] ?? ""}`}</strong>,
    );
    last = index + match[0].length;
  }
  if (nodes.length === 0) {
    return text;
  }
  if (last < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  }
  return nodes;
}
