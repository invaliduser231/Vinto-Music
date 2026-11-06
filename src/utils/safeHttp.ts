import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

import { ValidationError } from '../core/errors.ts';

const BLOCKED_RANGES = new BlockList();

const IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_RANGES: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

for (const [network, prefix] of IPV4_RANGES) BLOCKED_RANGES.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_RANGES) BLOCKED_RANGES.addSubnet(network, prefix, 'ipv6');

let allowPrivateAddresses = false;

export function setPrivateUrlPolicy(options: { allowPrivate: boolean }): void {
  allowPrivateAddresses = options.allowPrivate === true;
}

export function isPrivateUrlAccessAllowed(): boolean {
  return allowPrivateAddresses;
}

function unwrapMappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (match?.[1]) return match[1];

  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hexMatch?.[1] || !hexMatch[2]) return null;
  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function isBlockedAddress(address: string): boolean {
  const raw = String(address ?? '').trim().replace(/^\[|\]$/g, '');
  const withoutZone = raw.split('%')[0] ?? raw;
  const mapped = unwrapMappedIpv4(withoutZone);
  if (mapped) return isBlockedAddress(mapped);

  const family = isIP(withoutZone);
  if (family === 4) return BLOCKED_RANGES.check(withoutZone, 'ipv4');
  if (family === 6) return BLOCKED_RANGES.check(withoutZone, 'ipv6');
  return true;
}

export class UnsafeUrlError extends ValidationError {
  constructor(url: string) {
    super(`Refusing to load ${url} because it points at a private or local network address.`, {
      code: 'UNSAFE_URL',
      translationKey: 'errors.unsafeUrl',
    });
    this.name = 'UnsafeUrlError';
  }
}

function resolveAll(hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses);
    });
  });
}

export async function assertPublicHttpUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    throw new ValidationError('That link is not a valid URL.', { translationKey: 'errors.invalidUrl' });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(parsed.toString());
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError(`${parsed.protocol}//${parsed.host}`);
  }
  if (allowPrivateAddresses) return;

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new UnsafeUrlError(parsed.toString());
    return;
  }

  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered.endsWith('.local') || lowered.endsWith('.internal')) {
    throw new UnsafeUrlError(parsed.toString());
  }

  const addresses = await resolveAll(hostname).catch(() => []);
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new UnsafeUrlError(parsed.toString());
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: Record<string, unknown>, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }

    const list = Array.isArray(addresses) ? addresses : [];
    const allowed = allowPrivateAddresses ? list : list.filter((entry) => !isBlockedAddress(entry.address));
    if (!allowed.length) {
      const blocked: NodeJS.ErrnoException = new Error(`Blocked private address for ${hostname}`);
      blocked.code = 'EUNSAFEADDR';
      callback(blocked, []);
      return;
    }

    if (options.all === true) {
      callback(null, allowed);
      return;
    }
    const first = allowed[0]!;
    callback(null, first.address, first.family);
  });
}

let guardedAgent: Agent | null = null;

function getGuardedAgent(): Agent {
  guardedAgent ??= new Agent({
    connect: {
      lookup: guardedLookup as never,
    },
  });
  return guardedAgent;
}

export type SafeFetchInit = Omit<UndiciRequestInit, 'dispatcher'>;

type SafeFetchTransport = (url: string, init: SafeFetchInit) => Promise<Response>;

let testTransport: SafeFetchTransport | null = null;

export function _setSafeFetchTransport(transport: SafeFetchTransport | null): void {
  testTransport = transport;
}

async function sendRequest(url: string, init: SafeFetchInit): Promise<Response> {
  if (testTransport) return testTransport(url, init);
  await assertPublicHttpUrl(url);
  return undiciFetch(url, { ...init, dispatcher: getGuardedAgent() }) as unknown as Promise<Response>;
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(url: string, init: SafeFetchInit = {}) {
  const followRedirects = (init.redirect ?? 'follow') === 'follow';
  let currentUrl = url;
  let currentInit: SafeFetchInit = { ...init, redirect: 'manual' };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await sendRequest(currentUrl, currentInit);
    const location = response.headers.get('location');
    if (!followRedirects || !REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    await response.body?.cancel().catch(() => undefined);
    currentUrl = new URL(location, currentUrl).toString();
    const method = String(currentInit.method ?? 'GET').toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      const { body: _body, ...rest } = currentInit;
      currentInit = { ...rest, method: 'GET' };
    }
  }

  throw new ValidationError('That link redirects too many times.', { translationKey: 'errors.tooManyRedirects' });
}
