import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { AuthState } from './api';

export interface AuthCtx {
  auth: AuthState;
  refresh: () => Promise<AuthState>;
}
export const AuthContext = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(AuthContext);
