import ReactMarkdown from "react-markdown";
import type { Note } from "@/db/schema";
import { NOTE_TYPE_LABEL } from "@/lib/format";
import { Badge } from "./ui";

const SOURCE_LABEL: Record<string, string> = { web: "เว็บ", claude: "Claude", chatgpt: "ChatGPT", api: "API" };

export function NoteCard({
  note,
  compact,
  symbols,
  footer,
}: {
  note: Note;
  compact?: boolean;
  symbols?: string[];
  footer?: React.ReactNode;
}) {
  return (
    <article className={compact ? "border-l-2 border-accent/50 pl-3" : ""}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <time>{note.date}</time>
        <Badge>{NOTE_TYPE_LABEL[note.type]}</Badge>
        {note.source !== "web" && <Badge className="border-accent/40 text-accent">via {SOURCE_LABEL[note.source]}</Badge>}
        {note.conviction && <span title="Conviction">{"●".repeat(note.conviction)}{"○".repeat(5 - note.conviction)}</span>}
      </div>
      <h3 className="mt-1 font-medium">{note.title}</h3>
      {!compact && note.body && (
        <div className="prose-note mt-1 text-sm">
          <ReactMarkdown>{note.body}</ReactMarkdown>
        </div>
      )}
      {compact && note.body && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{note.body.replace(/[#*_`>-]/g, "")}</p>}
      {(note.tags.length > 0 || (symbols && symbols.length > 0)) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {symbols?.map((s) => (
            <Badge key={s} className="border-accent/40 font-medium text-accent">{s}</Badge>
          ))}
          {note.tags.map((t) => (
            <Badge key={t}>#{t}</Badge>
          ))}
        </div>
      )}
      {footer}
    </article>
  );
}
