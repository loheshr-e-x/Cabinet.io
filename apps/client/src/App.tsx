import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthModal } from './components/AuthModal';
import { ControlsInfo } from './components/ControlsInfo';
import { TouchController } from './components/TouchController';
import { ORCHESTRATOR_URL } from './config';
import { useInputHandler } from './hooks/useInputHandler';
import { useWebRTCSession } from './hooks/useWebRTCSession';
import './App.css';

interface GameItem {
  id: string;
  title: string;
  system: string;
  systemCore: string;
}

interface ActiveSession {
  sessionId: string;
  edgeWsUrl: string;
  token: string;
  game: GameItem;
}

function parseGameCatalog(value: unknown): GameItem[] {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('games' in value) ||
    !Array.isArray(value.games)
  ) {
    throw new Error('The game catalog service returned an invalid response.');
  }

  return value.games.map((game: unknown) => {
    if (
      typeof game !== 'object' ||
      game === null ||
      !('id' in game) ||
      typeof game.id !== 'string' ||
      !('title' in game) ||
      typeof game.title !== 'string' ||
      !('system' in game) ||
      typeof game.system !== 'string'
    ) {
      throw new Error('The game catalog service returned an invalid game.');
    }

    return {
      id: game.id,
      title: game.title,
      systemCore: game.system,
      system: game.system
        .replace(/^libretro[_-]/i, '')
        .replace(/[_-]+/g, ' ')
        .toLocaleUpperCase(),
    };
  });
}

function getSystemColor(system: string): string {
  let hash = 0;
  for (const character of system) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 75% 52%)`;
}

function getAccessToken(): string | null {
  return window.sessionStorage.getItem('cabinet.accessToken');
}

function hasTouchInput(): boolean {
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(max-width: 768px)').matches
  );
}

export function App() {
  const [games, setGames] = useState<GameItem[]>([]);
  const [selectedGame, setSelectedGame] = useState<GameItem | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(getAccessToken);
  const [username, setUsername] = useState(
    () => window.sessionStorage.getItem('cabinet.username') ?? '',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [systemFilter, setSystemFilter] = useState('ALL');
  const [launching, setLaunching] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [gamesLoading, setGamesLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [isTouchDevice, setIsTouchDevice] = useState(hasTouchInput);
  const [touchControlsOverride, setTouchControlsOverride] = useState<boolean | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [orchestratorStatus, setOrchestratorStatus] = useState<
    'checking' | 'online' | 'offline'
  >('checking');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamViewRef = useRef<HTMLElement | null>(null);
  const touchControlsEnabled = touchControlsOverride ?? isTouchDevice;

  const { connectionStatus, dataChannel, remoteStream } = useWebRTCSession({
    sessionId: activeSession?.sessionId ?? null,
    token: activeSession?.token ?? null,
    edgeWsUrl: activeSession?.edgeWsUrl ?? null,
  });
  const setButton = useInputHandler(dataChannel);
  const bindVideoElement = useCallback(
    (video: HTMLVideoElement | null) => {
      videoRef.current = video;
      if (video) video.srcObject = remoteStream;
    },
    [remoteStream],
  );

  useEffect(() => {
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    const narrowScreen = window.matchMedia('(max-width: 768px)');
    const update = () => setIsTouchDevice(coarsePointer.matches || narrowScreen.matches);
    coarsePointer.addEventListener('change', update);
    narrowScreen.addEventListener('change', update);
    return () => {
      coarsePointer.removeEventListener('change', update);
      narrowScreen.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const updateFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === streamViewRef.current);
    };
    document.addEventListener('fullscreenchange', updateFullscreenState);
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, []);

  const toggleFullscreen = async () => {
    const streamView = streamViewRef.current;
    if (!streamView) return;

    setFullscreenError('');
    try {
      if (document.fullscreenElement === streamView) {
        await document.exitFullscreen();
      } else {
        await streamView.requestFullscreen();
      }
    } catch (error) {
      setFullscreenError(
        error instanceof Error ? error.message : 'Could not change fullscreen mode.',
      );
    }
  };

  const signOut = () => {
    window.sessionStorage.removeItem('cabinet.accessToken');
    window.sessionStorage.removeItem('cabinet.username');
    setAccessToken(null);
    setUsername('');
    setActiveSession(null);
    setGames([]);
    setSelectedGame(null);
    setCatalogError('');
    setErrorMessage('');
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${ORCHESTRATOR_URL}/api/v1/health`, { signal: controller.signal })
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
    if (!accessToken) return;

    const controller = new AbortController();

    const loadGames = async () => {
      setGamesLoading(true);
      setCatalogError('');
      try {
        const response = await fetch(`${ORCHESTRATOR_URL}/api/v1/games`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          if (response.status === 401) {
            window.sessionStorage.removeItem('cabinet.accessToken');
            window.sessionStorage.removeItem('cabinet.username');
            setAccessToken(null);
            setUsername('');
            setActiveSession(null);
            setGames([]);
            setSelectedGame(null);
            setCatalogError('Your sign-in expired. Please sign in again.');
            return;
          }
          const message =
            typeof result === 'object' &&
            result !== null &&
            'error' in result &&
            typeof result.error === 'string'
              ? result.error
              : `Game catalog request failed (${response.status})`;
          throw new Error(message);
        }

        const catalog = parseGameCatalog(result);
        setGames(catalog);
        setSelectedGame((current) =>
          catalog.find((game) => game.id === current?.id) ?? catalog[0] ?? null,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('[Cabinet] Could not load the game catalog:', error);
        setCatalogError(
          error instanceof Error ? error.message : 'Could not load the game catalog.',
        );
      } finally {
        if (!controller.signal.aborted) setGamesLoading(false);
      }
    };

    void loadGames();
    return () => controller.abort();
  }, [accessToken]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  const visibleGames = games.filter((game) => {
    const query = searchQuery.trim().toLocaleLowerCase();
    const matchesSearch =
      query.length === 0 ||
      game.title.toLocaleLowerCase().includes(query) ||
      game.system.toLocaleLowerCase().includes(query);
    const matchesSystem = systemFilter === 'ALL' || game.system === systemFilter;
    return matchesSearch && matchesSystem;
  });
  const gameSystems = [...new Set(games.map((game) => game.system))].sort();

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
        !('edgeWsUrl' in result) ||
        typeof result.edgeWsUrl !== 'string'
      ) {
        throw new Error('The orchestrator returned an invalid session response.');
      }
      setSelectedGame(game);
      setActiveSession({
        sessionId: result.sessionId,
        edgeWsUrl: result.edgeWsUrl,
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
              {gameSystems.map((system) => (
                <option value={system} key={system}>{system}</option>
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
                <span className="player-rank">PLAYER</span>
              </div>
            )}
          </div>
        </header>

        {activeSession ? (
          <section className="stream-view" aria-label="Game stream" ref={streamViewRef}>
            <div className="stream-header">
              <div className="stream-header-actions">
                <button className="button button--quiet" onClick={exitStream}>
                  ← EXIT TO CATALOG
                </button>
                <ControlsInfo systemCore={activeSession.game.systemCore} />
                <button
                  className="button button--secondary"
                  type="button"
                  aria-pressed={touchControlsEnabled}
                  onClick={() =>
                    setTouchControlsOverride(!touchControlsEnabled)
                  }
                >
                  TOUCH CONTROLS: {touchControlsEnabled ? 'ON' : 'OFF'}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void toggleFullscreen()}
                  aria-pressed={isFullscreen}
                >
                  {isFullscreen ? 'EXIT FULLSCREEN' : 'FULLSCREEN'}
                </button>
              </div>
              <div className="stream-session-meta">
                <span className="eyebrow">NOW PLAYING</span>
                <strong>{activeSession.game.title}</strong>
                <span className="connection-state" aria-live="polite">
                  {connectionStatus.replaceAll('-', ' ').toUpperCase()}
                </span>
              </div>
              {fullscreenError && (
                <p className="stream-error" role="alert">{fullscreenError}</p>
              )}
            </div>
            <div className="stream-player-stage">
              <div className="stream-viewport">
                <video
                  ref={bindVideoElement}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    width: '100%',
                    height: '100%',
                    backgroundColor: '#000',
                  }}
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
                  <span>INPUT: <strong>{dataChannel?.readyState === 'open' ? 'READY' : 'WAITING'}</strong></span>
                  <span>ICE: <strong>{connectionStatus.toUpperCase()}</strong></span>
                </div>
              </div>
              <TouchController
                setButton={setButton}
                enabled={touchControlsEnabled}
              />
            </div>
          </section>
        ) : (
          <>
            {selectedGame && (
              <section className="resume-section">
                <div className="section-heading">
                  <h1>FEATURED GAME</h1>
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
                        style={{ backgroundColor: getSystemColor(selectedGame.system) }}
                      >
                        {selectedGame.system}
                      </span>
                    </div>
                    <p className="save-detail">
                      <span>AVAILABLE TO PLAY</span>
                      <span>{selectedGame.system}</span>
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
            )}

            <section className="library-section" aria-labelledby="library-heading">
              <div className="library-heading-row">
                <h2 id="library-heading" className="section-title">
                  YOUR LIBRARY <span>/{visibleGames.length.toString().padStart(2, '0')}</span>
                </h2>
                <div className="library-metrics" aria-label="Catalog statistics">
                  <span>GAMES: <strong>{games.length}</strong></span>
                  <i />
                  <span>SYSTEMS: <strong>{gameSystems.length}</strong></span>
                </div>
              </div>

              {gamesLoading ? (
                <p className="empty-library" role="status">LOADING GAME CATALOG…</p>
              ) : catalogError ? (
                <p className="empty-library" role="alert">GAME CATALOG UNAVAILABLE</p>
              ) : games.length === 0 ? (
                <p className="empty-library">NO GAMES IN THE CATALOG</p>
              ) : visibleGames.length > 0 ? (
                <div className="library-grid">
                  {visibleGames.map((game) => {
                    const isSelected = selectedGame?.id === game.id;
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

        {(errorMessage || catalogError || notice) && (
          <div
            className={`app-message${errorMessage || catalogError ? ' app-message--error' : ''}`}
            role={errorMessage || catalogError ? 'alert' : 'status'}
          >
            <span>{errorMessage || catalogError || notice}</span>
            <button
              className="message-dismiss"
              onClick={() => {
                setErrorMessage('');
                setCatalogError('');
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
    <div className={`cover-art${featured ? ' cover-art--featured' : ''}`}>
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
