// Reads a function id back apart.
//
// The id is the one string every verb takes from a user, so parsing it is
// a shared concern rather than each verb's own. A malformed id returns
// undefined and the caller reports it; nothing here throws, because the
// common case is a person retyping an id by hand.
export interface ParsedFid {
  /** Everything before the name: the module path the transform was given. */
  path: string;
  name: string;
  line: number;
  column: number;
  /** The call index, or undefined for a target that names every call. */
  call?: number;
}

// The path is matched greedily so a path holding a colon still resolves:
// a function name never contains one, so the last `:` before `name@` is
// always the separator.
const FID = /^(.*):([^:]*)@(\d+):(\d+)(?:#(\d+))?$/;

export function parseFid(fid: string): ParsedFid | undefined {
  const match = FID.exec(fid);
  if (!match) return undefined;
  const [, path, name, line, column, call] = match;
  return {
    path,
    name,
    line: Number(line),
    column: Number(column),
    call: call === undefined ? undefined : Number(call),
  };
}

/** The id with its call index removed, naming the function itself. */
export function fidWithoutCall(fid: string): string {
  const hash = fid.lastIndexOf("#");
  return hash === -1 ? fid : fid.slice(0, hash);
}

export function formatFid(parsed: ParsedFid): string {
  const base = `${parsed.path}:${parsed.name}@${parsed.line}:${parsed.column}`;
  return parsed.call === undefined ? base : `${base}#${parsed.call}`;
}
