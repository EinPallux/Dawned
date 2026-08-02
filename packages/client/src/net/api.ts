/**
 * Typed REST client for the game server's /api endpoints, plus session-token
 * storage ("stay signed in" → localStorage, otherwise sessionStorage —
 * docs/tech/SECURITY.md §1).
 */

import type {
  AccountInfo,
  ApiError,
  AuthResponse,
  CharacterSummary,
  CreateCharacterRequest,
} from '@dawned/shared';

const TOKEN_KEY = 'dawned.token';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const request = async <T>(path: string, init: RequestInit = {}, token?: string): Promise<T> => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiRequestError(0, 'network', 'Cannot reach the server — check your connection.');
  }

  if (response.status === 204) return undefined as T;
  const bodyText = await response.text();
  let body: unknown = undefined;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new ApiRequestError(response.status, 'bad_response', 'The server answered garbage.');
    }
  }
  if (!response.ok) {
    const error = body as Partial<ApiError> | undefined;
    throw new ApiRequestError(
      response.status,
      error?.error ?? 'unknown',
      error?.message ?? `Request failed (${response.status}).`,
    );
  }
  return body as T;
};

export const api = {
  register: (name: string, password: string): Promise<AuthResponse> =>
    request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, password }) }),

  login: (name: string, password: string): Promise<AuthResponse> =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ name, password }) }),

  logout: (token: string): Promise<void> => request('/api/auth/logout', { method: 'POST' }, token),

  me: (token: string): Promise<{ account: AccountInfo }> => request('/api/auth/me', {}, token),

  listCharacters: (token: string): Promise<{ characters: CharacterSummary[] }> =>
    request('/api/characters', {}, token),

  createCharacter: (
    token: string,
    body: CreateCharacterRequest,
  ): Promise<{ character: CharacterSummary }> =>
    request('/api/characters', { method: 'POST', body: JSON.stringify(body) }, token),

  deleteCharacter: (token: string, id: number): Promise<void> =>
    request(`/api/characters/${id}`, { method: 'DELETE' }, token),

  serverStatus: (): Promise<{ online: boolean; players: number; maxPlayers: number }> =>
    request('/api/status'),
};

/** Token persistence: remember-me picks the storage that survives the browser. */
export const tokenStore = {
  load(): string | null {
    return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY);
  },
  save(token: string, remember: boolean): void {
    this.clear();
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  },
};
