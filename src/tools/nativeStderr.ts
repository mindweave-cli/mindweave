/**
 * nativeStderr.ts — undo Windows PowerShell's dressing of a program's stderr lines.
 *
 * Under `2>&1`, Windows PowerShell 5.1 turns the first line a native program writes to
 * stderr into an error record and prints it as one:
 *
 *   node : Compiling thing v1.0
 *   At line:2 char:1
 *   + cargo build 2>&1 | Select-Object -Last 5
 *   + ~~~~~~~~~~~~~~~~
 *       + CategoryInfo          : NotSpecified: (Compiling thing v1.0:String) [], RemoteException
 *       + FullyQualifiedErrorId : NativeCommandError
 *
 * cargo, npm and git all write progress there, so a build that succeeded comes back
 * reading like a stack of errors, and a model that sees "CategoryInfo" and
 * "NativeCommandError" treats the command as failed. Only that exact block is rewritten,
 * back to the line the program actually printed; a real PowerShell error has a different
 * FullyQualifiedErrorId and is left alone.
 */

const BLOCK =
  /^[^\r\n]*? : ([^\r\n]*)\r?\nAt line:\d+ char:\d+\r?\n(?:\+ [^\r\n]*\r?\n)+[ \t]+\+ CategoryInfo[^\r\n]*\r?\n[ \t]+\+ FullyQualifiedErrorId : NativeCommandError[ \t]*(?:\r?\n[ \t]*(?=\r?\n))?/gm;

/** The text with every native-stderr error block reduced to the line it wraps (pure). */
export function stripNativeStderrNoise(text: string): string {
  if (!text.includes("NativeCommandError")) return text;
  return text.replace(BLOCK, "$1");
}
