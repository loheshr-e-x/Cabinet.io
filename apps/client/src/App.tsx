import { useEffect, useRef, useState } from 'react';
import { AuthModal } from './components/AuthModal';
import { ORCHESTRATOR_URL } from './config';
import { useInputHandler } from './hooks/useInputHandler';
import { useWebRTCSession } from './hooks/useWebRTCSession';
import './App.css';

interface GameItem {
  id: string;
  title: string;
  system: string;
  systemColor: string;
  coverStyle: string;
  lastSaved?: string;
  slotInfo?: string;
}

interface ActiveSession {
  sessionId: string;
  signalingUrl: string;
  token: string;
  game: GameItem;
}

const LIBRARY_GAMES: GameItem[] = [
  {
    id: 'snes_mario',
    title: 'SUPER MARIO WORLD',
    system: 'SNES',
    systemColor: '#ff6d37',
    coverStyle: 'cover-art--snes',
    lastSaved: '2 MINS AGO',
    slotInfo: 'SLOT 0 · LZ4 HOT TIER',
  },
  {
    id: 'gba_pokemon',
    title: 'POKÉMON EMERALD',
    system: 'GBA',
    systemColor: '#16b9e8',
    coverStyle: 'cover-art--gba',
  },
  {
    id: 'genesis_sonic',
    title: 'SONIC THE HEDGEHOG 2',
    system: 'GENESIS',
    systemColor: '#ff397c',
    coverStyle: 'cover-art--genesis',
  },
  {
    id: 'nes_zelda',
    title: 'THE LEGEND OF ZELDA',
    system: 'NES',
    systemColor: '#e9b943',
    coverStyle: 'cover-art--nes',
  },
];

function getAccessToken(): string | null {
  return window.sessionStorage.getItem('cabinet.accessToken');
}

export function App() {
  const [selectedGame, setSelectedGame] = useState<GameItem>(LIBRARY_GAMES[0]);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(getAccessToken);
  const [username, setUsername] = useState(
    () => window.sessionStorage.getItem('cabinet.username') ?? '',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [systemFilter, setSystemFilter] = useState('ALL');
  const [launching, setLaunching] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [orchestratorStatus, setOrchestratorStatus] = useState<
    'checking' | 'online' | 'offline'
  >('checking');
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const { connectionStatus, dataChannel, remoteStream } = useWebRTCSession({
    sessionId: activeSession?.sessionId ?? null,
    token: activeSession?.token ?? null,
    signalingUrl: activeSession?.signalingUrl ?? null,
  });
  useInputHandler(dataChannel);

  const signOut = () => {
    window.sessionStorage.removeItem('cabinet.accessToken');
    window.sessionStorage.removeItem('cabinet.username');
    setAccessToken(null);
    setUsername('');
    setActiveSession(null);
    setErrorMessage('');
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${ORCHESTRATOR_URL}/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Health check failed (${response.status})`);
        setOrchestratorStatus('online');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error('[Cabinet] Could not reach the orchestrator:', error);
        setOrchestratorStatus('offline');
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const visibleGames = LIBRARY_GAMES.filter((game) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const matchesSearch =
      query.length === 0 ||
      game.title.toLocaleLowerCase().includes(query) ||
      game.system.toLocaleLowerCase().includes(query);
    const matchesSystem = systemFilter === 'ALL' || game.system === systemFilter;
    return matchesSearch && matchesSystem;
  });

  const launchStream = async (game: GameItem) => {
    const token = accessToken;
    if (!token) {
      return;
    }

    setLaunching(true);
    setErrorMessage('');
    setNotice('');
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/v1/session/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gameId: game.id }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          signOut();
          return;
        }
        const serverMessage =
          typeof result === 'object' &&
          result !== null &&
          'error' in result &&
          typeof result.error === 'string'
            ? result.error
            : `Session request failed (${response.status})`;
        throw new Error(serverMessage);
      }
      if (
        typeof result !== 'object' ||
        result === null ||
        !('sessionId' in result) ||
        typeof result.sessionId !== 'string' ||
        !('signalingUrl' in result) ||
        typeof result.signalingUrl !== 'string'
      ) {
        throw new Error('The orchestrator returned an invalid session response.');
      }
      setSelectedGame(game);
      setActiveSession({
        sessionId: result.sessionId,
        signalingUrl: result.signalingUrl,
        token,
        game,
      });
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not start the game session. Check the orchestrator and try again.',
      );
    } finally {
      setLaunching(false);
    }
  };

  const exitStream = () => {
    setActiveSession(null);
    setErrorMessage('');
  };

  const showInviteNotice = () => {
    setNotice('Couch co-op invites are not connected yet.');
  };

  const statusLabel =
    orchestratorStatus === 'online'
      ? 'ONLINE'
      : orchestratorStatus === 'offline'
        ? 'OFFLINE'
        : 'CHECKING';

  return (
    <main className="crt-shell">
      <div className="crt-scanlines" aria-hidden="true" />
      <div className="crt-vignette" aria-hidden="true" />

      <div className="arcade-cabinet">
        <header className="cabinet-header">
          <div className="brand-cluster">
            <a className="brand-logo" href="/" aria-label="Cabinet.io home">
              CABINET.IO
            </a>
            <div
              className={`service-status service-status--${orchestratorStatus}`}
              aria-live="polite"
            >
              <span className="status-led" />
              <span>{statusLabel}</span>
            </div>
          </div>

          <label className="search-box">
            <input
              type="search"
              placeholder="SEARCH GAMES..."
              aria-label="Search games"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <span className="search-bracket" aria-hidden="true">⌕</span>
          </label>

          <label className="filter-box">
            <select
              aria-label="Filter games by system"
              value={systemFilter}
              onChange={(event) => setSystemFilter(event.target.value)}
            >
              <option value="ALL">FILTERS</option>
              {LIBRARY_GAMES.map((game) => (
                <option value={game.system} key={game.system}>{game.system}</option>
              ))}
            </select>
            <span aria-hidden="true">▾</span>
          </label>

          <div className="header-player">
            <span className="player-slot">SLOT: P1 READY</span>
            {accessToken ? (
              <button
                className="player-chip player-chip--signed-in"
                type="button"
                onClick={signOut}
                aria-label={`Sign out ${username}`}
                title={`Sign out ${username}`}
              >
                <span className="player-avatar" aria-hidden="true">
                  {(username.slice(0, 2) || 'P1').toUpperCase()}
                </span>
                <span className="player-rank">LOG OUT</span>
              </button>
            ) : (
              <div className="player-chip" aria-label="Player profile">
                <span className="player-avatar" aria-hidden="true">P1</span>
                <span className="player-rank">ELITE</span>
              </div>
            )}
          </div>
        </header>

        {activeSession ? (
          <section className="stream-view" aria-label="Game stream">
            <div className="stream-header">
              <button className="button button--quiet" onClick={exitStream}>
                ← EXIT TO CATALOG
              </button>
              <div className="stream-session-meta">
                <span className="eyebrow">NOW PLAYING</span>
                <strong>{activeSession.game.title}</strong>
                <span className="connection-state" aria-live="polite">
                  {connectionStatus.replaceAll('-', ' ').toUpperCase()}
                </span>
              </div>
            </div>
            <div className="stream-viewport">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                aria-label={`${activeSession.game.title} video stream`}
              />
              {!remoteStream && (
                <div className="stream-placeholder" role="status">
                  <span className="loading-orbit" />
                  <strong>CONNECTING TO EDGE NODE</strong>
                  <span>Waiting for the game stream…</span>
                </div>
              )}
              <div className="stream-hud" aria-label="Stream diagnostics">
                <span>FPS: <strong>60</strong></span>
                <span>INPUT: <strong>{dataChannel?.readyState === 'open' ? 'READY' : 'WAITING'}</strong></span>
                <span>ICE: <strong>{connectionStatus.toUpperCase()}</strong></span>
              </div>
            </div>
          </section>
        ) : (
          <>
            <section className="resume-section">
              <div className="section-heading">
                <h1>QUICK RESUME</h1>
              </div>

              <article className="resume-card">
                <div className="resume-art">
                  <CoverArtwork game={selectedGame} featured />
                </div>
                <div className="resume-content">
                  <div className="resume-title-line">
                    <h2>{selectedGame.title}</h2>
                    <span
                      className="system-tag"
                      style={{ backgroundColor: selectedGame.systemColor }}
                    >
                      {selectedGame.system}
                    </span>
                  </div>
                  <p className="save-detail">
                    <span>LAST SAVED</span>
                    <span>{selectedGame.lastSaved || 'READY TO PLAY'}</span>
                    <span className="save-divider">•</span>
                    <span>{selectedGame.slotInfo || 'SLOT 0 · READY'}</span>
                  </p>
                  <div className="resume-actions">
                    <button
                      className="button button--launch"
                      onClick={() => void launchStream(selectedGame)}
                      disabled={launching || orchestratorStatus !== 'online'}
                    >
                      {launching ? '◌ STARTING SESSION…' : '▶ LAUNCH INSTANT STREAM'}
                    </button>
                    <button
                      className="button button--secondary"
                      onClick={showInviteNotice}
                      title="Couch co-op invites are not connected yet"
                    >
                      + COUCH INVITE
                    </button>
                  </div>
                </div>
              </article>
            </section>

            <section className="library-section" aria-labelledby="library-heading">
              <div className="library-heading-row">
                <h2 id="library-heading" className="section-title">
                  YOUR LIBRARY <span>/{visibleGames.length.toString().padStart(2, '0')}</span>
                </h2>
                <div className="library-metrics" aria-label="Performance indicators">
                  <span>FPS: <strong>60</strong></span>
                  <i />
                  <span>PING: <strong>15ms</strong></span>
                </div>
              </div>

              {visibleGames.length > 0 ? (
                <div className="library-grid">
                  {visibleGames.map((game) => {
                    const isSelected = selectedGame.id === game.id;
                    return (
                      <article
                        className={`game-card${isSelected ? ' game-card--selected' : ''}`}
                        key={game.id}
                      >
                        <button
                          className="game-card-select"
                          onClick={() => setSelectedGame(game)}
                          aria-pressed={isSelected}
                          aria-label={`Select ${game.title}`}
                        >
                          <span className="game-cover">
                            <CoverArtwork game={game} />
                          </span>
                        </button>
                        <div className="game-card-actions">
                          <button
                            className="card-play"
                            onClick={() => void launchStream(game)}
                            disabled={launching || orchestratorStatus !== 'online'}
                          >
                            ▶ PLAY
                          </button>
                          <button
                            className="card-invite"
                            onClick={showInviteNotice}
                            title="Couch co-op invites are not connected yet"
                          >
                            INVITE P2
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="empty-library">NO GAMES MATCH “{searchQuery}”</p>
              )}
            </section>
          </>
        )}

        {(errorMessage || notice) && (
          <div
            className={`app-message${errorMessage ? ' app-message--error' : ''}`}
            role={errorMessage ? 'alert' : 'status'}
          >
            <span>{errorMessage || notice}</span>
            <button
              className="message-dismiss"
              onClick={() => {
                setErrorMessage('');
                setNotice('');
              }}
              aria-label="Dismiss message"
            >
              ×
            </button>
          </div>
        )}

        <footer className="cabinet-footer">
          <span>INSERT COIN <b>·</b> PRESS START</span>
          <span>CABINET.IO <b>©</b> CLOUD ARCADE</span>
        </footer>
      </div>
      {!accessToken && !activeSession && (
        <AuthModal
          onAuthSuccess={(token, authenticatedUsername) => {
            setAccessToken(token);
            setUsername(authenticatedUsername);
            setErrorMessage('');
          }}
        />
      )}
    </main>
  );
}

function CoverArtwork({ game, featured = false }: { game: GameItem; featured?: boolean }) {
  return (
    <div className={`cover-art ${game.coverStyle}${featured ? ' cover-art--featured' : ''}`}>
      <span className="cover-spark cover-spark--one" />
      <span className="cover-spark cover-spark--two" />
      <span className="cover-spark cover-spark--three" />
      <span className="cover-orb" />
      <span className="cover-mountain cover-mountain--back" />
      <span className="cover-mountain cover-mountain--front" />
      <span className="cover-title-mark">{game.title}</span>
      <span className="cover-subtitle">{game.system} · PLAYER 1</span>
      {!featured && <span className="cover-side-label">{game.system}</span>}
    </div>
  );
}

export default App;
