use crate::input_demuxer::InputPayload;
use crate::rom_store::download_rom;
use crate::signaling::{SignalingHandler, SignalingMessage};
use crate::webrtc_stream::WebRTCBroadcaster;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::env;
use std::error::Error;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
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

pub async fn serve(
    listener: TcpListener,
    input_sender: mpsc::Sender<InputPayload>,
) -> Result<(), std::io::Error> {
    loop {
        let (stream, address) = listener.accept().await?;
        let sender = input_sender.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, sender).await {
                eprintln!("[Cabinet Edge] WebRTC session from {address} failed: {error}");
            }
        });
    }
}

async fn handle_connection(
    stream: TcpStream,
    input_sender: mpsc::Sender<InputPayload>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
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

    let broadcaster = WebRTCBroadcaster::new(input_sender)
        .await
        .map_err(|error| format!("could not initialize WebRTC broadcaster: {error}"))?;
    handle_signaling(socket, broadcaster, rom).await
}

async fn handle_signaling(
    mut socket: WebSocketStream<TcpStream>,
    broadcaster: WebRTCBroadcaster,
    _rom: Vec<u8>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut answered = false;
    loop {
        tokio::select! {
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

    broadcaster.peer_connection.close().await?;
    Ok(())
}
