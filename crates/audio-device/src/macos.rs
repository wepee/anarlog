use std::collections::HashSet;

use cidre::{cf, core_audio as ca, io};

use crate::device::name_suggests_speaker;
use crate::{AudioDevice, AudioDeviceBackend, AudioDirection, DeviceId, Error, TransportType};

pub struct MacOSBackend;

impl MacOSBackend {
    fn ca_transport_to_transport_type(transport: ca::DeviceTransportType) -> TransportType {
        if transport == ca::DeviceTransportType::BUILT_IN {
            TransportType::BuiltIn
        } else if transport == ca::DeviceTransportType::USB {
            TransportType::Usb
        } else if transport == ca::DeviceTransportType::BLUETOOTH
            || transport == ca::DeviceTransportType::BLUETOOTH_LE
        {
            TransportType::Bluetooth
        } else if transport == ca::DeviceTransportType::HDMI
            || transport == ca::DeviceTransportType::DISPLAY_PORT
        {
            TransportType::Hdmi
        } else if transport == ca::DeviceTransportType::PCI {
            TransportType::Pci
        } else if transport == ca::DeviceTransportType::VIRTUAL
            || transport == ca::DeviceTransportType::AGGREGATE
        {
            TransportType::Virtual
        } else {
            TransportType::Unknown
        }
    }

    fn has_streams(device: &ca::Device, scope: ca::PropScope) -> bool {
        let addr = ca::PropSelector::DEVICE_STREAMS.addr(scope, ca::PropElement::MAIN);
        device
            .prop_size(&addr)
            .map(|size| size > 0)
            .unwrap_or(false)
    }

    fn create_audio_device(
        device: &ca::Device,
        direction: AudioDirection,
        default_device_id: Option<u32>,
    ) -> Option<AudioDevice> {
        let scope = match direction {
            AudioDirection::Input => ca::PropScope::INPUT,
            AudioDirection::Output => ca::PropScope::OUTPUT,
        };

        if !Self::has_streams(device, scope) {
            return None;
        }

        let uid = device.uid().ok()?;
        let name = device.name().ok()?;
        let transport_type = device
            .transport_type()
            .map(Self::ca_transport_to_transport_type)
            .unwrap_or(TransportType::Unknown);

        let is_default = default_device_id
            .map(|id| device.0.0 == id)
            .unwrap_or(false);

        let mut audio_device = AudioDevice {
            id: DeviceId::new(uid.to_string()),
            name: name.to_string(),
            direction,
            transport_type,
            is_default,
            volume: None,
            is_muted: None,
        };

        if direction == AudioDirection::Output {
            let volume_addr = ca::PropSelector::DEVICE_VOLUME_SCALAR
                .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);
            if let Ok(volume) = device.prop::<f32>(&volume_addr) {
                audio_device.volume = Some(volume);
            }

            let mute_addr = ca::PropSelector::DEVICE_PROCESS_MUTE
                .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);
            if let Ok(mute_value) = device.prop::<u32>(&mute_addr) {
                audio_device.is_muted = Some(mute_value != 0);
            }
        }

        Some(audio_device)
    }

    fn is_headphone_from_device(device: Option<ca::Device>) -> Option<bool> {
        let device = device?;
        let streams = device.streams().ok()?;

        let detected = streams.iter().any(|s| {
            s.terminal_type().ok().is_some_and(|term_type| {
                term_type == ca::StreamTerminalType::HEADPHONES
                    || term_type == ca::StreamTerminalType::HEADSET_MIC
                    || term_type.0 == io::audio::output_term::HEADPHONES
                    || term_type.0 == io::audio::output_term::HEAD_MOUNTED_DISPLAY_AUDIO
            })
        });

        if detected { Some(true) } else { None }
    }

    fn is_external_from_device(device: Option<ca::Device>) -> bool {
        device
            .and_then(|d| d.transport_type().ok())
            .map(|t| t != ca::DeviceTransportType::BUILT_IN)
            .unwrap_or(false)
    }
}

const TAP_DEVICE_NAME: &str = "anarlog-audio-tap";

const PROCESS_OUTPUT_DEVICES: ca::PropAddr = ca::PropAddr {
    selector: ca::PropSelector::PROCESS_DEVICES,
    scope: ca::PropScope::OUTPUT,
    element: ca::PropElement::MAIN,
};

// Devices other processes are rendering to. Our own playback is skipped: the silence stream that
// keeps the default output awake would otherwise count as speaker output. A process whose pid
// cannot be read is skipped too, since counting ourselves is the worse failure.
fn foreign_running_output_device_ids() -> Result<HashSet<u32>, Error> {
    let self_pid = std::process::id() as i32;
    let processes =
        ca::System::processes().map_err(|e| Error::EnumerationFailed(format!("{:?}", e)))?;

    Ok(processes
        .iter()
        .filter(|process| process.pid().ok().is_some_and(|pid| pid != self_pid))
        .filter(|process| process.is_running_output().unwrap_or(false))
        .filter_map(|process| process.prop_vec::<ca::Device>(&PROCESS_OUTPUT_DEVICES).ok())
        .flatten()
        .map(|device| device.0.0)
        .collect())
}

const PROCESS_INPUT_DEVICES: ca::PropAddr = ca::PropAddr {
    selector: ca::PropSelector::PROCESS_DEVICES,
    scope: ca::PropScope::INPUT,
    element: ca::PropElement::MAIN,
};

// Apple daemons, such as the wake-word listener, can hold the built-in mic with no call going
// on. Among Apple processes only those that host calls count: FaceTime and Safari's web pages.
const APPLE_CALL_PROCESS_PREFIXES: &[&str] = &[
    "com.apple.WebKit",
    "com.apple.Safari",
    "com.apple.FaceTime",
    "com.apple.avconferenced",
    "com.apple.TelephonyUtilities",
];

fn captures_for_a_call(bundle_id: Option<&str>) -> bool {
    match bundle_id {
        Some(id) if id.starts_with("com.apple.") => APPLE_CALL_PROCESS_PREFIXES
            .iter()
            .any(|prefix| id.starts_with(prefix)),
        _ => true,
    }
}

// Mics other processes are capturing from; our own capture is skipped.
fn foreign_running_input_device_ids() -> Result<HashSet<u32>, Error> {
    let self_pid = std::process::id() as i32;
    let processes =
        ca::System::processes().map_err(|e| Error::EnumerationFailed(format!("{:?}", e)))?;

    Ok(processes
        .iter()
        .filter(|process| process.pid().ok().is_some_and(|pid| pid != self_pid))
        .filter(|process| process.is_running_input().unwrap_or(false))
        .filter(|process| {
            let bundle_id = process.bundle_id().ok().map(|id| id.to_string());
            captures_for_a_call(bundle_id.as_deref())
        })
        .filter_map(|process| process.prop_vec::<ca::Device>(&PROCESS_INPUT_DEVICES).ok())
        .flatten()
        .map(|device| device.0.0)
        .collect())
}

impl AudioDeviceBackend for MacOSBackend {
    fn running_input_devices(&self) -> Result<Vec<AudioDevice>, Error> {
        let running = foreign_running_input_device_ids()?;
        let ca_devices =
            ca::System::devices().map_err(|e| Error::EnumerationFailed(format!("{:?}", e)))?;
        let default_input_id = ca::System::default_input_device().ok().map(|d| d.0.0);

        Ok(ca_devices
            .iter()
            .filter(|device| running.contains(&device.0.0))
            .filter(|device| {
                device
                    .name()
                    .map(|name| !name.to_string().contains(TAP_DEVICE_NAME))
                    .unwrap_or(true)
            })
            .filter_map(|device| {
                Self::create_audio_device(device, AudioDirection::Input, default_input_id)
            })
            .collect())
    }

    fn running_output_devices(&self) -> Result<Vec<AudioDevice>, Error> {
        let running = foreign_running_output_device_ids()?;
        let ca_devices =
            ca::System::devices().map_err(|e| Error::EnumerationFailed(format!("{:?}", e)))?;
        let default_output_id = ca::System::default_output_device().ok().map(|d| d.0.0);

        Ok(ca_devices
            .iter()
            .filter(|device| running.contains(&device.0.0))
            .filter(|device| {
                device
                    .name()
                    .map(|name| !name.to_string().contains(TAP_DEVICE_NAME))
                    .unwrap_or(true)
            })
            .filter_map(|device| {
                Self::create_audio_device(device, AudioDirection::Output, default_output_id)
            })
            .collect())
    }

    fn list_devices(&self) -> Result<Vec<AudioDevice>, Error> {
        let ca_devices =
            ca::System::devices().map_err(|e| Error::EnumerationFailed(format!("{:?}", e)))?;

        let default_input_id = ca::System::default_input_device().ok().map(|d| d.0.0);
        let default_output_id = ca::System::default_output_device().ok().map(|d| d.0.0);

        let mut devices = Vec::new();

        for ca_device in ca_devices {
            if let Ok(name) = ca_device.name() {
                if name.to_string().contains(TAP_DEVICE_NAME) {
                    continue;
                }
            }

            if let Some(input_device) =
                Self::create_audio_device(&ca_device, AudioDirection::Input, default_input_id)
            {
                devices.push(input_device);
            }

            if let Some(output_device) =
                Self::create_audio_device(&ca_device, AudioDirection::Output, default_output_id)
            {
                devices.push(output_device);
            }
        }

        Ok(devices)
    }

    fn get_default_input_device(&self) -> Result<Option<AudioDevice>, Error> {
        let ca_device = match ca::System::default_input_device() {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        if ca_device.is_unknown() {
            return Ok(None);
        }

        Ok(Self::create_audio_device(
            &ca_device,
            AudioDirection::Input,
            Some(ca_device.0.0),
        ))
    }

    fn get_default_output_device(&self) -> Result<Option<AudioDevice>, Error> {
        let ca_device = match ca::System::default_output_device() {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        if ca_device.is_unknown() {
            return Ok(None);
        }

        Ok(Self::create_audio_device(
            &ca_device,
            AudioDirection::Output,
            Some(ca_device.0.0),
        ))
    }

    fn set_default_input_device(&self, device_id: &DeviceId) -> Result<(), Error> {
        let uid = cf::String::from_str(device_id.as_str());
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| Error::DeviceNotFound(format!("{}: {:?}", device_id, e)))?;

        if ca_device.is_unknown() {
            return Err(Error::DeviceNotFound(device_id.to_string()));
        }

        ca::System::OBJ
            .set_prop(
                &ca::PropSelector::HW_DEFAULT_INPUT_DEVICE.global_addr(),
                &ca_device.0,
            )
            .map_err(|e| Error::SetDefaultFailed(format!("{:?}", e)))?;

        Ok(())
    }

    fn set_default_output_device(&self, device_id: &DeviceId) -> Result<(), Error> {
        let uid = cf::String::from_str(device_id.as_str());
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| Error::DeviceNotFound(format!("{}: {:?}", device_id, e)))?;

        if ca_device.is_unknown() {
            return Err(Error::DeviceNotFound(device_id.to_string()));
        }

        ca::System::OBJ
            .set_prop(
                &ca::PropSelector::HW_DEFAULT_OUTPUT_DEVICE.global_addr(),
                &ca_device.0,
            )
            .map_err(|e| Error::SetDefaultFailed(format!("{:?}", e)))?;

        Ok(())
    }

    fn is_headphone(&self, device: &AudioDevice) -> bool {
        if device.direction != AudioDirection::Output {
            return false;
        }

        let uid = cf::String::from_str(device.id.as_str());
        if let Ok(ca_device) = ca::Device::with_uid(&uid) {
            if let Some(true) = Self::is_headphone_from_device(Some(ca_device)) {
                return true;
            }
        }

        match device.transport_type {
            TransportType::Bluetooth => !name_suggests_speaker(&device.name),
            TransportType::Usb => {
                let name_lower = device.name.to_lowercase();
                name_lower.contains("headphone")
                    || name_lower.contains("headset")
                    || name_lower.contains("airpod")
                    || name_lower.contains("earbud")
            }
            TransportType::BuiltIn => {
                let name_lower = device.name.to_lowercase();
                name_lower.contains("headphone")
            }
            _ => false,
        }
    }

    fn get_device_volume(&self, device_id: &DeviceId) -> Result<f32, Error> {
        let uid = cf::String::from_str(device_id.as_str());
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| Error::DeviceNotFound(format!("{}: {:?}", device_id, e)))?;

        if ca_device.is_unknown() {
            return Err(Error::DeviceNotFound(device_id.to_string()));
        }

        let addr = ca::PropSelector::DEVICE_VOLUME_SCALAR
            .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);

        ca_device
            .prop(&addr)
            .map_err(|e| Error::AudioSystemError(format!("Failed to get volume: {:?}", e)))
    }

    fn set_device_volume(&self, device_id: &DeviceId, volume: f32) -> Result<(), Error> {
        let volume = volume.clamp(0.0, 1.0);

        let uid = cf::String::from_str(device_id.as_str());
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| Error::DeviceNotFound(format!("{}: {:?}", device_id, e)))?;

        if ca_device.is_unknown() {
            return Err(Error::DeviceNotFound(device_id.to_string()));
        }

        let addr = ca::PropSelector::DEVICE_VOLUME_SCALAR
            .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);

        ca_device
            .set_prop(&addr, &volume)
            .map_err(|e| Error::AudioSystemError(format!("Failed to set volume: {:?}", e)))
    }

    fn is_device_muted(&self, device_id: &DeviceId) -> Result<bool, Error> {
        let uid = cf::String::from_str(device_id.as_str());
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| Error::DeviceNotFound(format!("{}: {:?}", device_id, e)))?;

        if ca_device.is_unknown() {
            return Err(Error::DeviceNotFound(device_id.to_string()));
        }

        let addr = ca::PropSelector::DEVICE_PROCESS_MUTE
            .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);

        let mute_value: u32 = ca_device
            .prop(&addr)
            .map_err(|e| Error::AudioSystemError(format!("Failed to get mute state: {:?}", e)))?;

        Ok(mute_value != 0)
    }

    fn set_device_mute(&self, device_id: &DeviceId, muted: bool) -> Result<(), Error> {
        let uid = cf::String::from_str(device_id.as_str());
        let ca_device = ca::Device::with_uid(&uid)
            .map_err(|e| Error::DeviceNotFound(format!("{}: {:?}", device_id, e)))?;

        if ca_device.is_unknown() {
            return Err(Error::DeviceNotFound(device_id.to_string()));
        }

        let addr = ca::PropSelector::DEVICE_PROCESS_MUTE
            .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN);

        let mute_value: u32 = if muted { 1 } else { 0 };

        ca_device
            .set_prop(&addr, &mute_value)
            .map_err(|e| Error::AudioSystemError(format!("Failed to set mute state: {:?}", e)))
    }
}

pub fn is_headphone_from_default_output_device() -> Option<bool> {
    let device = ca::System::default_output_device().ok();
    MacOSBackend::is_headphone_from_device(device)
}

pub fn is_headphone_from_default_input_device() -> Option<bool> {
    let device = ca::System::default_input_device().ok();
    MacOSBackend::is_headphone_from_device(device)
}

pub fn is_default_input_external() -> bool {
    let device = ca::System::default_input_device().ok();
    MacOSBackend::is_external_from_device(device)
}

pub fn is_default_output_external() -> bool {
    let device = ca::System::default_output_device().ok();
    MacOSBackend::is_external_from_device(device)
}

mod clamshell {
    use std::ffi::{c_char, c_void};

    type CFTypeRef = *const c_void;

    const IO_MAIN_PORT_DEFAULT: u32 = 0;
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: CFTypeRef,
            allocator: CFTypeRef,
            options: u32,
        ) -> CFTypeRef;
        fn IOObjectRelease(object: u32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        fn CFStringCreateWithCString(
            allocator: CFTypeRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
    }

    /// Reads `AppleClamshellState` from the power management root domain. Desktops have no lid
    /// and report nothing, which reads as open.
    pub(crate) fn lid_closed() -> bool {
        unsafe {
            // IOServiceGetMatchingService consumes the matching dictionary.
            let matching = IOServiceMatching(c"IOPMrootDomain".as_ptr());
            if matching.is_null() {
                return false;
            }
            let root_domain = IOServiceGetMatchingService(IO_MAIN_PORT_DEFAULT, matching);
            if root_domain == 0 {
                return false;
            }

            let key = CFStringCreateWithCString(
                std::ptr::null(),
                c"AppleClamshellState".as_ptr(),
                CF_STRING_ENCODING_UTF8,
            );
            let value = if key.is_null() {
                std::ptr::null()
            } else {
                IORegistryEntryCreateCFProperty(root_domain, key, std::ptr::null(), 0)
            };
            if !key.is_null() {
                CFRelease(key);
            }
            IOObjectRelease(root_domain);

            if value.is_null() {
                return false;
            }
            let closed = value == kCFBooleanTrue;
            CFRelease(value);
            closed
        }
    }
}

pub(crate) use clamshell::lid_closed;
