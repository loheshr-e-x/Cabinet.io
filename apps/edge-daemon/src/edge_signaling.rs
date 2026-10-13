use crate::rom_store::download_rom;
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
    let token = Arc::new(std::sync::Mutex::new(None::<String>));
    let token_for_handshake = Arc::clone(&token);
    let socket = accept_hdr_async(
        stream,
        move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
              response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let extracted = request
                .uri()
                .query()
                .into_iter()
                .flat_map(|query| form_urlencoded::parse(query.as_bytes()))
                .find_map(|(key, value)| (key == "token").then(|| value.into_owned()));
            if let Some(value) = extracted {
                *token_for_handshake
                    .lock()
                    .expect("handshake token mutex poisoned") = Some(value);
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
    let token = token
        .lock()
        .map_err(|_| "session token mutex poisoned")?
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

    let rom = download_rom(&claims.rom_key).await?;
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
        rom,
        Arc::clone(&input_state),
        1920,
        1080,
    )?;

    let broadcaster = WebRTCBroadcaster::new(input_state)
        .await
        .map_err(|error| format!("could not initialize WebRTC broadcaster: {error}"))?;
    handle_signaling(socket, broadcaster, emulator).await
}

async fn handle_signaling(
    mut socket: WebSocketStream<TcpStream>,
    mut broadcaster: WebRTCBroadcaster,
    mut emulator: crate::emulator::EmulatorInstance,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let peer_connection = Arc::clone(&broadcaster.peer_connection);
    let result = handle_signaling_loop(&mut socket, &mut broadcaster, &mut emulator).await;
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
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut answered = false;
    let mut frame_ticker = interval(Duration::from_micros(16_667));
    let mut last_frame_number = 0;
    let frame_buffer = emulator.get_frame_buffer();
    let mut save_state_commands = broadcaster.take_save_state_commands();
    let mut peer_state_changes = broadcaster.take_peer_state_changes();
    let mut saved_state: Option<Vec<u8>> = None;
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
            }
            command = save_state_commands.recv(), if answered && !save_state_commands.is_closed() => {
                match command {
                    Some(crate::webrtc_stream::SaveStateCommand::Save(channel)) => {
                        let result = emulator.save_state().map(|state| {
                            let size = state.len();
                            saved_state = Some(state);
                            format!("Save state captured for this session ({size} bytes).")
                        });
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
                        let result = match saved_state.as_deref() {
                            Some(state) => emulator.load_state(state)
                                .map(|()| format!("Save state loaded ({} bytes).", state.len())),
                            None => Err("No save state has been captured in this session.".to_string()),
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
