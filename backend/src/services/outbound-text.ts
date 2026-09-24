export function formatAttributedOutbound(input: {
  actorName: string;
  destIsActor: boolean;
  item?: string;
  text: string;
}): string {
  const dictated = input.text.trim();
  const body = dictated || (input.item ? `תזכורת: ${input.item}` : "");
  if (!body) {
    return "";
  }
  if (input.destIsActor) {
    return body;
  }
  if (input.actorName && body.includes(input.actorName)) {
    return body;
  }
  if (dictated) {
    return `מאת ${input.actorName}: ${dictated}`;
  }
  return `${input.actorName} ביקש לתזכר אותך: ${input.item}`;
}
