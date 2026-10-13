mod edge_signaling;
mod emulator;
mod frame_buffer;
mod rom_store;
mod save_state;
mod signaling;
mod webrtc_stream;

use emulator::EmulatorInstance;
use save_state::SaveStateManager;
use std::env;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{interval, interval_at, Instant};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("[Cabinet Edge] Starting Edge Compute Daemon...");

    // 1. Pre-allocate 1920x1080 canvas engine buffers
    let emulator = EmulatorInstance::new(1920, 1080);

    // Railway terminates public TLS and forwards WebSocket traffic to this port.
    let port = env::var("PORT")
        .unwrap_or_else(|_| "8080".to_string())
        .parse::<u16>()?;
    let listener = edge_signaling::bind(port).await?;
    tokio::spawn(async move {
        if let Err(error) = edge_signaling::serve(listener).await {
            eprintln!("[Cabinet Edge] WebSocket listener stopped: {error}");
        }
    });
    println!("[Cabinet Edge] Direct WebRTC signaling listener on 0.0.0.0:{port}.");

    let save_state_manager = SaveStateManager::from_env()?.map(Arc::new);
    let save_identity = match (
        env::var("CABINET_USER_ID").ok(),
        env::var("CABINET_GAME_ID").ok(),
    ) {
        (Some(user_id), Some(game_id)) if !user_id.is_empty() && !game_id.is_empty() => {
            Some((user_id, game_id))
        }
        _ => None,
    };
    let auto_save_enabled = save_state_manager.is_some() && save_identity.is_some();
    if !auto_save_enabled {
        println!(
            "[Cabinet Save] Periodic saves are disabled; configure Redis/R2 and CABINET_USER_ID/CABINET_GAME_ID."
        );
    }
    let save_slot = if auto_save_enabled {
        Some(
            env::var("CABINET_SAVE_SLOT")
                .unwrap_or_else(|_| "0".to_string())
                .parse::<u8>()?,
        )
    } else {
        None
    };

    let mut ticker = interval(Duration::from_micros(16_666));
    let save_interval = Duration::from_secs(5 * 60);
    let mut save_ticker = interval_at(Instant::now() + save_interval, save_interval);

    println!("[Cabinet Edge] Entering input and save-state maintenance loop...");
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            _ = save_ticker.tick(), if auto_save_enabled => {
                match emulator.serialize_state() {
                    Ok(state) => {
                        if let (Some(manager), Some((user_id, game_id)), Some(slot_id)) =
                            (&save_state_manager, &save_identity, save_slot)
                        {
                            let manager = Arc::clone(manager);
                            let user_id = user_id.clone();
                            let game_id = game_id.clone();
                            tokio::spawn(async move {
                                if let Err(error) = manager
                                    .capture_and_sync_state(&user_id, &game_id, slot_id, &state)
                                    .await
                                {
                                    eprintln!("[Cabinet Save] Failed to store save state: {error}");
                                }
                            });
                        }
                    }
                    Err(error) => eprintln!("[Cabinet Save] Auto-save skipped: {error}"),
                }
            }
        }
    }
}
