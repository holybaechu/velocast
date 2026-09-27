use crate::{AudioClip, AudioEnvelopePoint, AudioPlan};

const MAX_JS_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSampleRounding {
    Floor,
    Ceil,
    Round,
}

fn safe_unsigned(value: u64, name: &str) -> Result<(), String> {
    if value > MAX_JS_INTEGER as u64 {
        return Err(format!(
            "audio.invalid_plan: {name} exceeds the JavaScript safe integer range"
        ));
    }
    Ok(())
}

/// Matches core framesToSamples for the wire's integer fps: nearest half ties
/// toward positive infinity. Arithmetic is exact in i128 before quantization.
pub fn audio_frames_to_samples(
    frame: i64,
    fps: u64,
    sample_rate: u64,
    rounding: AudioSampleRounding,
) -> Result<i64, String> {
    if !(-MAX_JS_INTEGER..=MAX_JS_INTEGER).contains(&frame) {
        return Err("audio.invalid_plan: frame must be a safe integer".to_owned());
    }
    safe_unsigned(fps, "fps")?;
    safe_unsigned(sample_rate, "sampleRate")?;
    if fps == 0 || sample_rate == 0 {
        return Err("audio.invalid_plan: fps and sampleRate must be positive".to_owned());
    }
    let numerator = i128::from(frame) * i128::from(sample_rate);
    let denominator = i128::from(fps);
    let mut quotient = numerator / denominator;
    let remainder = numerator % denominator;
    match rounding {
        AudioSampleRounding::Floor if remainder < 0 => quotient -= 1,
        AudioSampleRounding::Ceil if remainder > 0 => quotient += 1,
        AudioSampleRounding::Round if remainder > 0 && remainder * 2 >= denominator => {
            quotient += 1
        }
        AudioSampleRounding::Round if remainder < 0 && -remainder * 2 > denominator => {
            quotient -= 1
        }
        _ => {}
    }
    if !(-i128::from(MAX_JS_INTEGER)..=i128::from(MAX_JS_INTEGER)).contains(&quotient) {
        return Err(
            "audio.invalid_plan: converted sample position exceeds the safe integer range"
                .to_owned(),
        );
    }
    Ok(quotient as i64)
}

impl AudioPlan {
    pub fn validate(&self) -> Result<(), String> {
        safe_unsigned(self.sample_rate, "sampleRate")?;
        safe_unsigned(self.duration_samples, "durationSamples")?;
        if self.sample_rate == 0 {
            return Err("audio.invalid_plan: sampleRate must be positive".to_owned());
        }
        for clip in &self.clips {
            if clip.source.trim().is_empty()
                || clip.source.chars().any(|c| matches!(c, '\0' | '\r' | '\n'))
            {
                return Err(
                    "audio.invalid_plan: source must be nonempty without NUL/newlines".to_owned(),
                );
            }
            if !(-MAX_JS_INTEGER..=MAX_JS_INTEGER).contains(&clip.start_sample) {
                return Err("audio.invalid_plan: startSample must be a safe integer".to_owned());
            }
            safe_unsigned(clip.source_start_sample, "sourceStartSample")?;
            safe_unsigned(clip.duration_samples, "clip durationSamples")?;
            let output_end = i128::from(clip.start_sample) + i128::from(clip.duration_samples);
            if !(-i128::from(MAX_JS_INTEGER)..=i128::from(MAX_JS_INTEGER)).contains(&output_end) {
                return Err(
                    "audio.invalid_plan: clip output end exceeds the safe integer range".to_owned(),
                );
            }
            if u128::from(clip.source_start_sample) + u128::from(clip.duration_samples)
                > MAX_JS_INTEGER as u128
            {
                return Err(
                    "audio.invalid_plan: clip source end exceeds the safe integer range".to_owned(),
                );
            }
            if let Some(points) = &clip.volume_envelope {
                if points.is_empty() || points.len() > 10000 {
                    return Err(
                        "audio.invalid_plan: volumeEnvelope must contain 1 to 10000 points"
                            .to_owned(),
                    );
                }
                let mut previous = None;
                for point in points {
                    if point.sample > clip.duration_samples
                        || previous.is_some_and(|p| point.sample <= p)
                        || !point.gain.is_finite()
                        || point.gain < 0.0
                    {
                        return Err(
                            "audio.invalid_plan: invalid envelope sample or gain".to_owned()
                        );
                    }
                    previous = Some(point.sample);
                }
            }
            if !clip.gain.is_finite() || clip.gain < 0.0 {
                return Err("audio.invalid_plan: gain must be finite and nonnegative".to_owned());
            }
        }
        Ok(())
    }

    /// Half-open sample slice, rebased to zero. Preroll advances source trim;
    /// muted/outside clips disappear. No gain normalization or limiter is applied.
    pub fn slice_samples(&self, start: u64, end: u64) -> Result<Self, String> {
        self.validate()?;
        if start > end || end > self.duration_samples {
            return Err(
                "audio.invalid_range: sample slice must be within the plan with start <= end"
                    .to_owned(),
            );
        }
        let mut clips = Vec::new();
        for clip in &self.clips {
            let first = i128::from(start).max(i128::from(clip.start_sample));
            let last = i128::from(end)
                .min(i128::from(clip.start_sample) + i128::from(clip.duration_samples));
            if first >= last || clip.gain == 0.0 {
                continue;
            }
            clips.push(AudioClip {
                source: clip.source.clone(),
                start_sample: (first - i128::from(start)) as i64,
                source_start_sample: (i128::from(clip.source_start_sample) + first
                    - i128::from(clip.start_sample)) as u64,
                duration_samples: (last - first) as u64,
                gain: clip.gain,
                volume_envelope: clip.volume_envelope.as_ref().map(|points| {
                    slice_envelope(
                        points,
                        (first - i128::from(clip.start_sample)) as u64,
                        (last - i128::from(clip.start_sample)) as u64,
                    )
                }),
            });
        }
        let plan = Self {
            sample_rate: self.sample_rate,
            duration_samples: end - start,
            clips,
        };
        plan.validate()?;
        Ok(plan)
    }

    pub fn normalized(&self) -> Result<Self, String> {
        self.slice_samples(0, self.duration_samples)
    }

    pub fn slice_frames(
        &self,
        start: i64,
        end: i64,
        fps: u64,
        rounding: AudioSampleRounding,
    ) -> Result<Self, String> {
        if start < 0 || end < start {
            return Err("audio.invalid_range: frame slice requires 0 <= start <= end".to_owned());
        }
        let first = audio_frames_to_samples(start, fps, self.sample_rate, rounding)?;
        let last = audio_frames_to_samples(end, fps, self.sample_rate, rounding)?;
        self.slice_samples(first as u64, last as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_plan_normalization_and_slicing_cover_sample_boundaries() {
        let preroll = AudioPlan {
            sample_rate: 48_000,
            duration_samples: 10,
            clips: vec![AudioClip {
                source: "song.wav".to_owned(),
                start_sample: -2,
                source_start_sample: 4,
                duration_samples: 10,
                gain: 0.5,
                volume_envelope: None,
            }],
        };
        let normalized = preroll.normalized().unwrap();
        assert_eq!(normalized.clips[0].start_sample, 0);
        assert_eq!(normalized.clips[0].source_start_sample, 6);
        assert_eq!(normalized.clips[0].duration_samples, 8);
        assert_eq!(normalized.normalized().unwrap(), normalized);

        let partial = preroll.slice_samples(3, 9).unwrap();
        assert_eq!(partial.duration_samples, 6);
        assert_eq!(partial.clips[0].start_sample, 0);
        assert_eq!(partial.clips[0].source_start_sample, 9);
        assert_eq!(partial.clips[0].duration_samples, 5);

        let empty = preroll.slice_samples(5, 5).unwrap();
        assert_eq!(empty.duration_samples, 0);
        assert!(empty.clips.is_empty());

        let frame_plan = AudioPlan {
            sample_rate: 44_100,
            duration_samples: 44_100,
            clips: vec![AudioClip {
                source: "song.wav".to_owned(),
                start_sample: 0,
                source_start_sample: 0,
                duration_samples: 44_100,
                gain: 1.0,
                volume_envelope: None,
            }],
        };
        let frame_slice = frame_plan
            .slice_frames(1, 2, 24, AudioSampleRounding::Round)
            .unwrap();
        assert_eq!(frame_slice.duration_samples, 1_837);
        assert_eq!(frame_slice.clips[0].source_start_sample, 1_838);
        assert_eq!(frame_slice.clips[0].duration_samples, 1_837);

        let envelope_plan = AudioPlan {
            sample_rate: 48_000,
            duration_samples: 200,
            clips: vec![AudioClip {
                source: "voice.wav".to_owned(),
                start_sample: -10,
                source_start_sample: 4,
                duration_samples: 160,
                gain: 0.5,
                volume_envelope: Some(vec![
                    AudioEnvelopePoint {
                        sample: 0,
                        gain: 0.0,
                    },
                    AudioEnvelopePoint {
                        sample: 40,
                        gain: 1.0,
                    },
                    AudioEnvelopePoint {
                        sample: 80,
                        gain: 0.25,
                    },
                    AudioEnvelopePoint {
                        sample: 120,
                        gain: 1.0,
                    },
                    AudioEnvelopePoint {
                        sample: 160,
                        gain: 0.0,
                    },
                ]),
            }],
        };
        let envelope_slice = envelope_plan.slice_samples(10, 90).unwrap();
        assert_eq!(envelope_slice.duration_samples, 80);
        assert_eq!(envelope_slice.clips[0].source_start_sample, 24);
        assert_eq!(
            envelope_slice.clips[0].volume_envelope.as_ref().unwrap(),
            &vec![
                AudioEnvelopePoint {
                    sample: 0,
                    gain: 0.5
                },
                AudioEnvelopePoint {
                    sample: 20,
                    gain: 1.0
                },
                AudioEnvelopePoint {
                    sample: 60,
                    gain: 0.25
                },
                AudioEnvelopePoint {
                    sample: 80,
                    gain: 0.625
                },
            ]
        );
    }

    #[test]
    fn native_rounding_is_signed_and_overflow_checked() {
        assert_eq!(
            audio_frames_to_samples(1, 24, 44100, AudioSampleRounding::Floor).unwrap(),
            1837
        );
        assert_eq!(
            audio_frames_to_samples(1, 24, 44100, AudioSampleRounding::Round).unwrap(),
            1838
        );
        assert_eq!(
            audio_frames_to_samples(-1, 24, 44100, AudioSampleRounding::Round).unwrap(),
            -1837
        );
        assert_eq!(
            audio_frames_to_samples(-1, 24, 44100, AudioSampleRounding::Floor).unwrap(),
            -1838
        );
        assert_eq!(
            audio_frames_to_samples(-1, 24, 44100, AudioSampleRounding::Ceil).unwrap(),
            -1837
        );
        assert_eq!(
            audio_frames_to_samples(MAX_JS_INTEGER, 60, 60, AudioSampleRounding::Round).unwrap(),
            MAX_JS_INTEGER
        );
        assert!(audio_frames_to_samples(MAX_JS_INTEGER, 1, 2, AudioSampleRounding::Round).is_err());
        assert!(audio_frames_to_samples(1, 0, 48000, AudioSampleRounding::Round).is_err());
    }

    #[test]
    fn rejects_invalid_and_unsafe_audio_data_before_use() {
        let clip = AudioClip {
            source: "song.wav".to_owned(),
            start_sample: 0,
            source_start_sample: 0,
            duration_samples: 10,
            gain: 1.0,
            volume_envelope: None,
        };
        let plan = AudioPlan {
            sample_rate: 48000,
            duration_samples: 10,
            clips: vec![clip.clone()],
        };
        for gain in [f64::NAN, f64::INFINITY, -1.0] {
            let mut bad = plan.clone();
            bad.clips[0].gain = gain;
            assert!(bad.validate().is_err());
        }
        for source in ["", " ", "a\0b", "a\nb"] {
            let mut bad = plan.clone();
            bad.clips[0].source = source.to_owned();
            assert!(bad.validate().is_err());
        }
        let mut bad = plan.clone();
        bad.clips[0].start_sample = i64::MIN;
        assert!(bad.validate().is_err());
        let mut bad = plan.clone();
        bad.clips[0].source_start_sample = MAX_JS_INTEGER as u64;
        assert!(bad.validate().is_err());
        let mut bad = plan.clone();
        bad.clips[0].start_sample = MAX_JS_INTEGER;
        assert!(bad.validate().is_err());
        let mut bad = plan.clone();
        bad.sample_rate = 0;
        assert!(bad.validate().is_err());
        let mut bad = plan.clone();
        bad.duration_samples = u64::MAX;
        assert!(bad.validate().is_err());
        assert!(plan.slice_samples(0, 11).is_err());
        assert!(plan.slice_samples(5, 4).is_err());
        assert!(plan
            .slice_frames(-1, 1, 60, AudioSampleRounding::Round)
            .is_err());
        assert!(serde_json::from_str::<AudioPlan>(
            r#"{"sampleRate":48000,"durationSamples":-1,"clips":[]}"#
        )
        .is_err());
        assert!(serde_json::from_str::<AudioClip>(
            r#"{"source":"a","startSample":0.5,"sourceStartSample":0,"durationSamples":1,"gain":1}"#
        )
        .is_err());
    }
}

fn envelope_gain(points: &[AudioEnvelopePoint], sample: u64) -> f64 {
    if sample <= points[0].sample {
        return points[0].gain;
    }
    for pair in points.windows(2) {
        let (left, right) = (&pair[0], &pair[1]);
        if sample <= right.sample {
            return left.gain
                + (right.gain - left.gain)
                    * ((sample - left.sample) as f64 / (right.sample - left.sample) as f64);
        }
    }
    points.last().unwrap().gain
}
fn slice_envelope(points: &[AudioEnvelopePoint], start: u64, end: u64) -> Vec<AudioEnvelopePoint> {
    let mut result = vec![AudioEnvelopePoint {
        sample: 0,
        gain: envelope_gain(points, start),
    }];
    result.extend(
        points
            .iter()
            .filter(|point| point.sample > start && point.sample < end)
            .map(|point| AudioEnvelopePoint {
                sample: point.sample - start,
                gain: point.gain,
            }),
    );
    if end > start {
        result.push(AudioEnvelopePoint {
            sample: end - start,
            gain: envelope_gain(points, end),
        });
    }
    result
}
