use std::sync::Arc;
use tokio::sync::mpsc;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::input_demuxer::InputPayload;

pub struct WebRTCBroadcaster {
    pub peer_connection: Arc<RTCPeerConnection>,
    pub video_track: Arc<TrackLocalStaticSample>,
}

impl WebRTCBroadcaster {
    pub async fn new(
        input_sender: mpsc::Sender<InputPayload>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
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

        peer_connection.on_data_channel(Box::new(move |data_channel: Arc<RTCDataChannel>| {
            let input_sender = input_sender.clone();
            Box::pin(async move {
                data_channel.on_message(Box::new(move |message| {
                    let input_sender = input_sender.clone();
                    Box::pin(async move {
                        if message.is_string {
                            eprintln!("[Cabinet Edge] Ignoring text controller input message.");
                            return;
                        }

                        let payload = match InputPayload::from_bytes(&message.data) {
                            Ok(payload) => payload,
                            Err(error) => {
                                eprintln!("[Cabinet Edge] Invalid controller input: {error}");
                                return;
                            }
                        };

                        if let Err(error) = input_sender.send(payload).await {
                            eprintln!("[Cabinet Edge] Failed to queue controller input: {error}");
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

        Ok(Self {
            peer_connection,
            video_track,
        })
    }

    /// Sends a video frame sample down the WebRTC stream
    pub async fn send_frame(&self, frame_data: Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
        let sample = Sample {
            data: frame_data.into(),
            duration: std::time::Duration::from_millis(16), // ~60fps frame duration
            ..Default::default()
        };

        self.video_track.write_sample(&sample).await?;
        Ok(())
    }
}
