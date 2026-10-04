import { describe, expect, it } from 'vitest';
import { clearDomainPacks } from '@/src/core/registry/domainRegistry';
import { registerAllDomains } from '@/src/domains';
import { resolveDomainId } from './domain';

describe('resolveDomainId', () => {
  it('falls back to the kernel default when domainId is absent', () => {
    clearDomainPacks();
    const available = registerAllDomains();

    expect(resolveDomainId(undefined)).toEqual({ ok: true, domainId: undefined });
    expect(available[0]).toBe('demo');
  });

  it('accepts a registered domain id as given', () => {
    clearDomainPacks();
    registerAllDomains();

    expect(resolveDomainId('travel')).toEqual({ ok: true, domainId: 'travel' });
  });

  it('trims surrounding whitespace instead of rejecting a pasted value', () => {
    clearDomainPacks();
    registerAllDomains();

    expect(resolveDomainId('travel ')).toEqual({ ok: true, domainId: 'travel' });
    expect(resolveDomainId(' travel\n')).toEqual({ ok: true, domainId: 'travel' });
  });

  it('rejects case variants rather than silently folding them into another id', () => {
    clearDomainPacks();
    registerAllDomains();

    const rejected = resolveDomainId('Travel');
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.reason).toBe('UNKNOWN_DOMAIN');
    expect(rejected.domainId).toBe('Travel');
    expect(rejected.available).toEqual(expect.arrayContaining(['travel', 'demo']));
  });

  it('rejects an unknown domain with the available ids attached', () => {
    clearDomainPacks();
    registerAllDomains();

    const rejected = resolveDomainId('nope');
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected).toEqual({
      ok: false,
      reason: 'UNKNOWN_DOMAIN',
      domainId: 'nope',
      available: ['demo', 'travel'],
    });
  });

  it('treats an empty string as "not specified", not as an unknown domain', () => {
    clearDomainPacks();
    registerAllDomains();

    expect(resolveDomainId('')).toEqual({ ok: true, domainId: undefined });
    expect(resolveDomainId('   ')).toEqual({ ok: true, domainId: undefined });
  });
});
