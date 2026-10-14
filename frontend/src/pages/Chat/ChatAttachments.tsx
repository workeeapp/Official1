import type { ChatAttachmentRef } from "@workee/shared";
import { attachmentApi } from "@/services/attachment.service";

const KIND_LABEL: Record<ChatAttachmentRef["kind"], string> = {
  image: "תמונה",
  video: "סרטון",
  audio: "הקלטה",
  document: "מסמך",
  sticker: "מדבקה",
};

export function ChatAttachments({ attachments }: { attachments: ChatAttachmentRef[] }) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div data-testid="chat-attachments" className="mt-2 flex flex-wrap gap-2">
      {attachments.map((file) => {
        const url = attachmentApi.contentUrl(file.id);
        const label = file.file_name || KIND_LABEL[file.kind];
        if (file.kind === "image" || file.kind === "sticker") {
          return (
            <a
              key={file.id}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-xl border border-border bg-surface"
            >
              <img
                src={url}
                alt={label}
                loading="lazy"
                className="h-32 max-w-[min(16rem,70vw)] object-cover"
              />
            </a>
          );
        }
        if (file.kind === "video") {
          return (
            <video
              key={file.id}
              src={url}
              controls
              preload="metadata"
              aria-label={label}
              className="h-40 max-w-[min(18rem,70vw)] rounded-xl border border-border bg-black"
            />
          );
        }
        if (file.kind === "audio") {
          return (
            <audio
              key={file.id}
              src={url}
              controls
              preload="none"
              aria-label={label}
              className="min-h-11 max-w-[min(18rem,70vw)]"
            />
          );
        }
        return (
          <a
            key={file.id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            dir="auto"
            className="inline-flex min-h-11 max-w-[min(18rem,70vw)] items-center truncate rounded-xl border border-primary/40 bg-surface px-4 text-sm font-medium text-primary shadow-sm hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            📄 {label}
          </a>
        );
      })}
    </div>
  );
}
