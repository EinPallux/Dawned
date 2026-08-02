/**
 * Smoke-test fixtures: idempotent account + character setup over the REST API.
 *
 * Login is tried before register so re-runs against a long-lived dev server
 * neither trip the per-IP registration throttle nor collide on names. Character
 * names are world-unique, so each fixture account owns its fixed character name.
 */

const jsonHeaders = { 'content-type': 'application/json' };

const parse = async (response) => {
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
};

/** Login-or-register; resolves to a session token. */
export const ensureAccount = async (apiBase, name, password) => {
  const login = await parse(
    await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name, password }),
    }),
  );
  if (login.status === 200) return login.body.token;

  const register = await parse(
    await fetch(`${apiBase}/api/auth/register`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name, password }),
    }),
  );
  if (register.status === 201) return register.body.token;
  if (register.status === 429) {
    throw new Error(
      `registration throttled for ${name} and login failed — restart the game server to clear in-memory throttles`,
    );
  }
  throw new Error(
    `could not obtain account ${name}: login ${login.status} (${login.body.message ?? '?'}), register ${register.status} (${register.body.message ?? '?'})`,
  );
};

/** Find-or-create a character on the account; resolves to its summary. */
export const ensureCharacter = async (apiBase, token, name, classId) => {
  const auth = { ...jsonHeaders, authorization: `Bearer ${token}` };
  const list = await parse(await fetch(`${apiBase}/api/characters`, { headers: auth }));
  if (list.status !== 200) throw new Error(`listing characters failed: ${list.status}`);
  const existing = list.body.characters.find((entry) => entry.name === name);
  if (existing) return existing;

  const created = await parse(
    await fetch(`${apiBase}/api/characters`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name,
        classId,
        appearance: {
          body: 'm',
          skin: 1,
          outfit: 'ranger',
          outfitTint: 0,
          hair: 'buzzed',
          hairColor: 1,
          beard: false,
        },
      }),
    }),
  );
  if (created.status !== 201) {
    throw new Error(
      `creating character ${name} failed: ${created.status} (${created.body.message ?? '?'})`,
    );
  }
  return created.body.character;
};
