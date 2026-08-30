import { NextResponse, type NextRequest } from 'next/server';
import { getAuthSession } from '@/lib/auth-server';
import { BOT_API_ALLOWED_PATHS, readBotApiConfig } from '@/lib/bot-api';

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(req: NextRequest, context: RouteContext): Promise<NextResponse> {
  const config = readBotApiConfig();
  if (!config) {
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

  const target = new URL(`/api/v1/${suffix}`, config.baseUrl);
  target.search = req.nextUrl.search;

  const headers = new Headers({
    authorization: `Bearer ${config.secret}`,
    'x-user-id': session.userId,
  });

  let body: string | undefined;
  if (req.method !== 'GET') {
    body = await req.text();
    headers.set('content-type', 'application/json');
  }

  try {
    const response = await fetch(target, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
    });
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
