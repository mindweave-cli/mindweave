/**
 * userNotes.ts — a note for the model that rides in front of what the person typed.
 *
 * A front end that knows something the model could not have seen (the person renamed or deleted a file in a file list)
 * puts it ahead of their next message inside `<mw_note>…</mw_note>`. The model reads it; the person never sees it: it is
 * left out of the chat, of the text handed back for editing, and of the name a session is given.
 */
const NOTE = /<mw_note>[\s\S]*?<\/mw_note>\s*/g;

/** The text without its notes (pure). */
export function stripUserNotes(content: string): string {
  return content.replace(NOTE, "");
}

/** A note wrapped so it can be told apart again (pure). */
export function wrapUserNote(note: string): string {
  return `<mw_note>\n${note.trim()}\n</mw_note>\n\n`;
}
