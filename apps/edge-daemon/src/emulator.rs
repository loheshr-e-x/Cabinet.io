use crate::frame_buffer::FrameBuffer;
use std::os::raw::{c_uint, c_void};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy)]
pub struct LibretroSerializer {
    serialize_size: unsafe extern "C" fn() -> usize,
    serialize: unsafe extern "C" fn(*mut c_void, usize) -> bool,
}

impl LibretroSerializer {
    pub fn new(
        serialize_size: unsafe extern "C" fn() -> usize,
        serialize: unsafe extern "C" fn(*mut c_void, usize) -> bool,
    ) -> Self {
        Self {
            serialize_size,
            serialize,
        }
    }
}

pub struct EmulatorInstance {
    frame_buffer: Arc<Mutex<FrameBuffer>>,
    is_running: bool,
    serializer: Option<LibretroSerializer>,
}

impl EmulatorInstance {
    pub fn new(max_width: u32, max_height: u32) -> Self {
        let frame_buffer = Arc::new(Mutex::new(FrameBuffer::new(max_width, max_height, 2048)));

        Self {
            frame_buffer,
            is_running: false,
            serializer: None,
        }
    }

    pub fn set_serializer(&mut self, serializer: LibretroSerializer) {
        self.serializer = Some(serializer);
    }

    pub fn serialize_state(&self) -> Result<Vec<u8>, String> {
        let serializer = self
            .serializer
            .ok_or_else(|| "No loaded Libretro core serializer is attached".to_string())?;
        let size = unsafe { (serializer.serialize_size)() };
        if size == 0 {
            return Err("Libretro core reported a zero-byte save state".to_string());
        }

        let mut state = vec![0; size];
        let serialized =
            unsafe { (serializer.serialize)(state.as_mut_ptr().cast::<c_void>(), state.len()) };
        if !serialized {
            return Err("Libretro core failed to serialize its state".to_string());
        }

        Ok(state)
    }

    pub fn get_frame_buffer(&self) -> Arc<Mutex<FrameBuffer>> {
        Arc::clone(&self.frame_buffer)
    }

    /// Simulates a single emulator frame tick (60Hz loop)
    pub fn step_frame(&mut self) {
        if let Ok(_fb) = self.frame_buffer.lock() {
            // Simulated 60 FPS frame update into zero-allocation buffer
            // In full implementation, libretro calls retro_run() here
        }
    }
}

// Global Libretro C Callbacks (Static pointers for libretro-sys FFI)
pub unsafe extern "C" fn video_refresh_callback(
    data: *const c_void,
    _width: c_uint,
    _height: c_uint,
    _pitch: usize,
) {
    if data.is_null() {
        return;
    }
    // Access pre-allocated buffer without allocation
}

pub unsafe extern "C" fn audio_sample_batch_callback(data: *const i16, frames: usize) -> usize {
    if data.is_null() {
        return 0;
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe extern "C" fn mock_serialize_size() -> usize {
        4
    }

    unsafe extern "C" fn mock_serialize(data: *mut c_void, size: usize) -> bool {
        if data.is_null() || size < 4 {
            return false;
        }
        unsafe {
            std::ptr::copy_nonoverlapping([1, 2, 3, 4].as_ptr(), data.cast::<u8>(), 4);
        }
        true
    }

    #[test]
    fn serializes_state_through_libretro_callbacks() {
        let mut emulator = EmulatorInstance::new(1, 1);
        emulator.set_serializer(LibretroSerializer::new(mock_serialize_size, mock_serialize));

        assert_eq!(emulator.serialize_state().unwrap(), [1, 2, 3, 4]);
    }
}
