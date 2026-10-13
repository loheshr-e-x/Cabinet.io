use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::{config, Client as S3Client};
use lz4::block::{compress, decompress};
use postgres_native_tls::MakeTlsConnector;
use redis::AsyncCommands;
use std::env;
use std::error::Error;
use tokio_postgres::types::ToSql;

pub struct SaveStateManager {
    redis_client: Option<redis::Client>,
    s3_client: S3Client,
    r2_bucket: String,
    database_url: String,
}

impl SaveStateManager {
    pub fn new(
        r2_endpoint: &str,
        r2_access_key_id: &str,
        r2_secret_access_key: &str,
        r2_bucket: String,
        database_url: String,
        redis_url: Option<&str>,
    ) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let redis_client = redis_url.map(redis::Client::open).transpose()?;
        let credentials = config::Credentials::new(
            r2_access_key_id,
            r2_secret_access_key,
            None,
            None,
            "cloudflare-r2",
        );
        let s3_config = config::Builder::new()
            .behavior_version(config::BehaviorVersion::latest())
            .region(config::Region::new("auto"))
            .credentials_provider(credentials)
            .endpoint_url(r2_endpoint)
            .force_path_style(true)
            .build();

        Ok(Self {
            redis_client,
            s3_client: S3Client::from_conf(s3_config),
            r2_bucket,
            database_url,
        })
    }

    pub fn from_env() -> Result<Option<Self>, Box<dyn Error + Send + Sync>> {
        let r2_endpoint = env::var("R2_ENDPOINT").ok();
        let access_key = env::var("R2_ACCESS_KEY_ID").ok();
        let secret_key = env::var("R2_SECRET_ACCESS_KEY").ok();
        let bucket = env::var("R2_BUCKET").ok();
        let database_url = env::var("DATABASE_URL").ok();
        let redis_url = env::var("REDIS_URL").ok();

        let Some(database_url) = database_url else {
            return Ok(None);
        };

        let r2_endpoint = r2_endpoint.ok_or("R2_ENDPOINT is required")?;
        let access_key = access_key.ok_or("R2_ACCESS_KEY_ID is required")?;
        let secret_key = secret_key.ok_or("R2_SECRET_ACCESS_KEY is required")?;
        let bucket = bucket.ok_or("R2_BUCKET is required")?;

        Ok(Some(Self::new(
            &r2_endpoint,
            &access_key,
            &secret_key,
            bucket,
            database_url,
            redis_url.as_deref(),
        )?))
    }

    pub async fn capture_and_sync_state(
        &self,
        user_id: &str,
        game_id: &str,
        slot_id: u8,
        raw_ram_bytes: &[u8],
    ) -> Result<usize, Box<dyn Error + Send + Sync>> {
        if user_id.is_empty() || game_id.is_empty() {
            eprintln!(
                "[Cabinet Save] Skipping save-state persistence because user_id or game_id is empty."
            );
            return Err("user_id and game_id are required to persist a save state".into());
        }

        let size = i32::try_from(raw_ram_bytes.len())?;
        let object_key = save_state_object_key(user_id, game_id, slot_id);
        self.s3_client
            .put_object()
            .bucket(&self.r2_bucket)
            .key(&object_key)
            .body(ByteStream::from(raw_ram_bytes.to_vec()))
            .send()
            .await?;

        let tls = MakeTlsConnector::new(native_tls::TlsConnector::new()?);
        let (client, connection) = tokio_postgres::connect(&self.database_url, tls).await?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                eprintln!("[Cabinet Save] PostgreSQL connection error: {error}");
            }
        });
        client
            .execute(
                "
                    INSERT INTO save_states
                        (user_id, game_id, slot_id, r2_object_key, byte_size, updated_at)
                    VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id, game_id, slot_id)
                    DO UPDATE SET
                        r2_object_key = EXCLUDED.r2_object_key,
                        byte_size = EXCLUDED.byte_size,
                        updated_at = CURRENT_TIMESTAMP
                ",
                &[
                    &user_id as &(dyn ToSql + Sync),
                    &game_id as &(dyn ToSql + Sync),
                    &i32::from(slot_id),
                    &object_key,
                    &size,
                ],
            )
            .await?;

        if let Some(redis_client) = &self.redis_client {
            match compress(raw_ram_bytes, None, false) {
                Ok(compressed_payload) => {
                    let redis_key = format!("save:{user_id}:{game_id}:{slot_id}");
                    match redis_client.get_async_connection().await {
                        Ok(mut connection) => {
                            if let Err(error) = connection
                                .set_ex::<_, _, ()>(&redis_key, compressed_payload, 3600)
                                .await
                            {
                                eprintln!("[Cabinet Save] Redis cache write failed: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("[Cabinet Save] Redis cache connection failed: {error}");
                        }
                    }
                }
                Err(error) => {
                    eprintln!(
                        "[Cabinet Save] Could not compress optional Redis cache value: {error}"
                    );
                }
            }
        }
        println!("[Cabinet Save] State persisted to R2: key={object_key} ({size} bytes)");
        Ok(raw_ram_bytes.len())
    }

    pub async fn load_state(
        &self,
        user_id: &str,
        game_id: &str,
        slot_id: u8,
    ) -> Result<Option<Vec<u8>>, Box<dyn Error + Send + Sync>> {
        if user_id.is_empty() || game_id.is_empty() {
            eprintln!(
                "[Cabinet Save] Skipping save-state metadata lookup because user_id or game_id is empty."
            );
            return Ok(None);
        }

        let tls = MakeTlsConnector::new(native_tls::TlsConnector::new()?);
        let (client, connection) = tokio_postgres::connect(&self.database_url, tls).await?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                eprintln!("[Cabinet Save] PostgreSQL connection error: {error}");
            }
        });
        let record = client
            .query_opt(
                "
                    SELECT r2_object_key, byte_size
                    FROM save_states
                    WHERE user_id = $1::text::uuid AND game_id = $2::text::uuid AND slot_id = $3
                ",
                &[
                    &user_id as &(dyn ToSql + Sync),
                    &game_id as &(dyn ToSql + Sync),
                    &i32::from(slot_id),
                ],
            )
            .await?;
        let Some(record) = record else {
            return Ok(None);
        };
        let object_key: String = record.get(0);
        let stored_size = usize::try_from(record.get::<_, i32>(1))?;

        let response = self
            .s3_client
            .get_object()
            .bucket(&self.r2_bucket)
            .key(&object_key)
            .send()
            .await?;
        let data = response.body.collect().await?.into_bytes().to_vec();
        if data.len() != stored_size {
            return Err(format!(
                "Save state object size mismatch: metadata records {stored_size} bytes, got {}",
                data.len()
            )
            .into());
        }
        Ok(Some(data))
    }
}

fn save_state_object_key(user_id: &str, game_id: &str, slot_id: u8) -> String {
    if slot_id == 0 {
        format!("saves/{user_id}/{game_id}.state")
    } else {
        format!("saves/{user_id}/{game_id}/slot_{slot_id}.state")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lz4_state_payload_round_trips() {
        let raw_state = b"libretro save state";
        let compressed = compress(raw_state, None, false).unwrap();
        let restored = decompress(&compressed, Some(raw_state.len() as i32)).unwrap();

        assert_eq!(restored, raw_state);
    }

    #[test]
    fn default_slot_uses_user_game_state_key() {
        assert_eq!(
            save_state_object_key("user-id", "game-id", 0),
            "saves/user-id/game-id.state"
        );
        assert_eq!(
            save_state_object_key("user-id", "game-id", 2),
            "saves/user-id/game-id/slot_2.state"
        );
    }
}
