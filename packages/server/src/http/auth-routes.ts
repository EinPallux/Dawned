/**
 * Public auth + character REST endpoints (docs/tech/ARCHITECTURE.md §3 http/).
 * All bodies are zod-validated with the shared schemas; errors use the uniform
 * { error, message } shape the client maps to friendly copy.
 */

import {
  loginRequestSchema,
  registerRequestSchema,
  createCharacterRequestSchema,
  type ApiError,
} from '@dawned/shared';
import type { AccountRow } from '@dawned/shared/schema';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from './routes.js';
import type { AuthService } from '../auth/service.js';
import type { CharacterService } from '../characters/service.js';

export interface AuthRouteDeps {
  auth: AuthService;
  characters: CharacterService;
}

const apiError = (reply: FastifyReply, status: number, error: string, message: string) =>
  reply.code(status).send({ error, message } satisfies ApiError);

const clientIp = (request: FastifyRequest): string =>
  // Caddy fronts us in production; the leftmost forwarded hop is the client.
  (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
  request.socket.remoteAddress ??
  'unknown';

const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
};

const AUTH_STATUS: Record<string, number> = {
  invalid_name: 400,
  invalid_password: 400,
  name_taken: 409,
  invalid_credentials: 401,
  rate_limited: 429,
  locked_out: 429,
  banned: 403,
  invite_required: 403,
  invalid: 400,
  slots_full: 409,
  not_found: 404,
};

export const registerAuthRoutes = (app: App, deps: AuthRouteDeps): void => {
  const { auth, characters } = deps;

  /** Resolve the Bearer token or reply 401; returns null when already replied. */
  const requireAccount = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AccountRow | null> => {
    const token = bearerToken(request);
    const account = token ? await auth.validateSession(token) : null;
    if (!account) {
      await apiError(reply, 401, 'unauthorized', 'Log in to do that.');
      return null;
    }
    return account;
  };

  app.post('/api/auth/register', async (request, reply) => {
    const parsed = registerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid input.');
    }
    const { name, password, inviteCode } = parsed.data;
    const result = await auth.register(name, password, clientIp(request), inviteCode);
    if (!result.ok) {
      return apiError(reply, AUTH_STATUS[result.code] ?? 400, result.code, result.message);
    }
    return reply.code(201).send(result.value);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, 'invalid', 'Enter your account name and password.');
    }
    const { name, password } = parsed.data;
    const result = await auth.login(name, password, clientIp(request));
    if (!result.ok) {
      if (result.retryAfterMs) {
        void reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000));
      }
      return apiError(reply, AUTH_STATUS[result.code] ?? 400, result.code, result.message);
    }
    return reply.send(result.value);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = bearerToken(request);
    if (token) await auth.logout(token);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;
    return reply.send({ account: { id: account.id, name: account.name, role: account.role } });
  });

  app.get('/api/characters', async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;
    return reply.send({ characters: await characters.list(account.id) });
  });

  app.post('/api/characters', async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;
    const parsed = createCharacterRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return apiError(reply, 400, 'invalid', parsed.error.issues[0]?.message ?? 'Invalid input.');
    }
    const result = await characters.create(account.id, parsed.data);
    if (!result.ok) {
      return apiError(reply, AUTH_STATUS[result.code] ?? 400, result.code, result.message);
    }
    return reply.code(201).send({ character: result.value });
  });

  app.delete('/api/characters/:id', async (request, reply) => {
    const account = await requireAccount(request, reply);
    if (!account) return;
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return apiError(reply, 400, 'invalid', 'Invalid character id.');
    }
    const result = await characters.softDelete(account.id, id);
    if (!result.ok) {
      return apiError(reply, AUTH_STATUS[result.code] ?? 400, result.code, result.message);
    }
    return reply.code(204).send();
  });
};
