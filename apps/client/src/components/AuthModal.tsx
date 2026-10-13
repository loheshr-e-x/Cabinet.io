import { useState, type FormEvent } from 'react';
import { ORCHESTRATOR_URL } from '../config';

interface AuthModalProps {
  onAuthSuccess: (token: string, username: string) => void;
}

interface AuthResponse {
  token: string;
  user: {
    username: string;
  };
}

function isAuthResponse(value: unknown): value is AuthResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'token' in value &&
    typeof value.token === 'string' &&
    'user' in value &&
    typeof value.user === 'object' &&
    value.user !== null &&
    'username' in value.user &&
    typeof value.user.username === 'string'
  );
}

export function AuthModal({ onAuthSuccess }: AuthModalProps) {
  const [isSignup, setIsSignup] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const endpoint = isSignup ? 'signup' : 'login';
      const response = await fetch(`${ORCHESTRATOR_URL}/api/v1/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isSignup ? { username, email, password } : { email, password },
        ),
      });
      const result: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof result === 'object' &&
          result !== null &&
          'error' in result &&
          typeof result.error === 'string'
            ? result.error
            : `Authentication failed (${response.status})`;
        throw new Error(message);
      }
      if (!isAuthResponse(result)) {
        throw new Error('The authentication service returned an invalid response.');
      }

      window.sessionStorage.setItem('cabinet.accessToken', result.token);
      window.sessionStorage.setItem('cabinet.username', result.user.username);
      onAuthSuccess(result.token, result.user.username);
    } catch (authError) {
      setError(
        authError instanceof Error
          ? authError.message
          : 'Could not reach the authentication service.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = () => {
    setIsSignup((current) => !current);
    setError('');
  };

  return (
    <div className="auth-overlay">
      <section
        className="auth-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
      >
        <span className="auth-eyebrow">CABINET.IO ACCOUNT</span>
        <h2 id="auth-title">{isSignup ? 'CREATE PLAYER' : 'PLAYER LOGIN'}</h2>
        <p className="auth-description">
          {isSignup
            ? 'Create an account to save your arcade sessions.'
            : 'Sign in to launch your games and restore your sessions.'}
        </p>

        {error && <p className="auth-error" role="alert">{error}</p>}

        <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
          {isSignup && (
            <label>
              USERNAME
              <input
                autoComplete="username"
                minLength={3}
                maxLength={50}
                pattern="[a-zA-Z0-9_-]{3,50}"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
          )}
          <label>
            EMAIL
            <input
              autoComplete="email"
              type="email"
              maxLength={254}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            PASSWORD
            <input
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              type="password"
              minLength={isSignup ? 12 : 1}
              maxLength={72}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {isSignup && <span className="auth-hint">12+ characters</span>}
          </label>
          <button className="button button--launch auth-submit" disabled={submitting}>
            {submitting
              ? 'CONNECTING…'
              : isSignup
                ? 'CREATE ACCOUNT'
                : 'SIGN IN'}
          </button>
        </form>

        <button
          className="auth-mode-toggle"
          type="button"
          onClick={switchMode}
          disabled={submitting}
        >
          {isSignup ? 'ALREADY A PLAYER? SIGN IN' : 'NEW PLAYER? CREATE ACCOUNT'}
        </button>
      </section>
    </div>
  );
}
