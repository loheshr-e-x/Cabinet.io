/// Pre-allocated double buffer for audio and video frames.
/// Eliminates runtime allocation overhead and GC stutters.
pub struct FrameBuffer {
    pub video_buffer: Vec<u8>,
    pub audio_buffer: Vec<i16>,
    pub width: u32,
    pub height: u32,
    pub pitch: usize,
    pub frame_number: u64,
    max_width: u32,
    max_height: u32,
}

impl FrameBuffer {
    pub fn new(max_width: u32, max_height: u32, max_audio_samples: usize) -> Self {
        // 4 bytes per pixel for 32-bit RGBA
        let video_size = (max_width * max_height * 4) as usize;
        let audio_size = max_audio_samples * 2; // Stereo samples

        Self {
            video_buffer: vec![0u8; video_size],
            audio_buffer: vec![0i16; audio_size],
            width: max_width,
            height: max_height,
            pitch: (max_width * 4) as usize,
            frame_number: 0,
            max_width,
            max_height,
        }
    }

    pub fn update_video(
        &mut self,
        src_data: &[u8],
        width: u32,
        height: u32,
        pitch: usize,
    ) -> Result<(), &'static str> {
        let row_bytes = usize::try_from(width)
            .ok()
            .and_then(|width| width.checked_mul(4))
            .ok_or("invalid frame width")?;
        let required_bytes = pitch
            .checked_mul(height as usize)
            .ok_or("invalid frame size")?;
        if width == 0
            || height == 0
            || width > self.max_width
            || height > self.max_height
            || pitch < row_bytes
            || required_bytes > src_data.len()
        {
            return Err("frame dimensions, pitch, or source length are invalid");
        }

        for row in 0..height as usize {
            let src_start = row * pitch;
            let dst_start = row * row_bytes;
            self.video_buffer[dst_start..dst_start + row_bytes]
                .copy_from_slice(&src_data[src_start..src_start + row_bytes]);
        }
        self.width = width;
        self.height = height;
        self.pitch = row_bytes;
        self.frame_number = self.frame_number.wrapping_add(1);
        Ok(())
    }

    /// Copy incoming audio samples into pre-allocated memory
    pub fn update_audio(&mut self, samples: &[i16]) {
        let len = samples.len().min(self.audio_buffer.len());
        self.audio_buffer[..len].copy_from_slice(&samples[..len]);
    }
}
