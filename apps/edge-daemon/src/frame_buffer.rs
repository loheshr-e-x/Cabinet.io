#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PixelFormat {
    Xrgb8888,
    Rgb565,
    Rgb1555,
}

impl PixelFormat {
    pub fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Xrgb8888 => 4,
            Self::Rgb565 | Self::Rgb1555 => 2,
        }
    }
}

/// Pre-allocated double buffer for audio and video frames.
/// Eliminates runtime allocation overhead and GC stutters.
pub struct FrameBuffer {
    pub video_buffer: Vec<u8>,
    pub audio_buffer: Vec<i16>,
    pub width: u32,
    pub height: u32,
    pub pitch: usize,
    pub frame_number: u64,
    audio_len: usize,
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
            audio_len: 0,
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
        pixel_format: PixelFormat,
    ) -> Result<(), &'static str> {
        let input_pixel_bytes = pixel_format.bytes_per_pixel();
        let input_row_bytes = usize::try_from(width)
            .ok()
            .and_then(|width| width.checked_mul(input_pixel_bytes))
            .ok_or("invalid frame width")?;
        let output_row_bytes = usize::try_from(width)
            .ok()
            .and_then(|width| width.checked_mul(4))
            .ok_or("invalid frame width")?;
        let required_bytes = (height as usize)
            .checked_sub(1)
            .and_then(|last_row| pitch.checked_mul(last_row))
            .and_then(|last_row_start| last_row_start.checked_add(input_row_bytes))
            .ok_or("invalid frame size")?;
        if width == 0
            || height == 0
            || width > self.max_width
            || height > self.max_height
            || pitch < input_row_bytes
            || required_bytes > src_data.len()
            || output_row_bytes
                .checked_mul(height as usize)
                .is_none_or(|size| size > self.video_buffer.len())
        {
            return Err("frame dimensions, pitch, or source length are invalid");
        }

        for row in 0..height as usize {
            let src_start = row * pitch;
            let dst_start = row * output_row_bytes;
            match pixel_format {
                PixelFormat::Xrgb8888 => self.video_buffer[dst_start..dst_start + output_row_bytes]
                    .copy_from_slice(&src_data[src_start..src_start + input_row_bytes]),
                PixelFormat::Rgb565 | PixelFormat::Rgb1555 => {
                    for column in 0..width as usize {
                        let pixel_start = src_start + column * 2;
                        let pixel =
                            u16::from_le_bytes([src_data[pixel_start], src_data[pixel_start + 1]]);
                        let (red, green, blue) = match pixel_format {
                            PixelFormat::Rgb565 => (
                                scale_component((pixel >> 11) & 0x1f, 31),
                                scale_component((pixel >> 5) & 0x3f, 63),
                                scale_component(pixel & 0x1f, 31),
                            ),
                            PixelFormat::Rgb1555 => (
                                scale_component((pixel >> 10) & 0x1f, 31),
                                scale_component((pixel >> 5) & 0x1f, 31),
                                scale_component(pixel & 0x1f, 31),
                            ),
                            PixelFormat::Xrgb8888 => unreachable!(),
                        };
                        let output_start = dst_start + column * 4;
                        self.video_buffer[output_start..output_start + 4]
                            .copy_from_slice(&[blue, green, red, 0]);
                    }
                }
            }
        }
        self.width = width;
        self.height = height;
        self.pitch = output_row_bytes;
        self.frame_number = self.frame_number.wrapping_add(1);
        Ok(())
    }

    pub fn append_audio(&mut self, samples: &[i16]) -> usize {
        let len = samples
            .len()
            .min(self.audio_buffer.len().saturating_sub(self.audio_len));
        let stereo_len = len - len % 2;
        self.audio_buffer[self.audio_len..self.audio_len + stereo_len]
            .copy_from_slice(&samples[..stereo_len]);
        self.audio_len += stereo_len;
        stereo_len / 2
    }

    pub fn copy_audio_into(&mut self, destination: &mut Vec<i16>) {
        destination.clear();
        destination.extend_from_slice(&self.audio_buffer[..self.audio_len]);
        self.audio_len = 0;
    }
}

fn scale_component(component: u16, max_component: u16) -> u8 {
    (u32::from(component) * 255 / u32::from(max_component)) as u8
}

#[cfg(test)]
mod tests {
    use super::{FrameBuffer, PixelFormat};

    #[test]
    fn converts_padded_rgb565_rows_to_xrgb8888() {
        let mut buffer = FrameBuffer::new(2, 2, 1);
        let source = [
            0x00, 0xf8, 0xe0, 0x07, 0xaa, 0xaa, // Red, green, row padding
            0x1f, 0x00, 0xff, 0xff, 0xbb, 0xbb, // Blue, white, row padding
        ];

        buffer
            .update_video(&source, 2, 2, 6, PixelFormat::Rgb565)
            .unwrap();

        assert_eq!(
            &buffer.video_buffer[..16],
            &[0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]
        );
        assert_eq!(buffer.pitch, 8);
    }

    #[test]
    fn copies_padded_xrgb8888_rows_without_copying_padding() {
        let mut buffer = FrameBuffer::new(1, 2, 1);
        let source = [1, 2, 3, 4, 0xaa, 0xaa, 0xaa, 0xaa, 5, 6, 7, 8];

        buffer
            .update_video(&source, 1, 2, 8, PixelFormat::Xrgb8888)
            .unwrap();

        assert_eq!(&buffer.video_buffer[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn accumulates_and_drains_bounded_stereo_audio_samples() {
        let mut buffer = FrameBuffer::new(1, 1, 2);
        assert_eq!(buffer.append_audio(&[10, -10, 20, -20, 30, -30]), 2);
        let mut output = Vec::with_capacity(4);

        buffer.copy_audio_into(&mut output);
        assert_eq!(output, [10, -10, 20, -20]);
        buffer.copy_audio_into(&mut output);
        assert!(output.is_empty());
    }
}
