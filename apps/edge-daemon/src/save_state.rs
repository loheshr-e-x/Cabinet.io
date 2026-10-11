use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::{config, Client as S3Client};
use lz4::block::{compress, decompress};
use redis::AsyncCommands;
use std::env;
use std::error::Error;

pub struct SaveStateManager {
    redis_client: redis::Client,
    s3_client: S3Client,
    r2_bucket: String,
}

impl SaveStateManager {
    pub fn new(
        redis_url: &str,
        r2_endpoint: &str,
        r2_access_key_id: &str,
        r2_secret_access_key: &str,
        r2_bucket: String,
    ) -> Result<Self, Box<dyn Error>> {
        let redis_client = redis::Client::open(redis_url)?;
        let credentials = config::Credentials::new(
            r2_access_key_id,
            r2_secret_access_key,
            None,
            None,
            "cloudflare-r2",
        );
        let s3_config = config::Builder::new()
            .region(config::Region::new("auto"))
            .credentials_provider(credentials)
            .endpoint_url(r2_endpoint)
            .force_path_style(true)
            .build();

        Ok(Self {
            redis_client,
            s3_client: S3Client::from_conf(s3_config),
            r2_bucket,
        })
    }

    pub fn from_env() -> Result<Option<Self>, Box<dyn Error>> {
        let variables = [
            "REDIS_URL",
            "R2_ENDPOINT",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_BUCKET",
        ];
        let values = variables
            .iter()
            .map(|name| env::var(name).ok())
            .collect::<Vec<_>>();

        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        let mut required = values.into_iter();
        let redis_url = required.next().flatten().ok_or("REDIS_URL is required")?;
        let r2_endpoint = required.next().flatten().ok_or("R2_ENDPOINT is required")?;
        let access_key = required
            .next()
            .flatten()
            .ok_or("R2_ACCESS_KEY_ID is required")?;
        let secret_key = required
            .next()
            .flatten()
            .ok_or("R2_SECRET_ACCESS_KEY is required")?;
        let bucket = required.next().flatten().ok_or("R2_BUCKET is required")?;

        Ok(Some(Self::new(
            &redis_url,
            &r2_endpoint,
            &access_key,
            &secret_key,
            bucket,
        )?))
    }

    pub async fn capture_and_sync_state(
        &self,
        user_id: &str,
        game_id: &str,
        slot_id: u8,
        raw_ram_bytes: &[u8],
    ) -> Result<usize, Box<dyn Error + Send + Sync>> {
        let compressed_payload = compress(raw_ram_bytes, None, false)?;
        let compressed_size = compressed_payload.len();
        let redis_key = format!("save:{user_id}:{game_id}:{slot_id}");
        let mut connection = self.redis_client.get_async_connection().await?;

        let _: () = connection
            .set_ex(&redis_key, &compressed_payload, 3600)
            .await?;
        println!(
            "[Cabinet Save] Hot save stored in Redis: key={redis_key} ({compressed_size} bytes)"
        );

        let s3 = self.s3_client.clone();
        let bucket = self.r2_bucket.clone();
        let object_key = format!("states/{user_id}/{game_id}/slot_{slot_id}.lz4");
        tokio::spawn(async move {
            let result = s3
                .put_object()
                .bucket(bucket)
                .key(&object_key)
                .body(ByteStream::from(compressed_payload))
                .send()
                .await;

            match result {
                Ok(_) => println!("[Cabinet Save] Cold save persisted to R2: key={object_key}"),
                Err(error) => {
                    eprintln!("[Cabinet Save] Failed to persist cold save to R2: {error:?}")
                }
            }
        });

        Ok(compressed_size)
    }

    pub async fn load_and_decompress_state(
        &self,
        user_id: &str,
        game_id: &str,
        slot_id: u8,
        expected_uncompressed_size: usize,
    ) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
        let expected_size = i32::try_from(expected_uncompressed_size)?;
        let redis_key = format!("save:{user_id}:{game_id}:{slot_id}");
        let cached = match self.redis_client.get_async_connection().await {
            Ok(mut connection) => match connection.get(&redis_key).await {
                Ok(cached) => cached,
                Err(error) => {
                    eprintln!(
                        "[Cabinet Save] Redis read failed for key={redis_key}; falling back to R2: {error}"
                    );
                    None
                }
            },
            Err(error) => {
                eprintln!("[Cabinet Save] Redis connection failed; falling back to R2: {error}");
                None
            }
        };

        let compressed_data = match cached {
            Some(data) => {
                println!("[Cabinet Save] Hot cache HIT for key={redis_key}");
                data
            }
            None => {
                println!("[Cabinet Save] Hot cache MISS for key={redis_key}. Pulling from R2...");
                let object_key = format!("states/{user_id}/{game_id}/slot_{slot_id}.lz4");
                let response = self
                    .s3_client
                    .get_object()
                    .bucket(&self.r2_bucket)
                    .key(object_key)
                    .send()
                    .await?;
                response.body.collect().await?.into_bytes().to_vec()
            }
        };

        Ok(decompress(&compressed_data, Some(expected_size))?)
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
}
