/**
 * prodEnv.ts — run the terminal UI on React's PRODUCTION build, without leaking that setting.
 *
 * React ships two builds in one package and picks between them when it is first loaded, by
 * reading `process.env.NODE_ENV`. Nothing set it, so the app has always run on the
 * DEVELOPMENT build: the one that validates every element it creates, keeps debug
 * information on each, and does extra bookkeeping on every render. Measured on a long
 * transcript, a profile of one scrolling session spent more time in React's `jsx` and
 * `createElement` than in anything of ours, and the same scroll ran at roughly 36 frames a
 * second on the development build against 62 on production, with React's share of the CPU
 * falling from about 1.2 seconds to under 0.1.
 *
 * ## It must not stay set
 *
 * This process runs the user's commands, and a child inherits the environment. `NODE_ENV=
 * production` in there makes `npm install` skip dev dependencies, makes test runners and build
 * tools behave as if shipping, and is exactly the kind of invisible difference that costs an
 * afternoon. So the variable is set only while the few modules that read it are loaded, and
 * put back the moment they have been. React reads it once, at load, so nothing is lost: the
 * modules are cached, and the application's own imports get the production instances.
 *
 * An explicit `NODE_ENV` is left alone, so `NODE_ENV=development mindweave` still gives the
 * slow, checked build when debugging the UI itself.
 */

/** The packages whose build depends on NODE_ENV, in the order the application needs them. */
export const REACT_PACKAGES: readonly string[] = ["react", "react/jsx-runtime", "ink"];

/**
 * Load `packages` with NODE_ENV=production, then restore the environment exactly as it was.
 * Does nothing when NODE_ENV is already set: that is the user's choice.
 */
export async function loadWithProductionEnv(packages: readonly string[] = REACT_PACKAGES): Promise<void> {
  if (process.env["NODE_ENV"]) return;
  process.env["NODE_ENV"] = "production";
  try {
    for (const name of packages) await import(name);
  } finally {
    delete process.env["NODE_ENV"];
  }
}
