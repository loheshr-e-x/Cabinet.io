use crate::frame_buffer::FrameBuffer;
use libloading::Library;
use rust_libretro_sys as libretro;
use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::raw::{c_uint, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type RetroInit = unsafe extern "C" fn();
type RetroDeinit = unsafe extern "C" fn();
type RetroRun = unsafe extern "C" fn();
type RetroGetSystemInfo = unsafe extern "C" fn(*mut libretro::retro_system_info);
type RetroLoadGame = unsafe extern "C" fn(*const libretro::retro_game_info) -> bool;
type RetroUnloadGame = unsafe extern "C" fn();
type RetroSetEnvironment = unsafe extern "C" fn(libretro::retro_environment_t);
type RetroSetVideoRefresh = unsafe extern "C" fn(libretro::retro_video_refresh_t);
type RetroSetAudioSampleBatch = unsafe extern "C" fn(libretro::retro_audio_sample_batch_t);
type RetroSetInputPoll = unsafe extern "C" fn(libretro::retro_input_poll_t);
type RetroSetInputState = unsafe extern "C" fn(libretro::retro_input_state_t);

static ACTIVE_CORE: AtomicBool = AtomicBool::new(false);
static TEMP_ROM_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CALLBACK_FRAME_BUFFER: std::sync::OnceLock<Mutex<Option<Arc<Mutex<FrameBuffer>>>>> =
    std::sync::OnceLock::new();
static CALLBACK_INPUT_STATE: std::sync::OnceLock<Mutex<Option<Arc<Mutex<u16>>>>> =
    std::sync::OnceLock::new();

fn callback_frame_buffer() -> &'static Mutex<Option<Arc<Mutex<FrameBuffer>>>> {
    CALLBACK_FRAME_BUFFER.get_or_init(|| Mutex::new(None))
}

fn callback_input_state() -> &'static Mutex<Option<Arc<Mutex<u16>>>> {
    CALLBACK_INPUT_STATE.get_or_init(|| Mutex::new(None))
}

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
    library: Option<Library>,
    core_run: Option<RetroRun>,
    core_unload_game: Option<RetroUnloadGame>,
    core_deinit: Option<RetroDeinit>,
    rom: Vec<u8>,
    game_path: Option<CString>,
    temporary_rom_path: Option<PathBuf>,
    owns_active_core: bool,
    serializer: Option<LibretroSerializer>,
}

impl EmulatorInstance {
    pub fn new(max_width: u32, max_height: u32) -> Self {
        let frame_buffer = Arc::new(Mutex::new(FrameBuffer::new(max_width, max_height, 2048)));

        Self {
            frame_buffer,
            library: None,
            core_run: None,
            core_unload_game: None,
            core_deinit: None,
            rom: Vec::new(),
            game_path: None,
            temporary_rom_path: None,
            owns_active_core: false,
            serializer: None,
        }
    }

    pub fn load_core(
        core_path: &Path,
        rom: Vec<u8>,
        input_state: Arc<Mutex<u16>>,
        max_width: u32,
        max_height: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        if rom.is_empty() {
            return Err("cannot load an empty ROM".into());
        }
        if ACTIVE_CORE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("the edge daemon supports one active Libretro core at a time".into());
        }

        let result = Self::load_core_inner(core_path, rom, input_state, max_width, max_height);
        if result.is_err() {
            ACTIVE_CORE.store(false, Ordering::Release);
        }
        result
    }

    fn load_core_inner(
        core_path: &Path,
        rom: Vec<u8>,
        input_state: Arc<Mutex<u16>>,
        max_width: u32,
        max_height: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let library = unsafe { Library::new(core_path)? };
        let retro_init = unsafe { *library.get::<RetroInit>(b"retro_init\0")? };
        let retro_deinit = unsafe { *library.get::<RetroDeinit>(b"retro_deinit\0")? };
        let retro_run = unsafe { *library.get::<RetroRun>(b"retro_run\0")? };
        let retro_get_system_info =
            unsafe { *library.get::<RetroGetSystemInfo>(b"retro_get_system_info\0")? };
        let retro_load_game = unsafe { *library.get::<RetroLoadGame>(b"retro_load_game\0")? };
        let retro_unload_game = unsafe { *library.get::<RetroUnloadGame>(b"retro_unload_game\0")? };
        let set_environment =
            unsafe { *library.get::<RetroSetEnvironment>(b"retro_set_environment\0")? };
        let set_video_refresh =
            unsafe { *library.get::<RetroSetVideoRefresh>(b"retro_set_video_refresh\0")? };
        let set_audio_sample_batch =
            unsafe { *library.get::<RetroSetAudioSampleBatch>(b"retro_set_audio_sample_batch\0")? };
        let set_input_poll =
            unsafe { *library.get::<RetroSetInputPoll>(b"retro_set_input_poll\0")? };
        let set_input_state =
            unsafe { *library.get::<RetroSetInputState>(b"retro_set_input_state\0")? };

        let virtual_game_path = CString::new("game.nes")?;
        let mut system_info = libretro::retro_system_info {
            library_name: std::ptr::null(),
            library_version: std::ptr::null(),
            valid_extensions: std::ptr::null(),
            need_fullpath: false,
            block_extract: false,
        };
        unsafe { retro_get_system_info(&mut system_info) };
        let temporary_rom_path = if system_info.need_fullpath {
            Some(write_temporary_rom(&rom)?)
        } else {
            None
        };
        let game_path = match temporary_rom_path.as_ref() {
            Some(path) => CString::new(path.to_string_lossy().as_bytes())?,
            None => virtual_game_path,
        };

        let frame_buffer = Arc::new(Mutex::new(FrameBuffer::new(max_width, max_height, 2048)));
        {
            let mut target = callback_frame_buffer()
                .lock()
                .map_err(|_| "Libretro video callback lock poisoned")?;
            *target = Some(Arc::clone(&frame_buffer));
        }
        {
            let mut target = callback_input_state()
                .lock()
                .map_err(|_| "Libretro input callback lock poisoned")?;
            *target = Some(Arc::clone(&input_state));
        }

        unsafe {
            set_environment(Some(environment_callback));
            set_video_refresh(Some(video_refresh_callback));
            set_audio_sample_batch(Some(audio_sample_batch_callback));
            set_input_poll(Some(input_poll_callback));
            set_input_state(Some(input_state_callback));
            retro_init();
        }

        let game = libretro::retro_game_info {
            path: game_path.as_ptr(),
            data: if temporary_rom_path.is_some() {
                std::ptr::null()
            } else {
                rom.as_ptr().cast::<c_void>()
            },
            size: if temporary_rom_path.is_some() {
                0
            } else {
                rom.len()
            },
            meta: std::ptr::null(),
        };
        if !unsafe { retro_load_game(&game) } {
            unsafe { retro_deinit() };
            if let Ok(mut target) = callback_frame_buffer().lock() {
                *target = None;
            }
            if let Ok(mut target) = callback_input_state().lock() {
                *target = None;
            }
            if let Some(path) = &temporary_rom_path {
                let _ = fs::remove_file(path);
            }
            return Err(format!(
                "Libretro core rejected ROM {game_path:?} ({} bytes, need_fullpath={})",
                rom.len(),
                system_info.need_fullpath
            )
            .into());
        }

        let serializer = unsafe {
            match (
                library.get::<unsafe extern "C" fn() -> usize>(b"retro_serialize_size\0"),
                library
                    .get::<unsafe extern "C" fn(*mut c_void, usize) -> bool>(b"retro_serialize\0"),
            ) {
                (Ok(size), Ok(serialize)) => Some(LibretroSerializer::new(*size, *serialize)),
                _ => None,
            }
        };

        Ok(Self {
            frame_buffer,
            library: Some(library),
            core_run: Some(retro_run),
            core_unload_game: Some(retro_unload_game),
            core_deinit: Some(retro_deinit),
            rom,
            game_path: Some(game_path),
            temporary_rom_path,
            owns_active_core: true,
            serializer,
        })
    }

    #[cfg(test)]
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

    pub fn step_frame(&mut self) {
        if let Some(run) = self.core_run {
            unsafe { run() };
        }
    }
}

impl Drop for EmulatorInstance {
    fn drop(&mut self) {
        if let Some(unload) = self.core_unload_game.take() {
            unsafe { unload() };
        }
        if let Some(deinit) = self.core_deinit.take() {
            unsafe { deinit() };
        }
        self.core_run = None;
        self.library.take();
        self.rom.clear();
        self.game_path.take();
        if let Some(path) = self.temporary_rom_path.take() {
            if let Err(error) = fs::remove_file(path) {
                eprintln!("[Cabinet Edge] Failed to remove temporary ROM file: {error}");
            }
        }

        if self.owns_active_core {
            if let Ok(mut target) = callback_frame_buffer().lock() {
                *target = None;
            }
            if let Ok(mut target) = callback_input_state().lock() {
                *target = None;
            }
            ACTIVE_CORE.store(false, Ordering::Release);
        }
    }
}

fn write_temporary_rom(rom: &[u8]) -> Result<PathBuf, std::io::Error> {
    let temp_dir = std::env::temp_dir();
    for _ in 0..10 {
        let sequence = TEMP_ROM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = temp_dir.join(format!(
            "cabinet-edge-{}-{sequence}.nes",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                if let Err(error) = file.write_all(rom) {
                    let _ = fs::remove_file(&path);
                    return Err(error);
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a unique temporary ROM path",
    ))
}

unsafe extern "C" fn environment_callback(command: c_uint, data: *mut c_void) -> bool {
    if command == libretro::RETRO_ENVIRONMENT_SET_PIXEL_FORMAT && !data.is_null() {
        let requested_format = unsafe { *(data.cast::<u32>()) };
        return requested_format
            == libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32;
    }
    false
}

pub unsafe extern "C" fn video_refresh_callback(
    data: *const c_void,
    width: c_uint,
    height: c_uint,
    pitch: usize,
) {
    if data.is_null() {
        return;
    }
    let Some(source_len) = pitch.checked_mul(height as usize) else {
        return;
    };
    let source = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), source_len) };
    let Ok(target) = callback_frame_buffer().lock() else {
        return;
    };
    if let Some(frame_buffer) = target.as_ref() {
        if let Ok(mut frame_buffer) = frame_buffer.lock() {
            if let Err(error) = frame_buffer.update_video(source, width, height, pitch) {
                eprintln!("[Cabinet Edge] Dropping invalid Libretro frame: {error}");
            }
        }
    }
}

pub unsafe extern "C" fn audio_sample_batch_callback(data: *const i16, frames: usize) -> usize {
    if data.is_null() {
        return 0;
    }
    frames
}

unsafe extern "C" fn input_poll_callback() {}

unsafe extern "C" fn input_state_callback(
    port: c_uint,
    device: c_uint,
    _index: c_uint,
    id: c_uint,
) -> i16 {
    if port != 0 || device != libretro::RETRO_DEVICE_JOYPAD || id > 15 {
        return 0;
    }
    let Ok(target) = callback_input_state().lock() else {
        return 0;
    };
    let Some(input_state) = target.as_ref() else {
        return 0;
    };
    let Ok(input_state) = input_state.lock() else {
        return 0;
    };
    i16::from(*input_state & (1 << id) != 0)
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

    #[test]
    fn video_callback_copies_valid_frame_into_shared_buffer() {
        let frame_buffer = Arc::new(Mutex::new(FrameBuffer::new(2, 2, 1)));
        *callback_frame_buffer().lock().unwrap() = Some(Arc::clone(&frame_buffer));
        let frame = [1_u8, 2, 3, 4, 5, 6, 7, 8];

        unsafe {
            video_refresh_callback(frame.as_ptr().cast(), 2, 1, 8);
        }

        let captured = frame_buffer.lock().unwrap();
        assert_eq!(captured.width, 2);
        assert_eq!(captured.height, 1);
        assert_eq!(captured.frame_number, 1);
        assert_eq!(&captured.video_buffer[..8], &frame);
        *callback_frame_buffer().lock().unwrap() = None;
    }

    #[test]
    fn input_callback_reports_retropad_bits_from_shared_mask() {
        let input_state = Arc::new(Mutex::new(1 << libretro::RETRO_DEVICE_ID_JOYPAD_A));
        *callback_input_state().lock().unwrap() = Some(Arc::clone(&input_state));

        let pressed = unsafe {
            input_state_callback(
                0,
                libretro::RETRO_DEVICE_JOYPAD,
                0,
                libretro::RETRO_DEVICE_ID_JOYPAD_A,
            )
        };
        let released = unsafe {
            input_state_callback(
                0,
                libretro::RETRO_DEVICE_JOYPAD,
                0,
                libretro::RETRO_DEVICE_ID_JOYPAD_B,
            )
        };
        let unsupported_port =
            unsafe { input_state_callback(1, libretro::RETRO_DEVICE_JOYPAD, 0, 8) };

        assert_eq!(pressed, 1);
        assert_eq!(released, 0);
        assert_eq!(unsupported_port, 0);
        *callback_input_state().lock().unwrap() = None;
    }

    #[test]
    fn writes_fullpath_rom_to_a_nes_named_temporary_file() {
        let rom = [1_u8, 2, 3, 4];
        let path = write_temporary_rom(&rom).unwrap();

        assert_eq!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("nes")
        );
        assert_eq!(fs::read(&path).unwrap(), rom);
        fs::remove_file(path).unwrap();
    }
}
