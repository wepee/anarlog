#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
type PlatformDetector = macos::Detector;

#[derive(Default)]
pub struct AppDetector {
    inner: PlatformDetector,
}

impl crate::Observer for AppDetector {
    fn start(&mut self, f: crate::DetectCallback) {
        self.inner.start(f);
    }
    fn stop(&mut self) {
        self.inner.stop();
    }
}
