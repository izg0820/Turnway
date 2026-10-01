import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

// Demo only: anonymous server-issued ids let one person join as many users as they like.
// In production take userId from your authenticated session, and protect POST routes against
// CSRF beyond SameSite=Lax (Origin check or token). Add Secure and an expiry to any real cookie.
const COOKIE_NAME = 'turnway_demo_user';

// A per-process secret invalidates every cookie on restart, which is fine for a local demo
const secret = process.env.DEMO_COOKIE_SECRET || randomBytes(32).toString('hex');
if (secret.length < 32) throw new Error('DEMO_COOKIE_SECRET must be at least 32 characters.');

/** Request carrying the anonymous demo user id */
export interface DemoRequest extends IncomingMessage {
  demoUserId: string;
}

function sign(userId: string): string {
  return createHmac('sha256', secret).update(userId).digest('base64url');
}

/** Read the user id from a signed cookie, or undefined when missing or tampered with */
function readUserId(cookieHeader: string | undefined): string | undefined {
  const raw = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!raw) return undefined;

  const [userId, signature] = raw.split('.');
  if (!userId || !signature) return undefined;

  const expected = Buffer.from(sign(userId));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  return userId;
}

/**
 * Identify each browser with a server-issued signed cookie.
 * The client never supplies a user id; refreshes and tabs in one browser share the same user.
 */
export function demoUserMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  let userId = readUserId(req.headers.cookie);
  if (!userId) {
    userId = randomUUID();
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${userId}.${sign(userId)}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }
  // Safe: this middleware is the only writer of demoUserId and runs before every route
  (req as DemoRequest).demoUserId = userId;
  next();
}

/** Inject the demo user id resolved by the middleware */
export const DemoUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<DemoRequest>().demoUserId,
);
