use std::num::NonZeroU32;

use velocast_protocol::RendererConcurrency;

const AUTO_CONCURRENCY_CAP: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameRange {
    pub start: u32,
    pub end: u32,
}

impl FrameRange {
    pub fn new(start: u32, end: u32) -> Self {
        debug_assert!(start <= end, "frame range start must not exceed end");

        Self { start, end }
    }

    pub fn frames(self) -> std::ops::Range<u32> {
        self.start..self.end
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StridedFrameAssignment {
    pub start: u32,
    pub end: u32,
    pub step: NonZeroU32,
}

impl StridedFrameAssignment {
    pub fn frames(self) -> impl Iterator<Item = u32> {
        (self.start..self.end).step_by(self.step.get() as usize)
    }
}

pub fn available_parallelism() -> u32 {
    std::thread::available_parallelism()
        .map(|workers| workers.get() as u32)
        .unwrap_or(1)
}

/// Resolves worker count. Explicit worker requests are treated as user overrides
/// and may exceed detected host parallelism; `available_workers` is only used
/// for `Auto` and default resolution.
pub fn resolve_effective_concurrency(
    requested: Option<&RendererConcurrency>,
    max_concurrency: Option<NonZeroU32>,
    available_workers: u32,
    duration_frames: u32,
) -> u32 {
    let requested_workers = match requested {
        Some(RendererConcurrency::Workers(workers)) => workers.get(),
        Some(RendererConcurrency::Auto) | None => available_workers.min(AUTO_CONCURRENCY_CAP),
    };

    let capped_by_manifest = max_concurrency
        .map(NonZeroU32::get)
        .map_or(requested_workers, |max| requested_workers.min(max));

    capped_by_manifest.max(1).min(duration_frames.max(1))
}

#[allow(dead_code)]
pub fn chunk_frame_ranges(duration_frames: u32, concurrency: u32) -> Vec<FrameRange> {
    if duration_frames == 0 {
        return Vec::new();
    }

    let chunk_count = concurrency.max(1).min(duration_frames);
    let base = duration_frames / chunk_count;
    let remainder = duration_frames % chunk_count;
    let mut start = 0;
    let mut ranges = Vec::with_capacity(chunk_count as usize);

    for index in 0..chunk_count {
        let extra = u32::from(index < remainder);
        let end = start + base + extra;
        ranges.push(FrameRange::new(start, end));
        start = end;
    }

    ranges
}

pub fn strided_frame_assignments(
    duration_frames: u32,
    concurrency: u32,
) -> Vec<StridedFrameAssignment> {
    if duration_frames == 0 {
        return Vec::new();
    }

    let worker_count = concurrency.max(1).min(duration_frames);
    let step = NonZeroU32::new(worker_count).expect("worker count is at least one");

    (0..worker_count)
        .map(|start| StridedFrameAssignment {
            start,
            end: duration_frames,
            step,
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct FrameSchedule {
    next: u32,
    end: u32,
}

impl FrameSchedule {
    pub fn new(duration_frames: u32) -> Self {
        Self {
            next: 0,
            end: duration_frames,
        }
    }
}

impl Iterator for FrameSchedule {
    type Item = u32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.end {
            return None;
        }

        let frame = self.next;
        self.next += 1;
        Some(frame)
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU32;

    use super::*;
    use velocast_protocol::RendererConcurrency;

    #[test]
    fn schedules_frames_from_zero_to_duration_exclusive() {
        let frames: Vec<u32> = FrameSchedule::new(4).collect();

        assert_eq!(frames, vec![0, 1, 2, 3]);
    }

    #[test]
    fn schedules_no_frames_for_zero_duration() {
        let frames: Vec<u32> = FrameSchedule::new(0).collect();

        assert!(frames.is_empty());
    }

    #[test]
    fn frame_range_reports_length_and_frames() {
        let range = FrameRange::new(4, 7);

        assert_eq!(range.frames().collect::<Vec<_>>(), vec![4, 5, 6]);
    }

    #[test]
    fn available_parallelism_returns_at_least_one_worker() {
        assert!(available_parallelism() >= 1);
    }

    #[test]
    fn splits_frames_into_even_ranges() {
        let ranges = chunk_frame_ranges(240, 4);

        assert_eq!(
            ranges,
            vec![
                FrameRange::new(0, 60),
                FrameRange::new(60, 120),
                FrameRange::new(120, 180),
                FrameRange::new(180, 240),
            ]
        );
    }

    #[test]
    fn gives_earlier_ranges_one_extra_frame_when_needed() {
        let ranges = chunk_frame_ranges(10, 3);

        assert_eq!(
            ranges,
            vec![
                FrameRange::new(0, 4),
                FrameRange::new(4, 7),
                FrameRange::new(7, 10),
            ]
        );
    }

    #[test]
    fn does_not_create_empty_ranges() {
        let ranges = chunk_frame_ranges(2, 4);

        assert_eq!(ranges, vec![FrameRange::new(0, 1), FrameRange::new(1, 2)]);
    }

    #[test]
    fn chunks_zero_duration_as_no_ranges() {
        assert!(chunk_frame_ranges(0, 4).is_empty());
    }

    #[test]
    fn treats_zero_concurrency_as_one_chunk() {
        assert_eq!(chunk_frame_ranges(3, 0), vec![FrameRange::new(0, 3)]);
    }

    #[test]
    fn chunk_ranges_cover_duration_without_gaps_or_overlap() {
        let ranges = chunk_frame_ranges(11, 4);

        assert_eq!(ranges.first().map(|range| range.start), Some(0));
        assert_eq!(ranges.last().map(|range| range.end), Some(11));

        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
            assert!(pair[0].start < pair[0].end);
        }
        assert!(ranges.last().is_some_and(|range| range.start < range.end));
    }

    #[test]
    fn builds_strided_assignments_for_streaming_workers() {
        let assignments = strided_frame_assignments(5, 2);

        assert_eq!(
            assignments,
            vec![
                StridedFrameAssignment {
                    start: 0,
                    end: 5,
                    step: NonZeroU32::new(2).unwrap(),
                },
                StridedFrameAssignment {
                    start: 1,
                    end: 5,
                    step: NonZeroU32::new(2).unwrap(),
                },
            ]
        );
    }

    #[test]
    fn strided_assignments_do_not_create_empty_workers() {
        let assignments = strided_frame_assignments(2, 4);

        assert_eq!(
            assignments,
            vec![
                StridedFrameAssignment {
                    start: 0,
                    end: 2,
                    step: NonZeroU32::new(2).unwrap(),
                },
                StridedFrameAssignment {
                    start: 1,
                    end: 2,
                    step: NonZeroU32::new(2).unwrap(),
                },
            ]
        );
    }

    #[test]
    fn strided_assignment_iterates_assigned_absolute_frames() {
        let frames: Vec<_> = StridedFrameAssignment {
            start: 1,
            end: 7,
            step: NonZeroU32::new(3).unwrap(),
        }
        .frames()
        .collect();

        assert_eq!(frames, vec![1, 4]);
    }

    #[test]
    fn resolves_fixed_concurrency_with_manifest_cap() {
        let resolved = resolve_effective_concurrency(
            Some(&RendererConcurrency::Workers(NonZeroU32::new(8).unwrap())),
            NonZeroU32::new(4),
            16,
            240,
        );

        assert_eq!(resolved, 4);
    }

    #[test]
    fn explicit_concurrency_can_exceed_available_workers() {
        let resolved = resolve_effective_concurrency(
            Some(&RendererConcurrency::Workers(NonZeroU32::new(8).unwrap())),
            None,
            4,
            240,
        );

        assert_eq!(resolved, 8);
    }

    #[test]
    fn resolves_auto_concurrency_conservatively() {
        let resolved =
            resolve_effective_concurrency(Some(&RendererConcurrency::Auto), None, 16, 240);

        assert_eq!(resolved, 4);
    }

    #[test]
    fn resolves_default_concurrency_as_auto() {
        let resolved = resolve_effective_concurrency(None, None, 8, 240);

        assert_eq!(resolved, 4);
    }

    #[test]
    fn caps_concurrency_to_frame_count() {
        let resolved = resolve_effective_concurrency(
            Some(&RendererConcurrency::Workers(NonZeroU32::new(8).unwrap())),
            None,
            16,
            2,
        );

        assert_eq!(resolved, 2);
    }
}
