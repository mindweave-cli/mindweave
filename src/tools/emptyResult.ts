/**
 * emptyResult.ts — the words an empty search or file match ends with.
 *
 * "No matches found." answers two different questions the same way: the thing is not there, and
 * the thing is somewhere the search does not go. The model cannot tell them apart from the words,
 * and acts on whichever it assumes, so an empty result says what was looked in and what was left
 * out, and where to look next. The two openings stay exactly as they were, so anything that reads
 * them still does.
 */

/** Left out of every search, whatever the tool: the same list the tools' descriptions give. */
const NOT_SEARCHED =
  "anything the project's .gitignore excludes, node_modules, .git and build output are not searched, " +
  "and secrets and other agents' data are refused";

/** The result of a content search that found nothing. `where` is the path asked about, or none. */
export function noMatches(pattern: string, where: string | undefined): string {
  return (
    `No matches found for ${JSON.stringify(pattern)} in ${where ?? "the project"}. ` +
    `That does not prove it is absent: ${NOT_SEARCHED}. ` +
    "list_dir shows what is on disk, and read_file opens a file directly."
  );
}

/** The result of a file-name match that found nothing. */
export function noFiles(pattern: string, where: string | undefined): string {
  return (
    `No files found matching ${JSON.stringify(pattern)} in ${where ?? "the project"}. ` +
    `That does not prove none exists: ${NOT_SEARCHED}. list_dir shows what is on disk.`
  );
}
