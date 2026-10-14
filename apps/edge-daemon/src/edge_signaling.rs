use crate::rom_store::download_rom;
use crate::save_state::SaveStateManager;
use crate::signaling::{SignalingHandler, SignalingMessage};
use crate::webrtc_stream::WebRTCBroadcaster;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::env;
use std::error::Error;
use std::path::Path;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{interval, Duration};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async, WebSocketStream};
use url::form_urlencoded;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EdgeSessionClaims {
    token_type: String,
    session_id: String,
    user_id: String,
    game_id: Option<String>,
    rom_key: String,
    system_core: String,
    exp: usize,
}

pub async fn bind(port: u16) -> Result<TcpListener, std::io::Error> {
    TcpListener::bind(("0.0.0.0", port)).await
}

pub async fn serve(listener: TcpListener) -> Result<(), std::io::Error> {
    loop {
        let (stream, address) = listener.accept().await?;
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream).await {
                eprintln!("[Cabinet Edge] WebRTC session from {address} failed: {error}");
            }
        });
    }
}

async fn handle_connection(stream: TcpStream) -> Result<(), Box<dyn Error + Send + Sync>> {
    let session_query = Arc::new(std::sync::Mutex::new(None::<(String, Option<String>)>));
    let query_for_handshake = Arc::clone(&session_query);
    let socket = accept_hdr_async(
        stream,
        move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
              response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let (token, game_id) = parse_session_query(request.uri().query());
            if let Some(token) = token {
                *query_for_handshake
                    .lock()
                    .expect("handshake query mutex poisoned") = Some((token, game_id));
                Ok(response)
            } else {
                Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED)
                    .body(Some("session token required".to_string()))
                    .expect("valid unauthorized WebSocket response"))
            }
        },
    )
    .await?;
    let (token, query_game_id) = session_query
        .lock()
        .map_err(|_| "session query mutex poisoned")?
        .take()
        .ok_or("session token missing from WebSocket handshake")?;
    let secret = env::var("JWT_SECRET")?;
    let claims = decode::<EdgeSessionClaims>(
        &token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )?
    .claims;
    if claims.token_type != "edge-session"
        || claims.session_id.is_empty()
        || claims.user_id.is_empty()
        || claims.rom_key.is_empty()
        || claims.system_core.is_empty()
        || claims.exp == 0
    {
        return Err("invalid edge session claims".into());
    }
    let game_id = claims
        .game_id
        .filter(|game_id| !game_id.is_empty())
        .or(query_game_id)
        .unwrap_or_default();

    let rom = download_rom(&claims.rom_key).await.map_err(|error| {
        eprintln!(
            "[Cabinet Edge] Failed to fetch ROM from R2 key '{}': {error}",
            claims.rom_key
        );
        error
    })?;
    println!(
        "[Cabinet Edge] Loaded {} bytes for {} ({}) in session {}.",
        rom.len(),
        claims.system_core,
        claims.rom_key,
        claims.session_id
    );

    let core_path = env::var("LIBRETRO_CORE_PATH")
        .map_err(|_| "LIBRETRO_CORE_PATH must point to an installed Libretro shared library")?;
    let input_state = Arc::new(std::sync::Mutex::new(0_u16));
    let emulator = crate::emulator::EmulatorInstance::load_core(
        Path::new(&core_path),
        &claims.system_core,
        &claims.rom_key,
        &claims.session_id,
        rom,
        Arc::clone(&input_state),
        1920,
        1080,
    )?;

    let save_state_manager = SaveStateManager::from_env()?.map(Arc::new);
    if game_id.is_empty() {
        eprintln!("[Cabinet Save] Automatic restore skipped because the session has no game ID.");
    } else if let Some(manager) = &save_state_manager {
        match manager.load_state(&claims.user_id, &game_id, 0).await {
            Ok(Some(state)) => match emulator.load_state(&state) {
                Ok(()) => println!(
                    "[Cabinet Save] Restored saved state for user {} and game {}.",
                    claims.user_id, game_id
                ),
                Err(error) => eprintln!("[Cabinet Save] Stored state could not be loaded: {error}"),
            },
            Ok(None) => println!(
                "[Cabinet Save] No stored state found for user {} and game {}.",
                claims.user_id, game_id
            ),
            Err(error) => eprintln!("[Cabinet Save] Automatic restore failed: {error}"),
        }
    } else {
        println!(
            "[Cabinet Save] Persistent save states are disabled; R2 and DATABASE_URL are required."
        );
    }

    let broadcaster = WebRTCBroadcaster::new(input_state, emulator.audio_sample_rate())
        .await
        .map_err(|error| format!("could not initialize WebRTC broadcaster: {error}"))?;
    handle_signaling(
        socket,
        broadcaster,
        emulator,
        save_state_manager,
        claims.user_id,
        game_id,
    )
    .await
}

fn parse_session_query(query: Option<&str>) -> (Option<String>, Option<String>) {
    let mut token = None;
    let mut game_id = None;
    for (key, value) in query
        .into_iter()
        .flat_map(|query| form_urlencoded::parse(query.as_bytes()))
    {
        match key.as_ref() {
            "token" => token = Some(value.into_owned()),
            "gameId" => game_id = Some(value.into_owned()),
            _ => {}
        }
    }
    (token, game_id)
}

async fn handle_signaling(
    mut socket: WebSocketStream<TcpStream>,
    mut broadcaster: WebRTCBroadcaster,
    mut emulator: crate::emulator::EmulatorInstance,
    save_state_manager: Option<Arc<SaveStateManager>>,
    user_id: String,
    game_id: String,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let peer_connection = Arc::clone(&broadcaster.peer_connection);
    let result = handle_signaling_loop(
        &mut socket,
        &mut broadcaster,
        &mut emulator,
        save_state_manager,
        &user_id,
        &game_id,
    )
    .await;
    emulator.unload_core();
    let close_result = peer_connection.close().await;
    result?;
    close_result?;
    Ok(())
}

async fn handle_signaling_loop(
    socket: &mut WebSocketStream<TcpStream>,
    broadcaster: &mut WebRTCBroadcaster,
    emulator: &mut crate::emulator::EmulatorInstance,
    save_state_manager: Option<Arc<SaveStateManager>>,
    user_id: &str,
    game_id: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut answered = false;
    let mut frame_ticker = interval(Duration::from_micros(16_667));
    let mut last_frame_number = 0;
    let mut session_save_state: Option<Vec<u8>> = None;
    let frame_buffer = emulator.get_frame_buffer();
    let mut audio_samples = Vec::with_capacity(4096);
    let mut save_state_commands = broadcaster.take_save_state_commands();
    let mut peer_state_changes = broadcaster.take_peer_state_changes();
    loop {
        tokio::select! {
            _ = frame_ticker.tick(), if answered => {
                emulator.step_frame();
                let frame_number = frame_buffer
                    .lock()
                    .map_err(|_| "Libretro frame buffer lock poisoned")?
                    .frame_number;
                if frame_number != last_frame_number {
                    last_frame_number = frame_number;
                    broadcaster
                        .send_video_frame(Arc::clone(&frame_buffer), frame_number as i64)
                        .await?;
                }
                frame_buffer
                    .lock()
                    .map_err(|_| "Libretro audio buffer lock poisoned")?
                    .copy_audio_into(&mut audio_samples);
                broadcaster.send_audio_samples(&audio_samples).await?;
            }
            command = save_state_commands.recv(), if answered && !save_state_commands.is_closed() => {
                match command {
                    Some(crate::webrtc_stream::SaveStateCommand::Save(channel)) => {
                        let result = match emulator.save_state() {
                            Ok(state) => {
                                let state_size = state.len();
                                session_save_state = Some(state.clone());
                                if user_id.is_empty() || game_id.is_empty() {
                                    eprintln!(
                                        "[Cabinet Save] Keeping state in the active session only because user_id or game_id is empty."
                                    );
                                    Ok(format!("State saved for this session ({state_size} bytes; not persisted)."))
                                } else if let Some(manager) = &save_state_manager {
                                    manager
                                        .capture_and_sync_state(user_id, game_id, 0, &state)
                                        .await
                                        .map(|size| format!("Save state persisted ({size} bytes)."))
                                        .map_err(|error| error.to_string())
                                } else {
                                    Ok(format!("State saved for this session ({state_size} bytes; persistence is not configured)."))
                                }
                            }
                            Err(error) => Err(error.to_string()),
                        };
                        let (success, message) = match result {
                            Ok(message) => (true, message),
                            Err(error) => (false, error),
                        };
                        channel.send_text(serde_json::json!({
                            "type": "save_state_result",
                            "action": "save",
                            "success": success,
                            "message": message,
                        }).to_string()).await?;
                    }
                    Some(crate::webrtc_stream::SaveStateCommand::Load(channel)) => {
                        let persistent_state = if user_id.is_empty() || game_id.is_empty() {
                            eprintln!(
                                "[Cabinet Save] Loading from the active session only because user_id or game_id is empty."
                            );
                            Ok(None)
                        } else if let Some(manager) = &save_state_manager {
                            manager.load_state(user_id, game_id, 0).await
                        } else {
                            Ok(None)
                        };
                        let result = match persistent_state {
                            Ok(Some(state)) => emulator
                                .load_state(&state)
                                .map(|()| {
                                    session_save_state = Some(state.clone());
                                    format!("Save state loaded ({} bytes).", state.len())
                                })
                                .map_err(|error| error.to_string()),
                            Ok(None) => match &session_save_state {
                                Some(state) => emulator
                                    .load_state(state)
                                    .map(|()| format!("Session save state loaded ({} bytes).", state.len()))
                                    .map_err(|error| error.to_string()),
                                None => Err("No saved state is available for this session.".to_string()),
                            },
                            Err(error) => Err(error.to_string()),
                        };
                        let (success, message) = match result {
                            Ok(message) => (true, message),
                            Err(error) => (false, error),
                        };
                        channel.send_text(serde_json::json!({
                            "type": "save_state_result",
                            "action": "load",
                            "success": success,
                            "message": message,
                        }).to_string()).await?;
                    }
                    None => {}
                }
            }
            state = peer_state_changes.recv(), if !peer_state_changes.is_closed() => {
                if let Some(state) = state {
                    eprintln!("[Cabinet Edge] PeerConnection entered terminal state {state}; unloading core.");
                    break;
                }
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else { break };
                let message = incoming?;
                match message {
                    Message::Text(text) => {
                        let signal = SignalingHandler::parse_message(&text)?;
                        match signal {
                            SignalingMessage::Offer { sdp } if !answered => {
                                broadcaster.peer_connection
                                    .set_remote_description(RTCSessionDescription::offer(sdp)?)
                                    .await?;
                                let mut gathering_complete = broadcaster.peer_connection
                                    .gathering_complete_promise().await;
                                let answer = broadcaster.peer_connection.create_answer(None).await?;
                                broadcaster.peer_connection.set_local_description(answer).await?;
                                let _ = gathering_complete.recv().await;
                                let local_description = broadcaster.peer_connection
                                    .local_description().await
                                    .ok_or("WebRTC did not produce a local description")?;
                                socket.send(Message::Text(
                                    serde_json::json!({
                                        "type": "answer",
                                        "sdp": local_description.sdp,
                                    }).to_string()
                                )).await?;
                                answered = true;
                            }
                            SignalingMessage::Candidate {
                                candidate,
                                sdp_mid,
                                sdp_mline_index,
                            } if answered => {
                                broadcaster.peer_connection
                                    .add_ice_candidate(RTCIceCandidateInit {
                                        candidate,
                                        sdp_mid,
                                        sdp_mline_index,
                                        username_fragment: None,
                                    })
                                    .await?;
                            }
                            SignalingMessage::Offer { .. } => {
                                return Err("received a second SDP offer for the same session".into());
                            }
                            SignalingMessage::Candidate { .. } => {
                                return Err("received an ICE candidate before the SDP offer".into());
                            }
                            SignalingMessage::Answer { .. } => {
                                return Err("edge daemon cannot accept an SDP answer".into());
                            }
                        }
                    }
                    Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
                    Message::Close(_) => break,
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_edge_session_claims_without_game_id() {
        let claims: EdgeSessionClaims = serde_json::from_str(
            r#"{
                "tokenType":"edge-session",
                "sessionId":"session-test",
                "userId":"user-test",
                "romKey":"roms/test.nes",
                "systemCore":"fceumm",
                "exp":1
            }"#,
        )
        .unwrap();

        assert_eq!(claims.game_id, None);
    }

    #[test]
    fn extracts_optional_game_id_from_session_query() {
        let (token, game_id) = parse_session_query(Some("token=valid-token&gameId=game-123"));

        assert_eq!(token.as_deref(), Some("valid-token"));
        assert_eq!(game_id.as_deref(), Some("game-123"));
        assert_eq!(parse_session_query(Some("token=valid-token")).1, None);
        assert_eq!(parse_session_query(None), (None, None));
    }
}
