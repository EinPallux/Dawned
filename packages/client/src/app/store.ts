/**
 * Front-door state: screen routing, the session, and the character list
 * (zustand — docs/tech/TECH_STACK.md). The in-world game does NOT live here;
 * it has its own loop and stores only the entry parameters.
 */

import { create } from 'zustand';
import type { AccountInfo, CharacterSummary } from '@dawned/shared';
import { api, ApiRequestError, tokenStore } from '../net/api.js';

export type Screen = 'boot' | 'login' | 'select' | 'create' | 'world';

interface AppState {
  screen: Screen;
  token: string | null;
  account: AccountInfo | null;
  characters: CharacterSummary[];
  /** Character the player is entering the world with. */
  activeCharacter: CharacterSummary | null;
  busy: boolean;
  error: string | null;

  bootstrap: () => Promise<void>;
  login: (name: string, password: string, remember: boolean) => Promise<boolean>;
  register: (name: string, password: string, remember: boolean) => Promise<boolean>;
  logout: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  createCharacter: (
    request: Parameters<typeof api.createCharacter>[1],
  ) => Promise<CharacterSummary | null>;
  deleteCharacter: (id: number) => Promise<boolean>;
  enterWorld: (character: CharacterSummary) => void;
  leaveWorld: () => void;
  goTo: (screen: Screen) => void;
  clearError: () => void;
}

const message = (error: unknown): string =>
  error instanceof ApiRequestError ? error.message : 'Something went wrong — try again.';

export const useApp = create<AppState>((set, get) => ({
  screen: 'boot',
  token: null,
  account: null,
  characters: [],
  activeCharacter: null,
  busy: false,
  error: null,

  /** Resume a stored session if it still validates; otherwise show login. */
  bootstrap: async () => {
    const token = tokenStore.load();
    if (!token) {
      set({ screen: 'login' });
      return;
    }
    try {
      const { account } = await api.me(token);
      const { characters } = await api.listCharacters(token);
      set({ token, account, characters, screen: 'select' });
    } catch {
      tokenStore.clear();
      set({ screen: 'login' });
    }
  },

  login: async (name, password, remember) => {
    set({ busy: true, error: null });
    try {
      const { token, account } = await api.login(name, password);
      tokenStore.save(token, remember);
      const { characters } = await api.listCharacters(token);
      set({ token, account, characters, busy: false, screen: 'select' });
      return true;
    } catch (error) {
      set({ busy: false, error: message(error) });
      return false;
    }
  },

  register: async (name, password, remember) => {
    set({ busy: true, error: null });
    try {
      const { token, account } = await api.register(name, password);
      tokenStore.save(token, remember);
      set({ token, account, characters: [], busy: false, screen: 'select' });
      return true;
    } catch (error) {
      set({ busy: false, error: message(error) });
      return false;
    }
  },

  logout: async () => {
    const { token } = get();
    if (token) await api.logout(token).catch(() => undefined);
    tokenStore.clear();
    set({ token: null, account: null, characters: [], activeCharacter: null, screen: 'login' });
  },

  refreshCharacters: async () => {
    const { token } = get();
    if (!token) return;
    try {
      const { characters } = await api.listCharacters(token);
      set({ characters });
    } catch (error) {
      set({ error: message(error) });
    }
  },

  createCharacter: async (request) => {
    const { token } = get();
    if (!token) return null;
    set({ busy: true, error: null });
    try {
      const { character } = await api.createCharacter(token, request);
      set((state) => ({ characters: [...state.characters, character], busy: false }));
      return character;
    } catch (error) {
      set({ busy: false, error: message(error) });
      return null;
    }
  },

  deleteCharacter: async (id) => {
    const { token } = get();
    if (!token) return false;
    set({ busy: true, error: null });
    try {
      await api.deleteCharacter(token, id);
      set((state) => ({
        characters: state.characters.filter((entry) => entry.id !== id),
        busy: false,
      }));
      return true;
    } catch (error) {
      set({ busy: false, error: message(error) });
      return false;
    }
  },

  enterWorld: (character) => {
    set({ activeCharacter: character, screen: 'world', error: null });
  },

  leaveWorld: () => {
    set({ activeCharacter: null, screen: 'select' });
    void get().refreshCharacters();
  },

  goTo: (screen) => {
    set({ screen, error: null });
  },
  clearError: () => {
    set({ error: null });
  },
}));
