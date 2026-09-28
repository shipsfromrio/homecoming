/**
 * The name the running binary answers to, for every command line a message
 * suggests (`homecoming label "work"`) and every sentence that names the tool.
 *
 * This build is `homecoming` and never changes it. A bundle that ships the
 * same core under another binary name sets its own before the CLI module is
 * evaluated, because the program's help texts are built on import: its entry
 * calls `setProgramName` before it imports the CLI. A name set later still
 * reaches every message built at run time, but not the help texts already
 * built.
 */
let current = 'homecoming';

/** The binary name every printed hint and help text uses. */
export function programName(): string {
  return current;
}

/**
 * Sets the binary name. Refuses anything that is not a plain command word,
 * since it is pasted into command lines the user is told to run.
 */
export function setProgramName(name: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`program name "${name}" is not a plain command word`);
  }
  current = name;
}
