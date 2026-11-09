#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
type PlatformDetector = macos::Detector;

#[derive(Default)]
pub struct MicDetector {
    inner: PlatformDetector,
}

impl crate::Observer for MicDetector {
    fn start(&mut self, f: crate::DetectCallback) {
        self.inner.start(f);
    }
    fn stop(&mut self) {
        self.inner.stop();
    }
}
