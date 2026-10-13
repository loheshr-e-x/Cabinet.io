use aws_sdk_s3::{config, Client as S3Client};
use std::env;
use std::error::Error;

pub async fn download_rom(object_key: &str) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
    let endpoint = env::var("R2_ENDPOINT")?;
    let access_key = env::var("R2_ACCESS_KEY_ID")?;
    let secret_key = env::var("R2_SECRET_ACCESS_KEY")?;
    let bucket = env::var("R2_BUCKET")?;
    let credentials = config::Credentials::new(access_key, secret_key, None, None, "cloudflare-r2");
    let s3_config = config::Builder::new()
        .behavior_version(config::BehaviorVersion::latest())
        .region(config::Region::new("auto"))
        .credentials_provider(credentials)
        .endpoint_url(endpoint)
        .force_path_style(true)
        .build();
    let response = S3Client::from_conf(s3_config)
        .get_object()
        .bucket(bucket)
        .key(object_key)
        .send()
        .await?;
    let bytes = response.body.collect().await?.into_bytes().to_vec();
    if bytes.is_empty() {
        return Err("R2 ROM object is empty".into());
    }
    Ok(bytes)
}
