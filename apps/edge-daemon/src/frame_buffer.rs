/// Pre-allocated double buffer for audio and video frames.
/// Eliminates runtime allocation overhead and GC stutters.
pub struct FrameBuffer {
    pub video_buffer: Vec<u8>,
    pub audio_buffer: Vec<i16>,
    pub width: u32,
    pub height: u32,
    pub pitch: usize,
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
        }
    }

    /// Blit incoming core raw video frame directly into pre-allocated memory
    pub fn update_video(&mut self, src_data: &[u8], width: u32, height: u32, pitch: usize) {
        self.width = width;
        self.height = height;
        self.pitch = pitch;

        let bytes_to_copy = (pitch * height as usize).min(self.video_buffer.len());
        self.video_buffer[..bytes_to_copy].copy_from_slice(&src_data[..bytes_to_copy]);
    }

    /// Copy incoming audio samples into pre-allocated memory
    pub fn update_audio(&mut self, samples: &[i16]) {
        let len = samples.len().min(self.audio_buffer.len());
        self.audio_buffer[..len].copy_from_slice(&samples[..len]);
    }
}
