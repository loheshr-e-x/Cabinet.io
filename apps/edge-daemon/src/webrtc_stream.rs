use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use vpx_encode::{Config as VpxConfig, Encoder as VpxEncoder, VideoCodecId};
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::frame_buffer::FrameBuffer;

pub struct WebRTCBroadcaster {
    pub peer_connection: Arc<RTCPeerConnection>,
    pub video_track: Arc<TrackLocalStaticSample>,
    video_encoder_sender: mpsc::Sender<VideoFrameRequest>,
    save_state_commands: Option<mpsc::UnboundedReceiver<SaveStateCommand>>,
    peer_state_changes: Option<mpsc::UnboundedReceiver<RTCPeerConnectionState>>,
}

pub enum SaveStateCommand {
    Save(Arc<RTCDataChannel>),
    Load(Arc<RTCDataChannel>),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DataChannelCommand {
    SaveState,
    LoadState,
}

struct VideoFrameRequest {
    frame_buffer: Arc<std::sync::Mutex<FrameBuffer>>,
    pts: i64,
    response: oneshot::Sender<Result<Vec<Vec<u8>>, String>>,
}

impl WebRTCBroadcaster {
    pub async fn new(
        input_state: Arc<std::sync::Mutex<u16>>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (save_state_sender, save_state_commands) = mpsc::unbounded_channel();
        let (peer_state_sender, peer_state_changes) = mpsc::unbounded_channel();
        let mut media_engine = MediaEngine::default();

        // Register VP8 Video Codec
        media_engine.register_default_codecs()?;

        let api = APIBuilder::new().with_media_engine(media_engine).build();
        let config = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec![
                    "stun:stun.l.google.com:19302".to_string(),
                    "stun:stun1.l.google.com:19302".to_string(),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        let peer_connection = Arc::new(api.new_peer_connection(config).await?);
        peer_connection.on_peer_connection_state_change(Box::new(move |state| {
            if matches!(
                state,
                RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Closed
                    | RTCPeerConnectionState::Disconnected
            ) {
                let _ = peer_state_sender.send(state);
            }
            Box::pin(async {})
        }));

        peer_connection.on_data_channel(Box::new(move |data_channel: Arc<RTCDataChannel>| {
            let input_state = Arc::clone(&input_state);
            let save_state_sender = save_state_sender.clone();
            Box::pin(async move {
                if data_channel.label() != "input" {
                    eprintln!(
                        "[Cabinet Edge] Ignoring unsupported data channel: {}",
                        data_channel.label()
                    );
                    return;
                }
                eprintln!("[Cabinet Edge] Input data channel negotiated.");
                let command_channel = Arc::clone(&data_channel);
                data_channel.on_message(Box::new(move |message| {
                    let input_state = Arc::clone(&input_state);
                    let save_state_sender = save_state_sender.clone();
                    let data_channel = Arc::clone(&command_channel);
                    Box::pin(async move {
                        if message.is_string {
                            match serde_json::from_slice::<DataChannelCommand>(&message.data) {
                                Ok(DataChannelCommand::SaveState) => {
                                    if save_state_sender
                                        .send(SaveStateCommand::Save(data_channel))
                                        .is_err()
                                    {
                                        eprintln!(
                                            "[Cabinet Edge] Save-state command receiver stopped."
                                        );
                                    }
                                }
                                Ok(DataChannelCommand::LoadState) => {
                                    if save_state_sender
                                        .send(SaveStateCommand::Load(data_channel))
                                        .is_err()
                                    {
                                        eprintln!(
                                            "[Cabinet Edge] Load-state command receiver stopped."
                                        );
                                    }
                                }
                                Err(error) => eprintln!(
                                    "[Cabinet Edge] Invalid data-channel command: {error}"
                                ),
                            }
                            return;
                        }
                        if message.data.len() != 2 {
                            eprintln!(
                                "[Cabinet Edge] Invalid input mask size: expected 2 bytes, got {}.",
                                message.data.len()
                            );
                            return;
                        }
                        let mask = u16::from_le_bytes([message.data[0], message.data[1]]);
                        match input_state.lock() {
                            Ok(mut current) => *current = mask,
                            Err(_) => {
                                eprintln!("[Cabinet Edge] Input state lock poisoned.");
                            }
                        }
                    })
                }));
            })
        }));

        // Create VP8 Local Video Track
        let video_track = Arc::new(TrackLocalStaticSample::new(
            webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability {
                mime_type: "video/vp8".to_string(),
                ..Default::default()
            },
            "video".to_string(),
            "cabinet-stream".to_string(),
        ));

        // Attach track to peer connection
        peer_connection
            .add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal + Send + Sync>)
            .await?;

        let (video_encoder_sender, video_encoder_receiver) = mpsc::channel(1);
        std::thread::Builder::new()
            .name("cabinet-vp8-encoder".to_string())
            .spawn(move || video_encoder_worker(video_encoder_receiver))?;

        Ok(Self {
            peer_connection,
            video_track,
            video_encoder_sender,
            save_state_commands: Some(save_state_commands),
            peer_state_changes: Some(peer_state_changes),
        })
    }

    pub fn take_save_state_commands(&mut self) -> mpsc::UnboundedReceiver<SaveStateCommand> {
        self.save_state_commands
            .take()
            .expect("save-state command receiver already taken")
    }

    pub fn take_peer_state_changes(&mut self) -> mpsc::UnboundedReceiver<RTCPeerConnectionState> {
        self.peer_state_changes
            .take()
            .expect("peer state receiver already taken")
    }

    pub async fn send_video_frame(
        &mut self,
        frame_buffer: Arc<std::sync::Mutex<FrameBuffer>>,
        pts: i64,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (response_sender, response_receiver) = oneshot::channel();
        self.video_encoder_sender
            .send(VideoFrameRequest {
                frame_buffer,
                pts,
                response: response_sender,
            })
            .await?;
        let encoded_packets = response_receiver
            .await
            .map_err(|error| format!("VP8 encoder worker stopped: {error}"))??;

        for packet in encoded_packets {
            self.video_track
                .write_sample(&Sample {
                    data: packet.into(),
                    duration: std::time::Duration::from_micros(16_667),
                    ..Default::default()
                })
                .await?;
        }
        Ok(())
    }
}

fn video_encoder_worker(mut requests: mpsc::Receiver<VideoFrameRequest>) {
    let mut encoder: Option<(u32, u32, VpxEncoder)> = None;
    let mut i420_frame = Vec::new();
    while let Some(request) = requests.blocking_recv() {
        let result = request
            .frame_buffer
            .lock()
            .map_err(|_| "Libretro frame buffer lock poisoned".to_string())
            .and_then(|frame_buffer| {
                let byte_len = frame_buffer
                    .pitch
                    .checked_mul(frame_buffer.height as usize)
                    .ok_or_else(|| "frame size overflow".to_string())?;
                encode_video_frame(
                    &mut encoder,
                    &mut i420_frame,
                    &frame_buffer.video_buffer[..byte_len],
                    frame_buffer.width,
                    frame_buffer.height,
                    frame_buffer.pitch,
                    request.pts,
                )
                .map_err(|error| error.to_string())
            });
        let _ = request.response.send(result);
    }
}

fn encode_video_frame(
    encoder: &mut Option<(u32, u32, VpxEncoder)>,
    i420_frame: &mut Vec<u8>,
    frame_data: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
    pts: i64,
) -> Result<Vec<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
    if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
        return Err("VP8 encoder requires non-zero even frame dimensions".into());
    }
    let needs_encoder = encoder
        .as_ref()
        .is_none_or(|(encoder_width, encoder_height, _)| {
            *encoder_width != width || *encoder_height != height
        });
    if needs_encoder {
        *encoder = Some((
            width,
            height,
            VpxEncoder::new(VpxConfig {
                width,
                height,
                timebase: [1, 60],
                bitrate: 2_000,
                codec: VideoCodecId::VP8,
            })?,
        ));
    }

    xrgb8888_to_i420_into(frame_data, width, height, pitch, i420_frame)?;
    let (_, _, encoder) = encoder.as_mut().expect("encoder was initialized");
    Ok(encoder
        .encode(pts, i420_frame)?
        .map(|packet| packet.data.to_vec())
        .collect())
}

#[cfg(test)]
fn xrgb8888_to_i420(
    frame: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let mut i420 = Vec::new();
    xrgb8888_to_i420_into(frame, width, height, pitch, &mut i420)?;
    Ok(i420)
}

fn xrgb8888_to_i420_into(
    frame: &[u8],
    width: u32,
    height: u32,
    pitch: usize,
    i420: &mut Vec<u8>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let width = width as usize;
    let height = height as usize;
    let row_bytes = width.checked_mul(4).ok_or("frame width overflow")?;
    let frame_bytes = pitch.checked_mul(height).ok_or("frame size overflow")?;
    if width == 0
        || height == 0
        || width % 2 != 0
        || height % 2 != 0
        || pitch < row_bytes
        || frame_bytes > frame.len()
    {
        return Err("invalid XRGB8888 frame dimensions, pitch, or buffer size".into());
    }

    let y_size = width * height;
    let chroma_size = y_size / 4;
    i420.resize(y_size + 2 * chroma_size, 0);
    for y in 0..height {
        for x in 0..width {
            let offset = y * pitch + x * 4;
            let blue = frame[offset] as i32;
            let green = frame[offset + 1] as i32;
            let red = frame[offset + 2] as i32;
            i420[y * width + x] =
                (((66 * red + 129 * green + 25 * blue + 128) >> 8) + 16).clamp(0, 255) as u8;
        }
    }

    let u_offset = y_size;
    let v_offset = y_size + chroma_size;
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let mut red = 0;
            let mut green = 0;
            let mut blue = 0;
            for row in 0..2 {
                for column in 0..2 {
                    let offset = (y + row) * pitch + (x + column) * 4;
                    blue += frame[offset] as i32;
                    green += frame[offset + 1] as i32;
                    red += frame[offset + 2] as i32;
                }
            }
            red /= 4;
            green /= 4;
            blue /= 4;
            let chroma_index = (y / 2) * (width / 2) + (x / 2);
            i420[u_offset + chroma_index] =
                (((-38 * red - 74 * green + 112 * blue + 128) >> 8) + 128).clamp(0, 255) as u8;
            i420[v_offset + chroma_index] =
                (((112 * red - 94 * green - 18 * blue + 128) >> 8) + 128).clamp(0, 255) as u8;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{encode_video_frame, xrgb8888_to_i420};

    #[test]
    fn converts_xrgb_rows_to_i420() {
        let red_frame = [0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0];
        let i420 = xrgb8888_to_i420(&red_frame, 2, 2, 8).unwrap();
        assert_eq!(&i420[..4], &[82, 82, 82, 82]);
        assert_eq!(i420[4], 90);
        assert_eq!(i420[5], 240);
    }

    #[test]
    fn encodes_xrgb_frame_as_vp8() {
        let frame = [0_u8, 0, 255, 0].repeat(16 * 16);
        let mut encoder = None;
        let mut i420_frame = Vec::new();

        let packets =
            encode_video_frame(&mut encoder, &mut i420_frame, &frame, 16, 16, 16 * 4, 0).unwrap();

        assert!(!packets.is_empty());
    }
}
