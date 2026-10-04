import { listDomainIds } from '@/src/core/registry/domainRegistry';

export interface DomainIdResolved {
  ok: true;
  /** `undefined` means "let the kernel fall back to the first registered domain". */
  domainId: string | undefined;
}

export interface DomainIdRejected {
  ok: false;
  reason: 'UNKNOWN_DOMAIN';
  /** The raw value as received, so the caller can echo it back verbatim. */
  domainId: string;
  available: string[];
}

export type DomainIdResolution = DomainIdResolved | DomainIdRejected;

/**
 * Resolve the AG-UI endpoint's `domainId` against the registered domain packs.
 *
 * Two distinct cases, deliberately not collapsed into one:
 *
 * 1. **Absent (or blank)** — resolves to `undefined`, which preserves the
 *    documented kernel contract (`shared/run/types.ts`: omitting `domainId`
 *    takes the first registered pack). The caller opted out of choosing, so
 *    falling back is the agreed behaviour, not a silent downgrade.
 * 2. **Present but unknown** — rejected. The caller stated an intent; silently
 *    swapping in another domain would hand back a different domain than the one
 *    that was asked for without saying so, which is exactly the silent-failure
 *    pattern this endpoint is required not to have.
 *
 * Whitespace around a value is trimmed (a UI select initialising to `' '` or a
 * pasted value with a trailing newline is still an unambiguous choice). Case is
 * **not** normalised: domain ids are lowercase identifiers, and folding `Travel`
 * into `travel` would quietly accept a value no registered pack answers to, so
 * it is rejected with the available ids attached.
 */
export function resolveDomainId(raw: string | undefined): DomainIdResolution {
  const available = listDomainIds();

  if (raw === undefined) return { ok: true, domainId: undefined };

  const normalized = raw.trim();
  if (normalized.length === 0) return { ok: true, domainId: undefined };

  if (!available.includes(normalized)) {
    return { ok: false, reason: 'UNKNOWN_DOMAIN', domainId: raw, available: [...available] };
  }

  return { ok: true, domainId: normalized };
}
