use crate::frame_buffer::FrameBuffer;
use crate::frame_buffer::PixelFormat;
use libloading::Library;
use rust_libretro_sys as libretro;
use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::raw::{c_uint, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type RetroInit = unsafe extern "C" fn();
type RetroDeinit = unsafe extern "C" fn();
type RetroRun = unsafe extern "C" fn();
type RetroGetSystemInfo = unsafe extern "C" fn(*mut libretro::retro_system_info);
type RetroGetSystemAvInfo = unsafe extern "C" fn(*mut libretro::retro_system_av_info);
type RetroLoadGame = unsafe extern "C" fn(*const libretro::retro_game_info) -> bool;
type RetroUnloadGame = unsafe extern "C" fn();
type RetroSetEnvironment = unsafe extern "C" fn(libretro::retro_environment_t);
type RetroSetVideoRefresh = unsafe extern "C" fn(libretro::retro_video_refresh_t);
type RetroSetAudioSampleBatch = unsafe extern "C" fn(libretro::retro_audio_sample_batch_t);
type RetroSetAudioSample = unsafe extern "C" fn(libretro::retro_audio_sample_t);
type RetroSetInputPoll = unsafe extern "C" fn(libretro::retro_input_poll_t);
type RetroSetInputState = unsafe extern "C" fn(libretro::retro_input_state_t);
type RetroSerializeSize = unsafe extern "C" fn() -> usize;
type RetroSerialize = unsafe extern "C" fn(*mut c_void, usize) -> bool;
type RetroUnserialize = unsafe extern "C" fn(*const c_void, usize) -> bool;

static ACTIVE_CORE: AtomicBool = AtomicBool::new(false);
static TEMP_ROM_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CALLBACK_PIXEL_FORMAT: AtomicU32 =
    AtomicU32::new(libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32);
const MAX_VIDEO_WIDTH: usize = 1920;
const MAX_VIDEO_HEIGHT: usize = 1080;
const MAX_VIDEO_PITCH: usize = MAX_VIDEO_WIDTH * 4;
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
    serialize_size: RetroSerializeSize,
    serialize: RetroSerialize,
    unserialize: Option<RetroUnserialize>,
}

impl LibretroSerializer {
    pub fn new(
        serialize_size: RetroSerializeSize,
        serialize: RetroSerialize,
        unserialize: Option<RetroUnserialize>,
    ) -> Self {
        Self {
            serialize_size,
            serialize,
            unserialize,
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
    audio_sample_rate: u32,
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
            audio_sample_rate: 32_000,
        }
    }

    pub fn load_core(
        core_path: &Path,
        system_core: &str,
        rom_key: &str,
        session_id: &str,
        rom: Vec<u8>,
        input_state: Arc<Mutex<u16>>,
        max_width: u32,
        max_height: u32,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let core_path = resolve_core_path(core_path, system_core)?;
        if rom.is_empty() {
            return Err("cannot load an empty ROM".into());
        }
        if ACTIVE_CORE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("the edge daemon supports one active Libretro core at a time".into());
        }

        let result = Self::load_core_inner(
            &core_path,
            rom_key,
            session_id,
            rom,
            input_state,
            max_width,
            max_height,
        );
        if result.is_err() {
            ACTIVE_CORE.store(false, Ordering::Release);
        }
        result
    }

    fn load_core_inner(
        core_path: &Path,
        rom_key: &str,
        session_id: &str,
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
        let retro_get_system_av_info =
            unsafe { *library.get::<RetroGetSystemAvInfo>(b"retro_get_system_av_info\0")? };
        let retro_load_game = unsafe { *library.get::<RetroLoadGame>(b"retro_load_game\0")? };
        let retro_unload_game = unsafe { *library.get::<RetroUnloadGame>(b"retro_unload_game\0")? };
        let set_environment =
            unsafe { *library.get::<RetroSetEnvironment>(b"retro_set_environment\0")? };
        let set_video_refresh =
            unsafe { *library.get::<RetroSetVideoRefresh>(b"retro_set_video_refresh\0")? };
        let set_audio_sample_batch =
            unsafe { *library.get::<RetroSetAudioSampleBatch>(b"retro_set_audio_sample_batch\0")? };
        let set_audio_sample =
            unsafe { *library.get::<RetroSetAudioSample>(b"retro_set_audio_sample\0")? };
        let set_input_poll =
            unsafe { *library.get::<RetroSetInputPoll>(b"retro_set_input_poll\0")? };
        let set_input_state =
            unsafe { *library.get::<RetroSetInputState>(b"retro_set_input_state\0")? };

        let extension = rom_file_extension(rom_key)?;
        let virtual_game_path = CString::new(format!("game.{extension}"))?;
        let mut system_info = libretro::retro_system_info {
            library_name: std::ptr::null(),
            library_version: std::ptr::null(),
            valid_extensions: std::ptr::null(),
            need_fullpath: false,
            block_extract: false,
        };
        unsafe { retro_get_system_info(&mut system_info) };
        let temporary_rom_path = if system_info.need_fullpath {
            Some(write_temporary_rom(&rom, session_id, &extension)?)
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
            CALLBACK_PIXEL_FORMAT.store(
                libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32,
                Ordering::Release,
            );
            set_environment(Some(environment_callback));
            set_video_refresh(Some(video_refresh_callback));
            set_audio_sample_batch(Some(audio_sample_batch_callback));
            set_audio_sample(Some(audio_sample_callback));
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
        let mut av_info: libretro::retro_system_av_info = unsafe { std::mem::zeroed() };
        unsafe { retro_get_system_av_info(&mut av_info) };
        let audio_sample_rate = if av_info.timing.sample_rate.is_finite()
            && (8_000.0..=192_000.0).contains(&av_info.timing.sample_rate)
        {
            av_info.timing.sample_rate.round() as u32
        } else {
            32_000
        };

        let serializer = unsafe {
            match (
                library.get::<RetroSerializeSize>(b"retro_serialize_size\0"),
                library.get::<RetroSerialize>(b"retro_serialize\0"),
            ) {
                (Ok(size), Ok(serialize)) => {
                    let unserialize = library
                        .get::<RetroUnserialize>(b"retro_unserialize\0")
                        .ok()
                        .map(|function| *function);
                    Some(LibretroSerializer::new(*size, *serialize, unserialize))
                }
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
            audio_sample_rate,
        })
    }

    #[cfg(test)]
    pub fn set_serializer(&mut self, serializer: LibretroSerializer) {
        self.serializer = Some(serializer);
    }

    pub fn save_state(&self) -> Result<Vec<u8>, String> {
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

    pub fn load_state(&self, state: &[u8]) -> Result<(), String> {
        let serializer = self
            .serializer
            .ok_or_else(|| "No loaded Libretro core serializer is attached".to_string())?;
        let unserialize = serializer.unserialize.ok_or_else(|| {
            "The loaded Libretro core does not support loading save states".to_string()
        })?;
        if state.is_empty() {
            return Err("Cannot load an empty save state".to_string());
        }
        let expected_size = unsafe { (serializer.serialize_size)() };
        if state.len() != expected_size {
            return Err(format!(
                "Save state size mismatch: expected {expected_size} bytes, got {}",
                state.len()
            ));
        }

        if unsafe { unserialize(state.as_ptr().cast::<c_void>(), state.len()) } {
            Ok(())
        } else {
            Err("Libretro core rejected the save state".to_string())
        }
    }

    pub fn get_frame_buffer(&self) -> Arc<Mutex<FrameBuffer>> {
        Arc::clone(&self.frame_buffer)
    }

    pub fn audio_sample_rate(&self) -> u32 {
        self.audio_sample_rate
    }

    pub fn step_frame(&mut self) {
        if let Some(run) = self.core_run {
            unsafe { run() };
        }
    }

    pub fn unload_core(&mut self) {
        if !self.owns_active_core {
            return;
        }

        if let Some(unload) = self.core_unload_game.take() {
            unsafe { unload() };
        }
        if let Some(deinit) = self.core_deinit.take() {
            unsafe { deinit() };
        }
        self.core_run = None;
        self.serializer = None;
        self.library.take();
        self.rom.clear();
        self.game_path.take();
        if let Some(path) = self.temporary_rom_path.take() {
            if let Err(error) = fs::remove_file(path) {
                eprintln!("[Cabinet Edge] Failed to remove temporary ROM file: {error}");
            }
        }

        if let Ok(mut target) = callback_frame_buffer().lock() {
            *target = None;
        }
        if let Ok(mut target) = callback_input_state().lock() {
            *target = None;
        }
        self.owns_active_core = false;
        ACTIVE_CORE.store(false, Ordering::Release);
    }
}

impl Drop for EmulatorInstance {
    fn drop(&mut self) {
        self.unload_core();
    }
}

fn resolve_core_path(
    configured_path: &Path,
    system_core: &str,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let library_name = match system_core.trim().to_ascii_lowercase().as_str() {
        "fceumm" => "fceumm_libretro.so",
        "snes9x" => "snes9x_libretro.so",
        "mgba" => "mgba_libretro.so",
        core => return Err(format!("unsupported Libretro system core '{core}'").into()),
    };
    let core_directory = std::env::var_os("LIBRETRO_CORE_DIR")
        .map(PathBuf::from)
        .or_else(|| configured_path.parent().map(Path::to_path_buf))
        .ok_or("LIBRETRO_CORE_PATH must have a parent directory")?;
    Ok(core_directory.join(library_name))
}

fn rom_file_extension(rom_key: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let extension = Path::new(rom_key)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| {
            !extension.is_empty()
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .ok_or_else(|| format!("ROM key '{rom_key}' has no valid file extension"))?;
    Ok(extension.to_ascii_lowercase())
}

fn write_temporary_rom(
    rom: &[u8],
    session_id: &str,
    extension: &str,
) -> Result<PathBuf, std::io::Error> {
    let temp_dir = std::env::temp_dir();
    let safe_session_id = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    for _ in 0..10 {
        let sequence = TEMP_ROM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = temp_dir.join(format!(
            "cabinet-edge-{safe_session_id}-{}-{sequence}.{extension}",
            std::process::id(),
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
        let pixel_format = if requested_format
            == libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32
        {
            PixelFormat::Xrgb8888
        } else if requested_format == libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_RGB565 as u32
        {
            PixelFormat::Rgb565
        } else if requested_format
            == libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_0RGB1555 as u32
        {
            PixelFormat::Rgb1555
        } else {
            return false;
        };
        CALLBACK_PIXEL_FORMAT.store(pixel_format_to_libretro(pixel_format), Ordering::Release);
        return true;
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
    let pixel_format = pixel_format_from_libretro(CALLBACK_PIXEL_FORMAT.load(Ordering::Acquire));
    let Some(pixel_format) = pixel_format else {
        eprintln!("[Cabinet Edge] Dropping Libretro frame with unsupported pixel format.");
        return;
    };
    let input_row_bytes = (width as usize).checked_mul(pixel_format.bytes_per_pixel());
    let Some(input_row_bytes) = input_row_bytes else {
        eprintln!("[Cabinet Edge] Dropping Libretro frame with invalid row width.");
        return;
    };
    if width == 0
        || height == 0
        || width as usize > MAX_VIDEO_WIDTH
        || height as usize > MAX_VIDEO_HEIGHT
        || pitch < input_row_bytes
        || pitch > MAX_VIDEO_PITCH
    {
        eprintln!("[Cabinet Edge] Dropping Libretro frame with invalid dimensions or pitch.");
        return;
    }
    let Some(source_len) = pitch
        .checked_mul(height as usize - 1)
        .and_then(|last_row_start| last_row_start.checked_add(input_row_bytes))
    else {
        return;
    };
    let source = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), source_len) };
    let Ok(target) = callback_frame_buffer().lock() else {
        return;
    };
    if let Some(frame_buffer) = target.as_ref() {
        if let Ok(mut frame_buffer) = frame_buffer.lock() {
            if let Err(error) =
                frame_buffer.update_video(source, width, height, pitch, pixel_format)
            {
                eprintln!("[Cabinet Edge] Dropping invalid Libretro frame: {error}");
            }
        }
    }
}

fn pixel_format_to_libretro(format: PixelFormat) -> u32 {
    match format {
        PixelFormat::Xrgb8888 => libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32,
        PixelFormat::Rgb565 => libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_RGB565 as u32,
        PixelFormat::Rgb1555 => libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_0RGB1555 as u32,
    }
}

fn pixel_format_from_libretro(format: u32) -> Option<PixelFormat> {
    if format == pixel_format_to_libretro(PixelFormat::Xrgb8888) {
        Some(PixelFormat::Xrgb8888)
    } else if format == pixel_format_to_libretro(PixelFormat::Rgb565) {
        Some(PixelFormat::Rgb565)
    } else if format == pixel_format_to_libretro(PixelFormat::Rgb1555) {
        Some(PixelFormat::Rgb1555)
    } else {
        None
    }
}

pub unsafe extern "C" fn audio_sample_batch_callback(data: *const i16, frames: usize) -> usize {
    if data.is_null() {
        return 0;
    }
    let Some(sample_count) = frames.checked_mul(2) else {
        return 0;
    };
    let samples = unsafe { std::slice::from_raw_parts(data, sample_count) };
    let Ok(target) = callback_frame_buffer().lock() else {
        return 0;
    };
    let Some(frame_buffer) = target.as_ref() else {
        return 0;
    };
    let Ok(mut frame_buffer) = frame_buffer.lock() else {
        return 0;
    };
    frame_buffer.append_audio(samples)
}

pub unsafe extern "C" fn audio_sample_callback(left: i16, right: i16) {
    let Ok(target) = callback_frame_buffer().lock() else {
        return;
    };
    let Some(frame_buffer) = target.as_ref().cloned() else {
        return;
    };
    drop(target);
    if let Ok(mut frame_buffer) = frame_buffer.lock() {
        frame_buffer.append_audio(&[left, right]);
    };
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

    unsafe extern "C" fn mock_unserialize(data: *const c_void, size: usize) -> bool {
        !data.is_null() && size == 4
    }

    #[test]
    fn serializes_state_through_libretro_callbacks() {
        let mut emulator = EmulatorInstance::new(1, 1);
        emulator.set_serializer(LibretroSerializer::new(
            mock_serialize_size,
            mock_serialize,
            Some(mock_unserialize),
        ));

        assert_eq!(emulator.save_state().unwrap(), [1, 2, 3, 4]);
    }

    #[test]
    fn loads_state_through_libretro_callback_and_rejects_wrong_sizes() {
        let mut emulator = EmulatorInstance::new(1, 1);
        emulator.set_serializer(LibretroSerializer::new(
            mock_serialize_size,
            mock_serialize,
            Some(mock_unserialize),
        ));

        assert!(emulator.load_state(&[1, 2, 3, 4]).is_ok());
        assert!(emulator.load_state(&[1, 2]).is_err());
        assert!(emulator.load_state(&[]).is_err());
    }

    #[test]
    fn explicitly_unloading_core_releases_active_core_lock_idempotently() {
        ACTIVE_CORE.store(true, Ordering::Release);
        let mut emulator = EmulatorInstance::new(1, 1);
        emulator.owns_active_core = true;

        emulator.unload_core();
        assert!(!ACTIVE_CORE.load(Ordering::Acquire));

        emulator.unload_core();
        assert!(!ACTIVE_CORE.load(Ordering::Acquire));
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
    fn audio_batch_callback_copies_stereo_samples_into_shared_buffer() {
        let frame_buffer = Arc::new(Mutex::new(FrameBuffer::new(1, 1, 4)));
        *callback_frame_buffer().lock().unwrap() = Some(Arc::clone(&frame_buffer));
        let samples = [100_i16, -100, 200, -200];

        let consumed = unsafe { audio_sample_batch_callback(samples.as_ptr(), 2) };
        let mut captured = Vec::new();
        frame_buffer.lock().unwrap().copy_audio_into(&mut captured);

        assert_eq!(consumed, 2);
        assert_eq!(captured, samples);
        *callback_frame_buffer().lock().unwrap() = None;
    }

    #[test]
    fn negotiates_xrgb8888_rgb565_and_0rgb1555_formats() {
        for (requested, expected) in [
            (
                libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32,
                PixelFormat::Xrgb8888,
            ),
            (
                libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_RGB565 as u32,
                PixelFormat::Rgb565,
            ),
            (
                libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_0RGB1555 as u32,
                PixelFormat::Rgb1555,
            ),
        ] {
            let mut requested = requested;
            let accepted = unsafe {
                environment_callback(
                    libretro::RETRO_ENVIRONMENT_SET_PIXEL_FORMAT,
                    (&mut requested as *mut u32).cast(),
                )
            };

            assert!(accepted);
            assert_eq!(
                pixel_format_from_libretro(CALLBACK_PIXEL_FORMAT.load(Ordering::Acquire)),
                Some(expected)
            );
        }

        CALLBACK_PIXEL_FORMAT.store(
            libretro::retro_pixel_format::RETRO_PIXEL_FORMAT_XRGB8888 as u32,
            Ordering::Release,
        );
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
    fn writes_fullpath_rom_with_the_source_extension_and_session_id() {
        let rom = [1_u8, 2, 3, 4];
        for extension in ["nes", "sfc", "gba"] {
            let path = write_temporary_rom(&rom, "session-test", extension).unwrap();

            assert_eq!(
                path.extension().and_then(|extension| extension.to_str()),
                Some(extension)
            );
            assert!(path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains("session-test"));
            assert_eq!(fs::read(&path).unwrap(), rom);
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn selects_core_library_from_system_core() {
        let configured_path = Path::new("/usr/lib/libretro/fceumm_libretro.so");

        assert_eq!(
            resolve_core_path(configured_path, "fceumm").unwrap(),
            Path::new("/usr/lib/libretro/fceumm_libretro.so")
        );
        assert_eq!(
            resolve_core_path(configured_path, "snes9x").unwrap(),
            Path::new("/usr/lib/libretro/snes9x_libretro.so")
        );
        assert_eq!(
            resolve_core_path(configured_path, "mgba").unwrap(),
            Path::new("/usr/lib/libretro/mgba_libretro.so")
        );
        assert!(resolve_core_path(configured_path, "unknown").is_err());
    }

    #[test]
    fn reads_rom_extension_from_r2_key() {
        assert_eq!(rom_file_extension("roms/game.sfc").unwrap(), "sfc");
        assert_eq!(rom_file_extension("roms/game.gba").unwrap(), "gba");
        assert!(rom_file_extension("roms/game").is_err());
    }
}
