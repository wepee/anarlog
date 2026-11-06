use crate::actors::SAMPLE_RATE;

// Digital silence: a working mic always carries some noise above one 16-bit step (~3e-5).
const SILENT_PEAK: f32 = 1e-5;
const SILENT_WINDOW_SAMPLES: usize = SAMPLE_RATE as usize * 15;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum MicSilence {
    Detected,
    Ended,
}

/// Reports a mic that has delivered nothing but digital silence since it opened: a closed
/// laptop's built-in mic, a revoked permission, or a muted interface. Once the mic has been heard
/// it stays quiet, because Bluetooth headsets in call mode gate silence between words.
#[derive(Debug, Default)]
pub(super) struct MicSilenceMonitor {
    silent_samples: usize,
    reported: bool,
    heard: bool,
}

impl MicSilenceMonitor {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    pub(super) fn observe(&mut self, raw_mic: &[f32]) -> Option<MicSilence> {
        if self.heard || raw_mic.is_empty() {
            return None;
        }

        if raw_mic.iter().any(|sample| sample.abs() > SILENT_PEAK) {
            self.heard = true;
            return self.reported.then_some(MicSilence::Ended);
        }

        self.silent_samples += raw_mic.len();
        if !self.reported && self.silent_samples >= SILENT_WINDOW_SAMPLES {
            self.reported = true;
            return Some(MicSilence::Detected);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_silence(monitor: &mut MicSilenceMonitor, samples: usize) -> Vec<MicSilence> {
        let frame = vec![0.0; 1600];
        (0..samples / frame.len())
            .filter_map(|_| monitor.observe(&frame))
            .collect()
    }

    #[test]
    fn reports_a_mic_that_never_delivers_sound_until_it_is_heard() {
        let mut monitor = MicSilenceMonitor::default();
        assert_eq!(
            feed_silence(&mut monitor, SILENT_WINDOW_SAMPLES * 2),
            vec![MicSilence::Detected]
        );
        assert_eq!(monitor.observe(&[0.0, 0.01]), Some(MicSilence::Ended));

        assert!(
            feed_silence(&mut monitor, SILENT_WINDOW_SAMPLES * 2).is_empty(),
            "a mic heard once may go quiet between words"
        );

        monitor.reset();
        assert_eq!(
            feed_silence(&mut monitor, SILENT_WINDOW_SAMPLES),
            vec![MicSilence::Detected],
            "a newly opened mic is watched again"
        );
    }
}
