import { NextResponse, type NextRequest } from 'next/server';
import { getAuthSession } from '@/lib/auth-server';
import {
  BOT_API_ALLOWED_PATHS,
  mergeUserVoiceResponses,
  planBotApiRoute,
  readBotApiConfig,
  stripClientIdentity,
} from '@/lib/bot-api';
import { getShardDirectory, type ShardDirectory } from '@/lib/shard-directory';

type RouteContext = { params: Promise<{ path: string[] }> };

async function resolveTargets(directory: ShardDirectory, path: string, search: URLSearchParams, body: string | undefined): Promise<string[]> {
  const route = planBotApiRoute(path, search, body);
  if (route.kind === 'every-shard') return directory.allUrls();
  if (route.kind === 'bootstrap') return [directory.bootstrap];
  const target = await directory.urlForGuild(route.guildId);
  return target ? [target] : [];
}

async function forward(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const config = readBotApiConfig();
  const directory = getShardDirectory();
  if (!config || !directory) {
    return NextResponse.json({ error: 'dashboard api not configured' }, { status: 503 });
  }

  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { path } = await context.params;
  const suffix = (path ?? []).map((segment) => String(segment).trim()).filter(Boolean).join('/');
  if (!BOT_API_ALLOWED_PATHS.has(suffix)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const headers = new Headers({
    authorization: `Bearer ${config.secret}`,
    'x-user-id': session.userId,
  });

  let body: string | undefined;
  if (req.method !== 'GET') {
    body = stripClientIdentity(await req.text());
    headers.set('content-type', 'application/json');
  }

  const targets = await resolveTargets(directory, suffix, req.nextUrl.searchParams, body);
  if (!targets.length) {
    return NextResponse.json({ error: 'shard unavailable' }, { status: 503 });
  }

  const requestShard = (baseUrl: string) => {
    const target = new URL(`/api/v1/${suffix}`, baseUrl);
    target.search = req.nextUrl.search;
    return fetch(target, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
    });
  };

  if (targets.length > 1) {
    const results = await Promise.allSettled(targets.map(async (baseUrl) => {
      const response = await requestShard(baseUrl);
      return response.ok ? response.json() as Promise<unknown> : null;
    }));
    const payloads = results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
    if (!payloads.length) {
      return NextResponse.json({ error: 'bot api unreachable' }, { status: 502 });
    }
    return NextResponse.json(mergeUserVoiceResponses(payloads), { headers: { 'cache-control': 'no-store' } });
  }

  try {
    const response = await requestShard(targets[0] ?? directory.bootstrap);
    const payload = await response.text();
    return new NextResponse(payload, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'bot api unreachable' }, { status: 502 });
  }
}

export async function GET(req: NextRequest, context: RouteContext) {
  return forward(req, context);
}

export async function POST(req: NextRequest, context: RouteContext) {
  return forward(req, context);
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  return forward(req, context);
}
