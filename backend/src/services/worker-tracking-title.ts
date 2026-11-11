/**
 * Lucy's own follow-up / nudge row title. It is not the speaker's chore.
 * Kept on the worker book; never shown on bare speaker «הצג משימות».
 */
export function isWorkerTrackingTitle(title: string): boolean {
  const text = title.trim();
  return (
    text.startsWith("להזכיר ל") ||
    text.startsWith("לשלוח הודעה") ||
    text.startsWith("לשלוח נדנוד") ||
    text.startsWith("לעזור ל")
  );
}
