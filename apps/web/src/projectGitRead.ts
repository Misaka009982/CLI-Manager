import { useEffect, useState } from "react";
import type { JsonObject, JsonValue } from "./domain";
import type { TranslationKey } from "./i18n";
import { gitReadError } from "./projectGit";

export type GitT = (key: TranslationKey) => string;
export type GitReader = (kind: string, parameters: JsonObject, signal: AbortSignal) => Promise<JsonValue>;
export type GitRepoProps = { read: GitReader; repository: string; t: GitT };

// Parameter identity and cancellation prevent stale results across repositories/searches.
export function useGitRead<T>(read: GitReader, kind: string, parameters: JsonObject, parse: (value: JsonValue) => T) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify(parameters);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null);
    void read(kind, JSON.parse(identity), controller.signal).then((data) => {
      if (!controller.signal.aborted) {
        const parsed = parse(data);
        setValue(parsed); setLoadedIdentity(identity);
      }
    }).catch((reason) => { if (!controller.signal.aborted) setError(gitReadError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [read, kind, identity, parse, revision]);
  return { value: loadedIdentity === identity ? value : null, error, busy,
    refresh: () => setRevision((old) => old + 1) };
}
